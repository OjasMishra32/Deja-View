// Media helpers built on ffmpeg/ffprobe (Homebrew) and macOS sips.
// HDR video (HLG or PQ, e.g. any iPhone 12 or later clip) is tone-mapped to SDR in thumbnails, extracted frames
// and frame picking (server/hdr.ts); SDR video takes exactly the plain path.

import { rename, stat, unlink } from 'node:fs/promises';
import { hdrChain, hdrSourceFromStream, RGB_TO_JPEG, type HdrChain, type HdrSource, type HdrTransfer } from './hdr.ts';

export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
export const SIPS = process.env.SIPS_BIN || '/usr/bin/sips';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command without a shell. Never throws for a non-zero exit; throws only if the binary is missing. */
export async function exec(
  argv: string[],
  opts: { timeoutMs?: number; cwd?: string; stdin?: Uint8Array; env?: Record<string, string | undefined> } = {},
): Promise<ExecResult> {
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env as Record<string, string> | undefined,
      stdin: opts.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    throw new Error(`cannot run ${argv[0]}: ${(e as Error).message}`);
  }
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

export async function execBytes(argv: string[], timeoutMs = 120_000): Promise<{ code: number; data: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const [buf, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, data: new Uint8Array(buf), stderr };
}

export function lastLines(text: string, n = 6): string {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

/**
 * A file we cannot use. `message` is the end of a product sentence that follows the file name
 * ('"clip.mp4" looks incomplete ...'); `detail` is the tool output, for the server log only.
 */
export class MediaReadError extends Error {
  constructor(
    message: string,
    readonly detail = '',
    readonly reason: 'unreadable' | 'no-video' | 'no-duration' = 'unreadable',
  ) {
    super(message);
    this.name = 'MediaReadError';
  }
}

export type MediaKind = 'jpeg' | 'png' | 'heic' | 'webp' | 'gif' | 'avif' | 'bmp' | 'tiff' | 'video' | 'unknown';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mts', 'm2ts', 'ts', 'flv', 'wmv', 'mpg', 'mpeg']);

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Identifies a file from its first bytes, falling back to the file name and MIME type. */
export function sniffKind(head: Uint8Array, name = '', mime = ''): MediaKind {
  const b = head;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'video';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'bmp';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))) return 'tiff';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // Matroska/WebM
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, Math.min(b.length - 8, 32));
    if (/heic|heix|heim|heis|hevc|hevx|mif1|msf1/.test(brands.slice(0, 4))) return 'heic';
    if (/avif|avis/.test(brands.slice(0, 4))) return 'avif';
    return 'video';
  }
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) return 'video';
  const ext = extOf(name);
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'png') return 'png';
  if (ext === 'heic' || ext === 'heif') return 'heic';
  if (IMAGE_EXT.has(ext)) return ext as MediaKind;
  if (VIDEO_EXT.has(ext) || mime.startsWith('video/')) return 'video';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  return 'unknown';
}

export function isImageKind(k: MediaKind): boolean {
  return k !== 'video' && k !== 'unknown';
}

export interface ExifInfo {
  /** 1..8, 1 when absent. */
  orientation: number;
  /** FocalLengthIn35mmFilm, when recorded. */
  focal35?: number;
  make?: string;
  model?: string;
}

/** Reads the few EXIF fields we use from a JPEG (APP1 "Exif" segment, IFD0 plus the Exif sub-IFD). */
export function readJpegExif(buf: Uint8Array): ExifInfo {
  const info: ExifInfo = { orientation: 1 };
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return info;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return info;
    const marker = buf[o + 1]!;
    if (marker === 0xda || marker === 0xd9) return info;
    const len = (buf[o + 2]! << 8) | buf[o + 3]!;
    const s = o + 4;
    if (marker === 0xe1 && len >= 16 && String.fromCharCode(...buf.subarray(s, s + 4)) === 'Exif') {
      const t = s + 6;
      const end = Math.min(buf.length, o + 2 + len);
      const le = buf[t] === 0x49;
      const u16 = (p: number) => (p + 2 > end ? 0 : le ? buf[p]! | (buf[p + 1]! << 8) : (buf[p]! << 8) | buf[p + 1]!);
      const u32 = (p: number) =>
        p + 4 > end
          ? 0
          : le
            ? (buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16) | (buf[p + 3]! << 24)) >>> 0
            : ((buf[p]! << 24) | (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!) >>> 0;
      const ascii = (e: number) => {
        const count = u32(e + 4);
        const at = count <= 4 ? e + 8 : t + u32(e + 8);
        if (at + count > end || count > 256) return undefined;
        return String.fromCharCode(...buf.subarray(at, at + count)).replace(/\0+$/, '').trim() || undefined;
      };
      const walk = (ifd: number, depth: number) => {
        if (ifd + 2 > end || depth > 1) return;
        const n = u16(ifd);
        for (let i = 0; i < n && i < 200; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > end) break;
          const tag = u16(e);
          if (tag === 0x0112) {
            const v = u16(e + 8);
            if (v >= 1 && v <= 8) info.orientation = v;
          } else if (tag === 0xa405) {
            const v = u16(e + 8);
            if (v > 0) info.focal35 = v;
          } else if (tag === 0x010f) info.make = ascii(e);
          else if (tag === 0x0110) info.model = ascii(e);
          else if (tag === 0x8769) walk(t + u32(e + 8), depth + 1);
        }
      };
      walk(t + u32(t + 4), 0);
      return info;
    }
    o += 2 + len;
  }
  return info;
}

/** EXIF orientation (1..8) of a JPEG, 1 when absent. */
export function jpegOrientation(buf: Uint8Array): number {
  return readJpegExif(buf).orientation;
}

/**
 * A minimal APP1 segment: Orientation = 1 and FocalLengthIn35mmFilm, so pipelines that read EXIF still find the
 * focal length after normalization (which drops the original metadata).
 */
export function exifApp1(focal35: number): Uint8Array {
  const tiff = new Uint8Array(56);
  const dv = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, 8, true);
  // IFD0: Orientation, ExifIFD pointer.
  dv.setUint16(8, 2, true);
  dv.setUint16(10, 0x0112, true);
  dv.setUint16(12, 3, true);
  dv.setUint32(14, 1, true);
  dv.setUint16(18, 1, true);
  dv.setUint16(22, 0x8769, true);
  dv.setUint16(24, 4, true);
  dv.setUint32(26, 1, true);
  dv.setUint32(30, 38, true);
  dv.setUint32(34, 0, true);
  // Exif IFD: FocalLengthIn35mmFilm.
  dv.setUint16(38, 1, true);
  dv.setUint16(40, 0xa405, true);
  dv.setUint16(42, 3, true);
  dv.setUint32(44, 1, true);
  dv.setUint16(48, Math.max(1, Math.min(65535, Math.round(focal35))), true);
  dv.setUint32(52, 0, true);
  const body = new Uint8Array(6 + tiff.length);
  body.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  body.set(tiff, 6);
  const seg = new Uint8Array(4 + body.length);
  seg.set([0xff, 0xe1, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255]);
  seg.set(body, 4);
  return seg;
}

/** Inserts an APP1 segment right after SOI (and after a JFIF APP0 if present). */
export function insertApp1(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(app1, at);
  out.set(jpeg.subarray(at), at + app1.length);
  return out;
}

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
  rotation: number;
  /** Set for HDR video ('hlg' or 'pq'); thumbnails and extracted frames are tone-mapped to SDR. */
  hdr?: HdrTransfer;
}

// ---- colour / HDR detection: probeVideo records each file's colour so the frame helpers need no second probe.

const colorCache = new Map<string, { version: string; source: HdrSource | null }>();

async function fileVersion(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

async function rememberColor(path: string, source: HdrSource | null): Promise<void> {
  const version = await fileVersion(path);
  if (version === null) return;
  if (colorCache.size > 256) colorCache.clear();
  colorCache.set(path, { version, source });
}

/** How to tone-map this video, or null for SDR (or when it cannot be probed). Free after probeVideo. */
export async function videoHdrSource(path: string): Promise<HdrSource | null> {
  const version = await fileVersion(path);
  const hit = colorCache.get(path);
  if (hit && version !== null && hit.version === version) return hit.source;
  const r = await exec(
    [FFPROBE, '-v', 'error', '-select_streams', 'v', '-print_format', 'json', '-show_entries',
      'stream=codec_type,color_transfer,color_primaries,color_space,color_range:stream_disposition=attached_pic', path],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  if (!r || r.code !== 0) return null;
  let streams: any[] = [];
  try {
    streams = JSON.parse(r.stdout).streams ?? [];
  } catch {
    return null;
  }
  const v = streams.find((s) => s.disposition?.attached_pic !== 1);
  if (!v) return null;
  const source = hdrSourceFromStream(v);
  await rememberColor(path, source);
  return source;
}

/** The tone-mapping filters for an HDR video, null for SDR (or when the LUT cannot be written). */
async function hdrFor(path: string): Promise<HdrChain | null> {
  const source = await videoHdrSource(path);
  if (!source) return null;
  try {
    return await hdrChain(source);
  } catch (e) {
    console.warn(`[media] HDR tone mapping unavailable for ${path}: ${(e as Error).message}`);
    return null;
  }
}

const UNREADABLE_VIDEO = 'looks incomplete or damaged (still copying?). Export or AirDrop it again.';

/** ffprobe a video. Throws a MediaReadError (product phrase + tool output) when it has no usable video stream. */
export async function probeVideo(path: string): Promise<ProbeInfo> {
  const r = await exec(
    [FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) throw new MediaReadError(UNREADABLE_VIDEO, `ffprobe exit ${r.code}: ${lastLines(r.stderr, 3)}`);
  let info: any;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw new MediaReadError(UNREADABLE_VIDEO, 'ffprobe output unreadable');
  }
  const streams: any[] = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new MediaReadError('has no video in it.', 'no video stream', 'no-video');
  const duration = Number(v.duration ?? info.format?.duration ?? 0);
  if (!(duration > 0)) throw new MediaReadError('looks incomplete (it has no length). Export it again.', 'no duration in the container', 'no-duration');
  const rate = String(v.avg_frame_rate || v.r_frame_rate || '0/1');
  const [n, d] = rate.split('/').map(Number);
  const fps = d ? n! / d : Number(n) || 0;
  let rotation = 0;
  for (const sd of v.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
  if (v.tags?.rotate) rotation = Number(v.tags.rotate) || rotation;
  const hdr = hdrSourceFromStream(v);
  await rememberColor(path, hdr);
  return {
    duration,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    codec: String(v.codec_name ?? ''),
    rotation,
    ...(hdr ? { hdr: hdr.transfer } : {}),
  };
}

const MAX_IMAGE_SIDE = 4096;

export interface NormalizedImage {
  width: number;
  height: number;
  focal35?: number;
  make?: string;
  model?: string;
}

/**
 * Converts any supported image to a baseline JPEG with EXIF orientation applied to the pixels
 * (ffmpeg rotates by the EXIF tag and does not copy it into the output). HEIC goes through sips first.
 * The 35 mm equivalent focal length, when the source has one, is written back as a minimal EXIF block.
 */
export async function normalizeImage(src: string, kind: MediaKind, dest: string): Promise<NormalizedImage> {
  let input = src;
  let tmp: string | null = null;
  if (kind === 'heic' || kind === 'avif' || kind === 'tiff') {
    tmp = `${dest}.sips.jpg`;
    const r = await exec([SIPS, '-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', src, '--out', tmp], { timeoutMs: 60_000 });
    if (r.code === 0 && (await Bun.file(tmp).exists())) {
      input = tmp;
    } else {
      await unlink(tmp).catch(() => {});
      tmp = null;
    }
  }
  let exif: ExifInfo = { orientation: 1 };
  try {
    exif = readJpegExif(new Uint8Array(await Bun.file(input).slice(0, 256 * 1024).arrayBuffer()));
  } catch {
    /* not a JPEG */
  }
  const out = `${dest}.part.jpg`;
  const scale = `scale='min(${MAX_IMAGE_SIDE},iw)':'min(${MAX_IMAGE_SIDE},ih)':force_original_aspect_ratio=decrease`;
  const r = await exec(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', `${scale},format=yuvj420p`, '-q:v', '2', out],
    { timeoutMs: 90_000 },
  );
  if (tmp) await unlink(tmp).catch(() => {});
  if (r.code !== 0 || !(await Bun.file(out).exists())) {
    await unlink(out).catch(() => {});
    throw new MediaReadError("isn't a photo we can open.", `ffmpeg exit ${r.code}: ${lastLines(r.stderr, 3)}`);
  }
  if (exif.focal35) {
    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    await Bun.write(out, insertApp1(bytes, exifApp1(exif.focal35)));
  }
  await rename(out, dest);
  const size = await imageSize(dest);
  return {
    ...size,
    ...(exif.focal35 ? { focal35: exif.focal35 } : {}),
    ...(exif.make ? { make: exif.make } : {}),
    ...(exif.model ? { model: exif.model } : {}),
  };
}

export async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const r = await exec([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path], {
    timeoutMs: 15_000,
  });
  try {
    const s = JSON.parse(r.stdout).streams?.[0] ?? {};
    return { width: Number(s.width) || 0, height: Number(s.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 640 px wide thumbnail from an image. */
export async function thumbFromImage(src: string, dest: string, width = 640): Promise<void> {
  const out = `${dest}.part.jpg`;
  const r = await exec(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2,format=yuvj420p`, '-q:v', '4', out],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) throw new Error(`thumbnail failed: ${lastLines(r.stderr, 2)}`);
  await rename(out, dest);
}

/** Thumbnail from a video frame at time t (seconds). Rotation metadata is applied by ffmpeg; HDR is tone-mapped. */
export async function thumbFromVideo(src: string, dest: string, t: number, width = 640): Promise<void> {
  const out = `${dest}.part.jpg`;
  const hdr = await hdrFor(src);
  const plainVf = `scale='min(${width},iw)':-2,format=yuvj420p`;
  const hdrVf = hdr ? [`scale='min(${width},iw)':-2${hdr.scaleOptions}`, ...hdr.toSdr, RGB_TO_JPEG].join(',') : null;
  const args = (ss: number, vf: string) => [
    FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', ss.toFixed(3), '-i', src, '-frames:v', '1',
    '-vf', vf, '-q:v', '4', out,
  ];
  const run = (ss: number) => runWithHdrFallback(hdrVf, plainVf, out, (vf) => args(ss, vf), 60_000, src);
  let r = await run(t);
  if ((r.code !== 0 || !(await Bun.file(out).exists())) && t > 0) r = await run(0);
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`thumbnail failed: ${lastLines(r.stderr, 2)}`);
  await rename(out, dest);
}

/**
 * Runs ffmpeg with the tone-mapping filters when there are any; if that writes nothing, runs it again with the
 * plain filters (an ffmpeg without lut3d still gets a picture, just not tone-mapped).
 */
async function runWithHdrFallback(
  hdrVf: string | null,
  plainVf: string,
  out: string,
  argv: (vf: string) => string[],
  timeoutMs: number,
  src: string,
): Promise<ExecResult> {
  if (hdrVf) {
    const r = await exec(argv(hdrVf), { timeoutMs });
    if (r.code === 0 && (await Bun.file(out).exists())) return r;
    console.warn(`[media] HDR tone mapping failed for ${src}, using the plain frame: ${lastLines(r.stderr, 2)}`);
  }
  return exec(argv(plainVf), { timeoutMs });
}

/** A soft gradient placeholder for prompt-only scenes. */
export async function placeholderThumb(dest: string, seed: number): Promise<void> {
  const out = `${dest}.part.jpg`;
  const palettes = [
    ['0x2b5876', '0x4e4376', '0xf3a683'],
    ['0x1a2a6c', '0xb21f1f', '0xfdbb2d'],
    ['0x0f2027', '0x2c5364', '0x7fd1ae'],
    ['0x355c7d', '0x6c5b7b', '0xc06c84'],
    ['0x232526', '0x414345', '0xe0c3fc'],
  ];
  const [c0, c1, c2] = palettes[Math.abs(seed) % palettes.length]!;
  const r = await exec(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=640x400:c0=${c0}:c1=${c1}:c2=${c2}:n=3:type=linear:speed=0:x0=0:y0=400:x1=640:y1=0`, '-frames:v', '1', '-q:v', '4', out],
    { timeoutMs: 20_000 },
  );
  if (r.code !== 0) throw new Error(`placeholder failed: ${lastLines(r.stderr, 2)}`);
  await rename(out, dest);
}

/**
 * Rewrites a video's container without re-encoding. Streamed recordings (MediaRecorder WebM, many screen and game
 * recorders) have no duration in the header; a remux to a seekable file writes it, for us and for the pipelines.
 */
export async function remuxVideo(src: string, dest: string): Promise<void> {
  const r = await exec([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0', '-c', 'copy', dest], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0 || !(await Bun.file(dest).exists())) {
    await unlink(dest).catch(() => {});
    throw new MediaReadError(UNREADABLE_VIDEO, `remux failed (exit ${r.code}): ${lastLines(r.stderr, 3)}`);
  }
}

/** Containers without a seek index (broadcast/recorder streams): seeking into them lands mid-GOP and decodes nothing. */
export const UNINDEXED_VIDEO_EXT = new Set(['ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'flv']);

/**
 * Copies the video and audio streams of an unindexed container (game and camera recordings in .ts, .m2ts, .mpg ...)
 * into Matroska, which has a seek index, without re-encoding. Data streams are dropped. Throws MediaReadError.
 */
export async function remuxToIndexed(src: string, dest: string): Promise<void> {
  const r = await exec(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'matroska', dest],
    { timeoutMs: 5 * 60_000 },
  );
  if (r.code !== 0 || !(await Bun.file(dest).exists()) || Bun.file(dest).size === 0) {
    await unlink(dest).catch(() => {});
    throw new MediaReadError(UNREADABLE_VIDEO, `remux to Matroska failed (exit ${r.code}): ${lastLines(r.stderr, 3)}`);
  }
}

/** Full-resolution still at time t (seconds). HDR is tone-mapped to SDR. */
export async function extractFrame(src: string, t: number, dest: string): Promise<void> {
  const out = `${dest}.part.jpg`;
  const hdr = await hdrFor(src);
  const hdrVf = hdr ? [`scale=flags=accurate_rnd+full_chroma_int${hdr.scaleOptions}`, ...hdr.toSdr, RGB_TO_JPEG].join(',') : null;
  const r = await runWithHdrFallback(
    hdrVf,
    'format=yuvj420p',
    out,
    (vf) => [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '2', out],
    60_000,
    src,
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`frame extraction failed: ${lastLines(r.stderr, 2)}`);
  await rename(out, dest);
}

/** Variance of a 4-neighbour Laplacian on a grayscale frame. Higher is sharper. */
export function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = gray[i - 1]! + gray[i + 1]! + gray[i - w]! + gray[i + w]! - 4 * gray[i]!;
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return n ? s / n : 0;
}

/**
 * Picks the sharpest, steadiest moment of a video: samples small grayscale frames, scores each by
 * Laplacian variance and penalises frame-to-frame motion. Returns the timestamp in seconds.
 */
export async function pickBestFrameTime(src: string, duration: number, samples = 48): Promise<number> {
  const W = 320;
  const H = 180;
  const start = Math.min(0.3, duration * 0.05);
  const span = Math.max(0.1, duration - start - Math.min(0.3, duration * 0.05));
  const fps = Math.min(8, Math.max(0.2, samples / span));
  const argv = (vf: string) => [FFMPEG, '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', src, '-t', span.toFixed(3),
    '-vf', vf, '-f', 'rawvideo', 'pipe:1'];
  const hdr = await hdrFor(src);
  let r = hdr
    ? await execBytes(argv([`fps=${fps.toFixed(4)}`, `scale=${W}:${H}:flags=area${hdr.scaleOptions}`, ...hdr.toSdr, 'format=gray'].join(',')), 180_000)
    : null;
  if (r && (r.code !== 0 || r.data.length < W * H)) {
    console.warn(`[media] HDR tone mapping failed for ${src}, picking from plain frames: ${lastLines(r.stderr, 2)}`);
    r = null;
  }
  r ??= await execBytes(argv(`fps=${fps.toFixed(4)},scale=${W}:${H}:flags=area,format=gray`), 180_000);
  const frameBytes = W * H;
  const count = Math.floor(r.data.length / frameBytes);
  if (r.code !== 0 || count === 0) return Math.min(duration / 2, 1);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) frames.push(r.data.subarray(i * frameBytes, (i + 1) * frameBytes));
  const sharp = frames.map((f) => laplacianVariance(f, W, H));
  const maxSharp = Math.max(...sharp, 1e-6);
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    const prev = i > 0 ? meanAbsDiff(frames[i]!, frames[i - 1]!) : null;
    const next = i < count - 1 ? meanAbsDiff(frames[i]!, frames[i + 1]!) : null;
    const motion = prev === null ? (next ?? 0) : next === null ? prev : (prev + next) / 2;
    // Sharpness normalised to [0,1]; motion in grey levels per pixel (roughly 0..30).
    const score = sharp[i]! / maxSharp - motion / 12;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return Math.min(duration - 0.05, start + best / fps);
}
