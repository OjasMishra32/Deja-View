// Routes for shared presence and Roblox (team/contracts.md 5 and 6), as a Bun.serve `routes` object:
//
//   GET  /api/presence/:sceneId           everyone in a scene, metres
//   POST /api/presence/:sceneId           headset / browser viewer (4 Hz, metres) -> everyone else
//   GET  /api/roblox/:sceneId/map         the room as coloured boxes in studs (built once, cached, gzip), plus
//                                         walkBounds (world.bounds in studs) when the scene has them
//   POST /api/roblox/:sceneId/presence    a Roblox game server's players (4 Hz, studs) -> everyone else in studs
//   POST /api/roblox/:sceneId/event       a Roblox moment (tag, round) -> onEvent subscribers (the /ws layer)
//
// Every handler answers OPTIONS (CORS *), returns JSON errors as {error: "<sentence>"} and never throws: a broken
// request, a slow disk or a failing subscriber becomes a 4xx/5xx for that request only.
// /api/roblox/* checks DV_KEY (x-dejaview-key) only when a key is configured; requests from this machine skip it,
// but a request that came through the tunnel (it carries proxy headers) does not.

import { join } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import { isVideoScene } from '../copy.ts';
import {
  fail,
  json,
  keyRejected,
  methodNotAllowed,
  pathSegment,
  preflight,
  readJson,
  SCENE_ID_RE,
  SOCIAL_CORS,
  type RequestIpSource,
} from './http.ts';
import { parsePresenceBody, PresenceStore, type PresenceOptions } from './presence.ts';
import {
  mapChunk,
  mapResponse,
  mapWalkBounds,
  parseRobloxEvent,
  parseRobloxPresence,
  personToStuds,
  RobloxMapService,
  type MapServiceOptions,
} from './roblox.ts';

export type SocialHandler = (req: Request, server?: RequestIpSource) => Promise<Response>;
export type SocialRoutes = Record<string, SocialHandler>;

export interface SocialRouteDeps {
  getScene: (id: string) => Promise<Scene | null>;
  presence: PresenceStore;
  maps: RobloxMapService;
  /** DV_KEY; empty or missing means no key is required. */
  dvKey?: string | null;
  /** How long a scene lookup is reused (presence posts arrive 4 times a second). Default 1000 ms. */
  sceneCacheMs?: number;
  log?: (msg: string) => void;
}

const PRESENCE_BODY_MAX = 8 * 1024;
const ROBLOX_PRESENCE_BODY_MAX = 64 * 1024;
const EVENT_BODY_MAX = 8 * 1024;

const NO_SUCH_SCENE = 'No such scene';
/** contracts 6.1, 6.2: only Photo worlds become Roblox rooms; a Video memory stays in the headset and the browser. */
export const VIDEO_NO_ROOM = 'Video memories stay in the headset and the browser: only Photo worlds become Roblox rooms.';

/** The route table. Pass the result's entries into Bun.serve({ routes }). */
export function createSocialRoutes(deps: SocialRouteDeps): SocialRoutes {
  const { presence, maps } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const cacheMs = deps.sceneCacheMs ?? 1000;
  const sceneCache = new Map<string, { at: number; scene: Scene | null }>();
  const eventBuckets = new Map<string, { tokens: number; last: number }>();
  const recentEvents = new Map<string, number>();

  async function sceneFor(id: string | null): Promise<Scene | null> {
    if (!id || !SCENE_ID_RE.test(id)) return null;
    const now = Date.now();
    const hit = sceneCache.get(id);
    if (hit && now - hit.at < cacheMs) return hit.scene;
    let scene: Scene | null = null;
    try {
      scene = await deps.getScene(id);
    } catch (e) {
      log(`[social] scene lookup ${id} failed: ${(e as Error).message}`);
    }
    sceneCache.set(id, { at: now, scene });
    if (sceneCache.size > 512) sceneCache.delete(sceneCache.keys().next().value!);
    return scene;
  }

  /** Runs a handler and turns anything it throws into a 500, so one bad request never takes the server down. */
  function safe(name: string, fn: SocialHandler): SocialHandler {
    return async (req, server) => {
      try {
        return await fn(req, server);
      } catch (e) {
        log(`[social] ${name} ${req.method} ${new URL(req.url).pathname}: ${(e as Error).stack ?? e}`);
        return fail(500, 'Something went wrong on the server. Try again.');
      }
    };
  }

  async function active(): Promise<{ sceneId: string; name: string } | null> {
    const a = presence.activeHeadset();
    if (!a) return null;
    const s = await sceneFor(a.sceneId);
    return { sceneId: a.sceneId, name: s?.name ?? a.sceneId };
  }

  function withRound(sceneId: string, body: Record<string, unknown>): Record<string, unknown> {
    const round = presence.currentRound(sceneId);
    if (round) body.round = round;
    return body;
  }

  // ------------------------------------------------------------ /api/presence/:sceneId (metres)

  const presenceRoute: SocialHandler = async (req) => {
    if (req.method === 'OPTIONS') return preflight();
    const sceneId = pathSegment(req, 3);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!(await sceneFor(sceneId))) return fail(404, NO_SUCH_SCENE);
      const snap = presence.snapshot(sceneId!);
      return json(withRound(sceneId!, { t: snap.t, people: snap.people }));
    }
    if (req.method !== 'POST') return methodNotAllowed('GET, HEAD, POST, OPTIONS');
    const body = await readJson(req, PRESENCE_BODY_MAX);
    if (!body.ok) return fail(body.status, body.error);
    const parsed = parsePresenceBody(body.value);
    if (!parsed.ok) return fail(400, parsed.error);
    if (!(await sceneFor(sceneId))) return fail(404, NO_SUCH_SCENE);
    const res = presence.upsert(sceneId!, parsed.value);
    if (!res.ok) {
      if (res.reason === 'rate') {
        const s = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
        return fail(429, 'Too many updates. Send at most 4 a second.', { retryAfter: res.retryAfterMs / 1000 }, { 'Retry-After': String(s) });
      }
      return fail(503, 'This room is full right now.', {}, { 'Retry-After': '5' });
    }
    const snap = presence.snapshot(sceneId!, [parsed.value.id]);
    return json(withRound(sceneId!, { t: snap.t, people: snap.people }));
  };

  // ------------------------------------------------------------ /api/roblox/:sceneId/presence (studs)

  const robloxPresenceRoute: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed('GET, POST, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const sceneId = pathSegment(req, 3);
    let players: ReturnType<typeof parseRobloxPresence> = { ok: true, value: { players: [], listed: [], skipped: [] } };
    if (req.method === 'POST') {
      const body = await readJson(req, ROBLOX_PRESENCE_BODY_MAX);
      if (!body.ok) return fail(body.status, body.error);
      players = parseRobloxPresence(body.value);
      if (!players.ok) return fail(400, players.error);
    }
    if (!(await sceneFor(sceneId))) return fail(404, NO_SUCH_SCENE);
    const batch = players.value;
    let limited = 0;
    for (const p of batch.players) {
      const r = presence.upsert(sceneId!, p);
      if (!r.ok) limited++;
    }
    if (batch.server) presence.syncServer(sceneId!, batch.server, batch.players.map((p) => p.id));
    const snap = presence.snapshot(sceneId!, batch.listed);
    const out: Record<string, unknown> = {
      t: snap.t,
      others: snap.people.map((p) => personToStuds(p)),
      active: await active(),
    };
    if (batch.skipped.length) out.skipped = batch.skipped.length;
    if (limited) out.limited = limited;
    if (batch.skipped.length) log(`[social] roblox presence ${sceneId}: skipped ${batch.skipped.map((s) => `#${s.index} ${s.error}`).join('; ')}`);
    return json(withRound(sceneId!, out));
  };

  // ------------------------------------------------------------ /api/roblox/:sceneId/event

  function eventAllowed(sceneId: string): boolean {
    const now = Date.now();
    const b = eventBuckets.get(sceneId) ?? { tokens: 20, last: now };
    b.tokens = Math.min(20, b.tokens + ((now - b.last) / 1000) * 5);
    b.last = now;
    eventBuckets.set(sceneId, b);
    if (eventBuckets.size > 512) eventBuckets.delete(eventBuckets.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Roblox retries a failed post up to 3 times: the same moment within 2 s is delivered once. */
  function duplicate(sceneId: string, ev: Record<string, unknown>): boolean {
    const now = Date.now();
    for (const [k, at] of recentEvents) if (now - at > 2000) recentEvents.delete(k);
    const key = `${sceneId}|${JSON.stringify(ev)}`;
    if (recentEvents.has(key)) return true;
    recentEvents.set(key, now);
    return false;
  }

  const eventRoute: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const sceneId = pathSegment(req, 3);
    const body = await readJson(req, EVENT_BODY_MAX);
    if (!body.ok) return fail(body.status, body.error);
    const parsed = parseRobloxEvent(body.value);
    if (!parsed.ok) return fail(400, parsed.error);
    if (!(await sceneFor(sceneId))) return fail(404, NO_SUCH_SCENE);
    if (!eventAllowed(sceneId!)) return fail(429, 'Too many events at once.', {}, { 'Retry-After': '1' });
    const ev = parsed.value;
    if (duplicate(sceneId!, ev)) return json({ ok: true, duplicate: true });
    if (ev.type === 'tag' && typeof ev.target === 'string') {
      // where the headset should play TAGGED: the target's latest position (room metres)
      const who = presence.get(ev.target);
      if (who && presence.sceneOf(ev.target) === sceneId) {
        ev.pos = [who.x, who.y, who.z];
        if (ev.targetName === undefined) ev.targetName = who.name;
      }
    }
    const sent = presence.publishEvent(sceneId!, ev);
    return json({ ok: true, t: sent.t });
  };

  // ------------------------------------------------------------ /api/roblox/:sceneId/map

  const mapRoute: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    const sceneId = pathSegment(req, 3);
    if (!sceneId || !SCENE_ID_RE.test(sceneId)) return fail(404, NO_SUCH_SCENE);
    const scene = await sceneFor(sceneId);
    if (isVideoScene(scene)) return fail(404, VIDEO_NO_ROOM);
    const url = new URL(req.url);
    const r = await maps.get(sceneId, url.searchParams.get('maxParts'));
    switch (r.status) {
      case 202:
        return json({ status: 'building', retryAfter: r.retryAfter }, 202, { 'Retry-After': String(r.retryAfter) });
      case 404:
        return fail(404, r.error);
      case 409:
        return fail(409, r.error, { status: r.sceneStatus });
      case 503:
        return fail(503, r.error, { retryAfter: r.retryAfter }, { 'Retry-After': String(r.retryAfter) });
      case 500:
        return fail(500, r.error);
    }
    const map = r.map;
    // the walk box (scene.json world.bounds in studs) is added at response time, so cached maps stay valid
    const walk = mapWalkBounds(map, scene);
    const chunkRaw = url.searchParams.get('chunk');
    if (chunkRaw !== null && chunkRaw !== '') {
      const c = mapChunk(map, Number(chunkRaw), walk);
      if (!c.ok) return fail(400, c.error);
      return json(c.body, 200, { 'Cache-Control': 'no-cache', 'X-Map-Parts': String(map.parts) });
    }
    const out = mapResponse(map, walk);
    const headers: Record<string, string> = {
      ...SOCIAL_CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: out.etag,
      Vary: 'Accept-Encoding',
      'X-Map-Parts': String(map.parts),
    };
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === out.etag || t.trim() === `W/${out.etag}`)) {
      return new Response(null, { status: 304, headers });
    }
    const gzip = /\bgzip\b/i.test(req.headers.get('accept-encoding') ?? '');
    const bytes = gzip ? out.gzip : out.body;
    if (gzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(bytes.byteLength);
    return new Response(req.method === 'HEAD' ? null : (bytes as Uint8Array<ArrayBuffer>), { status: 200, headers });
  };

  return {
    '/api/presence/:sceneId': safe('presence', presenceRoute),
    '/api/roblox/:sceneId/map': safe('roblox map', mapRoute),
    '/api/roblox/:sceneId/presence': safe('roblox presence', robloxPresenceRoute),
    '/api/roblox/:sceneId/event': safe('roblox event', eventRoute),
  };
}

// ---------------------------------------------------------------- one-call setup

export interface SocialOptions {
  getScene: (id: string) => Promise<Scene | null>;
  sceneDir: (id: string) => string;
  /** Repo root (pipeline/roblox_map.py lives under it; builds run with it as the working directory). */
  root: string;
  /** The repo's .venv python (server/config.ts LOCAL_PYTHON). */
  python: string;
  dvKey?: string | null;
  presence?: PresenceOptions;
  maps?: Partial<MapServiceOptions>;
  log?: (msg: string) => void;
}

export interface Social {
  presence: PresenceStore;
  maps: RobloxMapService;
  routes: SocialRoutes;
  stop(): void;
}

/** Creates the presence store (ticking), the map service and the routes in one go. */
export function createSocial(o: SocialOptions): Social {
  const presence = new PresenceStore({ log: o.log, ...o.presence }).start();
  const maps = new RobloxMapService({
    getScene: o.getScene,
    sceneDir: o.sceneDir,
    python: o.python,
    script: join(o.root, 'pipeline', 'roblox_map.py'),
    cwd: o.root,
    log: o.log,
    ...o.maps,
  });
  const routes = createSocialRoutes({ getScene: o.getScene, presence, maps, dvKey: o.dvKey, log: o.log });
  return {
    presence,
    maps,
    routes,
    stop() {
      presence.stop();
      maps.stop();
    },
  };
}
