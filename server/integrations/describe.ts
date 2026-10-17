// The world caption for a new upload: POST GUIDE_URL/describe {image} -> {caption} (team/contracts.md section 8).
//
// The upload flow calls describeForJob(<scene dir>/thumb.jpg or the input photo) right after an upload is accepted
// and before the GPU job starts. The image is shrunk to at most 1024 px on its long side first (a phone photo is
// 3 to 5 MB; the guide only needs about 150 KB), and the whole thing, resize included, has one time budget
// (the contract's 5 s by default). Any failure returns null and the job uses its built-in captioner, so a slow or
// missing guide never blocks a world.
//
// A Video memory goes through describeClipForJob(<the clip>, scene) instead: up to 8 frames evenly spaced over the
// clip (JPEG, at most 768 px on the long side, in clip order) go out as `frames`, with `scene` {id, name} and one still
// as `image` (the thumbnail, so a guide that only reads `image` answers as before). The guide then says what happens
// ("who is playing, who wins"), and that caption is stored like a photo's, so /ask gets it back as scene.caption.
// Same rules, with a larger budget (GUIDE_DESCRIBE_CLIP_TIMEOUT_MS, 12 s): frames are grabbed in memory, and any
// failure returns null.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Scene } from '../../shared/types.ts';
import { hdrChain, hdrSourceFromStream, RGB_TO_JPEG, type HdrSource } from '../hdr.ts';
import { DESCRIBE_CLIP_TIMEOUT_MS, integrationsConfigFromEnv, prefixedLogger, type Logger } from './config.ts';
import { defaultGuideClient, type GuideCallResult, type GuideClient } from './guide.ts';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const SIPS = process.env.SIPS_BIN || '/usr/bin/sips';

export interface DescribeOptions {
  /** Defaults to the process-wide client configured from GUIDE_URL / GUIDE_KEY. */
  client?: GuideClient;
  /** Total budget, resize included. Default: GUIDE_DESCRIBE_TIMEOUT_MS or the contract's 5000 ms. */
  timeoutMs?: number;
  /** Long side of the image sent to the guide. */
  maxSide?: number;
  log?: Logger;
}

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function run(argv: string[], timeoutMs: number): Promise<{ code: number; out: Uint8Array }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), Math.max(50, timeoutMs));
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    return { code, out: new Uint8Array(out) };
  } finally {
    clearTimeout(timer);
  }
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 100 && b[0] === 0xff && b[1] === 0xd8;
}

/**
 * The image as a JPEG data URL no larger than `maxSide` on its long side, or null. Tries ffmpeg (in memory), then
 * sips (macOS), then the original bytes when they are already a small JPEG, PNG or WebP.
 */
export async function imageDataUrlForGuide(path: string, opts: { maxSide?: number; timeoutMs?: number } = {}): Promise<string | null> {
  const maxSide = opts.maxSide ?? 1024;
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  const left = () => deadline - Date.now();
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  try {
    const vf = `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p`;
    const r = await run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', path, '-frames:v', '1', '-vf', vf, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], left());
    if (r.code === 0 && isJpeg(r.out)) return `data:image/jpeg;base64,${Buffer.from(r.out).toString('base64')}`;
  } catch {
    /* ffmpeg missing: try sips */
  }

  if (left() > 100) {
    const tmp = join(tmpdir(), `dv-describe-${randomBytes(6).toString('hex')}.jpg`);
    try {
      const r = await run([SIPS, '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(maxSide), path, '--out', tmp], left());
      const out = Bun.file(tmp);
      if (r.code === 0 && (await out.exists())) {
        const b = new Uint8Array(await out.arrayBuffer());
        if (isJpeg(b)) return `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
      }
    } catch {
      /* no sips either */
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  const mime = MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''];
  if (mime && file.size <= 4 * 1024 * 1024) return `data:${mime};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
  return null;
}

/** The guide's caption as a world prompt: one line, at most 600 characters, or null when there is nothing usable. */
export function cleanCaption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (s.length < 8) return null;
  if (s.length <= 600) return s;
  const cut = s.slice(0, 600);
  const end = cut.lastIndexOf('. ');
  return end > 200 ? cut.slice(0, end + 1) : cut;
}

/**
 * Asks the guide to describe a photo for the world generator. Returns the caption, or null on any failure
 * (guide off, slow, degraded, unreadable image). Never throws.
 */
export async function describeForJob(imagePath: string, opts: DescribeOptions = {}): Promise<string | null> {
  const log = opts.log ?? prefixedLogger('guide');
  const budget = opts.timeoutMs ?? integrationsConfigFromEnv().guide.timeouts.describe;
  const t0 = Date.now();
  try {
    const client = opts.client ?? defaultGuideClient();
    if (!client.enabled) return null;
    const image = await imageDataUrlForGuide(imagePath, { maxSide: opts.maxSide, timeoutMs: Math.min(2000, Math.max(200, budget - 500)) });
    if (!image) {
      log.warn(`describe: could not read ${imagePath.split('/').slice(-3).join('/')}`);
      return null;
    }
    const remaining = budget - (Date.now() - t0);
    if (remaining < 300) return null;
    const r = await client.call('describe', { image }, { timeoutMs: remaining });
    return captionFrom(r, t0, log, 'caption');
  } catch (e) {
    log.warn(`describe failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

function captionFrom(r: GuideCallResult, t0: number, log: Logger, what: string): string | null {
  if (r.kind !== 'ok') {
    if (!r.failFast) log.warn(`describe: no caption (${r.kind === 'http' ? `HTTP ${r.status}` : r.kind}) after ${Date.now() - t0} ms; the job uses its own captioner`);
    return null;
  }
  // A degraded answer is the guide's canned line (or, for a clip, its notes), never a description of this upload:
  // the contract treats it as an error, so the job keeps its own captioner and the backfill can try again later.
  if (r.body?.degraded === true) {
    log.warn(`describe: the guide answered degraded (${String(r.body?.error ?? 'no reason').slice(0, 80)}) after ${Date.now() - t0} ms; the job uses its own captioner`);
    return null;
  }
  const caption = cleanCaption(r.body?.caption);
  if (caption) log.info(`describe: ${what} in ${Date.now() - t0} ms: ${JSON.stringify(caption.slice(0, 90))}${caption.length > 90 ? '…' : ''}`);
  return caption;
}

// ---------------------------------------------------------------------------------------------------------------
// Video memories: frames from the clip

/** The contract's cap on `frames`. */
export const MAX_CLIP_FRAMES = 8;
/** Long side of every frame (and of the still) sent with a clip. */
export const CLIP_FRAME_SIDE = 768;
/** ffmpeg processes grabbing frames at once (one seek and one decode each). */
const GRAB_CONCURRENCY = 3;

const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts|ts|mpg|mpeg|flv|wmv)$/i;

export interface ClipFramesOptions {
  /** How many frames, at most MAX_CLIP_FRAMES. */
  count?: number;
  /** Long side, at most CLIP_FRAME_SIDE. */
  maxSide?: number;
  timeoutMs?: number;
  /** The file is a packed tw-pack-v1 layer (RGB above depth and mask): frames come from its RGB rows only. */
  packed?: boolean;
}

export interface ClipDescribeOptions extends DescribeOptions {
  /** Frames sent, evenly spaced over the clip. Default and cap: MAX_CLIP_FRAMES. */
  maxFrames?: number;
  /** A still sent as `image` next to the frames (for an upload, its thumbnail). Default: the first frame. */
  imagePath?: string;
  packed?: boolean;
}

/** The clip a Video scene came from: the uploaded video, else its packed video layer. null when neither is on disk. */
export function clipForScene(scene: Pick<Scene, 'input' | 'video'>, sceneDir: string): { path: string; packed: boolean } | null {
  const base = resolve(sceneDir);
  const inside = (rel: string) => {
    const p = resolve(base, rel);
    return p.startsWith(base + sep) && existsSync(p) ? p : null;
  };
  const rel = scene.input?.files?.find((f) => f.startsWith('input/') && VIDEO_FILE.test(f));
  const upload = rel ? inside(rel) : null;
  if (upload) return { path: upload, packed: false };
  const layer = scene.video?.file ? inside(scene.video.file) : null;
  return layer ? { path: layer, packed: scene.video!.layout === 'tw-pack-v1' } : null;
}

/** Length and colour of the clip's video stream, or null when ffprobe cannot read one. */
async function probeClip(path: string, timeoutMs: number): Promise<{ duration: number; hdr: HdrSource | null } | null> {
  const r = await run(
    [FFPROBE, '-v', 'error', '-print_format', 'json', '-show_entries',
      'format=duration:stream=codec_type,duration,color_transfer,color_primaries,color_space,color_range:stream_disposition=attached_pic', path],
    timeoutMs,
  ).catch(() => null);
  if (!r || r.code !== 0) return null;
  let info: any;
  try {
    info = JSON.parse(new TextDecoder().decode(r.out));
  } catch {
    return null;
  }
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const duration = Number(v?.duration) || Number(info.format?.duration) || 0;
  if (!v || !(duration > 0)) return null;
  return { duration, hdr: hdrSourceFromStream(v) };
}

/**
 * Up to `count` frames evenly spaced over a clip (the middle of each equal slice), as JPEG data URLs no larger than
 * `maxSide` on the long side, in clip order. HDR clips are tone-mapped like their thumbnails. Frames that cannot be
 * read are left out; [] when the clip cannot be read at all or the time runs out first. Frames stay in memory.
 */
export async function clipFramesForGuide(path: string, opts: ClipFramesOptions = {}): Promise<string[]> {
  const count = Math.max(1, Math.min(MAX_CLIP_FRAMES, Math.floor(opts.count ?? MAX_CLIP_FRAMES)));
  const maxSide = Math.max(16, Math.min(CLIP_FRAME_SIDE, Math.floor(opts.maxSide ?? CLIP_FRAME_SIDE)));
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const left = () => deadline - Date.now();
  if (!(await Bun.file(path).exists())) return [];

  const clip = await probeClip(path, Math.min(2000, left()));
  if (!clip) return [];
  const crop = opts.packed ? 'crop=iw:trunc(ih*2/3/2)*2:0:0,' : '';
  const fit = `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const plainVf = `${crop}${fit},format=yuvj420p`;
  let hdrVf: string | null = null;
  if (clip.hdr) {
    try {
      const chain = await hdrChain(clip.hdr);
      hdrVf = [`${crop}${fit}${chain.scaleOptions}`, ...chain.toSdr, RGB_TO_JPEG].join(',');
    } catch {
      /* no LUT: plain frames */
    }
  }

  const grab = async (t: number, vf: string): Promise<Uint8Array | null> => {
    if (left() < 100) return null;
    const r = await run(
      [FFMPEG, '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', vf, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      left(),
    ).catch(() => null);
    return r && r.code === 0 && isJpeg(r.out) ? r.out : null;
  };

  const times = Array.from({ length: count }, (_, i) => (clip.duration * (i + 0.5)) / count);
  const frames: (Uint8Array | null)[] = times.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < times.length && left() > 100) {
      const i = next++;
      let b = hdrVf ? await grab(times[i]!, hdrVf) : null;
      if (!b && hdrVf) hdrVf = null; // this ffmpeg cannot tone-map: plain frames from here on
      b ??= await grab(times[i]!, plainVf);
      frames[i] = b;
    }
  };
  await Promise.all(Array.from({ length: Math.min(GRAB_CONCURRENCY, count) }, worker));
  return frames.filter((b): b is Uint8Array => !!b).map((b) => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`);
}

/**
 * Asks the guide what happens in a Video memory: frames from the clip, the scene's id and name, and one still.
 * Returns the caption, or null on any failure (guide off, slow, degraded, unreadable clip). Never throws.
 */
export async function describeClipForJob(videoPath: string, scene: { id: string; name?: string }, opts: ClipDescribeOptions = {}): Promise<string | null> {
  const log = opts.log ?? prefixedLogger('guide');
  const budget = opts.timeoutMs ?? integrationsConfigFromEnv().guide.timeouts.describeClip ?? DESCRIBE_CLIP_TIMEOUT_MS;
  const t0 = Date.now();
  try {
    const client = opts.client ?? defaultGuideClient();
    if (!client.enabled) return null;
    const maxSide = Math.min(CLIP_FRAME_SIDE, opts.maxSide ?? CLIP_FRAME_SIDE);
    // at most 40% of the budget (and 5 s) for the frames: the guide's model needs the rest for 8 pictures
    const grabMs = Math.min(5000, Math.max(300, Math.round(budget * 0.4)));
    const [frames, still] = await Promise.all([
      clipFramesForGuide(videoPath, { count: opts.maxFrames, maxSide, timeoutMs: grabMs, packed: opts.packed }),
      opts.imagePath ? imageDataUrlForGuide(opts.imagePath, { maxSide, timeoutMs: grabMs }) : Promise.resolve(null),
    ]);
    if (!frames.length) {
      log.warn(`describe: could not read frames from ${videoPath.split('/').slice(-3).join('/')}`);
      return null;
    }
    const remaining = budget - (Date.now() - t0);
    if (remaining < 500) return null;
    const name = typeof scene.name === 'string' ? scene.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const body = { image: still ?? frames[0]!, frames, scene: name ? { id: scene.id, name } : { id: scene.id } };
    const r = await client.call('describe', body, { timeoutMs: remaining });
    return captionFrom(r, t0, log, `clip caption (${frames.length} frames)`);
  } catch (e) {
    log.warn(`describe (clip) failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}
