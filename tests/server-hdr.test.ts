// HDR (HLG / PQ) video gets tone-mapped thumbnails, extracted frames and frame picking; SDR keeps the plain path.
// The clips are built from the same synthetic SDR frames: once as SDR H.264, once as HLG and once as PQ HEVC
// 10-bit (BT.2020, SDR white at the BT.2408 reference white).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cubeText,
  hdrChain,
  hdrSourceFromStream,
  hdrTransfer,
  lutFile,
  lutValues,
  toeDecode,
  toeText,
  tonemap,
  tonemapSigned,
} from '../server/hdr.ts';
import { exec, execBytes, extractFrame, FFMPEG, pickBestFrameTime, probeVideo, thumbFromVideo, videoHdrSource } from '../server/media.ts';

const REPO = join(import.meta.dir, '..');
const PYTHON = join(REPO, '.venv', 'bin', 'python');
const W = 320;
const H = 180;
const FPS = 10;
const N = 8;

async function ffmpegHas(kind: 'encoders' | 'filters', name: string): Promise<boolean> {
  try {
    const r = await exec([FFMPEG, '-hide_banner', `-${kind}`], { timeoutMs: 20_000 });
    return r.stdout.split('\n').some((l) => l.trim().split(/\s+/)[1] === name);
  } catch {
    return false;
  }
}
const HAS_X265 = (await ffmpegHas('encoders', 'libx265')) && (await ffmpegHas('filters', 'lut3d')) && (await ffmpegHas('filters', 'lut1d'));
const HAS_PYTHON = await Bun.file(PYTHON).exists();

// ---- test clips -------------------------------------------------------------------------------------------------

/** A small room-like scene: wall, floor, a white card, a person (blue shirt, skin) that moves, a grey ramp. */
function roomFrames(): Uint8Array {
  const out = new Uint8Array(N * W * H * 3);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / (1 << 24);
  const squares = Array.from({ length: 40 }, () => ({
    x: Math.floor(rnd() * (W - 14)),
    y: Math.floor(rnd() * (H - 14)),
    c: [30 + Math.floor(rnd() * 200), 30 + Math.floor(rnd() * 200), 30 + Math.floor(rnd() * 200)],
  }));
  for (let f = 0; f < N; f++) {
    const px = 40 + 8 * f;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let c = y < H / 2 ? [168, 150, 128] : [112, 92, 74];
        for (const s of squares) if (x >= s.x && x < s.x + 12 && y >= s.y && y < s.y + 12) c = s.c;
        if (y >= 12 && y < 52 && x >= 210 && x < 300) c = [255, 255, 255];
        if (y >= H - 16) {
          const v = Math.round((x / (W - 1)) * 255);
          c = [v, v, v];
        }
        if (y >= 50 && y < H - 30 && x >= px && x < px + 40) c = [60, 90, 170];
        if (y >= 30 && y < 50 && x >= px + 8 && x < px + 32) c = [224, 172, 140];
        out.set(c, ((f * H + y) * W + x) * 3);
      }
    }
  }
  return out;
}

const M709_TO_2020 = [
  [0.627404, 0.329282, 0.0433136],
  [0.069097, 0.91954, 0.0113612],
  [0.0163916, 0.0880132, 0.895595],
];
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };

/** SDR BT.709 RGB (gamma 2.4) to an HLG or PQ BT.2020 signal in [0, 1]; SDR white -> 203 nits. */
function sdrToHdr(rgb8: Uint8Array, transfer: 'hlg' | 'pq'): Uint16Array {
  const out = new Uint16Array(rgb8.length);
  for (let i = 0; i < rgb8.length; i += 3) {
    const lin = [0, 1, 2].map((k) => Math.pow(rgb8[i + k]! / 255, 2.4));
    const nits = M709_TO_2020.map((row) => (row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!) * 203);
    let sig: number[];
    if (transfer === 'hlg') {
      const ys = Math.pow((0.2627 * nits[0]! + 0.678 * nits[1]! + 0.0593 * nits[2]!) / 1000, 1 / 1.2);
      sig = nits.map((n) => {
        const e = Math.min(1, Math.max(0, n / (1000 * Math.pow(Math.max(ys, 1e-12), 0.2))));
        return e <= 1 / 12 ? Math.sqrt(3 * e) : 0.17883277 * Math.log(Math.max(12 * e - 0.28466892, 1e-12)) + 0.55991073;
      });
    } else {
      sig = nits.map((n) => {
        const y = Math.pow(Math.min(1, Math.max(0, n / 10000)), PQ.m1);
        return Math.pow((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y), PQ.m2);
      });
    }
    for (let k = 0; k < 3; k++) out[i + k] = Math.round(Math.min(1, Math.max(0, sig[k]!)) * 65535);
  }
  return out;
}

async function ff(args: string[], stdin?: Uint8Array) {
  const r = await exec([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 60_000, stdin });
  if (r.code !== 0) throw new Error(r.stderr);
}

async function rgb24(path: string, vf?: string): Promise<Uint8Array> {
  const r = await execBytes([FFMPEG, '-v', 'error', '-i', path, ...(vf ? ['-vf', vf] : []), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.data;
}

function stats(rgb: Uint8Array) {
  const n = rgb.length / 3;
  const luma = new Float64Array(n);
  let sum = 0;
  let sat = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma[i]!;
    const mx = Math.max(r, g, b);
    sat += mx ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  luma.sort();
  return { mean: sum / n, p98: luma[Math.floor(n * 0.98)]!, sat: (sat / n) * 255 };
}

let dir: string;
const clip: Record<'sdr' | 'hlg' | 'pq', string> = { sdr: '', hlg: '', pq: '' };
const prevLutDir = process.env.DEJAVIEW_HDR_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dejaview-hdr-test-'));
  process.env.DEJAVIEW_HDR_DIR = join(dir, 'luts');
  if (!HAS_X265) return;
  const frames = roomFrames();
  const raw = ['-f', 'rawvideo', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', '-'];
  clip.sdr = join(dir, 'sdr.mp4');
  await ff(['-pix_fmt', 'rgb24', ...raw, '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-crf', '10', '-colorspace', 'bt709', '-color_range', 'tv', clip.sdr], frames);
  for (const t of ['hlg', 'pq'] as const) {
    const trc = t === 'hlg' ? 'arib-std-b67' : 'smpte2084';
    clip[t] = join(dir, t === 'hlg' ? 'hlg.mov' : 'pq.mp4');
    const sig = sdrToHdr(frames, t);
    await ff(['-pix_fmt', 'rgb48le', ...raw, '-vf', 'scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p10le',
      '-c:v', 'libx265', '-preset', 'fast', '-crf', '8', '-x265-params', `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited`,
      '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc', '-color_range', 'tv', '-tag:v', 'hvc1', clip[t]],
      new Uint8Array(sig.buffer));
  }
}, 60_000);

afterAll(async () => {
  if (prevLutDir === undefined) delete process.env.DEJAVIEW_HDR_DIR;
  else process.env.DEJAVIEW_HDR_DIR = prevLutDir;
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---- the maths ---------------------------------------------------------------------------------------------------

describe('tone mapping maths', () => {
  test('HLG and PQ are detected from ffprobe stream fields', () => {
    expect(hdrTransfer('arib-std-b67')).toBe('hlg');
    expect(hdrTransfer('smpte2084')).toBe('pq');
    for (const sdr of ['bt709', 'smpte170m', 'bt2020-10', 'unknown', '', undefined]) expect(hdrTransfer(sdr)).toBeUndefined();
    expect(hdrSourceFromStream({ color_transfer: 'bt709' })).toBeNull();
    expect(hdrSourceFromStream({ color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv' }))
      .toEqual({ transfer: 'hlg', primaries: 'bt2020', matrix: 'bt2020', range: 'tv' });
    expect(hdrSourceFromStream({ color_transfer: 'smpte2084' })).toEqual({ transfer: 'pq', primaries: 'bt2020', matrix: 'bt2020', range: 'tv' });
    expect(hdrSourceFromStream({ color_transfer: 'arib-std-b67', color_primaries: 'bt709', color_space: 'bt709', color_range: 'pc' }))
      .toEqual({ transfer: 'hlg', primaries: 'bt709', matrix: 'bt709', range: 'pc' });
  });

  test('reference white, mid-tones and the peak', () => {
    const white = Math.pow(0.95, 1 / 2.4); // reference white ends at 0.95 linear (8-bit 250)
    for (const v of tonemap(0.75, 0.75, 0.75, 'hlg')) expect(Math.abs(v - white)).toBeLessThan(2e-4);
    for (const v of tonemap(1, 1, 1, 'hlg')) expect(v).toBeCloseTo(1, 9);
    for (const v of tonemap(1, 1, 1, 'pq')) expect(v).toBeCloseTo(1, 9);
    // Mid-tones below the knee come back exactly from the SDR -> HDR conversion.
    for (const t of ['hlg', 'pq'] as const) {
      const sdr = new Uint8Array([128, 128, 128, 224, 172, 140, 60, 90, 170, 20, 20, 20]);
      const sig = sdrToHdr(sdr, t);
      for (let i = 0; i < sdr.length; i += 3) {
        const back = tonemap(sig[i]! / 65535, sig[i + 1]! / 65535, sig[i + 2]! / 65535, t).map((v) => v * 255);
        for (let k = 0; k < 3; k++) expect(Math.abs(back[k]! - sdr[i + k]!)).toBeLessThan(0.1);
      }
    }
    // Out of BT.709 the signed value goes negative; the clipped one stays in range.
    const signed = tonemapSigned(0, 0.7, 0, 'hlg');
    expect(signed[0]).toBeLessThan(0);
    expect(tonemap(0, 0.7, 0, 'hlg')[0]).toBe(0);
  });

  test('the two LUT stages compose to the exact tone map', () => {
    const half = 0.5 / 65535;
    for (const t of ['hlg', 'pq'] as const) {
      for (let i = 0; i < 2000; i++) {
        const rgb = [(i * 0.6180339) % 1, (i * 0.4142135) % 1, (i * 0.7320508) % 1] as const;
        const stored = lutValues(rgb[0], rgb[1], rgb[2], t).map((v) => Math.min(1, Math.max(0, v - half)));
        const exact = tonemap(rgb[0], rgb[1], rgb[2], t);
        for (let k = 0; k < 3; k++) expect(Math.abs(toeDecode(stored[k]!) - exact[k]!)).toBeLessThan(1e-12);
      }
    }
  });

  test('LUT files are written once into the private LUT directory and rewritten if deleted', async () => {
    const a = await lutFile('pq', 'bt2020', 5);
    expect(a.startsWith(process.env.DEJAVIEW_HDR_DIR!)).toBe(true);
    expect(await Bun.file(a).text()).toBe(cubeText('pq', 'bt2020', 5));
    expect(await lutFile('pq', 'bt2020', 5)).toBe(a);
    await unlink(a);
    expect(await lutFile('pq', 'bt2020', 5)).toBe(a);
    expect(await Bun.file(a).exists()).toBe(true);
  });

  test.skipIf(!HAS_PYTHON)('the LUT files are byte-identical to the Python pipeline', async () => {
    const script = [
      'import hashlib, sys',
      "sys.path.insert(0, 'pipeline')",
      'from common.hdr import cube_text, toe_text',
      "h = lambda s: hashlib.sha256(s.encode()).hexdigest()",
      "print(h(cube_text('hlg')), h(cube_text('pq')), h(cube_text('hlg', 'bt709')), h(toe_text()))",
    ].join('\n');
    const r = await exec([PYTHON, '-c', script], { cwd: REPO, timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
    expect(r.stdout.trim().split(' ')).toEqual([sha(cubeText('hlg')), sha(cubeText('pq')), sha(cubeText('hlg', 'bt709')), sha(toeText())]);
  }, 60_000);
});

// ---- the media helpers -------------------------------------------------------------------------------------------

describe.skipIf(!HAS_X265)('HDR video in the media helpers', () => {
  test('probeVideo reports hdr only for HDR video', async () => {
    expect((await probeVideo(clip.hlg)).hdr).toBe('hlg');
    expect((await probeVideo(clip.pq)).hdr).toBe('pq');
    const sdr = await probeVideo(clip.sdr);
    expect('hdr' in sdr).toBe(false);
    const copy = join(dir, 'copy.mov');
    await copyFile(clip.hlg, copy); // never probed: the helpers probe it once themselves
    expect((await videoHdrSource(copy))?.transfer).toBe('hlg');
    expect(await videoHdrSource(clip.sdr)).toBeNull();
  });

  test('thumbnails and extracted frames look like the SDR source', async () => {
    await thumbFromVideo(clip.sdr, join(dir, 'sdr-thumb.jpg'), 0.3, 320);
    await extractFrame(clip.sdr, 0.3, join(dir, 'sdr-frame.jpg'));
    const ref = stats(await rgb24(join(dir, 'sdr-thumb.jpg')));
    const refFrame = stats(await rgb24(join(dir, 'sdr-frame.jpg')));
    for (const t of ['hlg', 'pq'] as const) {
      // What the old code made: a plain conversion, dim and flat.
      await ff(['-ss', '0.300', '-i', clip[t], '-frames:v', '1', '-vf', "scale='min(320,iw)':-2,format=yuvj420p", '-q:v', '4', join(dir, `${t}-old.jpg`)]);
      const old = stats(await rgb24(join(dir, `${t}-old.jpg`)));
      expect(old.p98).toBeLessThan(ref.p98 - 20);
      await thumbFromVideo(clip[t], join(dir, `${t}-thumb.jpg`), 0.3, 320);
      const thumb = stats(await rgb24(join(dir, `${t}-thumb.jpg`)));
      expect(Math.abs(thumb.mean - ref.mean)).toBeLessThan(3);
      expect(Math.abs(thumb.p98 - ref.p98)).toBeLessThan(8); // white -> 250 by design (highlight roll-off)
      expect(Math.abs(thumb.sat - ref.sat)).toBeLessThan(6);
      await extractFrame(clip[t], 0.3, join(dir, `${t}-frame.jpg`));
      const frame = stats(await rgb24(join(dir, `${t}-frame.jpg`)));
      expect(Math.abs(frame.mean - refFrame.mean)).toBeLessThan(3);
      expect(Math.abs(frame.p98 - refFrame.p98)).toBeLessThan(8);
    }
  }, 60_000);

  test('frame picking works on HDR video', async () => {
    const info = await probeVideo(clip.hlg);
    for (const t of ['hlg', 'pq'] as const) {
      const at = await pickBestFrameTime(clip[t], info.duration);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(info.duration);
    }
  }, 60_000);

  test('SDR video keeps the exact plain commands', async () => {
    await thumbFromVideo(clip.sdr, join(dir, 'a.jpg'), 0.3);
    await ff(['-ss', '0.300', '-i', clip.sdr, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2,format=yuvj420p", '-q:v', '4', join(dir, 'b.jpg')]);
    expect(Buffer.compare(Buffer.from(await Bun.file(join(dir, 'a.jpg')).arrayBuffer()), Buffer.from(await Bun.file(join(dir, 'b.jpg')).arrayBuffer()))).toBe(0);
    await extractFrame(clip.sdr, 0.3, join(dir, 'c.jpg'));
    await ff(['-ss', '0.300', '-i', clip.sdr, '-frames:v', '1', '-vf', 'format=yuvj420p', '-q:v', '2', join(dir, 'd.jpg')]);
    expect(Buffer.compare(Buffer.from(await Bun.file(join(dir, 'c.jpg')).arrayBuffer()), Buffer.from(await Bun.file(join(dir, 'd.jpg')).arrayBuffer()))).toBe(0);
  }, 60_000);

  test.skipIf(!HAS_PYTHON)('the server filters decode bit-identically to the Python pipeline', async () => {
    for (const t of ['hlg', 'pq'] as const) {
      const chain = await hdrChain(hdrSourceFromStream({ color_transfer: t === 'hlg' ? 'arib-std-b67' : 'smpte2084' })!);
      const vf = [`scale=${W}:${H}:flags=area+accurate_rnd+full_chroma_int${chain.scaleOptions}`, ...chain.toSdr].join(',');
      const r = await execBytes([FFMPEG, '-v', 'error', '-nostdin', '-i', clip[t], '-an', '-sn', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb48le', 'pipe:1']);
      expect(r.code).toBe(0);
      const v16 = new Uint16Array(r.data.buffer, r.data.byteOffset, r.data.length / 2);
      const ts = Uint8Array.from(v16, (x) => Math.floor((x + 128) / 257));
      const out = join(dir, `${t}.py.rgb`);
      const script = [
        'import sys',
        "sys.path.insert(0, 'pipeline')",
        'from common.media import iter_frames',
        `open(sys.argv[2], 'wb').write(b''.join(f.tobytes() for f in iter_frames(sys.argv[1], (${W}, ${H}))))`,
      ].join('\n');
      const py = await exec([PYTHON, '-c', script, clip[t], out], { cwd: REPO, timeoutMs: 60_000, env: { ...process.env } });
      expect(py.stderr).toBe('');
      const fromPython = new Uint8Array(await Bun.file(out).arrayBuffer());
      expect(fromPython.length).toBe(N * W * H * 3);
      expect(Buffer.compare(Buffer.from(ts), Buffer.from(fromPython))).toBe(0);
    }
  }, 60_000);
});
