// HTTP routes for the teammate integrations, as a Bun.serve `routes` object (dependencies injected):
//
//   GET  /api/notes/:sceneId     {notes:[...]} from the DeepSpace relay's cache (CORS: any origin may read)
//   POST /api/notes/:sceneId     {author, text, x, y, z} -> DeepSpace; DeepSpace's answer, or 502 {"error":"notes offline"}
//   GET  /api/guide/health       the guide's GET /health, or 502 {"ok":false,"error":"guide offline"}
//   POST /api/guide/:name        describe | hotspots | narrate | ask, forwarded to GUIDE_URL/<name>
//
// POSTs pass the same cross-site guard as the rest of the API (server/guard.ts) and carry no CORS headers.
// createIntegrations() below builds everything (config from env, DeepSpace forwarder + notes, guide client + proxy,
// these routes) in one call for server/index.ts.

import type { Scene } from '../../shared/types.ts';
import { guardOptionsFromEnv, mutationBlocked } from '../guard.ts';
import {
  integrationsConfigFromEnv,
  prefixedLogger,
  readPublicUrl,
  type Env,
  type FetchLike,
  type IntegrationsConfig,
  type Logger,
} from './config.ts';
import {
  createDeepSpace,
  isSceneId,
  noteEvent,
  type DeepSpace,
  type DeepSpaceNote,
  type NotesRelay,
  type PresenceSource,
} from './deepspace.ts';
import { describeClipForJob, describeForJob, type ClipDescribeOptions } from './describe.ts';
import { createGuideClient, createGuideProxy, readBodyCapped, type GuideClient, type GuideProxy } from './guide.ts';

export { createPresenceFeed, presenceFromGetter, type PresenceFeed, type PresenceSource } from './deepspace.ts';

type RouteRequest = Request & { params?: Record<string, string> };
type RouteHandler = (req: RouteRequest) => Promise<Response>;
/** Shape accepted by Bun.serve({ routes }). */
export type IntegrationRoutes = Record<string, Partial<Record<'GET' | 'HEAD' | 'POST' | 'OPTIONS', RouteHandler>>>;

export interface IntegrationRoutesDeps {
  notes: Pick<NotesRelay, 'list' | 'create'>;
  guide: Pick<GuideProxy, 'handle' | 'health'>;
  /** Why a POST is refused (logged), or null to let it through. Default: server/guard.ts with the env options. */
  guard?: (req: Request) => string | null;
  /** Whether a scene exists (notes for a world that does not exist are a 404). Default: any valid id passes. */
  sceneExists?: (id: string) => Promise<boolean>;
  log?: Logger;
}

const READ_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MESSAGES = {
  noScene: "We couldn't find that scene.",
  notAllowed: 'This action only works from the Déjà View app.',
  notJson: 'Send the note as JSON: author, text, x, y, z.',
  tooLarge: 'That note is too big.',
  server: 'Something went wrong on the server. Try again.',
  method: "That action isn't supported here.",
} as const;

function readJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...READ_CORS, 'Cache-Control': 'no-store' } });
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
}

/** CORS preflight: reads get CORS headers; a preflight for a change gets none, so browsers refuse it. */
function preflight(req: Request): Response {
  const wanted = (req.headers.get('access-control-request-method') ?? '').toUpperCase();
  if (wanted && wanted !== 'GET' && wanted !== 'HEAD') return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, POST, OPTIONS', Vary: 'Origin' } });
  return new Response(null, { status: 204, headers: READ_CORS });
}

function param(req: RouteRequest, name: string, re: RegExp): string {
  const p = req.params?.[name];
  if (typeof p === 'string') return p;
  const m = re.exec(new URL(req.url).pathname);
  return m ? decodeURIComponent(m[1]!) : '';
}

const NOTES_PATH = /^\/api\/notes\/([^/]+)\/?$/;
const GUIDE_PATH = /^\/api\/guide\/([^/]+)\/?$/;

export function createIntegrationRoutes(deps: IntegrationRoutesDeps): IntegrationRoutes {
  const log = deps.log ?? prefixedLogger('http');
  const guardEnv = guardOptionsFromEnv();
  const guard = deps.guard ?? ((req: Request) => mutationBlocked(req, guardEnv));

  /** Never lets an exception escape into Bun (the server keeps serving whatever a teammate's service does). */
  const safe =
    (fn: RouteHandler, priv: boolean): RouteHandler =>
    async (req) => {
      try {
        return await fn(req);
      } catch (e) {
        log.warn(`${req.method} ${new URL(req.url).pathname}: ${(e as Error)?.stack ?? e}`);
        return priv ? privateJson({ error: MESSAGES.server }, 500) : readJson({ error: MESSAGES.server }, 500);
      }
    };

  const guarded =
    (fn: RouteHandler): RouteHandler =>
    async (req) => {
      const why = guard(req);
      if (why) {
        log.warn(`[guard] refused ${req.method} ${new URL(req.url).pathname}: ${why}`);
        return privateJson({ error: MESSAGES.notAllowed }, 403);
      }
      return fn(req);
    };

  const exists = async (id: string): Promise<boolean> => (deps.sceneExists ? deps.sceneExists(id).catch(() => false) : true);

  const notesGet: RouteHandler = async (req) => {
    const id = param(req, 'sceneId', NOTES_PATH);
    if (!isSceneId(id) || !(await exists(id))) return readJson({ error: MESSAGES.noScene }, 404);
    const res = readJson(await deps.notes.list(id));
    return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };

  const notesPost: RouteHandler = async (req) => {
    const id = param(req, 'sceneId', NOTES_PATH);
    if (!isSceneId(id) || !(await exists(id))) return privateJson({ error: MESSAGES.noScene }, 404);
    const read = await readBodyCapped(req, 16 * 1024).catch(() => ({ ok: false as const }));
    if (!read.ok) return privateJson({ error: MESSAGES.tooLarge }, 413);
    let body: unknown;
    try {
      body = JSON.parse(read.text || 'null');
    } catch {
      return privateJson({ error: MESSAGES.notJson }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return privateJson({ error: MESSAGES.notJson }, 400);
    const r = await deps.notes.create(id, body);
    return privateJson(r.body, r.status);
  };

  const guidePost: RouteHandler = async (req) => deps.guide.handle(param(req, 'name', GUIDE_PATH), req);
  const guideHealth: RouteHandler = async () => {
    const res = await deps.guide.health();
    return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...READ_CORS } });
  };
  const notAllowed: RouteHandler = async () => readJson({ error: MESSAGES.method }, 405);
  const opts: RouteHandler = async (req) => preflight(req);

  return {
    '/api/notes/:sceneId': {
      GET: safe(notesGet, false),
      HEAD: safe(notesGet, false),
      POST: safe(guarded(notesPost), true),
      OPTIONS: opts,
    },
    '/api/guide/health': { GET: safe(guideHealth, false), HEAD: safe(guideHealth, false), OPTIONS: opts },
    '/api/guide/:name': { POST: safe(guarded(guidePost), true), GET: notAllowed, OPTIONS: opts },
  };
}

/**
 * The same routes as one fetch-style function: a Response for our paths, null for everything else. For wiring the
 * integrations in front of app.handle() instead of through Bun's `routes`.
 */
export function createIntegrationHandler(deps: IntegrationRoutesDeps): (req: Request) => Promise<Response | null> {
  const routes = createIntegrationRoutes(deps);
  return async (req) => {
    const path = new URL(req.url).pathname;
    const method = req.method.toUpperCase() as 'GET' | 'HEAD' | 'POST' | 'OPTIONS';
    let table: IntegrationRoutes[string] | undefined;
    if (NOTES_PATH.test(path)) table = routes['/api/notes/:sceneId'];
    else if (path === '/api/guide/health' || path === '/api/guide/health/') table = routes['/api/guide/health'];
    else if (GUIDE_PATH.test(path)) table = routes['/api/guide/:name'];
    if (!table) return null;
    const fn = table[method];
    return fn ? fn(req) : privateJson({ error: MESSAGES.method }, 405);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Everything at once

export type NoteMessage = { type: 'note'; sceneId: string; note: DeepSpaceNote };

export interface IntegrationsOptions {
  /** The scene store (SceneStore): get() for the guide's scene context, sceneDir() for thumbnails and labels. */
  store: { get(id: string): Promise<Scene | null>; sceneDir(id: string): string };
  /** Who is in which scene (see deepspace.ts: createPresenceFeed, presenceFromGetter, or any {snapshot()}). */
  presence: PresenceSource;
  /** Broadcast on /ws. Receives {type:"note", sceneId, note} once per new note id. */
  publish?: (msg: NoteMessage) => void;
  env?: Env;
  /** Overrides env parsing entirely (tests). */
  config?: IntegrationsConfig;
  fetch?: FetchLike;
  guard?: (req: Request) => string | null;
  /** Labels already pinned in a world, [{label, blurb}]. Default: <sceneDir>/hotspots.json. */
  getHotspots?: (sceneId: string) => Promise<unknown>;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
}

export interface IntegrationsStatus {
  deepspace: ReturnType<DeepSpace['status']>;
  guide: ReturnType<GuideClient['status']>;
  publicUrl: string | null;
}

export interface Integrations {
  config: IntegrationsConfig;
  deepspace: DeepSpace;
  guideClient: GuideClient;
  guide: GuideProxy;
  /** Spread into Bun.serve({ routes }). */
  routes: IntegrationRoutes;
  /** Fetch-style alternative to `routes`. */
  handle: (req: Request) => Promise<Response | null>;
  /** Starts the presence push and the notes poller (no-ops when DS_URL is unset). Safe to call twice. */
  start(): void;
  stop(): void;
  status(): Promise<IntegrationsStatus>;
  /** describeForJob with this instance's guide client and timeout. */
  describeForJob(imagePath: string): Promise<string | null>;
  /** describeClipForJob (a Video memory's frames) with this instance's guide client and clip budget. */
  describeClipForJob(videoPath: string, scene: { id: string; name?: string }, opts?: Pick<ClipDescribeOptions, 'imagePath' | 'packed'>): Promise<string | null>;
  /** Call when a scene becomes ready: caches the greeting with the thumbnail. Never throws. */
  narrateWarmup(sceneId: string): Promise<boolean>;
}

export function createIntegrations(opts: IntegrationsOptions): Integrations {
  const config = opts.config ?? integrationsConfigFromEnv(opts.env);
  const base = opts.log ?? console;
  const dsLog = prefixedLogger('deepspace', base);
  const guideLog = prefixedLogger('guide', base);
  const deepspace = createDeepSpace({
    config: config.deepspace,
    presence: opts.presence,
    fetch: opts.fetch,
    now: opts.now,
    log: dsLog,
    onNotes: (sceneId, notes) => {
      if (!opts.publish) return;
      for (const note of notes) opts.publish(noteEvent(sceneId, note));
    },
  });
  const guideClient = createGuideClient({ config: config.guide, fetch: opts.fetch, log: guideLog, now: opts.now });
  const guide = createGuideProxy({
    client: guideClient,
    config: config.guide,
    getScene: (id) => opts.store.get(id),
    sceneDir: (id) => opts.store.sceneDir(id),
    getHotspots: opts.getHotspots,
    log: guideLog,
  });
  const routeDeps: IntegrationRoutesDeps = {
    notes: deepspace.notes,
    guide,
    guard: opts.guard,
    sceneExists: async (id) => !!(await opts.store.get(id)),
    log: prefixedLogger('http', base),
  };
  let started = false;
  return {
    config,
    deepspace,
    guideClient,
    guide,
    routes: createIntegrationRoutes(routeDeps),
    handle: createIntegrationHandler(routeDeps),
    start() {
      if (started) return;
      started = true;
      deepspace.start();
      if (config.guide.url) guideClient.startMonitor();
      else guideLog.info('GUIDE_URL is not set: labels, voice answers and greetings use their fallbacks');
    },
    stop() {
      started = false;
      deepspace.stop();
      guideClient.close();
    },
    async status() {
      return { deepspace: deepspace.status(), guide: guideClient.status(), publicUrl: await readPublicUrl(config.publicUrlFile) };
    },
    describeForJob: (imagePath) => describeForJob(imagePath, { client: guideClient, timeoutMs: config.guide.timeouts.describe, log: guideLog }),
    describeClipForJob: (videoPath, scene, o = {}) =>
      describeClipForJob(videoPath, scene, { ...o, client: guideClient, timeoutMs: config.guide.timeouts.describeClip, log: guideLog }),
    narrateWarmup: (sceneId) => guide.narrateWarmup(sceneId),
  };
}
