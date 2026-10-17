// HDR (HLG and PQ) to SDR tone mapping for thumbnails and extracted frames.
//
// iPhone 12 and later record HDR video by default (HEVC 10-bit, BT.2020, HLG). A plain conversion to RGB leaves
// those frames dim and flat. This ffmpeg build has neither zscale nor libplacebo, so the conversion is done with
// LUTs applied after converting the YCbCr frames to 16-bit non-linear RGB:
//   scale=...:in_color_matrix=bt2020:in_range=tv,format=gbrp16le,lut3d=file=<tone cube>,lut1d=file=<toe cube>
//
// The maths and the .cube text are the same as pipeline/common/hdr.py (the steps and the reasons for the toe
// LUT are explained there): display light from the HLG or PQ signal, reference white 203 nits -> 1.0,
// BT.2020 -> BT.709 primaries, a soft roll-off on max(R, G, B) above KNEE, gamma 2.4. Keep the two files in
// step; tests/server-hdr.test.ts checks that both write the same bytes.

import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type HdrTransfer = 'hlg' | 'pq';
export type HdrPrimaries = 'bt2020' | 'bt709';

export const LUT_VERSION = 1;
/** 3D LUT points per axis. */
export const LUT_SIZE = 65;
/** 1D LUT entries: one per 16-bit code. */
export const TOE_SIZE = 65536;
export const REF_WHITE_NITS = 203;
/** HLG nominal display peak; the assumed mastering peak for PQ. */
export const PEAK_NITS = 1000;
/** The roll-off starts at 90% of reference white (linear light); reference white ends at 0.95. */
export const KNEE = 0.9;
export const SDR_GAMMA = 2.4;
/** Linear light below which the 3D LUT stores linear values (times TOE_SLOPE) instead of gamma 2.4. */
export const TOE = 0.1;
const TOE_V = Math.pow(TOE, 1.0 / SDR_GAMMA);
const TOE_SLOPE = TOE_V / TOE;
/** ffmpeg truncates LUT outputs to 16 bits; half a step in every entry makes that round. */
const HALF_STEP = 0.5 / 65535.0;

/** ffprobe color_transfer -> our name. */
const TRANSFERS: Record<string, HdrTransfer> = { 'arib-std-b67': 'hlg', smpte2084: 'pq' };

const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;
const HLG_GAMMA = 1.2; // system gamma for a 1000 nit display

const PQ_M1 = 2610.0 / 16384.0;
const PQ_M2 = (2523.0 / 4096.0) * 128.0;
const PQ_C1 = 3424.0 / 4096.0;
const PQ_C2 = (2413.0 / 4096.0) * 32.0;
const PQ_C3 = (2392.0 / 4096.0) * 32.0;

const Y2020 = [0.2627, 0.678, 0.0593] as const;
const Y709 = [0.2126, 0.7152, 0.0722] as const;
/** Linear BT.2020 RGB to linear BT.709 RGB (ITU-R BT.2087). */
const M2020_TO_709 = [
  [1.660491, -0.5876411, -0.0728499],
  [-0.1245505, 1.1328999, -0.0083494],
  [-0.0181508, -0.1005789, 1.1187297],
] as const;

export function hdrTransfer(colorTransfer: unknown): HdrTransfer | undefined {
  return TRANSFERS[String(colorTransfer ?? '').trim().toLowerCase()];
}

/** How an HDR video stream is encoded, as far as the tone mapping needs to know. */
export interface HdrSource {
  transfer: HdrTransfer;
  primaries: HdrPrimaries;
  /** ffmpeg scale in_color_matrix */
  matrix: 'bt2020' | 'bt709' | 'bt601';
  /** ffmpeg scale in_range */
  range: 'tv' | 'pc';
}

/** From ffprobe's stream fields; null for SDR. Untagged primaries/matrix/range mean BT.2020 limited range. */
export function hdrSourceFromStream(s: {
  color_transfer?: unknown;
  color_primaries?: unknown;
  color_space?: unknown;
  color_range?: unknown;
}): HdrSource | null {
  const transfer = hdrTransfer(s.color_transfer);
  if (!transfer) return null;
  const prim = String(s.color_primaries ?? '').toLowerCase() === 'bt709' ? 'bt709' : 'bt2020';
  const cs = String(s.color_space ?? '').toLowerCase();
  const matrix = cs === 'bt709' ? 'bt709' : cs === 'smpte170m' || cs === 'bt470bg' ? 'bt601' : 'bt2020';
  const range = ['pc', 'jpeg', 'full'].includes(String(s.color_range ?? '').toLowerCase()) ? 'pc' : 'tv';
  return { transfer, primaries: prim, matrix, range };
}

// ---- the maths ------------------------------------------------------------------------------------------------

const clip01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function hlgInvOetf(x: number): number {
  return x <= 0.5 ? (x * x) / 3.0 : (Math.exp((x - HLG_C) / HLG_A) + HLG_B) / 12.0;
}

function pqEotf(x: number): number {
  const p = Math.pow(x, 1.0 / PQ_M2);
  return 10000.0 * Math.pow(Math.max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), 1.0 / PQ_M1);
}

function encode(x: number): number {
  return Math.sign(x) * Math.pow(Math.min(Math.abs(x), 1.0), 1.0 / SDR_GAMMA);
}

/** Linear BT.709 light relative to SDR white after the roll-off (negative outside BT.709). Mirrors hdr.py _linear(). */
function linear(r0: number, g0: number, b0: number, transfer: HdrTransfer, primaries: HdrPrimaries): [number, number, number] {
  let r = clip01(r0);
  let g = clip01(g0);
  let b = clip01(b0);
  if (transfer === 'hlg') {
    const yc = primaries === 'bt709' ? Y709 : Y2020;
    r = hlgInvOetf(r);
    g = hlgInvOetf(g);
    b = hlgInvOetf(b);
    const ys = yc[0] * r + yc[1] * g + yc[2] * b;
    const k = PEAK_NITS * Math.pow(ys, HLG_GAMMA - 1.0);
    r = k * r;
    g = k * g;
    b = k * b;
  } else {
    r = pqEotf(r);
    g = pqEotf(g);
    b = pqEotf(b);
  }
  r = r / REF_WHITE_NITS;
  g = g / REF_WHITE_NITS;
  b = b / REF_WHITE_NITS;
  if (primaries !== 'bt709') {
    const m = M2020_TO_709;
    const r2 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
    const g2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
    const b2 = m[2][0] * r + m[2][1] * g + m[2][2] * b;
    r = r2;
    g = g2;
    b = b2;
  }
  // Roll-off on max(R, G, B): identity up to KNEE, then u * (1 + u / U^2) / (1 + u) on the excess.
  const peak = PEAK_NITS / REF_WHITE_NITS;
  const span = 1.0 - KNEE;
  const bigU = (peak - KNEE) / span;
  const mx = Math.max(Math.max(r, g), b);
  if (mx > KNEE) {
    const u = (mx - KNEE) / span;
    const mapped = Math.min(KNEE + span * ((u * (1.0 + u / (bigU * bigU))) / (1.0 + u)), 1.0);
    const s = mapped / mx;
    r = r * s;
    g = g * s;
    b = b * s;
  }
  return [r, g, b];
}

/** Non-linear SDR BT.709 R'G'B' before the final clip (a negative channel outside BT.709). hdr.py tonemap_signed(). */
export function tonemapSigned(r: number, g: number, b: number, transfer: HdrTransfer, primaries: HdrPrimaries = 'bt2020'): [number, number, number] {
  const [x, y, z] = linear(r, g, b, transfer, primaries);
  return [encode(x) + 0, encode(y) + 0, encode(z) + 0];
}

/** What the 3D LUT stores: TOE_SLOPE * x below TOE (negative values too), gamma 2.4 above. */
function toeEncode(x: number): number {
  return x < TOE ? x * TOE_SLOPE : Math.pow(Math.min(Math.max(x, TOE), 1.0), 1.0 / SDR_GAMMA);
}

/** The 1D LUT: stored value back to gamma 2.4 (identity at and above the encoded TOE). hdr.py toe_decode(). */
export function toeDecode(y: number): number {
  return y < TOE_V ? Math.pow(Math.max(y, 0.0) / TOE_SLOPE, 1.0 / SDR_GAMMA) : y;
}

/** The 3D LUT entry for one HDR R'G'B' input (half a 16-bit step added). hdr.py lut_values(). */
export function lutValues(r: number, g: number, b: number, transfer: HdrTransfer, primaries: HdrPrimaries = 'bt2020'): [number, number, number] {
  const [x, y, z] = linear(r, g, b, transfer, primaries);
  return [toeEncode(x) + HALF_STEP, toeEncode(y) + HALF_STEP, toeEncode(z) + HALF_STEP];
}

/** The exact per-pixel SDR value (0..1) the LUT approximates. */
export function tonemap(r: number, g: number, b: number, transfer: HdrTransfer, primaries: HdrPrimaries = 'bt2020'): [number, number, number] {
  const [x, y, z] = tonemapSigned(r, g, b, transfer, primaries);
  return [clip01(x), clip01(y), clip01(z)];
}

// ---- the LUT --------------------------------------------------------------------------------------------------

function header(kind: string, what: string): string[] {
  return [
    `# Deja View HDR to SDR tone mapping v${LUT_VERSION}: ${what}`,
    `# reference white ${REF_WHITE_NITS} nits, peak ${PEAK_NITS} nits, knee ${KNEE}, gamma ${SDR_GAMMA}, toe ${TOE}`,
    `TITLE "dejaview-${kind}-v${LUT_VERSION}"`,
  ];
}

/** The 3D .cube LUT (red index fastest) from HDR R'G'B'. Byte-identical to hdr.py cube_text(). */
export function cubeText(transfer: HdrTransfer, primaries: HdrPrimaries = 'bt2020', size = LUT_SIZE): string {
  const lines = [...header(`${transfer}-${primaries}`, `${transfer} ${primaries} to BT.709, then the toe LUT`), `LUT_3D_SIZE ${size}`];
  const axis = Array.from({ length: size }, (_, i) => i / (size - 1));
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [x, y, z] = lutValues(axis[ri]!, axis[gi]!, axis[bi]!, transfer, primaries);
        lines.push(`${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** The 1D .cube LUT applied after the 3D one. Byte-identical to hdr.py toe_text(). */
export function toeText(size = TOE_SIZE): string {
  const lines = [...header('toe', 'linear toe back to gamma 2.4'), `LUT_1D_SIZE ${size}`];
  for (let i = 0; i < size; i++) {
    const v = (toeDecode(i / (size - 1)) + HALF_STEP).toFixed(6);
    lines.push(`${v} ${v} ${v}`);
  }
  return lines.join('\n') + '\n';
}

let privateDir: string | null = null;

/** DEJAVIEW_HDR_DIR, else <tmp>/dejaview-hdr-<uid> when it is ours and private, else a per-process temp dir. */
export function lutDir(): string {
  const env = process.env.DEJAVIEW_HDR_DIR;
  if (env) {
    mkdirSync(env, { recursive: true });
    return env;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const d = join(tmpdir(), `dejaview-hdr-${uid ?? 'user'}`);
  try {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = lstatSync(d);
    if (st.isDirectory() && (uid === undefined || st.uid === uid) && !(st.mode & 0o022)) return d;
  } catch {
    /* fall through to a private directory */
  }
  if (!privateDir) {
    privateDir = mkdtempSync(join(tmpdir(), 'dejaview-hdr-'));
    const dir = privateDir;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return privateDir;
}

const luts = new Map<string, Promise<string>>();

/** lutDir()/name with makeText() in it, written atomically once per process, then reused (rewritten if deleted). */
async function written(name: string, makeText: () => string): Promise<string> {
  const cached = luts.get(name);
  if (cached) {
    const path = await cached.catch(() => null);
    if (path && (await Bun.file(path).exists())) return path;
    if (luts.get(name) === cached) luts.delete(name);
    return written(name, makeText);
  }
  const p = (async () => {
    const path = join(lutDir(), name);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, makeText(), { mode: 0o600 });
      await rename(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return path;
  })();
  luts.set(name, p);
  p.catch(() => {
    if (luts.get(name) === p) luts.delete(name);
  });
  return p;
}

/** The 3D LUT file for this source. */
export function lutFile(transfer: HdrTransfer, primaries: HdrPrimaries = 'bt2020', size = LUT_SIZE): Promise<string> {
  return written(`${transfer}-${primaries}-${size}-v${LUT_VERSION}.cube`, () => cubeText(transfer, primaries, size));
}

/** The 1D LUT file (the same for every source). */
export function toeFile(): Promise<string> {
  return written(`toe-${TOE_SIZE}-v${LUT_VERSION}.cube`, () => toeText());
}

// ---- ffmpeg filters -------------------------------------------------------------------------------------------

/** A file path as a quoted ffmpeg filter option value. */
export function filterPath(p: string): string {
  if (p.includes("'") || p.includes('\\')) throw new Error(`unsupported character in LUT path: ${p}`);
  return `'${p}'`;
}

/** Extra `scale` options that turn the stream's YCbCr into full-range non-linear RGB. */
export function scaleOptions(src: HdrSource): string {
  return `:in_color_matrix=${src.matrix}:in_range=${src.range}`;
}

/**
 * Filters after the `scale` (with scaleOptions); they end in SDR gbrp16le. Planar gbrp16le on purpose: ffmpeg 8.1
 * converts yuv420p10le straight to packed rgb48le with wrong green and blue under some scale flags.
 */
export function lutFilters(lut: string, toe: string): string[] {
  return ['format=gbrp16le', `lut3d=file=${filterPath(lut)}:interp=tetrahedral`, `lut1d=file=${filterPath(toe)}`];
}

/** Tone-mapped RGB to a JFIF JPEG's YCbCr (BT.601, full range). */
export const RGB_TO_JPEG = 'scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p';

export interface HdrChain {
  source: HdrSource;
  /** Append to the `scale=` that comes first. */
  scaleOptions: string;
  /** Filters right after that scale; they end in SDR gbrp16le. */
  toSdr: string[];
}

/** The filters that tone-map this source (writes the LUT on first use). */
export async function hdrChain(source: HdrSource): Promise<HdrChain> {
  const [lut, toe] = await Promise.all([lutFile(source.transfer, source.primaries), toeFile()]);
  return { source, scaleOptions: scaleOptions(source), toSdr: lutFilters(lut, toe) };
}
