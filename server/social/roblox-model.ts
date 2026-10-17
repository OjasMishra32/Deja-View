// The Roblox model of a world (pipeline/roblox_mesh.py): a textured, chunked .glb in studs plus its sidecar, and an
// optional upload to Roblox through Open Cloud, so a game server can load the room with AssetService:LoadAssetAsync.
//
//   GET  /api/roblox/:sceneId/model.glb   the model file (model/gltf-binary, CORS *). 404 with a sentence when the
//                                         world has no model yet.
//   GET  /api/roblox/:sceneId/model       the sidecar (data/scenes/<id>/roblox-model.json) plus `glbUrl`, `assetId`
//                                         when the current file has been uploaded, and `upload` (where an upload
//                                         stands). With an uploader, a model that was never uploaded starts uploading.
//   POST /api/roblox/:sceneId/model       start (or retry) the upload now; 202 with the upload state.
//
// The model is in the voxel map's frame (contracts 3.2, 6.2): studs, Y up, -Z forward, floor at y = 0, each chunk's
// MeshPart centred on its `center`. The voxel map stays the instant fallback and the collision.
//
// Uploads run only when ROBLOX_API_KEY and ROBLOX_CREATOR_ID are set (ROBLOX_CREATOR_TYPE=group for a group-owned
// experience). One upload is POST https://apis.roblox.com/assets/v1/assets (multipart: `request` JSON with assetType
// "Model", `fileContent` the .glb as model/gltf-binary; header x-api-key, which needs Assets read + write for the
// creator), then GET https://apis.roblox.com/assets/v1/operations/<id> until it is done. The assetId is stored in the
// sidecar with the sha1 of the file it belongs to, so a rebuilt model is uploaded again instead of pointing at the old
// one. LoadAssetAsync only loads assets the experience's creator owns, so the creator here must own the experience.

import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import { isVideoScene } from '../copy.ts';
import { fail, json, keyRejected, methodNotAllowed, pathSegment, preflight, SCENE_ID_RE, SOCIAL_CORS, type RequestIpSource } from './http.ts';

export const MODEL_FILE = 'roblox.glb';
export const MODEL_SIDECAR = 'roblox-model.json';
/** Open Cloud's limit for one asset upload ("up to 20 MB"; read as decimal megabytes, the stricter reading). */
export const MAX_UPLOAD_BYTES = 20_000_000;
export const ROBLOX_API = 'https://apis.roblox.com';

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

/** Uploads one .glb as a Model asset through Open Cloud and waits for its assetId. */
export class RobloxAssetUploader {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;

  constructor(private opts: UploaderOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.base = (opts.baseUrl ?? ROBLOX_API).replace(/\/+$/, '');
  }

  async upload(bytes: Uint8Array, displayName: string, description: string): Promise<UploadResult> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('The model is bigger than the 20 MB Roblox allows for one upload.');
    const creator = this.opts.creatorType === 'group' ? { groupId: this.opts.creatorId } : { userId: this.opts.creatorId };
    const request = {
      assetType: 'Model',
      displayName: displayName.slice(0, 50),
      description: description.slice(0, 1000),
      creationContext: { creator },
    };
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }), MODEL_FILE);
    const res = await this.fetch(`${this.base}/assets/v1/assets`, { method: 'POST', headers: { 'x-api-key': this.opts.apiKey }, body: form });
    if (!res.ok) throw await robloxError(res, 'uploading the model');
    let op = (await res.json()) as Operation;
    const operationId = op.operationId ?? op.path?.split('/').pop() ?? '';
    if (!operationId && !op.done) throw new Error('Roblox accepted the upload but sent no operation to follow.');
    const deadline = Date.now() + (this.opts.timeoutMs ?? 180_000);
    while (!op.done) {
      if (Date.now() > deadline) throw new Error('Roblox did not finish processing the model in time.');
      await this.sleep(this.opts.pollMs ?? 1500);
      const r = await this.fetch(`${this.base}/assets/v1/operations/${encodeURIComponent(operationId)}`, {
        headers: { 'x-api-key': this.opts.apiKey },
      });
      if (!r.ok) throw await robloxError(r, 'waiting for the upload');
      op = (await r.json()) as Operation;
    }
    if (op.error) throw new Error(`Roblox could not import the model: ${op.error.message ?? op.error.code ?? 'unknown error'}`);
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
  assetId?: string;
  error?: string;
  /** Unix seconds of the last upload attempt or success. */
  at?: number;
}

export interface Sidecar {
  sha1?: string;
  name?: string;
  assetId?: string;
  upload?: { assetId?: string; sha1?: string; operationId?: string; at?: number };
  [k: string]: unknown;
}

export interface ModelServiceOptions {
  sceneDir: (id: string) => string;
  uploader?: RobloxAssetUploader | null;
  /** After a failed upload, GETs do not retry it for this long (POST always does). Default 60 s. */
  failureHoldMs?: number;
  log?: (msg: string) => void;
}

/** Reads models and sidecars from scene directories and runs at most one upload per scene at a time. */
export class RobloxModelService {
  private inflight = new Map<string, Promise<void>>();
  private failures = new Map<string, { sha1: string; at: number; error: string }>();
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

  async sidecar(sceneId: string): Promise<Sidecar | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.opts.sceneDir(sceneId), MODEL_SIDECAR), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Sidecar) : null;
    } catch {
      return null;
    }
  }

  /** The assetId for the model as it is now: only when the upload was of this very file. */
  static currentAssetId(s: Sidecar): string | undefined {
    const u = s.upload;
    if (!u?.assetId || !s.sha1 || u.sha1 !== s.sha1) return undefined;
    return String(u.assetId);
  }

  status(sceneId: string, s: Sidecar): UploadStatus {
    const assetId = RobloxModelService.currentAssetId(s);
    if (assetId) return { state: 'done', assetId, at: s.upload?.at };
    if (!this.opts.uploader) return { state: 'off' };
    if (this.inflight.has(sceneId)) return { state: 'uploading' };
    const f = this.failures.get(sceneId);
    if (f && f.sha1 === (s.sha1 ?? '')) return { state: 'failed', error: f.error, at: Math.floor(f.at / 1000) };
    return { state: 'none' };
  }

  /**
   * Starts an upload of the current model unless it is already uploaded, uploading, or (when `force` is false) failed
   * less than failureHoldMs ago. Returns the state right after the decision; the upload itself runs in the background.
   */
  ensureUploaded(sceneId: string, s: Sidecar, force = false): UploadStatus {
    const now = this.status(sceneId, s);
    if (now.state === 'off' || now.state === 'done' || now.state === 'uploading') return now;
    const f = this.failures.get(sceneId);
    if (!force && f && f.sha1 === (s.sha1 ?? '') && Date.now() - f.at < (this.opts.failureHoldMs ?? 60_000)) return now;
    const job = this.upload(sceneId).finally(() => this.inflight.delete(sceneId));
    this.inflight.set(sceneId, job);
    return { state: 'uploading' };
  }

  /** Waits for a running upload (tests, shutdown). */
  async settle(sceneId: string): Promise<void> {
    await this.inflight.get(sceneId)?.catch(() => {});
  }

  private async upload(sceneId: string): Promise<void> {
    const uploader = this.opts.uploader!;
    let sha1 = '';
    try {
      const bytes = new Uint8Array(await readFile(this.glbPath(sceneId)));
      sha1 = createHash('sha1').update(bytes).digest('hex');
      const before = await this.sidecar(sceneId);
      const name = String(before?.name ?? sceneId);
      const t0 = Date.now();
      const r = await uploader.upload(bytes, `Déjà View: ${name}`, `The ${name} world from Déjà View (scene ${sceneId}), in studs.`);
      // write the assetId only if the sidecar still describes the file that went up
      const s = await this.sidecar(sceneId);
      if (!s || (s.sha1 && s.sha1 !== sha1)) {
        this.log(`[roblox-model] ${sceneId}: uploaded as ${r.assetId}, but the model changed meanwhile; not recorded`);
        return;
      }
      const at = Math.floor(Date.now() / 1000);
      const next: Sidecar = { ...s, sha1: s.sha1 ?? sha1, assetId: r.assetId, upload: { assetId: r.assetId, sha1, operationId: r.operationId, at } };
      await this.writeSidecar(sceneId, next);
      this.failures.delete(sceneId);
      this.log(`[roblox-model] ${sceneId}: uploaded as asset ${r.assetId} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      const error = (e as Error).message || 'The upload failed.';
      this.failures.set(sceneId, { sha1, at: Date.now(), error });
      this.log(`[roblox-model] ${sceneId}: upload failed: ${error}`);
    }
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

  const glbRoute: ModelHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const found = await sceneOf(req);
    if (found instanceof Response) return found;
    const path = models.glbPath(found.id);
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) return fail(404, NO_MODEL);
    const etag = `"rg-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers: Record<string, string> = {
      ...SOCIAL_CORS,
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'no-cache',
      'Content-Disposition': `attachment; filename="${found.id}.glb"`,
      ETag: etag,
    };
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) return new Response(null, { status: 304, headers });
    headers['Content-Length'] = String(st.size);
    return new Response(req.method === 'HEAD' ? null : Bun.file(path), { status: 200, headers });
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
    const { assetId: _stale, ...rest } = s;
    const body: Record<string, unknown> = { ...rest, glbUrl: `/api/roblox/${found.id}/model.glb`, upload };
    if (upload.state === 'done' && upload.assetId) body.assetId = upload.assetId;
    const res = json(body);
    return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };

  return {
    '/api/roblox/:sceneId/model.glb': safe('model glb', glbRoute),
    '/api/roblox/:sceneId/model': safe('model', modelRoute),
  };
}
