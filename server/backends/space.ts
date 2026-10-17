// hf-space backend (rentfree only): FlashWorld on Hugging Face ZeroGPU.
//
// imlixinyang/FlashWorld-Demo-Spark is a static web page with no API; it calls the Gradio Space
// imlixinyang/FlashWorld-Demo (app_gradio.py), which is what this backend talks to:
//   /gradio_generate(json_input: str) -> str   JSON {success, file_id, file_size, generation_time} or {error}
//   /download_file(file_id: str)       -> File  the .spz
//   /gradio_delete(file_id: str)                removes the server copy
//
// Coordinate frame of the returned SPZ (from app_gradio.py and utils.py of that Space, and docs/FLASHWORLD.md):
// request cameras are camera-to-world poses in the OpenGL/three.js convention (looks down -Z, +Y up), quaternion
// [w, x, y, z]. normalize_cameras() re-expresses every pose relative to cameras[0] and divides translations by
// T_norm + 0.01; create_rays() builds rays with z = -1 and +y up (OpenGL); export_gaussians() multiplies positions by
// T_norm and writes them to SPZ without any axis conversion. So the file is in camera 0's own OpenGL frame: camera 0
// at the origin looking down -Z, +Y up, units of the request positions (metres here). Our camera 0 is the input
// photo with identity rotation, so the file already has viewer axes: quaternion [0, 0, 0, 1]. Without a floor fit
// the input camera is assumed to be 1.45 m above the floor, so the world is lifted by that much and the spawn sits
// on the floor under the input camera, facing the photo (yaw 0 = looking down -Z).

import { Client } from '@gradio/client';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, stat, constants as fsc } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { JobResult, Vec3 } from '../../shared/types.ts';
import { SPACE_ID } from '../config.ts';
import type { SpaceStatus } from '../health.ts';
import { exec, extractFrame, FFMPEG, imageSize, lastLines, laplacianVariance, execBytes, pickBestFrameTime, probeVideo, thumbFromImage } from '../media.ts';
import { ProductError, readProgress, sleep, throwIfAborted, type Availability, type BackendDriver, type RunContext } from './types.ts';

export const NEUTRAL_PROMPT = 'A realistic, detailed, static 3D scene with consistent lighting.';
/** Long-side field of view assumed when a photo has no 35 mm focal length (phone main camera). */
export const DEFAULT_LONG_FOV_DEG = 65;
export const CAMERA_HEIGHT_M = 1.45;
const N_VIEWS = 24;

/** [w, x, y, z] */
export type WxyzQuat = [number, number, number, number];

export interface FlashWorldCamera {
  position: Vec3;
  quaternion: WxyzQuat;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

export interface FlashWorldRequest {
  image_prompt: string;
  text_prompt: string;
  image_index: number;
  resolution: [number, number, number];
  cameras: FlashWorldCamera[];
}

/** Yaw about +Y (positive turns left), then pitch about the camera's X (negative looks down); three.js 'YXZ'. */
export function yawPitchQuat(yaw: number, pitch: number): WxyzQuat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return [cy * cp, cy * sp, sy * cp, -sy * sp];
}

const DEG = Math.PI / 180;

/**
 * The spin360 preset of docs/FLASHWORLD.md: views 0-15 turn left through a full circle on a 0.3 m ring whose centre
 * is 0.3 m behind the input camera, pitching down to -10 degrees behind you; views 16-23 walk 1.6 m forward while
 * panning from -20 to +20 degrees at -8 degrees pitch. View 0 is the input photo at the origin.
 */
export function spin360(K: { fx: number; fy: number; cx: number; cy: number }): FlashWorldCamera[] {
  const cams: FlashWorldCamera[] = [];
  const ring = 0.3;
  for (let i = 0; i < 16; i++) {
    const yaw = i * 22.5 * DEG;
    const pitch = -10 * DEG * (1 - Math.cos(yaw)) / 2;
    const fwd: Vec3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    cams.push({ position: [ring * fwd[0], 0, ring + ring * fwd[2]], quaternion: yawPitchQuat(yaw, pitch), ...K });
  }
  for (let k = 0; k < 8; k++) {
    const yaw = (-20 + (40 * k) / 7) * DEG;
    cams.push({ position: [0, 0, (-1.6 * (k + 1)) / 8], quaternion: yawPitchQuat(yaw, -8 * DEG), ...K });
  }
  cams[0]!.position = [0, 0, 0];
  cams[0]!.quaternion = [1, 0, 0, 0];
  return cams;
}

/** Intrinsics in target pixels for a source image center-cropped and resized to W x H ("cover"). */
export function intrinsicsFor(W: number, H: number, srcW: number, srcH: number, focal35?: number) {
  const longFov = focal35 ? 2 * Math.atan(18 / focal35) : DEFAULT_LONG_FOV_DEG * DEG;
  const fSrc = Math.max(srcW, srcH) / 2 / Math.tan(longFov / 2);
  const s = Math.max(W / srcW, H / srcH);
  const f = fSrc * s;
  return { fx: f, fy: f, cx: W / 2, cy: H / 2 };
}

export function targetResolution(width: number, height: number): [number, number, number] {
  return height > width ? [N_VIEWS, 704, 480] : [N_VIEWS, 480, 704];
}

async function grayThumb(path: string): Promise<Uint8Array | null> {
  const r = await execBytes([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', path, '-frames:v', '1', '-vf', 'scale=320:240,format=gray', '-f', 'rawvideo', 'pipe:1'], 30_000);
  return r.code === 0 && r.data.length === 320 * 240 ? r.data : null;
}

/** The sharpest of several photos (variance of the Laplacian). */
export async function sharpestImage(paths: string[]): Promise<string> {
  if (paths.length <= 1) return paths[0]!;
  let best = paths[0]!;
  let bestScore = -1;
  for (const p of paths) {
    const g = await grayThumb(p);
    const score = g ? laplacianVariance(g, 320, 240) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Center-crops and resizes the photo to W x H and returns it as a JPEG data URL. */
export async function encodeTarget(src: string, W: number, H: number, dest: string): Promise<string> {
  const r = await exec(
    [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1',
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},format=yuvj420p`, '-q:v', '2', dest],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) throw new Error(`could not prepare the photo: ${lastLines(r.stderr, 2)}`);
  const b64 = Buffer.from(await Bun.file(dest).arrayBuffer()).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

export interface SpzHeader {
  version: number;
  numPoints: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
}

/** Reads the 16-byte header at the start of the gzip stream of an SPZ file. */
export async function readSpzHeader(path: string): Promise<SpzHeader> {
  const head = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const src = createReadStream(path);
    const gz = createGunzip();
    const done = (err?: Error) => {
      src.destroy();
      gz.destroy();
      if (err && n < 16) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    gz.on('data', (c: Buffer) => {
      chunks.push(c);
      n += c.length;
      if (n >= 16) done();
    });
    gz.on('error', (e) => done(e));
    gz.on('end', () => done(n < 16 ? new Error('SPZ file is truncated') : undefined));
    src.on('error', (e) => done(e));
    src.pipe(gz);
  });
  if (head.length < 16 || head.readUInt32LE(0) !== 0x5053474e) throw new Error('not an SPZ file');
  return {
    version: head.readUInt32LE(4),
    numPoints: head.readUInt32LE(8),
    shDegree: head[12]!,
    fractionalBits: head[13]!,
    flags: head[14]!,
  };
}

/**
 * Turns a Space error into one actionable sentence for the log (`reason`) and, when there is something useful to
 * say, a product sentence for the UI (`user`) that names no service.
 */
export function explainSpaceError(message: string, hasToken: boolean): { reason: string; kind: 'quota' | 'crash' | 'other'; user?: string } {
  const m = message
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(JSON processing error|Processing error|Error):\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .slice(0, 400);
  if (/quota|exceeded your|GPU duration|requested vs\.? \d+s left|PRO subscription/i.test(m)) {
    const detail = /\(([^()]*requested[^()]*)\)/.exec(m)?.[1] ?? m.split(/(?<=\.)\s/)[0];
    return {
      kind: 'quota',
      user: 'The free cloud GPU is used up for now. Try again later.',
      reason: hasToken
        ? `the ZeroGPU quota of this Hugging Face account is used up (${detail}); wait for it to refill or log in to HiPerGator`
        : `the anonymous ZeroGPU quota is used up (${detail}); put a Hugging Face read token in .env as HF_TOKEN or log in to HiPerGator`,
    };
  }
  if (/CUDA|NVML|CUDACachingAllocator|out of memory|GPU task aborted|ZeroGPU worker error|No CUDA GPUs/i.test(m)) {
    return {
      kind: 'crash',
      user: 'The cloud GPU had a problem on its side. Try again in a minute.',
      reason: `the public Space crashed on its GPU, a problem on its side (${m.slice(0, 160)}); try again later or use HiPerGator`,
    };
  }
  if (/401|403|Unauthorized|invalid token|Invalid user token/i.test(m)) {
    return { kind: 'other', reason: `Hugging Face rejected the token (${m}); check HF_TOKEN in .env` };
  }
  return { kind: 'other', reason: m || 'unknown error from the Space' };
}

export async function spaceStatus(spaceId = SPACE_ID): Promise<SpaceStatus> {
  const res = await fetch(`https://huggingface.co/api/spaces/${spaceId}`, {
    signal: AbortSignal.timeout(6000),
    headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {},
  });
  if (!res.ok) return { available: false, reason: `Space lookup failed (HTTP ${res.status})` };
  const info: any = await res.json();
  const stage = String(info?.runtime?.stage ?? 'UNKNOWN');
  const ok = ['RUNNING', 'SLEEPING', 'RUNNING_BUILDING', 'APP_STARTING', 'RUNNING_APP_STARTING'].includes(stage);
  if (ok) return { available: true, stage };
  const err = info?.runtime?.errorMessage ? `: ${String(info.runtime.errorMessage).slice(0, 160)}` : '';
  return { available: false, stage, reason: `the Space ${spaceId} is ${stage.toLowerCase().replace(/_/g, ' ')}${err}` };
}

export interface SpaceDriverOptions {
  status: () => Promise<SpaceStatus>;
  spaceId?: string;
  token?: string;
  /** Python + pipeline/flashworld_run.py for building the request and post-processing (pruning, levelling). */
  pipeline?: { python: string; script: string; cwd: string };
  /** Overall limit for one generation (queue + GPU). */
  timeoutMs?: number;
  /** Called when the Space turns out to be unusable for a while (quota spent). */
  onBlocked?: () => void;
}

interface GenerateResult {
  file_id: string;
  file_size?: number;
  generation_time?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

export interface SpaceDriver extends BackendDriver {
  /** Why the Space is known to be unusable right now (quota spent), or null. */
  blockedReason(): string | null;
}

export function spaceDriver(opts: SpaceDriverOptions): SpaceDriver {
  const spaceId = opts.spaceId ?? SPACE_ID;
  const token = opts.token ?? process.env.HF_TOKEN;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let quotaUntil = 0;
  let quotaReason = '';

  async function pipelineReady(): Promise<boolean> {
    if (!opts.pipeline) return false;
    try {
      await access(opts.pipeline.python, fsc.X_OK);
      await access(opts.pipeline.script, fsc.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async function runPython(ctx: RunContext, args: string[], what: string): Promise<boolean> {
    const p = opts.pipeline!;
    const r = await exec([p.python, '-u', p.script, ...args], {
      cwd: p.cwd,
      timeoutMs: 10 * 60_000,
      env: { ...process.env, PYTHONUNBUFFERED: '1', THIRDWHEEL_BACKEND: 'hf-space' },
    });
    if (r.stdout.trim() || r.stderr.trim()) ctx.logRaw(lastLines(`${r.stdout}\n${r.stderr}`, 40));
    if (r.code !== 0) ctx.log(`${what} failed (exit ${r.code}); using the built-in fallback`);
    return r.code === 0;
  }

  /** The photo FlashWorld sees: the sharpest photo, or the sharpest steady frame of a video. */
  async function pickSource(ctx: RunContext, work: string): Promise<{ path: string; focal35?: number } | null> {
    const files = ctx.scene.input?.files ?? [];
    const meta: Record<string, any> = await Bun.file(join(ctx.jobDir, 'input', 'meta.json')).json().catch(() => ({}));
    const images = files.filter((f) => /\.jpe?g$/i.test(f)).map((f) => join(ctx.jobDir, f));
    if (images.length) {
      ctx.report({ stage: images.length > 1 ? 'Picking the sharpest photo' : 'Preparing the photo' });
      const path = await sharpestImage(images);
      const name = path.split('/').pop()!;
      return { path, focal35: Number(meta[name]?.focal35) || undefined };
    }
    const video = files.find((f) => f.startsWith('input/video.'));
    if (video) {
      ctx.report({ stage: 'Picking the sharpest frame of the video' });
      const src = join(ctx.jobDir, video);
      const info = await probeVideo(src);
      const t = await pickBestFrameTime(src, info.duration);
      const dest = join(work, 'frame.jpg');
      await extractFrame(src, t, dest);
      ctx.log(`using the video frame at ${t.toFixed(2)} s`);
      return { path: dest };
    }
    return null;
  }

  async function buildRequest(ctx: RunContext, work: string, prompt: string, source: { path: string; focal35?: number } | null): Promise<FlashWorldRequest> {
    const requestPath = join(work, 'request.json');
    if (await pipelineReady()) {
      const args = source ? ['--image', source.path] : [];
      if (prompt) args.push('--prompt', prompt);
      if (await runPython(ctx, [...args, '--emit-request', requestPath], 'flashworld_run.py --emit-request')) {
        try {
          const req = (await Bun.file(requestPath).json()) as FlashWorldRequest;
          if (Array.isArray(req.cameras) && req.cameras.length >= 2 && Array.isArray(req.resolution)) {
            if (req.image_prompt && !req.image_prompt.startsWith('data:') && (await Bun.file(req.image_prompt).exists())) {
              const mime = /\.png$/i.test(req.image_prompt) ? 'image/png' : 'image/jpeg';
              req.image_prompt = `data:${mime};base64,${Buffer.from(await Bun.file(req.image_prompt).arrayBuffer()).toString('base64')}`;
            }
            if (!req.text_prompt && prompt) req.text_prompt = prompt;
            return req;
          }
        } catch {
          /* fall through */
        }
      }
    }
    let image = '';
    let K = intrinsicsFor(704, 480, 704, 480);
    let resolution: [number, number, number] = [N_VIEWS, 480, 704];
    if (source) {
      const { width, height } = await imageSize(source.path);
      if (!width || !height) throw new Error('could not read the input photo');
      resolution = targetResolution(width, height);
      const [, H, W] = resolution;
      image = await encodeTarget(source.path, W, H, join(work, 'input.jpg'));
      K = intrinsicsFor(W, H, width, height, source.focal35);
    }
    const req: FlashWorldRequest = { image_prompt: image, text_prompt: prompt, image_index: 0, resolution, cameras: spin360(K) };
    await Bun.write(requestPath, JSON.stringify(req));
    return req;
  }

  async function generate(ctx: RunContext, req: FlashWorldRequest): Promise<{ client: Client; result: GenerateResult }> {
    ctx.report({ status: 'uploading', stage: 'Connecting to the cloud GPU', progress: 0.05 });
    const client = await withTimeout(
      Client.connect(spaceId, { ...(token ? { token: token as `hf_${string}` } : {}), events: ['data', 'status'] }),
      120_000,
      'connecting to the Space',
    );
    throwIfAborted(ctx.signal);
    ctx.report({ status: 'uploading', stage: 'Sending the request to the cloud GPU', progress: 0.08 });
    const job = client.submit('/gradio_generate', { json_input: JSON.stringify(req) });
    const onAbort = () => void job.cancel().catch(() => {});
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const t0 = Date.now();
    let gpuStart = 0;
    let ticker: ReturnType<typeof setInterval> | null = null;
    try {
      const run = (async () => {
        for await (const m of job) {
          if (m.type === 'status') {
            if (m.stage === 'error') throw new Error(typeof m.message === 'string' ? m.message : 'the Space reported an error');
            if (m.stage === 'pending' && m.queue && typeof m.position === 'number' && m.position > 0) {
              ctx.report({ status: 'queued', stage: `Waiting for the cloud GPU (${m.position} ahead)` });
            } else if (m.stage === 'pending' || m.stage === 'generating') {
              if (!gpuStart) {
                gpuStart = Date.now();
                ctx.report({ status: 'running', stage: 'Generating the world on the cloud GPU', progress: 0.1 });
                ticker = setInterval(() => {
                  const p = 0.1 + 0.75 * (1 - Math.exp(-(Date.now() - gpuStart) / 40_000));
                  ctx.report({ progress: p });
                }, 1000);
              }
            }
          } else if (m.type === 'data') {
            return m.data as unknown[];
          }
        }
        throw new Error('the Space closed the connection without a result');
      })();
      const data = await withTimeout(run, timeoutMs, 'the Space');
      const raw = data?.[0];
      let parsed: any;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        throw new Error(`unexpected reply: ${String(raw).slice(0, 200)}`);
      }
      if (!parsed?.success || !parsed.file_id) throw new Error(String(parsed?.error ?? 'no file in the reply'));
      ctx.log(`Space generated ${parsed.file_id} in ${Number(parsed.generation_time ?? 0).toFixed(1)} s on the GPU (${((Date.now() - t0) / 1000).toFixed(0)} s total)`);
      return { client, result: parsed as GenerateResult };
    } finally {
      if (ticker) clearInterval(ticker);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  async function download(ctx: RunContext, client: Client, fileId: string, dest: string): Promise<void> {
    ctx.report({ status: 'downloading', stage: 'Downloading the world', progress: 0.88 });
    const r = await withTimeout(client.predict('/download_file', { file_id: fileId }), 120_000, 'asking for the download');
    const f: any = (r.data as unknown[])?.[0];
    const url: string | undefined = f?.url ?? (typeof f === 'string' ? f : undefined);
    if (!url) throw new Error('the Space returned no download link');
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctx.signal });
    if (!res.ok) throw new Error(`downloading the world failed (HTTP ${res.status})`);
    await Bun.write(dest, res);
    const size = (await stat(dest)).size;
    if (size < 1024) throw new Error(`the downloaded world is only ${size} bytes`);
    void client.predict('/gradio_delete', { file_id: fileId }).catch(() => {});
  }

  /** Without the Python post-processor: keep the raw SPZ and use the documented default placement. */
  async function fallbackResult(ctx: RunContext, rawSpz: string, source: { path: string } | null, prompt: string): Promise<void> {
    const header = await readSpzHeader(rawSpz);
    await copyFile(rawSpz, join(ctx.outDir, 'world.spz'));
    let thumb: string | undefined;
    const thumbSrc = source?.path ?? (ctx.scene.thumb ? join(ctx.sceneDir, ctx.scene.thumb) : null);
    if (thumbSrc && (await Bun.file(thumbSrc).exists())) {
      await thumbFromImage(thumbSrc, join(ctx.outDir, 'thumb.jpg')).then(() => (thumb = 'thumb.jpg')).catch(() => {});
    }
    const result: JobResult = {
      world: {
        file: 'world.spz',
        transform: { position: [0, CAMERA_HEIGHT_M, 0], quaternion: [0, 0, 0, 1], scale: 1 },
        floorY: null,
        spawn: { position: [0, 0, 0], yaw: 0 },
        source: 'flashworld',
        splatCount: header.numPoints,
      },
      ...(thumb ? { thumb } : {}),
      caption: source ? 'Generated from one photo: the rest of the room was imagined.' : 'Generated from your prompt.',
    };
    await Bun.write(join(ctx.outDir, 'scene.json'), JSON.stringify(result, null, 2));
  }

  async function run(ctx: RunContext): Promise<void> {
    const work = join(ctx.jobDir, 'space');
    await mkdir(work, { recursive: true });
    await mkdir(ctx.outDir, { recursive: true });
    ctx.report({ status: 'running', stage: 'Getting ready', progress: 0.01 });

    const source = await pickSource(ctx, work);
    const userPrompt = ctx.job.prompt?.trim() ?? '';
    if (!source && !userPrompt) throw new ProductError('Photo mode needs a photo, a video or a prompt.', 'nothing to generate from: no photo, video frame or prompt');
    const prompt = userPrompt || NEUTRAL_PROMPT;
    const req = await buildRequest(ctx, work, prompt, source);
    throwIfAborted(ctx.signal);

    let gen: { client: Client; result: GenerateResult } | null = null;
    for (let attempt = 1; attempt <= 2 && !gen; attempt++) {
      try {
        gen = await generate(ctx, req);
      } catch (e) {
        throwIfAborted(ctx.signal);
        const msg = (e as Error)?.message ?? String(e);
        const ex = explainSpaceError(msg, !!token);
        ctx.log(`Space attempt ${attempt}: ${msg}`);
        if (ex.kind === 'quota') {
          quotaUntil = Date.now() + 10 * 60_000;
          quotaReason = ex.reason;
          opts.onBlocked?.();
        }
        if (ex.kind !== 'crash' || attempt === 2) throw ex.user ? new ProductError(ex.user, ex.reason) : new Error(ex.reason);
        ctx.report({ status: 'queued', stage: 'The cloud GPU hiccupped; trying once more', progress: 0.05 });
        await sleep(5000, ctx.signal);
      }
    }
    const rawSpz = join(work, 'flashworld.spz');
    await download(ctx, gen!.client, gen!.result.file_id, rawSpz);
    throwIfAborted(ctx.signal);

    ctx.report({ status: 'downloading', stage: 'Placing the world', progress: 0.94 });
    if (await pipelineReady()) {
      const progressPath = join(work, 'post-progress.json');
      const ok = await runPython(
        ctx,
        ['--from-spz', rawSpz, '--request', join(work, 'request.json'), '--out', ctx.outDir, '--progress', progressPath],
        'flashworld_run.py --from-spz',
      );
      const prog = await readProgress(progressPath);
      if (ok && (await Bun.file(join(ctx.outDir, 'scene.json')).exists())) {
        if (prog?.stage) ctx.log(`post-process: ${prog.stage}`);
        return;
      }
    }
    await fallbackResult(ctx, rawSpz, source, prompt);
  }

  return {
    name: 'hf-space',
    label: 'FlashWorld Space',
    place: 'the cloud GPU',
    lane: 'hf-space',
    canResume: false,
    supports: (m) => m === 'rentfree',
    blockedReason: () => (Date.now() < quotaUntil ? quotaReason : null),
    available: async (): Promise<Availability> => {
      if (Date.now() < quotaUntil) return { ok: false, reason: quotaReason };
      const s = await opts.status();
      return s.available ? { ok: true } : { ok: false, reason: s.reason ?? 'unavailable' };
    },
    run,
  };
}
