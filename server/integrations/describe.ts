// The world caption for a new upload: POST GUIDE_URL/describe {image} -> {caption} (team/contracts.md section 8).
//
// The upload flow calls describeForJob(<scene dir>/thumb.jpg or the input photo) right after an upload is accepted
// and before the GPU job starts. The image is shrunk to at most 1024 px on its long side first (a phone photo is
// 3 to 5 MB; the guide only needs about 150 KB), and the whole thing, resize included, has one time budget
// (the contract's 5 s by default). Any failure returns null and the job uses its built-in captioner, so a slow or
// missing guide never blocks a world.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { integrationsConfigFromEnv, prefixedLogger, type Logger } from './config.ts';
import { defaultGuideClient, type GuideClient } from './guide.ts';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
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
    if (r.kind !== 'ok') {
      if (!r.failFast) log.warn(`describe: no caption (${r.kind === 'http' ? `HTTP ${r.status}` : r.kind}) after ${Date.now() - t0} ms; the job uses its own captioner`);
      return null;
    }
    const caption = cleanCaption(r.body?.caption);
    if (caption) log.info(`describe: caption in ${Date.now() - t0} ms: ${JSON.stringify(caption.slice(0, 90))}${caption.length > 90 ? '…' : ''}`);
    return caption;
  } catch (e) {
    log.warn(`describe failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}
