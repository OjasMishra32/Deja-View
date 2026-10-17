// Writes the presence stream into the replay database: every snapshot the presence store pushes (at most 5 a second
// per scene, contracts 3.3) becomes one row per person, and every Roblox moment (tag, round) becomes a moment row.
//
// Writes are batched once a second. When the database is slow or gone, rows wait in a bounded buffer (the oldest are
// dropped first) and the next tries back off, so a lost connection never slows the presence spine down.

import type { PersonView, PresenceEvent } from '../social/presence.ts';
import type { Moment, ReplayDb, Sample } from './store.ts';

export interface PresenceFeedLike {
  onPresence(fn: (sceneId: string, people: PersonView[], t: number) => void): () => void;
  onEvent(fn: (sceneId: string, event: PresenceEvent) => void): () => void;
}

export interface RecorderOptions {
  db: ReplayDb;
  presence: PresenceFeedLike;
  /** Batch period. Default 1000 ms. */
  flushMs?: number;
  /** Rows kept while the database is unreachable. Default 50 000 (about 40 minutes of 5 people). */
  maxBuffer?: number;
  /** Rows per INSERT. Default 2000. */
  batch?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RecorderStatus {
  written: number;
  moments: number;
  buffered: number;
  dropped: number;
  lastWriteAt: number | null;
  error: string | null;
}

export interface Recorder {
  start(): void;
  /** Stops listening and writes what is left (best effort). */
  stop(): Promise<void>;
  flush(): Promise<void>;
  status(): RecorderStatus;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export function createRecorder(opts: RecorderOptions): Recorder {
  const { db, presence } = opts;
  const flushMs = opts.flushMs ?? 1000;
  const maxBuffer = opts.maxBuffer ?? 50_000;
  const batch = opts.batch ?? 2000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));

  let samples: Sample[] = [];
  let moments: Moment[] = [];
  const st: RecorderStatus = { written: 0, moments: 0, buffered: 0, dropped: 0, lastWriteAt: null, error: null };
  let failures = 0;
  let retryAt = 0;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const unsubs: (() => void)[] = [];

  function trim() {
    const over = samples.length - maxBuffer;
    if (over > 0) {
      samples.splice(0, over);
      st.dropped += over;
    }
    if (moments.length > 5000) moments.splice(0, moments.length - 5000);
  }

  function onPresence(sceneId: string, people: PersonView[], t: number) {
    if (!people.length) return;
    const at = Math.round(t * 1000);
    for (const p of people) {
      if (![p.x, p.y, p.z, p.yaw].every(Number.isFinite)) continue;
      samples.push({ t: at, sceneId, personId: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    }
    trim();
  }

  function onEvent(sceneId: string, ev: PresenceEvent) {
    const { type, t, ...body } = ev;
    moments.push({ t: Math.round((Number.isFinite(t) ? t : now() / 1000) * 1000), sceneId, type: String(type), body });
    trim();
  }

  async function writeOnce(): Promise<void> {
    if (now() < retryAt) return;
    try {
      while (samples.length) {
        const part = samples.slice(0, batch);
        await db.insertSamples(part);
        samples.splice(0, part.length);
        st.written += part.length;
      }
      if (moments.length) {
        const part = moments.slice();
        await db.insertMoments(part);
        moments.splice(0, part.length);
        st.moments += part.length;
      }
      if (failures) log('[replay] writing again');
      failures = 0;
      st.error = null;
      st.lastWriteAt = now();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (!failures || st.error !== msg) log(`[replay] write failed, keeping ${samples.length} rows for later: ${msg}`);
      st.error = msg;
      retryAt = now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
    }
  }

  function flush(): Promise<void> {
    if (!flushing) flushing = writeOnce().finally(() => (flushing = null));
    return flushing;
  }

  return {
    start() {
      if (timer) return;
      unsubs.push(presence.onPresence(onPresence), presence.onEvent(onEvent));
      timer = setInterval(() => void flush(), flushMs);
      (timer as { unref?: () => void }).unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
      retryAt = 0;
      await flushing;
      await flush();
    },
    flush,
    status() {
      return { ...st, buffered: samples.length };
    },
  };
}
