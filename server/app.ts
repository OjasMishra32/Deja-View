// HTTP API handlers (everything except the HTML pages and the WebSocket upgrade, which live in index.ts).
//
// Reads (GET /api/scenes, GET /api/scenes/:id, GET /api/scenes/:id/hotspots, GET /api/health, GET /data/...) answer
// any origin, so the viewer can load assets from anywhere. Changes (POST /api/scenes, POST /api/scenes/:id/retry,
// PUT /api/scenes/:id/hotspots, DELETE /api/scenes/:id) carry no CORS headers and pass server/guard.ts first: the
// app's own pages, or a request with the API token.
//
// Every `error` in a response body is a short product sentence; technical detail goes to the server log.

import { rm } from 'node:fs/promises';
import type { Backend, Scene, SceneMode, ServerEvent } from '../shared/types.ts';
import { normalizeMode, publicScene, type UploadMode } from './copy.ts';
import { CORS_HEADERS, notFound, safeJoin, serveFile } from './files.ts';
import { MUTATING_METHODS, mutationBlocked, NOT_ALLOWED_MESSAGE, type GuardOptions } from './guard.ts';
import { publicHealth, type HealthMonitor } from './health.ts';
import { cleanStoredHotspots, MAX_HOTSPOTS_BODY, readHotspots, writeHotspots } from './hotspots.ts';
import { DEFAULT_ORDER, type JobRunner } from './jobs.ts';
import type { SceneStore } from './store.ts';
import { isValidId } from './store.ts';
import { createSceneFromUpload, readUploadForm, UploadError, type UploadRequest } from './upload.ts';

export interface AppDeps {
  store: SceneStore;
  runner: JobRunner;
  health: Pick<HealthMonitor, 'info'>;
  publish: (e: ServerEvent) => void;
  maxUploadBytes: number;
  /** Optional directory served at the site root for unmatched GETs (web/public). */
  publicDir?: string;
  /** Who may create, retry and delete scenes (server/guard.ts). Defaults to the app's own origin only. */
  guard?: GuardOptions;
  /** A second server on a data folder another server owns: it shows scenes but changes nothing. */
  readOnly?: boolean;
}

/** API messages a person can read. */
export const MESSAGES = {
  tooLarge: (limitGb: number) => `That upload is too big. The limit is ${limitGb} GB; trim the clip (10 to 30 seconds is plenty).`,
  notAForm: 'The upload has to be sent as a form with a mode and your files.',
  unreadableUpload: "The upload didn't arrive in one piece. Try again.",
  uploadFailed: "Something went wrong while saving your upload. Try again.",
  noSuchScene: "We couldn't find that scene. It may have been deleted.",
  sampleDelete: "Samples can't be deleted.",
  sampleRetry: "Samples are ready-made and don't need to be rebuilt.",
  busy: 'This scene is already being built.',
  methodNotAllowed: "That action isn't supported here.",
  notFound: 'Not found.',
  badPath: "That file path isn't valid.",
  serverError: 'Something went wrong on the server. Try again.',
  readOnly: 'This copy of the app can only show scenes. Make changes from the main Déjà View server.',
  badHotspots: 'Send the labels as JSON with a hotspots list (label, blurb, x, y, z).',
  hotspotsTooLarge: 'That list of labels is too big.',
} as const;

/** Thrown by a capped request body (server/index.ts) once a body sent without a length passes the limit. */
export class BodyTooLarge extends Error {
  constructor() {
    super('request body too large');
  }
}

/** Whether reading a body failed because it was cut off at the size limit. */
function tooLargeError(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    if (x instanceof BodyTooLarge || (x as Error)?.message === 'request body too large') return true;
  }
  return false;
}

/** Read-only responses: any origin may read them. */
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', ...headers } });
}

/** Responses to state-changing requests: no CORS headers, so other origins cannot read them. */
function privateJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function privateError(status: number, message: string): Response {
  return privateJson({ error: message }, status);
}

function backendParam(v: string | null | undefined): Backend | undefined {
  return v && (DEFAULT_ORDER as string[]).includes(v) ? (v as Backend) : undefined;
}

/** "Unknown mode" text shared by create and retry. */
function unknownMode(raw: string): string {
  return `Unknown mode "${raw.slice(0, 40)}". Use photo or video.`;
}

/** Whether a scene's stored inputs can be rebuilt in another mode; null when they can, else the reason. */
export function modeMismatch(mode: UploadMode, scene: Scene): string | null {
  const files = scene.input?.files ?? [];
  const videos = files.filter((f) => /(^|\/)video\.[a-z0-9]+$/i.test(f)).length;
  const photos = files.length - videos;
  const prompt = !!scene.input?.prompt?.trim();
  if (mode === 'thirdwheel' && !videos) return 'Video mode needs a video, and this scene was made from photos.';
  if (mode === 'reconstruct' && !videos && photos < 8) return 'Reconstruct needs at least 8 photos or a video.';
  if (mode === 'rentfree' && !files.length && !prompt) return 'Photo mode needs a photo, a video or a prompt.';
  return null;
}

/** Fields of a small POST body (JSON, form or none), for retry. */
async function readSmallBody(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  try {
    if (type.includes('application/json')) {
      const body: unknown = await req.json();
      if (body && typeof body === 'object') {
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      }
    } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
      const form = await req.formData();
      for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
    }
  } catch {
    /* an empty or unreadable body means no options */
  }
  return out;
}

export function createApp(deps: AppDeps) {
  const { store, runner } = deps;
  const guard = deps.guard ?? {};
  const limitGb = Math.round(deps.maxUploadBytes / 1024 ** 3) || 1;

  async function createScene(req: Request): Promise<Response> {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > deps.maxUploadBytes) return privateError(413, MESSAGES.tooLarge(limitGb));
    const type = req.headers.get('content-type') ?? '';
    let upload: UploadRequest;
    let only: Backend | undefined;
    try {
      if (type.includes('application/json')) {
        const body: any = await req.json();
        upload = { mode: String(body?.mode ?? ''), name: body?.name, prompt: body?.prompt, files: [] };
        only = backendParam(body?.backend);
      } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
        const form = await req.formData();
        upload = readUploadForm(form);
        const b = form.get('backend');
        only = backendParam(typeof b === 'string' ? b : undefined);
      } else {
        return privateError(415, MESSAGES.notAForm);
      }
    } catch (e) {
      if (tooLargeError(e)) return privateError(413, MESSAGES.tooLarge(limitGb));
      console.warn(`[upload] could not read the request body: ${(e as Error).message}`);
      return privateError(400, MESSAGES.unreadableUpload);
    }
    const total = upload.files.reduce((n, f) => n + f.size, 0);
    if (total > deps.maxUploadBytes) return privateError(413, MESSAGES.tooLarge(limitGb));
    try {
      const scene = await createSceneFromUpload(store, upload);
      deps.publish({ type: 'scene', scene }); // mapped to the public shape where it is sent (server/index.ts)
      runner.enqueue(scene.id, { only: only ?? backendParam(new URL(req.url).searchParams.get('backend')) });
      return privateJson(publicScene(scene), 201);
    } catch (e) {
      if (e instanceof UploadError) return privateError(e.status, e.message);
      console.error('[upload]', e);
      return privateError(500, MESSAGES.uploadFailed);
    }
  }

  async function deleteScene(id: string, url: URL): Promise<Response> {
    const scene = await store.get(id);
    if (!scene) return privateError(404, MESSAGES.noSuchScene);
    if (scene.mode === 'sample' && url.searchParams.get('force') !== '1') return privateError(403, MESSAGES.sampleDelete);
    await runner.cancel(id);
    await store.delete(id);
    await rm(runner.jobDir(id), { recursive: true, force: true }).catch(() => {});
    deps.publish({ type: 'scene_deleted', id });
    return privateJson({ ok: true, id });
  }

  /**
   * Re-runs a scene. Options (query string or a JSON/form body): `backend` restricts the backend, `mode` rebuilds
   * the same inputs in another mode (photo, video, or the internal ids) when they fit it.
   */
  async function retryScene(id: string, url: URL, req?: Request): Promise<Response> {
    const scene = await store.get(id);
    if (!scene) return privateError(404, MESSAGES.noSuchScene);
    if (scene.mode === 'sample') return privateError(400, MESSAGES.sampleRetry);
    if (runner.isActive(id)) return privateError(409, MESSAGES.busy);
    const body = req ? await readSmallBody(req) : {};
    const rawMode = url.searchParams.get('mode') ?? body.mode;
    let mode: SceneMode | undefined;
    if (rawMode !== undefined && rawMode.trim() !== '') {
      const m = normalizeMode(rawMode);
      if (!m) return privateError(400, unknownMode(rawMode));
      if (m !== scene.mode) {
        const why = modeMismatch(m, scene);
        if (why) return privateError(400, why);
        mode = m;
      }
    }
    const only = backendParam(url.searchParams.get('backend') ?? body.backend);
    const s = await runner.retry(id, only, mode);
    return s ? privateJson(publicScene(s)) : privateError(404, MESSAGES.noSuchScene);
  }

  /** GET: the scene's stored 3D labels, `{hotspots: []}` when none were stored yet. */
  async function getHotspots(id: string): Promise<Response> {
    if (!isValidId(id) || !(await store.get(id))) return error(404, MESSAGES.noSuchScene);
    return json({ hotspots: await readHotspots(store.sceneDir(id)) });
  }

  /** PUT: replaces the scene's labels (the viewer stores what it placed) and tells every viewer on /ws. */
  async function putHotspots(id: string, req: Request): Promise<Response> {
    if (!isValidId(id) || !(await store.get(id))) return privateError(404, MESSAGES.noSuchScene);
    if (Number(req.headers.get('content-length') || 0) > MAX_HOTSPOTS_BODY) return privateError(413, MESSAGES.hotspotsTooLarge);
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return privateError(400, MESSAGES.unreadableUpload);
    }
    if (raw.length > MAX_HOTSPOTS_BODY) return privateError(413, MESSAGES.hotspotsTooLarge);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return privateError(400, MESSAGES.badHotspots);
    }
    const hotspots = cleanStoredHotspots(body);
    if (!hotspots) return privateError(400, MESSAGES.badHotspots);
    // A list whose every entry is broken is a client bug, not "clear the labels": keep what is stored.
    // (An explicit empty list still clears them.)
    const sent = Array.isArray(body) ? body : (body as { hotspots: unknown[] }).hotspots;
    if (sent.length > 0 && hotspots.length === 0) return privateError(400, MESSAGES.badHotspots);
    await writeHotspots(store.sceneDir(id), hotspots);
    deps.publish({ type: 'hotspots', sceneId: id, hotspots });
    return privateJson({ ok: true, hotspots });
  }

  /** Answers a CORS preflight: read methods get CORS headers, changes get none (so browsers refuse them). */
  function preflight(req: Request): Response {
    const wanted = (req.headers.get('access-control-request-method') ?? '').toUpperCase();
    if (wanted && MUTATING_METHODS.has(wanted)) {
      return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS', Vary: 'Origin' } });
    }
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  /** Returns a Response for API and asset paths, or null when the path is not ours. */
  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const isApi = path.startsWith('/api/');

    if (method === 'OPTIONS' && (isApi || path.startsWith('/data/'))) return preflight(req);

    if (isApi && MUTATING_METHODS.has(method)) {
      if (deps.readOnly) return privateError(503, MESSAGES.readOnly);
      const why = mutationBlocked(req, guard);
      if (why) {
        console.warn(`[guard] refused ${method} ${path}: ${why}`);
        return privateError(403, NOT_ALLOWED_MESSAGE);
      }
    }

    if (path === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') return error(405, MESSAGES.methodNotAllowed);
      return json(publicHealth(await deps.health.info(url.searchParams.get('refresh') === '1')));
    }

    if (path === '/api/scenes' || path === '/api/scenes/') {
      if (method === 'GET' || method === 'HEAD') return json((await store.list()).map(publicScene));
      if (method === 'POST') return createScene(req);
      return privateError(405, MESSAGES.methodNotAllowed);
    }

    let m = /^\/api\/scenes\/([^/]+)\/?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === 'GET' || method === 'HEAD') {
        const s = isValidId(id) ? await store.get(id) : null;
        return s ? json(publicScene(s)) : error(404, MESSAGES.noSuchScene);
      }
      if (!isValidId(id)) return privateError(404, MESSAGES.noSuchScene);
      // Worlds are never deleted through the website; THIRDWHEEL_ALLOW_DELETE=1 turns it back on for local cleanup.
      if (method === 'DELETE') {
        if (process.env.THIRDWHEEL_ALLOW_DELETE !== '1') return privateError(403, 'Worlds cannot be deleted here.');
        return deleteScene(id, url);
      }
      return privateError(405, MESSAGES.methodNotAllowed);
    }

    m = /^\/api\/scenes\/([^/]+)\/hotspots\/?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === 'GET' || method === 'HEAD') return getHotspots(id);
      if (method === 'PUT') return putHotspots(id, req);
      return privateError(405, MESSAGES.methodNotAllowed);
    }

    m = /^\/api\/scenes\/([^/]+)\/retry\/?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method !== 'POST') return privateError(405, MESSAGES.methodNotAllowed);
      if (!isValidId(id)) return privateError(404, MESSAGES.noSuchScene);
      return retryScene(id, url, req);
    }

    if (isApi) return MUTATING_METHODS.has(method) ? privateError(404, MESSAGES.notFound) : error(404, MESSAGES.notFound);

    m = /^\/data\/scenes\/([^/]+)\/(.+)$/.exec(path);
    if (m) {
      if (method !== 'GET' && method !== 'HEAD') return privateError(405, MESSAGES.methodNotAllowed);
      const id = m[1]!;
      if (!isValidId(id)) return notFound(MESSAGES.notFound);
      const file = safeJoin(store.sceneDir(id), m[2]!);
      if (!file) return error(400, MESSAGES.badPath);
      return serveFile(req, file);
    }

    if (deps.publicDir && (method === 'GET' || method === 'HEAD') && path !== '/') {
      const sub = path.startsWith('/public/') ? path.slice('/public/'.length) : path.slice(1);
      const file = safeJoin(deps.publicDir, sub);
      if (file && (await Bun.file(file).exists())) return serveFile(req, file, { cacheControl: 'public, max-age=300' });
    }
    return null;
  }

  return { handle, createScene, deleteScene, retryScene };
}

