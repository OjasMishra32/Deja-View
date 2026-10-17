// Turns a multipart upload into a new scene directory: normalized inputs, a thumbnail and scene.json.

import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene, SceneMode } from '../shared/types.ts';
import type { SceneStore } from './store.ts';
import { normalizeMode, UPLOAD_MODES, type UploadMode } from './copy.ts';
import {
  extOf,
  isImageKind,
  MediaReadError,
  normalizeImage,
  placeholderThumb,
  probeVideo,
  remuxToIndexed,
  remuxVideo,
  sniffKind,
  thumbFromImage,
  thumbFromVideo,
  type MediaKind,
  type ProbeInfo,
  UNINDEXED_VIDEO_EXT,
} from './media.ts';

export { UPLOAD_MODES, type UploadMode };

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface UploadRequest {
  mode: string;
  name?: string;
  prompt?: string;
  files: File[];
}

const MIN_RECONSTRUCT_PHOTOS = 8;
const MAX_PHOTOS = 400;
const MAX_PROMPT = 2000;
/** Below this the world model has too little to work with (a 1x1 image even crashes the depth step). */
export const MIN_PHOTO_SIDE = 320;
export const MIN_VIDEO_SIDE = 160;

interface Classified {
  file: File;
  kind: MediaKind;
}

const MODE_LABEL: Record<UploadMode, string> = {
  rentfree: 'Photo',
  thirdwheel: 'Video',
  reconstruct: 'Reconstruction',
};

function defaultName(mode: UploadMode, prompt: string | undefined): string {
  if (prompt) {
    const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
    return words.length > 48 ? words.slice(0, 47) + '…' : words;
  }
  const when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${MODE_LABEL[mode]} · ${when}`;
}

/** Reads the form fields of a multipart request into an UploadRequest. */
export function readUploadForm(form: FormData): UploadRequest {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const files: File[] = [];
  for (const key of ['files', 'file', 'files[]']) {
    for (const v of form.getAll(key)) if (typeof v !== 'string' && v.size > 0) files.push(v as File);
  }
  return { mode: str('mode') ?? '', name: str('name'), prompt: str('prompt'), files };
}

/** Validates the request against the per-mode input rules and returns the classified files. */
export async function validateUpload(req: UploadRequest): Promise<{ mode: UploadMode; prompt?: string; images: Classified[]; videos: Classified[] }> {
  // "photo" and "video" are the public names; rentfree/thirdwheel are the internal ids and keep working.
  const mode = normalizeMode(req.mode);
  if (!mode) {
    throw new UploadError(req.mode ? `Unknown mode "${req.mode.slice(0, 40)}". Use photo or video.` : 'Choose a mode: photo or video.');
  }
  const prompt = req.prompt?.trim() ? req.prompt.trim().slice(0, MAX_PROMPT) : undefined;
  const classified: Classified[] = [];
  for (const file of req.files) {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const kind = sniffKind(head, file.name, file.type);
    if (kind === 'unknown') throw new UploadError(`"${file.name || 'This file'}" isn't a photo or video we can open.`);
    classified.push({ file, kind });
  }
  const images = classified.filter((c) => isImageKind(c.kind));
  const videos = classified.filter((c) => c.kind === 'video');

  if (images.length && videos.length) throw new UploadError('Send photos or one video, not both.');
  if (videos.length > 1) throw new UploadError(`Send one video at a time (you picked ${videos.length}).`);
  if (images.length > MAX_PHOTOS) throw new UploadError(`That's too many photos (${images.length}). The limit is ${MAX_PHOTOS}.`);

  if (mode === 'rentfree') {
    if (!images.length && !videos.length && !prompt) throw new UploadError('Photo mode needs a photo, a video or a prompt.');
  } else if (mode === 'thirdwheel') {
    if (!videos.length) throw new UploadError('Video mode needs one video, filmed from a still, propped-up phone.');
  } else if (mode === 'reconstruct') {
    if (!videos.length && images.length < MIN_RECONSTRUCT_PHOTOS) {
      throw new UploadError(`Reconstruct needs at least ${MIN_RECONSTRUCT_PHOTOS} photos or a video (you sent ${images.length}).`);
    }
  }
  return { mode, prompt, images, videos };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** "<name>" plus the rest of a sentence, for upload errors about one file. */
function aboutFile(name: string, fallback: string, rest: string): string {
  return `${name ? `"${name}"` : fallback} ${rest}`;
}

/** Turns a media failure into an UploadError about that file; the tool output goes to the server log only. */
function fileError(name: string, fallback: string, e: unknown): UploadError {
  if (e instanceof MediaReadError) {
    if (e.detail) console.warn(`[upload] ${name || fallback}: ${e.detail}`);
    return new UploadError(aboutFile(name, fallback, e.message));
  }
  console.warn(`[upload] ${name || fallback}:`, e);
  return new UploadError(aboutFile(name, fallback, "couldn't be read. Try exporting it again."));
}

/** Probes an uploaded video; a streamed file without a duration (MediaRecorder WebM) is remuxed once and probed again. */
async function probeUpload(path: string, log: string[]): Promise<ProbeInfo> {
  try {
    return await probeVideo(path);
  } catch (e) {
    if (!(e instanceof MediaReadError) || e.reason !== 'no-duration') throw e;
    const ext = extOf(path) || 'mp4';
    const fixed = `${path}.remux.${ext}`;
    await remuxVideo(path, fixed);
    await rename(fixed, path);
    log.push(`${path.split('/').slice(-2).join('/')}: no duration in the container; remuxed`);
    return probeVideo(path);
  }
}

function videoExt(file: File): string {
  const ext = extOf(file.name);
  if (/^(mp4|mov|m4v|webm|mkv|avi|3gp|mts|m2ts|ts|mpg|mpeg|flv|wmv)$/.test(ext)) return ext;
  if (file.type === 'video/quicktime') return 'mov';
  if (file.type === 'video/webm') return 'webm';
  return 'mp4';
}

/**
 * Creates the scene directory, writes normalized inputs (input/00.jpg, 01.jpg ... or input/video.<ext>),
 * makes thumb.jpg and saves scene.json with status 'queued'. Removes the directory again on failure.
 */
export async function createSceneFromUpload(store: SceneStore, req: UploadRequest): Promise<Scene> {
  const { mode, prompt, images, videos } = await validateUpload(req);
  const name = (req.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || defaultName(mode, prompt);
  const id = await store.newId(name);
  const dir = store.sceneDir(id);
  const inputDir = join(dir, 'input');
  await mkdir(inputDir, { recursive: true });
  const t0 = Date.now();
  const log: string[] = [];
  /** input/meta.json: per-file facts lost in normalization (original name, size, 35 mm focal length). */
  const meta: Record<string, Record<string, unknown>> = {};

  try {
    const files: string[] = [];
    let caption: string | undefined;
    let thumb: string | undefined;

    if (images.length) {
      const results = await mapLimit(images, 4, async (c, i) => {
        const nn = String(i).padStart(2, '0');
        const raw = join(inputDir, `.raw-${nn}.${extOf(c.file.name) || c.kind}`);
        await Bun.write(raw, c.file);
        try {
          let img;
          try {
            img = await normalizeImage(raw, c.kind, join(inputDir, `${nn}.jpg`));
          } catch (e) {
            throw fileError(c.file.name, `Photo ${i + 1}`, e);
          }
          if (img.width && img.height && Math.min(img.width, img.height) < MIN_PHOTO_SIDE) {
            throw new UploadError(
              aboutFile(c.file.name, `Photo ${i + 1}`, `is too small (${img.width}x${img.height}). Use a photo at least ${MIN_PHOTO_SIDE} px on the short side.`),
            );
          }
          meta[`${nn}.jpg`] = { source: c.file.name || undefined, ...img };
          log.push(
            `input/${nn}.jpg <- ${c.file.name || 'photo'} (${c.kind}, ${img.width}x${img.height}${img.focal35 ? `, ${img.focal35} mm equiv.` : ''})`,
          );
        } finally {
          await unlink(raw).catch(() => {});
        }
        return `input/${nn}.jpg`;
      });
      files.push(...results);
      try {
        await thumbFromImage(join(dir, files[0]!), join(dir, 'thumb.jpg'));
        thumb = 'thumb.jpg';
      } catch (e) {
        log.push(`thumbnail: ${(e as Error).message}`);
      }
    } else if (videos.length) {
      const v = videos[0]!.file;
      let rel = `input/video.${videoExt(v)}`;
      await Bun.write(join(dir, rel), v);
      if (UNINDEXED_VIDEO_EXT.has(extOf(rel))) {
        // No seek index (.ts, .m2ts, .mpg ...): frames picked by time would decode as nothing. Copy the streams into
        // Matroska, which every pipeline reads and can seek; keep the original only if that fails.
        const mkv = 'input/video.mkv';
        try {
          await remuxToIndexed(join(dir, rel), join(dir, mkv));
          await unlink(join(dir, rel)).catch(() => {});
          log.push(`${rel}: no seek index; streams copied into ${mkv}`);
          rel = mkv;
        } catch (e) {
          log.push(`${rel}: could not copy into Matroska (${e instanceof MediaReadError ? e.detail : (e as Error).message}); keeping it`);
        }
      }
      let info;
      try {
        info = await probeUpload(join(dir, rel), log);
      } catch (e) {
        throw fileError(v.name, 'This video', e);
      }
      if (info.width && info.height && Math.min(info.width, info.height) < MIN_VIDEO_SIDE) {
        throw new UploadError(
          aboutFile(v.name, 'This video', `is too small (${info.width}x${info.height}). Use a video at least ${MIN_VIDEO_SIDE} px on the short side.`),
        );
      }
      files.push(rel);
      meta[rel.slice('input/'.length)] = { source: v.name || undefined, ...info };
      log.push(
        `${rel} <- ${v.name || 'video'} (${info.codec} ${info.width}x${info.height} ${info.fps} fps, ${info.duration.toFixed(1)} s, audio ${info.hasAudio ? 'yes' : 'no'}${info.hdr ? `, HDR ${info.hdr} tone-mapped` : ''})`,
      );
      if (mode === 'thirdwheel' && !info.hasAudio) caption = 'This clip has no sound.';
      try {
        await thumbFromVideo(join(dir, rel), join(dir, 'thumb.jpg'), Math.min(1, info.duration * 0.25));
        thumb = 'thumb.jpg';
      } catch (e) {
        log.push(`thumbnail: ${(e as Error).message}`);
      }
    } else {
      try {
        await placeholderThumb(join(dir, 'thumb.jpg'), [...id].reduce((a, c) => a + c.charCodeAt(0), 0));
        thumb = 'thumb.jpg';
      } catch (e) {
        log.push(`thumbnail: ${(e as Error).message}`);
      }
    }

    if (Object.keys(meta).length) await Bun.write(join(inputDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

    const now = new Date().toISOString();
    const scene: Scene = {
      id,
      name,
      mode: mode as SceneMode,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      input: prompt ? { files, prompt } : { files },
      ...(thumb ? { thumb } : {}),
      ...(caption ? { caption } : {}),
    };
    const saved = await store.save(scene);
    const header = `[${now}] created ${mode} scene "${name}" in ${Date.now() - t0} ms${prompt ? ` (prompt: ${JSON.stringify(prompt)})` : ''}`;
    await Bun.write(join(dir, 'log.txt'), [header, ...log].join('\n') + '\n');
    return saved;
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
