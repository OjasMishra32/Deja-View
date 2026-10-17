// The Roblox model of a world (pipeline/roblox_mesh.py): textured, chunked .glb files in studs plus their sidecar,
// an optional skybox (six PNG faces), and an optional upload of all of it to Roblox through Open Cloud, so a game
// server can load the room with AssetService:LoadAssetAsync and set the faces on a Sky.
//
//   GET  /api/roblox/:sceneId/model.glb      the first (or only) model file (model/gltf-binary, CORS *). 404 with a
//                                            sentence when the world has no model yet.
//   GET  /api/roblox/:sceneId/model/:file    any file the sidecar lists: a model part (roblox.glb, roblox-2.glb, ...)
//                                            or a sky face (sky-front.png, ...), for a Studio import; nothing else.
//   GET  /api/roblox/:sceneId/model          the sidecar (data/scenes/<id>/roblox-model.json) plus `glbUrl`, `parts`
//                                            ([{file, url, assetId?, bounds?}]), `bounds`, `walkBounds` and
//                                            `floorY: 0` (studs, map frame: model-frame.ts), `assetId` (the first
//                                            part's, only once EVERY part is uploaded, so a game never loads half a
//                                            room), `sky` ({front, back, left, right, up, down} asset ids once all
//                                            six are uploaded, else null), `skyFiles` and `upload` (where the uploads
//                                            stand). With an uploader, a model that was never uploaded starts
//                                            uploading.
//   POST /api/roblox/:sceneId/model          start (or retry) the uploads now; 202 with the upload state.
//
// A v1 sidecar describes one file (roblox.glb, `sha1`); a v2 sidecar lists `parts` [{file, sha1, ...}] (each under
// 20 MB; the first is roblox.glb and its sha1 is also the top-level `sha1`) and `sky` {front: {file, sha1}, ...}.
// The model is in the voxel map's frame (contracts 3.2, 6.2): studs, Y up, -Z forward, floor at y = 0; each part's
// MeshParts sit where they were modelled, so every loaded part is parented without moving it. The voxel map stays the
// instant fallback and the collision. Sky faces follow Roblox's Sky properties (front = SkyboxFt, looking -Z; see
// skyInfo in the sidecar).
//
// Uploads run only when ROBLOX_UPLOAD=1 and ROBLOX_API_KEY and ROBLOX_CREATOR_ID are set (ROBLOX_CREATOR_TYPE=group
// for a group-owned experience). One upload is POST https://apis.roblox.com/assets/v1/assets (multipart: `request`
// JSON with assetType "Model" for a .glb as model/gltf-binary, or "Decal" for a sky face as image/png; header
// x-api-key, which needs Assets read + write for the creator), then GET https://apis.roblox.com/assets/v1/operations/
// <id> until it is done. Creator Hub (Open Cloud, "Usage guide for assets"): Decal/Image takes .png up to 8000 px,
// and the operation's `assetId` is what goes after rbxassetid:// in a texture property. Every assetId is stored in
// the sidecar next to the sha1 of the file it belongs to, so a rebuilt file is uploaded again instead of pointing at
// the old one. LoadAssetAsync only loads assets the experience's creator owns, so the creator here must own the
// experience.

import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import { isVideoScene } from '../copy.ts';
import { fail, json, keyRejected, methodNotAllowed, pathSegment, preflight, SCENE_ID_RE, SOCIAL_CORS, type RequestIpSource } from './http.ts';
import { modelFrame } from './model-frame.ts';

export const MODEL_FILE = 'roblox.glb';
export const MODEL_SIDECAR = 'roblox-model.json';
export const OBJECTS_FILE = 'objects.json';
/** Open Cloud's limit for one asset upload ("up to 20 MB"; read as decimal megabytes, the stricter reading). */
export const MAX_UPLOAD_BYTES = 20_000_000;
export const ROBLOX_API = 'https://apis.roblox.com';
/** The six Sky faces, in the order they upload; values of `sky` in the response are asset ids. */
export const SKY_FACES = ['front', 'back', 'left', 'right', 'up', 'down'] as const;
export type SkyFace = (typeof SKY_FACES)[number];
/** Roblox's Sky property for each face. */
export const SKY_PROPERTY: Record<SkyFace, string> = {
  front: 'SkyboxFt',
  back: 'SkyboxBk',
  left: 'SkyboxLf',
  right: 'SkyboxRt',
  up: 'SkyboxUp',
  down: 'SkyboxDn',
};

/** File names a sidecar may point at: model parts and sky faces, nothing with a path in it. */
const PART_FILE_RE = /^roblox(-\d{1,2})?\.glb$/;
const SKY_FILE_RE = /^sky-(front|back|left|right|up|down)\.png$/;

const NO_SUCH_SCENE = 'No such scene';
const NO_MODEL = 'This room has no Roblox model yet.';

// ---------------------------------------------------------------- the uploader

export interface UploaderOptions {
  apiKey: string;
  /** The Roblox user or group that owns the experience (LoadAssetAsync only loads the creator's own assets). */
  creatorId: string;
  creatorType?: 'user' | 'group';
  fetch?: typeof fetch;
  /** Delay between operation polls. Default 1500 ms. */
  pollMs?: number;
  /** Give up on an operation after this long. Default 180 s. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export interface UploadResult {
  assetId: string;
  operationId: string;
}

/** What one upload is: a Model (.glb, the default) or a Decal (a PNG, e.g. a sky face). */
export interface UploadKind {
  assetType?: 'Model' | 'Decal';
  contentType?: string;
  fileName?: string;
}

/** Roblox's error body, as a sentence for the log and the `upload.error` field. */
async function robloxError(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const b = JSON.parse(text) as { message?: string; error?: string | { message?: string }; errors?: { message?: string }[] };
      detail = b.message ?? (typeof b.error === 'string' ? b.error : b.error?.message) ?? b.errors?.[0]?.message ?? '';
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    /* no body */
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`Roblox refused the API key while ${what} (it needs Assets read and write for the creator)${detail ? `: ${detail}` : '.'}`);
  }
  if (res.status === 429) return new Error(`Roblox is rate limiting uploads (${what}); try again in a minute.`);
  return new Error(`Roblox answered ${res.status} while ${what}${detail ? `: ${detail}` : '.'}`);
}

/** Uploads one file as an asset through Open Cloud and waits for its assetId. */
export class RobloxAssetUploader {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;

  constructor(private opts: UploaderOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.base = (opts.baseUrl ?? ROBLOX_API).replace(/\/+$/, '');
  }

  async upload(bytes: Uint8Array, displayName: string, description: string, kind: UploadKind = {}): Promise<UploadResult> {
    const assetType = kind.assetType ?? 'Model';
    const what = assetType === 'Model' ? 'the model' : 'the image';
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`The file is bigger than the 20 MB Roblox allows for one upload (${what}).`);
    const creator = this.opts.creatorType === 'group' ? { groupId: this.opts.creatorId } : { userId: this.opts.creatorId };
    const request = {
      assetType,
      displayName: displayName.slice(0, 50),
      description: description.slice(0, 1000),
      creationContext: { creator },
    };
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    const type = kind.contentType ?? (assetType === 'Model' ? 'model/gltf-binary' : 'image/png');
    form.append('fileContent', new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), kind.fileName ?? MODEL_FILE);
    const res = await this.fetch(`${this.base}/assets/v1/assets`, { method: 'POST', headers: { 'x-api-key': this.opts.apiKey }, body: form });
    if (!res.ok) throw await robloxError(res, `uploading ${what}`);
    let op = (await res.json()) as Operation;
    const operationId = op.operationId ?? op.path?.split('/').pop() ?? '';
    if (!operationId && !op.done) throw new Error('Roblox accepted the upload but sent no operation to follow.');
    const deadline = Date.now() + (this.opts.timeoutMs ?? 180_000);
    while (!op.done) {
      if (Date.now() > deadline) throw new Error(`Roblox did not finish processing ${what} in time.`);
      await this.sleep(this.opts.pollMs ?? 1500);
      const r = await this.fetch(`${this.base}/assets/v1/operations/${encodeURIComponent(operationId)}`, {
        headers: { 'x-api-key': this.opts.apiKey },
      });
      if (!r.ok) throw await robloxError(r, 'waiting for the upload');
      op = (await r.json()) as Operation;
    }
    if (op.error) throw new Error(`Roblox could not import ${what}: ${op.error.message ?? op.error.code ?? 'unknown error'}`);
    const assetId = op.response?.assetId;
    if (assetId === undefined || assetId === null || String(assetId) === '') throw new Error('Roblox finished the upload without an assetId.');
    return { assetId: String(assetId), operationId };
  }
}

interface Operation {
  path?: string;
  operationId?: string;
  done?: boolean;
  error?: { code?: number | string; message?: string };
  response?: { assetId?: string | number; [k: string]: unknown };
}

/**
 * The uploader when ROBLOX_UPLOAD=1 and ROBLOX_API_KEY and ROBLOX_CREATOR_ID are set, else null (uploads stay off).
 * The explicit switch matters: Bun loads the repo's .env into every server started there, test servers on copied
 * data folders included, and only the one live server should ever put models on the team's account.
 */
export function uploaderFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): RobloxAssetUploader | null {
  if (env.ROBLOX_UPLOAD?.trim() !== '1') return null;
  const apiKey = env.ROBLOX_API_KEY?.trim();
  const creatorId = env.ROBLOX_CREATOR_ID?.trim();
  if (!apiKey || !creatorId || !/^\d{1,20}$/.test(creatorId)) return null;
  const creatorType = env.ROBLOX_CREATOR_TYPE?.trim().toLowerCase() === 'group' ? 'group' : 'user';
  return new RobloxAssetUploader({ apiKey, creatorId, creatorType, fetch: fetchImpl });
}

// ---------------------------------------------------------------- the model service

export type UploadState = 'off' | 'none' | 'uploading' | 'done' | 'failed';

export interface UploadStatus {
  state: UploadState;
  /** The first part's assetId, once every part (and sky face) is uploaded. */
  assetId?: string;
  error?: string;
  /** Unix seconds of the last upload attempt or success. */
  at?: number;
  /** Files uploaded (current) out of the files the sidecar lists. */
  done?: number;
  total?: number;
}

export interface UploadRecord {
  assetId?: string;
  sha1?: string;
  operationId?: string;
  at?: number;
}

/** One file of a v2 sidecar: a model part or a sky face. */
export interface FileEntry {
  file?: string;
  sha1?: string;
  bytes?: number;
  upload?: UploadRecord;
  [k: string]: unknown;
}

export interface Sidecar {
  sha1?: string;
  name?: string;
  assetId?: string;
  upload?: UploadRecord;
  parts?: FileEntry[];
  sky?: Partial<Record<SkyFace, FileEntry>> | null;
  [k: string]: unknown;
}

/** One file to upload, from the sidecar. `part` is the index in `parts` (-1: a v1 sidecar's single file). */
export interface UploadItem {
  file: string;
  sha1: string;
  kind: 'model' | 'sky';
  part?: number;
  face?: SkyFace;
  record?: UploadRecord;
}

const isEntry = (e: unknown): e is FileEntry => !!e && typeof e === 'object' && !Array.isArray(e);

/** The model parts a sidecar lists (a v1 sidecar: roblox.glb with the top-level sha1 and upload). */
export function modelItems(s: Sidecar): UploadItem[] {
  if (Array.isArray(s.parts) && s.parts.length) {
    const out: UploadItem[] = [];
    s.parts.forEach((p, i) => {
      if (isEntry(p) && typeof p.file === 'string' && PART_FILE_RE.test(p.file)) {
        const sha1 = typeof p.sha1 === 'string' ? p.sha1 : '';
        // the first part is also the top-level file: a v1 server that uploaded it left its record at the top level
        const top = i === 0 && p.file === MODEL_FILE && isEntry(s.upload) && s.upload.sha1 === sha1 ? s.upload : undefined;
        out.push({ file: p.file, sha1, kind: 'model', part: i, record: isEntry(p.upload) ? p.upload : top });
      }
    });
    return out;
  }
  return [{ file: MODEL_FILE, sha1: s.sha1 ?? '', kind: 'model', part: -1, record: s.upload }];
}

/** The six sky faces, when the sidecar lists all six (a partial sky is no sky). */
export function skyItems(s: Sidecar): UploadItem[] {
  const sky = s.sky;
  if (!isEntry(sky)) return [];
  const out: UploadItem[] = [];
  for (const face of SKY_FACES) {
    const e = (sky as Record<string, unknown>)[face];
    if (!isEntry(e) || typeof e.file !== 'string' || !SKY_FILE_RE.test(e.file)) return [];
    out.push({ file: e.file, sha1: typeof e.sha1 === 'string' ? e.sha1 : '', kind: 'sky', face, record: isEntry(e.upload) ? e.upload : undefined });
  }
  return out;
}

export function uploadItems(s: Sidecar): UploadItem[] {
  return [...modelItems(s), ...skyItems(s)];
}

/** The item's assetId when it was uploaded from the very file the sidecar describes now. */
export function currentId(it: UploadItem): string | undefined {
  const r = it.record;
  if (!r?.assetId || !it.sha1 || r.sha1 !== it.sha1) return undefined;
  return String(r.assetId);
}

export interface ModelServiceOptions {
  sceneDir: (id: string) => string;
  uploader?: RobloxAssetUploader | null;
  /** After a failed upload, GETs do not retry it for this long (POST always does). Default 60 s. */
  failureHoldMs?: number;
  log?: (msg: string) => void;
}

/** Reads models and sidecars from scene directories and runs at most one upload job per scene at a time. */
export class RobloxModelService {
  private inflight = new Map<string, Promise<void>>();
  private failures = new Map<string, { sig: string; at: number; error: string }>();
  private readonly log: (msg: string) => void;

  constructor(private opts: ModelServiceOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
  }

  get uploads(): boolean {
    return !!this.opts.uploader;
  }

  glbPath(sceneId: string): string {
    return join(this.opts.sceneDir(sceneId), MODEL_FILE);
  }

  filePath(sceneId: string, file: string): string {
    return join(this.opts.sceneDir(sceneId), file);
  }

  async sidecar(sceneId: string): Promise<Sidecar | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.opts.sceneDir(sceneId), MODEL_SIDECAR), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Sidecar) : null;
    } catch {
      return null;
    }
  }

  /** The first part's assetId, only when every part was uploaded from the files as they are now. */
  static currentAssetId(s: Sidecar): string | undefined {
    const parts = modelItems(s);
    const ids = parts.map(currentId);
    return parts.length && ids.every(Boolean) ? ids[0] : undefined;
  }

  /** {front, back, ...} asset ids when all six faces are uploaded from the files as they are now, else null. */
  static currentSky(s: Sidecar): Record<SkyFace, string> | null {
    const faces = skyItems(s);
    if (faces.length !== SKY_FACES.length) return null;
    const out = {} as Record<SkyFace, string>;
    for (const it of faces) {
      const id = currentId(it);
      if (!id) return null;
      out[it.face!] = id;
    }
    return out;
  }

  private static signature(s: Sidecar): string {
    return uploadItems(s)
      .map((it) => `${it.file}:${it.sha1}`)
      .join(',');
  }

  status(sceneId: string, s: Sidecar): UploadStatus {
    const items = uploadItems(s);
    const done = items.filter((it) => currentId(it)).length;
    const total = items.length;
    const assetId = RobloxModelService.currentAssetId(s);
    if (done === total && assetId) {
      const at = Math.max(0, ...items.map((it) => it.record?.at ?? 0));
      return { state: 'done', assetId, at: at || undefined, done, total };
    }
    if (!this.opts.uploader) return { state: 'off', done, total };
    if (this.inflight.has(sceneId)) return { state: 'uploading', done, total };
    const f = this.failures.get(sceneId);
    if (f && f.sig === RobloxModelService.signature(s)) return { state: 'failed', error: f.error, at: Math.floor(f.at / 1000), done, total };
    return { state: 'none', done, total };
  }

  /**
   * Starts uploading whatever the sidecar lists that is not uploaded yet, unless that is nothing, an upload job is
   * running, or (when `force` is false) the same files failed less than failureHoldMs ago. Returns the state right
   * after the decision; the uploads themselves run in the background, one file after the other.
   */
  ensureUploaded(sceneId: string, s: Sidecar, force = false): UploadStatus {
    const now = this.status(sceneId, s);
    if (now.state === 'off' || now.state === 'done' || now.state === 'uploading') return now;
    const f = this.failures.get(sceneId);
    if (!force && f && f.sig === RobloxModelService.signature(s) && Date.now() - f.at < (this.opts.failureHoldMs ?? 60_000)) return now;
    const job = this.uploadAll(sceneId).finally(() => this.inflight.delete(sceneId));
    this.inflight.set(sceneId, job);
    return { state: 'uploading', done: now.done, total: now.total };
  }

  /** Waits for a running upload job (tests, shutdown). */
  async settle(sceneId: string): Promise<void> {
    await this.inflight.get(sceneId)?.catch(() => {});
  }

  private async uploadAll(sceneId: string): Promise<void> {
    const uploader = this.opts.uploader!;
    let sig = '';
    try {
      const first = await this.sidecar(sceneId);
      if (!first) return;
      sig = RobloxModelService.signature(first);
      const todo = uploadItems(first).filter((it) => !currentId(it));
      const name = String(first.name ?? sceneId);
      const nParts = modelItems(first).length;
      const t0 = Date.now();
      for (const it of todo) {
        const bytes = new Uint8Array(await readFile(this.filePath(sceneId, it.file)));
        const sha1 = createHash('sha1').update(bytes).digest('hex');
        if (it.sha1 && it.sha1 !== sha1) throw new Error(`${it.file} on disk is not the file the sidecar describes; rebuild the model.`);
        const label =
          it.kind === 'sky'
            ? `Déjà View: ${name} sky ${it.face}`
            : nParts > 1
              ? `Déjà View: ${name} ${it.part! + 1}/${nParts}`
              : `Déjà View: ${name}`;
        const description =
          it.kind === 'sky'
            ? `The ${it.face} face (${SKY_PROPERTY[it.face!]}) of the ${name} sky from Déjà View (scene ${sceneId}).`
            : `The ${name} world from Déjà View (scene ${sceneId})${nParts > 1 ? `, part ${it.part! + 1} of ${nParts}` : ''}, in studs.`;
        const kind: UploadKind =
          it.kind === 'sky'
            ? { assetType: 'Decal', contentType: 'image/png', fileName: it.file }
            : { assetType: 'Model', contentType: 'model/gltf-binary', fileName: it.file };
        const r = await uploader.upload(bytes, label, description, kind);
        // record the assetId only if the sidecar still describes the file that went up
        const s = await this.sidecar(sceneId);
        if (!s) return;
        const rec: UploadRecord = { assetId: r.assetId, sha1, operationId: r.operationId, at: Math.floor(Date.now() / 1000) };
        if (!this.record(s, it, sha1, rec)) {
          this.log(`[roblox-model] ${sceneId}: uploaded ${it.file} as ${r.assetId}, but the model changed meanwhile; not recorded`);
          return;
        }
        await this.writeSidecar(sceneId, s);
        this.log(`[roblox-model] ${sceneId}: uploaded ${it.file} as asset ${r.assetId}`);
      }
      this.failures.delete(sceneId);
      if (todo.length) this.log(`[roblox-model] ${sceneId}: ${todo.length} file(s) uploaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      const error = (e as Error).message || 'The upload failed.';
      this.failures.set(sceneId, { sig, at: Date.now(), error });
      this.log(`[roblox-model] ${sceneId}: upload failed: ${error}`);
    }
  }

  /** Writes `rec` into the sidecar entry of `it` when that entry still has the uploaded file's sha1. */
  private record(s: Sidecar, it: UploadItem, sha1: string, rec: UploadRecord): boolean {
    if (it.kind === 'sky') {
      const e = isEntry(s.sky) ? (s.sky as Record<string, unknown>)[it.face!] : undefined;
      if (!isEntry(e) || e.file !== it.file || (e.sha1 && e.sha1 !== sha1)) return false;
      e.sha1 = e.sha1 || sha1;
      e.upload = rec;
      return true;
    }
    if (it.part === -1) {
      if (Array.isArray(s.parts) && s.parts.length) return false;
      if (s.sha1 && s.sha1 !== sha1) return false;
      s.sha1 = s.sha1 ?? sha1;
      s.upload = rec;
      s.assetId = rec.assetId;
      return true;
    }
    const p = Array.isArray(s.parts) ? s.parts[it.part!] : undefined;
    if (!isEntry(p) || p.file !== it.file || (p.sha1 && p.sha1 !== sha1)) return false;
    p.sha1 = p.sha1 || sha1;
    p.upload = rec;
    if (it.part === 0) {
      // the first part is also the top-level file (v1 readers): keep its record there too
      s.sha1 = s.sha1 || sha1;
      if (s.sha1 === sha1) s.upload = rec;
    }
    return true;
  }

  private async writeSidecar(sceneId: string, s: Sidecar): Promise<void> {
    const path = join(this.opts.sceneDir(sceneId), MODEL_SIDECAR);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 1));
    await rename(tmp, path);
  }
}

// ---------------------------------------------------------------- routes

export type ModelHandler = (req: Request, server?: RequestIpSource) => Promise<Response>;

export interface ModelRouteDeps {
  getScene: (id: string) => Promise<Scene | null>;
  models: RobloxModelService;
  /** DV_KEY; empty or missing means no key is required (contracts 2.2: /api/roblox/* checks it when set). */
  dvKey?: string | null;
  log?: (msg: string) => void;
}

/** The route table for the model: spread it into Bun.serve({ routes }) next to the social routes. */
export function createRobloxModelRoutes(deps: ModelRouteDeps): Record<string, ModelHandler> {
  const { models } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));

  function safe(name: string, fn: ModelHandler): ModelHandler {
    return async (req, server) => {
      try {
        return await fn(req, server);
      } catch (e) {
        log(`[roblox-model] ${name} ${req.method} ${new URL(req.url).pathname}: ${(e as Error).stack ?? e}`);
        return fail(500, 'Something went wrong on the server. Try again.');
      }
    };
  }

  /** The scene id from the path when it names a scene that exists, else a 404 response. */
  async function sceneOf(req: Request): Promise<{ id: string; scene: Scene } | Response> {
    const id = pathSegment(req, 3);
    if (!id || !SCENE_ID_RE.test(id)) return fail(404, NO_SUCH_SCENE);
    const scene = await deps.getScene(id).catch(() => null);
    if (!scene) return fail(404, NO_SUCH_SCENE);
    // contracts 6.2b: Photo scenes only
    if (isVideoScene(scene)) return fail(404, 'Video memories have no Roblox room: only Photo worlds do.');
    return { id, scene };
  }

  /** A file from the scene folder with CORS, an ETag and 304s; 404 (`missing`) when it is not there. */
  async function serveFile(req: Request, path: string, type: string, downloadName: string, missing: string): Promise<Response> {
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) return fail(404, missing);
    const etag = `"rg-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers: Record<string, string> = {
      ...SOCIAL_CORS,
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      ETag: etag,
    };
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) return new Response(null, { status: 304, headers });
    headers['Content-Length'] = String(st.size);
    return new Response(req.method === 'HEAD' ? null : Bun.file(path), { status: 200, headers });
  }

  const glbRoute: ModelHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const found = await sceneOf(req);
    if (found instanceof Response) return found;
    return serveFile(req, models.glbPath(found.id), 'model/gltf-binary', `${found.id}.glb`, NO_MODEL);
  };

  const fileRoute: ModelHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const found = await sceneOf(req);
    if (found instanceof Response) return found;
    const file = pathSegment(req, 5) ?? '';
    const s = await models.sidecar(found.id);
    const listed = s ? uploadItems(s).some((it) => it.file === file) : false;
    if (!listed || !(PART_FILE_RE.test(file) || SKY_FILE_RE.test(file))) return fail(404, 'No such file in this room model.');
    const png = file.endsWith('.png');
    return serveFile(req, models.filePath(found.id, file), png ? 'image/png' : 'model/gltf-binary', `${found.id}-${file}`, 'No such file in this room model.');
  };

  const modelRoute: ModelHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return methodNotAllowed('GET, HEAD, POST, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const found = await sceneOf(req);
    if (found instanceof Response) return found;
    const s = await models.sidecar(found.id);
    const hasGlb = await stat(models.glbPath(found.id)).then((st) => st.isFile(), () => false);
    if (!s || !hasGlb) return fail(404, NO_MODEL);
    if (req.method === 'POST') {
      if (!models.uploads) return fail(409, 'Uploads to Roblox are off on this server (ROBLOX_API_KEY and ROBLOX_CREATOR_ID are not set).');
      return json({ upload: models.ensureUploaded(found.id, s, true) }, 202);
    }
    const upload = req.method === 'GET' ? models.ensureUploaded(found.id, s) : models.status(found.id, s);
    const { assetId: _stale, parts: _parts, sky: _sky, ...rest } = s;
    const base = `/api/roblox/${found.id}/model`;
    const parts = modelItems(s).map((it) => {
      const meta = it.part !== undefined && it.part >= 0 && Array.isArray(s.parts) ? s.parts[it.part] : undefined;
      const out: Record<string, unknown> = { file: it.file, url: `${base}/${it.file}` };
      if (isEntry(meta)) {
        if (typeof meta.bytes === 'number') out.bytes = meta.bytes;
        if (typeof meta.triangles === 'number') out.triangles = meta.triangles;
      }
      const id = currentId(it);
      if (id) out.assetId = id;
      return out;
    });
    // bounds (read from the .glb files), walkBounds and the floor, in studs in the map frame: the game aligns the
    // model it loads on them
    const frame = await modelFrame(found.scene, s, parts.map((p) => models.filePath(found.id, String(p.file))));
    frame.partBounds.forEach((b, i) => {
      if (b) parts[i]!.bounds = b;
    });
    const faces = skyItems(s);
    const body: Record<string, unknown> = {
      ...rest,
      ...frame.fields,
      glbUrl: `${base}.glb`,
      parts,
      sky: RobloxModelService.currentSky(s),
      skyFiles: faces.length ? Object.fromEntries(faces.map((it) => [it.face!, `${base}/${it.file}`])) : null,
      upload,
    };
    const assetId = RobloxModelService.currentAssetId(s);
    if (assetId) body.assetId = assetId;
    const res = json(body);
    return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };

  const objectsRoute: ModelHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return methodNotAllowed('GET, HEAD, POST, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const found = await sceneOf(req);
    if (found instanceof Response) return found;
    const path = models.filePath(found.id, OBJECTS_FILE);
    if (req.method === 'POST') {
      let doc: unknown;
      try {
        doc = await req.json();
      } catch {
        return fail(400, 'Expected a JSON object layer.');
      }
      const d = doc as { units?: unknown; objects?: unknown };
      if (!d || typeof d !== 'object' || !Array.isArray(d.objects)) return fail(400, 'objects must be an array.');
      if (d.units !== undefined && d.units !== 'studs') return fail(400, 'units must be "studs".');
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(doc));
      await rename(tmp, path);
      return json({ ok: true, objects: (d.objects as unknown[]).length });
    }
    return serveFile(req, path, 'application/json', `${found.id}-objects.json`, 'No object layer for this room.');
  };

  return {
    '/api/roblox/:sceneId/model.glb': safe('model glb', glbRoute),
    '/api/roblox/:sceneId/model/:file': safe('model file', fileRoute),
    '/api/roblox/:sceneId/model': safe('model', modelRoute),
    '/api/roblox/:sceneId/objects': safe('objects', objectsRoute),
  };
}
