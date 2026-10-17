// Replays of a memory: who walked where, and when. The presence stream is recorded into Tiger Data (or any Postgres)
// through TIGER_DATA_URL; without it the routes answer 503 and nothing else changes.
//
//   GET /api/replay/status                      on or off, what the database supports, rows written, the last error
//   GET /api/replay/:sceneId/sessions           the visits to a memory: [{from, to, seconds, names}], newest first
//   GET /api/replay/:sceneId?from&to&step       everyone's path in a time range (default: the latest visit),
//                                               column arrays per person, plus the Roblox moments in that range
//   GET /api/replay/:sceneId/heat?from&to&cell  person-seconds per floor cell (default cell 0.5 m, latest visit)
//
// Times are Unix milliseconds; positions are room-frame metres (team/contracts.md 3.1). Read-only, CORS *.

import type { Scene } from '../../shared/types.ts';
import { fail, json, methodNotAllowed, preflight, SCENE_ID_RE } from '../social/http.ts';
import { createRecorder, type PresenceFeedLike, type Recorder } from './recorder.ts';
import { openReplayDb, redactUrl, type Features, type ReplayDb } from './store.ts';

export type ReplayHandler = (req: Request) => Promise<Response>;

export interface ReplayDeps {
  /** TIGER_DATA_URL. Missing or empty: replay is off. */
  url?: string | null;
  presence: PresenceFeedLike;
  getScene: (id: string) => Promise<Scene | null>;
  /** Tests inject a database. */
  open?: (url: string) => Promise<ReplayDb>;
  /** Wait between connection attempts. Default 30 s. */
  retryMs?: number;
  log?: (msg: string) => void;
}

export interface ReplayStatus {
  enabled: boolean;
  connected: boolean;
  database: string | null;
  features: Features | null;
  written: number;
  moments: number;
  buffered: number;
  dropped: number;
  lastWriteAt: number | null;
  error: string | null;
}

export interface Replay {
  readonly enabled: boolean;
  routes: Record<string, ReplayHandler>;
  start(): void;
  stop(): Promise<void>;
  status(): ReplayStatus;
}

/** Longest range one request may ask for. */
const MAX_RANGE_MS = 3 * 3600_000;
/** Points per person a replay returns at most; the step grows to fit. */
const MAX_POINTS = 2400;
const DEFAULT_STEP_MS = 250;

const MESSAGES = {
  off: 'Replays are off on this server. Set TIGER_DATA_URL to turn them on.',
  connecting: 'The replay database is not reachable right now. Try again in a moment.',
  noScene: 'No such scene',
  badRange: 'Give from and to as Unix milliseconds, from before to, at most 3 hours apart.',
  server: 'Something went wrong on the server. Try again.',
} as const;

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createReplay(deps: ReplayDeps): Replay {
  const url = (deps.url ?? '').trim() || null;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const open = deps.open ?? ((u: string) => openReplayDb(u, { log }));
  const retryMs = deps.retryMs ?? 30_000;

  let db: ReplayDb | null = null;
  let connectError: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // The recorder starts at once and buffers; this stand-in refuses writes until the database is open.
  const lazy: ReplayDb = {
    get features() {
      return db?.features ?? { postgres: '', timescale: null, hypertable: false, aggregate: false, compression: false };
    },
    insertSamples: (rows) => (db ? db.insertSamples(rows) : Promise.reject(new Error(connectError ?? 'not connected yet'))),
    insertMoments: (rows) => (db ? db.insertMoments(rows) : Promise.reject(new Error(connectError ?? 'not connected yet'))),
    tracks: (...a) => db!.tracks(...a),
    moments: (...a) => db!.moments(...a),
    heat: (...a) => db!.heat(...a),
    sessions: (...a) => db!.sessions(...a),
    count: (...a) => db!.count(...a),
    close: async () => {},
  };
  const recorder: Recorder | null = url ? createRecorder({ db: lazy, presence: deps.presence, log }) : null;

  async function connect(): Promise<void> {
    if (!url || db || stopped) return;
    try {
      db = await open(url);
      connectError = null;
      const f = db.features;
      log(
        `[replay] recording to ${redactUrl(url)} (Postgres ${f.postgres}${f.timescale ? `, TimescaleDB ${f.timescale}` : ''}` +
          `${f.hypertable ? ', hypertable' : ''}${f.aggregate ? ', 1 s continuous aggregate' : ''}${f.compression ? ', compression' : ''})`,
      );
    } catch (e) {
      connectError = (e as Error).message || String(e);
      log(`[replay] cannot reach ${redactUrl(url)}: ${connectError}. Trying again in ${Math.round(retryMs / 1000)} s.`);
      retryTimer = setTimeout(() => void connect(), retryMs);
      (retryTimer as { unref?: () => void }).unref?.();
    }
  }

  const sceneExists = async (id: string) => {
    try {
      return !!(await deps.getScene(id));
    } catch {
      return false;
    }
  };

  /** The asked range, or the latest visit when none is given. null = no history yet. */
  async function rangeOf(params: URLSearchParams, sceneId: string): Promise<{ from: number; to: number } | 'bad' | null> {
    const from = num(params.get('from'));
    const to = num(params.get('to'));
    if (from === null && to === null) {
      const [latest] = await db!.sessions(sceneId, 60, 1);
      if (!latest) return null;
      return { from: Math.max(latest.from, latest.to - MAX_RANGE_MS), to: latest.to };
    }
    const f = from ?? (to as number) - 600_000;
    const t = to ?? Date.now();
    if (!(t > f) || t - f > MAX_RANGE_MS) return 'bad';
    return { from: f, to: t };
  }

  const handler: ReplayHandler = async (req) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const u = new URL(req.url);
    const parts = u.pathname.split('/').filter(Boolean); // api, replay, <id>, <what>?
    const sceneId = parts[2] ? decodeURIComponent(parts[2]) : '';
    const what = parts[3] ?? '';

    if (sceneId === 'status' && !what) return json(status());
    if (!url) return fail(503, MESSAGES.off, { enabled: false });
    if (!SCENE_ID_RE.test(sceneId) || (what && what !== 'heat' && what !== 'sessions')) return fail(404, MESSAGES.noScene);
    if (!db) return fail(503, MESSAGES.connecting, { enabled: true }, { 'Retry-After': '10' });
    if (!(await sceneExists(sceneId))) return fail(404, MESSAGES.noScene);

    try {
      // what was just recorded should be in the answer
      await recorder?.flush();
      if (what === 'sessions') {
        const limit = clamp(num(u.searchParams.get('limit')) ?? 20, 1, 100);
        return json({ sceneId, sessions: await db.sessions(sceneId, 60, limit) });
      }
      const range = await rangeOf(u.searchParams, sceneId);
      if (range === 'bad') return fail(400, MESSAGES.badRange);
      if (!range) {
        return what === 'heat'
          ? json({ sceneId, from: null, to: null, cell: null, max: 0, cells: [] })
          : json({ sceneId, from: null, to: null, step: null, people: [], moments: [] });
      }
      if (what === 'heat') {
        const cell = clamp(num(u.searchParams.get('cell')) ?? 0.5, 0.1, 5);
        const cells = await db.heat(sceneId, range.from, range.to, cell);
        return json({ sceneId, ...range, cell, max: cells.reduce((m, c) => Math.max(m, c.seconds), 0), cells });
      }
      const span = range.to - range.from;
      const step = Math.max(clamp(num(u.searchParams.get('step')) ?? DEFAULT_STEP_MS, 100, 60_000), Math.ceil(span / MAX_POINTS));
      const [people, moments] = await Promise.all([db.tracks(sceneId, range.from, range.to, step), db.moments(sceneId, range.from, range.to)]);
      return json({
        sceneId,
        ...range,
        step,
        people,
        moments: moments.map((m) => ({ ...m.body, type: m.type, t: m.t - range.from })),
      });
    } catch (e) {
      log(`[replay] ${req.method} ${u.pathname}: ${(e as Error).stack ?? e}`);
      return fail(500, MESSAGES.server);
    }
  };

  function status(): ReplayStatus {
    const r = recorder?.status();
    return {
      enabled: !!url,
      connected: !!db,
      database: url ? redactUrl(url) : null,
      features: db?.features ?? null,
      written: r?.written ?? 0,
      moments: r?.moments ?? 0,
      buffered: r?.buffered ?? 0,
      dropped: r?.dropped ?? 0,
      lastWriteAt: r?.lastWriteAt ?? null,
      error: db ? (r?.error ?? null) : url ? connectError : null,
    };
  }

  return {
    enabled: !!url,
    routes: {
      '/api/replay/status': handler,
      '/api/replay/:sceneId': handler,
      '/api/replay/:sceneId/:what': handler,
    },
    start() {
      if (!url) return;
      stopped = false;
      recorder!.start();
      void connect();
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      await recorder?.stop();
      const d = db;
      db = null;
      await d?.close().catch(() => {});
    },
    status,
  };
}
