// HTTP API handlers (everything except the HTML pages and the WebSocket upgrade, which live in index.ts).

import { rm } from 'node:fs/promises';
import type { Backend, ServerEvent } from '../shared/types.ts';
import { CORS_HEADERS, notFound, safeJoin, serveFile } from './files.ts';
import type { HealthMonitor } from './health.ts';
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
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', ...headers } });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function backendParam(v: string | null | undefined): Backend | undefined {
  return v && (DEFAULT_ORDER as string[]).includes(v) ? (v as Backend) : undefined;
}

export function createApp(deps: AppDeps) {
  const { store, runner } = deps;

  async function createScene(req: Request): Promise<Response> {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > deps.maxUploadBytes) {
      return error(413, `Upload too large (${(len / 1e9).toFixed(2)} GB); the limit is ${(deps.maxUploadBytes / 1024 ** 3).toFixed(0)} GB`);
    }
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
        return error(415, 'Send multipart/form-data with mode, name, prompt and files');
      }
    } catch (e) {
      return error(400, `Could not read the upload: ${(e as Error).message}`);
    }
    const total = upload.files.reduce((n, f) => n + f.size, 0);
    if (total > deps.maxUploadBytes) return error(413, 'Upload too large; the limit is 1 GB');
    try {
      const scene = await createSceneFromUpload(store, upload);
      deps.publish({ type: 'scene', scene });
      runner.enqueue(scene.id, { only: only ?? backendParam(new URL(req.url).searchParams.get('backend')) });
      return json(scene, 201);
    } catch (e) {
      if (e instanceof UploadError) return error(e.status, e.message);
      console.error('[upload]', e);
      return error(500, `Upload failed: ${(e as Error).message}`);
    }
  }

  async function deleteScene(id: string, url: URL): Promise<Response> {
    const scene = await store.get(id);
    if (!scene) return error(404, 'No such scene');
    if (scene.mode === 'sample' && url.searchParams.get('force') !== '1') {
      return error(403, 'Samples are bundled demo content; pass ?force=1 to delete one (bun run samples restores it)');
    }
    await runner.cancel(id);
    await store.delete(id);
    await rm(runner.jobDir(id), { recursive: true, force: true }).catch(() => {});
    deps.publish({ type: 'scene_deleted', id });
    return json({ ok: true, id });
  }

  async function retryScene(id: string, url: URL): Promise<Response> {
    const scene = await store.get(id);
    if (!scene) return error(404, 'No such scene');
    if (scene.mode === 'sample') return error(400, 'Samples have no job to re-run');
    if (runner.isActive(id)) return error(409, 'This scene is already being processed');
    const s = await runner.retry(id, backendParam(url.searchParams.get('backend')));
    return s ? json(s) : error(404, 'No such scene');
  }

  /** Returns a Response for API and asset paths, or null when the path is not ours. */
  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS' && (path.startsWith('/api/') || path.startsWith('/data/'))) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === '/api/health') {
      if (method !== 'GET') return error(405, 'Method not allowed');
      return json(await deps.health.info(url.searchParams.get('refresh') === '1'));
    }

    if (path === '/api/scenes' || path === '/api/scenes/') {
      if (method === 'GET') return json(await store.list());
      if (method === 'POST') return createScene(req);
      return error(405, 'Method not allowed');
    }

    let m = /^\/api\/scenes\/([^/]+)\/?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (!isValidId(id)) return error(404, 'No such scene');
      if (method === 'GET') {
        const s = await store.get(id);
        return s ? json(s) : error(404, 'No such scene');
      }
      if (method === 'DELETE') return deleteScene(id, url);
      return error(405, 'Method not allowed');
    }

    m = /^\/api\/scenes\/([^/]+)\/retry\/?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (!isValidId(id)) return error(404, 'No such scene');
      if (method !== 'POST') return error(405, 'Method not allowed');
      return retryScene(id, url);
    }

    if (path.startsWith('/api/')) return error(404, 'Unknown API route');

    m = /^\/data\/scenes\/([^/]+)\/(.+)$/.exec(path);
    if (m) {
      if (method !== 'GET' && method !== 'HEAD') return error(405, 'Method not allowed');
      const id = m[1]!;
      if (!isValidId(id)) return notFound();
      const file = safeJoin(store.sceneDir(id), m[2]!);
      if (!file) return error(400, 'Bad path');
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

