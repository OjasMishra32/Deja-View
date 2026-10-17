// DeepSpace: the live presence push (team/contracts.md 7.1) and the notes relay (7.2).
//
// Presence push   every scene with people in it -> POST <DS_URL>/api/ingest about 4 times a second, a full snapshot of
//                 at most 32 people with exactly 7 fields each, header X-DejaView-Key. Fire and forget with a 2 s
//                 timeout; while a scene's previous push is in flight the next one is skipped (never queued); when
//                 DeepSpace is down every push pauses with exponential backoff; exactly one push with people: [] when
//                 the last person leaves.
// Notes           GET <DS_URL>/api/notes?sceneId=<id> every 2 s for every scene with someone in it (and at once when
//                 a scene gets its first person, or when the headset asks for its notes). The last good list is kept
//                 and served when DeepSpace is unreachable. New note ids go to onNotes listeners (the WebSocket layer
//                 broadcasts {type:"note", sceneId, note}). Headset-made notes are forwarded to POST <DS_URL>/api/notes.
//
// Nothing here throws into the caller or blocks a request on DeepSpace for longer than its timeout.

import {
  backoffMs,
  callJson,
  CONTRACT,
  hostOf,
  onceLogger,
  prefixedLogger,
  type CallResult,
  type DeepSpaceConfig,
  type FetchLike,
  type Logger,
} from './config.ts';

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** Longest pause between presence pushes while DeepSpace is down (1, 2, then 3 s). */
export const PRESENCE_BACKOFF_CAP_MS = 3000;
/** Longest pause between notes reads while DeepSpace is down (2, then 4 s). */
export const NOTES_BACKOFF_CAP_MS = 4000;

export function isSceneId(s: unknown): s is string {
  return typeof s === 'string' && SCENE_ID.test(s);
}

// ---------------------------------------------------------------------------------------------------------------
// Presence source adapter

export type PersonKind = 'vr' | 'roblox' | 'web';
const KINDS = new Set<string>(['vr', 'roblox', 'web']);

/** A person as the presence layer holds them (metres, room frame, feet). Extra fields are fine; they are dropped. */
export interface PresencePerson {
  id: string;
  name?: string;
  kind?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  [extra: string]: unknown;
}

/** Exactly the 7 fields DeepSpace receives per person. */
export interface IngestPerson {
  id: string;
  name: string;
  kind: PersonKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface IngestBody {
  sceneId: string;
  /** Unix seconds (float) on this server's clock when the snapshot was taken. */
  t: number;
  people: IngestPerson[];
}

/**
 * One scene's people: an array, or the GET /api/presence/:sceneId shape {t, people}. Elements are typed loosely on
 * purpose (any presence layer's person type fits, e.g. server/social PersonView); each one is checked at runtime and
 * people with a missing or non-finite coordinate are skipped.
 */
export type PresenceList = readonly unknown[] | { readonly people?: readonly unknown[] | null } | null | undefined;

/** Every scene with people in it. Scenes missing from a snapshot count as empty. */
export type PresenceSnapshot =
  | ReadonlyMap<string, PresenceList>
  | Readonly<Record<string, PresenceList>>
  | Iterable<readonly [string, PresenceList]>;

/**
 * What the forwarder needs from the presence layer: who is in which scene right now. It is called about 4 times a
 * second and may be sync or async; a slow call never stacks up (the next tick waits for it).
 */
export interface PresenceSource {
  snapshot(): PresenceSnapshot | Promise<PresenceSnapshot>;
}

/** Adapter for a pull-style presence layer: a list of scene ids plus getPresence(sceneId). */
export function presenceFromGetter(opts: {
  scenes: () => Iterable<string> | Promise<Iterable<string>>;
  get: (sceneId: string) => PresenceList | Promise<PresenceList>;
}): PresenceSource {
  return {
    async snapshot() {
      const ids = [...new Set(await opts.scenes())];
      const lists = await Promise.all(ids.map(async (id) => [id, await opts.get(id)] as const));
      return lists;
    },
  };
}

export interface PresenceFeed extends PresenceSource {
  /** The presence layer calls this on every update for a scene (each presence POST, or each change), full list. */
  onPresence(sceneId: string, people: PresenceList): void;
  /** Scenes with people right now. */
  scenes(): string[];
  clear(sceneId?: string): void;
}

/**
 * Adapter for a push-style presence layer. Call feed.onPresence(sceneId, people) whenever a scene's people change
 * or a presence POST arrives. A scene that has not been refreshed for `staleMs` (default 3.5 s, just over the
 * contract's 3 s drop) counts as empty, so a layer that forgets to report a departure never leaves a ghost on the map.
 */
export function createPresenceFeed(opts: { staleMs?: number; now?: () => number } = {}): PresenceFeed {
  const staleMs = opts.staleMs ?? 3500;
  const now = opts.now ?? Date.now;
  const latest = new Map<string, { people: unknown[]; at: number }>();
  const fresh = () => {
    const t = now();
    for (const [id, v] of latest) if (t - v.at > staleMs || !v.people.length) latest.delete(id);
    return latest;
  };
  return {
    onPresence(sceneId, people) {
      if (!isSceneId(sceneId)) return;
      const arr = listOf(people);
      if (!arr.length) latest.delete(sceneId);
      else latest.set(sceneId, { people: [...arr], at: now() });
    },
    scenes: () => [...fresh().keys()],
    clear(sceneId) {
      if (sceneId === undefined) latest.clear();
      else latest.delete(sceneId);
    },
    snapshot() {
      return new Map([...fresh()].map(([id, v]) => [id, v.people] as const));
    },
  };
}

function listOf(list: PresenceList): readonly unknown[] {
  if (Array.isArray(list)) return list;
  const people = (list as { people?: unknown } | null | undefined)?.people;
  return Array.isArray(people) ? people : [];
}

function entriesOf(snap: PresenceSnapshot): Iterable<readonly [string, PresenceList]> {
  if (snap instanceof Map) return snap.entries();
  if (snap && typeof (snap as Iterable<unknown>)[Symbol.iterator] === 'function') return snap as Iterable<readonly [string, PresenceList]>;
  return Object.entries(snap as Record<string, PresenceList>);
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

const round = (v: number, dp: number) => {
  const k = 10 ** dp;
  return Math.round(v * k) / k + 0; // + 0 turns -0 into 0
};

/** Radians wrapped to (-pi, pi]. */
export function wrapYaw(a: number): number {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
}

function guessKind(id: string): PersonKind {
  if (id.startsWith('quest-')) return 'vr';
  if (id.startsWith('rbx-')) return 'roblox';
  return 'web';
}

/** One person in the ingest shape, or null when a coordinate is missing or not finite. */
export function toIngestPerson(p: unknown): IngestPerson | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim().slice(0, 64) : '';
  if (!id) return null;
  const nums = [o.x, o.y, o.z, o.yaw];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const [x, y, z, yaw] = nums as number[];
  const kind = typeof o.kind === 'string' && KINDS.has(o.kind) ? (o.kind as PersonKind) : guessKind(id);
  const rawName = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : '';
  return { id, name: clip(rawName || id, CONTRACT.authorMax), kind, x: round(x!, 3), y: round(y!, 3), z: round(z!, 3), yaw: round(wrapYaw(yaw!), 4) };
}

const KIND_RANK: Record<PersonKind, number> = { vr: 0, roblox: 1, web: 2 };

/** A scene's people as DeepSpace gets them: valid, de-duplicated, at most `max` (headsets are never the ones cut). */
export function toIngestPeople(list: PresenceList, max: number = CONTRACT.maxPeople): IngestPerson[] {
  const out: IngestPerson[] = [];
  const ids = new Set<string>();
  for (const raw of listOf(list)) {
    const p = toIngestPerson(raw);
    if (!p || ids.has(p.id)) continue;
    ids.add(p.id);
    out.push(p);
  }
  if (out.length > max) {
    out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    out.length = max;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared link state (one per DeepSpace URL use: presence and notes keep their own, so one never mutes the other)

interface LinkState {
  up: boolean | null;
  failures: number;
  backoffUntil: number;
  lastOkAt: number | null;
  lastError: string | null;
}

function describeFailure(r: CallResult): string {
  if (r.kind === 'http') {
    const err = typeof r.body?.error === 'string' ? `: ${r.body.error.slice(0, 120)}` : '';
    return `HTTP ${r.status}${err}`;
  }
  return r.detail ?? r.kind;
}

function keyHeaders(key: string | null): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(key ? { 'X-DejaView-Key': key } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Presence forwarder

export interface ForwarderStatus {
  enabled: boolean;
  host: string | null;
  /** null until the first push answered. */
  up: boolean | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Successful pushes since start. */
  pushes: number;
  failures: number;
  /** Pushes skipped because the scene's previous one was still in flight. */
  skippedInFlight: number;
  /** Ticks skipped while backing off. */
  skippedBackoff: number;
  /** Scenes with people in the last snapshot. */
  scenes: string[];
  inFlight: number;
}

export interface DeepSpaceForwarder {
  /** Starts the 250 ms loop (does nothing when DS_URL is unset). */
  start(): void;
  stop(): void;
  /** One pass: take a snapshot, push what is due. Exposed for tests; start() calls it on a timer. */
  tick(): Promise<void>;
  /** Resolves when no push is in flight (tests). */
  idle(): Promise<void>;
  /** Scenes with people in the last snapshot (feeds the notes poller). */
  activeScenes(): string[];
  status(): ForwarderStatus;
}

export interface ForwarderOptions {
  config: Pick<DeepSpaceConfig, 'url' | 'key' | 'pushHz' | 'idleHz' | 'pushTimeoutMs' | 'maxPeople'>;
  source: PresenceSource;
  fetch?: FetchLike;
  /** Milliseconds since the epoch (Date.now). `t` in each push is now() / 1000. */
  now?: () => number;
  log?: Logger;
  /** Most pushes in flight at once across all scenes. */
  maxInFlight?: number;
  tickMs?: number;
}

interface SceneState {
  inFlight: boolean;
  lastSentAt: number;
  lastSig: string;
  /** DeepSpace may believe people are here: an empty push is owed when they are gone. */
  occupied: boolean;
  emptyPending: boolean;
  emptyAttempts: number;
}

const TICK_SLACK_MS = 40;

export function createDeepSpaceForwarder(opts: ForwarderOptions): DeepSpaceForwarder {
  const cfg = opts.config;
  const enabled = !!cfg.url;
  const doFetch: FetchLike = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? prefixedLogger('deepspace');
  const once = onceLogger(log);
  const maxInFlight = opts.maxInFlight ?? 8;
  const tickMs = opts.tickMs ?? 250;
  const url = `${cfg.url ?? ''}/api/ingest`;
  const headers = keyHeaders(cfg.key);

  const scenes = new Map<string, SceneState>();
  const pending = new Set<Promise<void>>();
  const link: LinkState = { up: null, failures: 0, backoffUntil: 0, lastOkAt: null, lastError: null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let snapshotting = false;
  let lastActive: string[] = [];
  let inFlight = 0;
  const stats = { pushes: 0, failures: 0, skippedInFlight: 0, skippedBackoff: 0 };

  function state(id: string): SceneState {
    let s = scenes.get(id);
    if (!s) {
      s = { inFlight: false, lastSentAt: -Infinity, lastSig: '', occupied: false, emptyPending: false, emptyAttempts: 0 };
      scenes.set(id, s);
    }
    return s;
  }

  function markUp(t: number) {
    if (link.up === false) log.info(`DeepSpace is back (${hostOf(cfg.url)}); presence push resumed`);
    link.up = true;
    link.failures = 0;
    link.backoffUntil = 0;
    link.lastOkAt = t;
    link.lastError = null;
  }

  function markDown(t: number, reason: string, minBackoffMs = 0) {
    link.failures++;
    stats.failures++;
    // a push is tiny, so the cap is short: the map wakes up within about 3 s of DeepSpace coming back
    link.backoffUntil = t + Math.max(minBackoffMs, backoffMs(link.failures, 1000, PRESENCE_BACKOFF_CAP_MS));
    if (link.up !== false) log.warn(`DeepSpace presence push failing (${reason}); backing off and retrying`);
    link.up = false;
    link.lastError = reason;
  }

  function onResult(id: string, st: SceneState, r: CallResult, empty: boolean) {
    const t = now();
    let delivered = false;
    if (r.kind === 'ok') {
      markUp(t);
      stats.pushes++;
      delivered = true;
    } else if (r.kind === 'http' && (r.status === 400 || r.status === 413 || r.status === 422)) {
      // A contract bug, not an outage: log it once, keep pushing.
      markUp(t);
      once.warn(`ingest-${r.status}-${describeFailure(r)}`, `DeepSpace refused a presence push for ${id} (${describeFailure(r)})`);
      delivered = true;
    } else if (r.kind === 'http' && (r.status === 401 || r.status === 403)) {
      markDown(t, `HTTP ${r.status}: DeepSpace refused the key (check DS_KEY)`, 10_000);
    } else if (r.kind === 'http' && r.status === 404) {
      markDown(t, 'HTTP 404: DeepSpace has no /api/ingest route (not deployed yet?)', 5000);
    } else {
      markDown(t, describeFailure(r));
    }
    if (empty) {
      if (delivered) st.emptyPending = false;
      else if (++st.emptyAttempts >= 3) st.emptyPending = false;
      if (!st.emptyPending && !st.occupied && !st.inFlight) scenes.delete(id);
    }
  }

  function push(id: string, people: IngestPerson[], t: number, empty: boolean) {
    const st = state(id);
    if (st.inFlight) {
      stats.skippedInFlight++;
      return;
    }
    if (inFlight >= maxInFlight) return;
    const sig = empty ? '[]' : JSON.stringify(people);
    const gap = 1000 / (sig === st.lastSig ? cfg.idleHz : cfg.pushHz);
    if (!empty && t - st.lastSentAt < gap - TICK_SLACK_MS) return;
    const body: IngestBody = { sceneId: id, t: round(t / 1000, 3), people };
    const text = JSON.stringify(body);
    if (text.length > CONTRACT.maxIngestBytes) {
      once.warn(`too-big-${id}`, `presence push for ${id} is over 32 KB; skipped`);
      return;
    }
    st.inFlight = true;
    st.lastSentAt = t;
    st.lastSig = sig;
    inFlight++;
    const p = callJson(doFetch, url, { method: 'POST', headers, body: text, timeoutMs: cfg.pushTimeoutMs })
      .then((r) => onResult(id, st, r, empty))
      .catch((e) => once.warn('push-crash', `presence push error: ${(e as Error)?.message ?? e}`))
      .finally(() => {
        st.inFlight = false;
        inFlight--;
        pending.delete(p);
      });
    pending.add(p);
  }

  async function readSnapshot(): Promise<Map<string, IngestPerson[]>> {
    const out = new Map<string, IngestPerson[]>();
    const snap = await opts.source.snapshot();
    if (!snap) return out;
    for (const [id, list] of entriesOf(snap)) {
      if (!isSceneId(id)) continue;
      const people = toIngestPeople(list, cfg.maxPeople);
      if (people.length) out.set(id, people);
    }
    return out;
  }

  async function tick(): Promise<void> {
    if (snapshotting) return;
    snapshotting = true;
    let snap: Map<string, IngestPerson[]>;
    try {
      snap = await readSnapshot();
      once.reset('snapshot');
    } catch (e) {
      once.warn('snapshot', `presence snapshot failed: ${(e as Error)?.message ?? e}`);
      return;
    } finally {
      snapshotting = false;
    }
    const t = now();
    for (const [id, st] of scenes) {
      if (st.occupied && !snap.has(id)) {
        st.occupied = false;
        st.emptyPending = true;
        st.emptyAttempts = 0;
      }
    }
    for (const id of snap.keys()) {
      const st = state(id);
      st.occupied = true;
      st.emptyPending = false;
    }
    lastActive = [...snap.keys()];
    if (!enabled) return;
    if (t < link.backoffUntil) {
      stats.skippedBackoff++;
      return;
    }
    for (const [id, people] of snap) push(id, people, t, false);
    for (const [id, st] of scenes) if (st.emptyPending) push(id, [], t, true);
    for (const [id, st] of scenes) if (!st.occupied && !st.emptyPending && !st.inFlight) scenes.delete(id);
  }

  return {
    start() {
      if (timer) return;
      if (!enabled) {
        log.info('DS_URL is not set: the live map push is off');
        return;
      }
      log.info(`pushing presence to ${hostOf(cfg.url)} at ${cfg.pushHz} Hz${cfg.key ? '' : ' (no DS_KEY set: DeepSpace will refuse it)'}`);
      timer = setInterval(() => void tick(), tickMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    activeScenes: () => [...lastActive],
    status: () => ({
      enabled,
      host: hostOf(cfg.url),
      up: link.up,
      lastOkAt: link.lastOkAt,
      lastError: link.lastError,
      ...stats,
      scenes: [...lastActive],
      inFlight,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Notes relay

/** A note exactly as DeepSpace stores it (7.2). */
export interface DeepSpaceNote {
  id: string;
  sceneId: string;
  author: string;
  text: string;
  x: number;
  y: number;
  z: number;
  createdAt: string;
}

/** What the headset posts to POST /api/notes/:sceneId. */
export interface NoteInput {
  author?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

/** Receives only notes whose ids were not seen before, oldest first. */
export type NotesListener = (sceneId: string, notes: DeepSpaceNote[]) => void;

/** The /ws message for one new note. */
export function noteEvent(sceneId: string, note: DeepSpaceNote): { type: 'note'; sceneId: string; note: DeepSpaceNote } {
  return { type: 'note', sceneId, note };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A note from DeepSpace in the contract shape (only the 8 fields), or null when it is unusable. */
export function sanitizeNote(raw: unknown, sceneId: string): DeepSpaceNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const id = typeof n.id === 'string' ? n.id.trim().slice(0, 96) : typeof n.id === 'number' ? String(n.id) : '';
  if (!id) return null;
  if (n.sceneId !== undefined && n.sceneId !== sceneId) return null;
  const text = typeof n.text === 'string' ? n.text.trim() : '';
  if (!text || !finite(n.x) || !finite(n.z)) return null;
  return {
    id,
    sceneId,
    author: typeof n.author === 'string' ? clip(n.author.trim(), CONTRACT.authorMax) : '',
    text: clip(text, 500),
    x: n.x,
    y: finite(n.y) ? n.y : CONTRACT.noteDefaultY,
    z: n.z,
    createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
  };
}

export type NoteValidation =
  | { ok: true; note: { author: string; text: string; x: number; y: number; z: number } }
  | { ok: false; error: string };

export const NOTE_MESSAGES = {
  text: `Write a note of 1 to ${CONTRACT.noteTextMax} characters.`,
  position: 'A note needs a spot in the room: x, y and z in metres.',
  offline: 'notes offline',
  refused: "That note couldn't be saved. Try again.",
} as const;

/** Checks a headset-made note before it leaves the server. */
export function validateNoteInput(input: unknown, defaultAuthor = 'Judge'): NoteValidation {
  const b = (input && typeof input === 'object' ? input : {}) as NoteInput;
  const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || Array.from(text).length > CONTRACT.noteTextMax) return { ok: false, error: NOTE_MESSAGES.text };
  if (!finite(b.x) || !finite(b.z) || (b.y !== undefined && b.y !== null && !finite(b.y))) return { ok: false, error: NOTE_MESSAGES.position };
  const author = clip((typeof b.author === 'string' ? b.author.replace(/\s+/g, ' ').trim() : '') || defaultAuthor, CONTRACT.authorMax);
  return { ok: true, note: { author, text, x: b.x, y: finite(b.y) ? b.y : CONTRACT.noteDefaultY, z: b.z } };
}

export interface NotesStatus {
  enabled: boolean;
  host: string | null;
  up: boolean | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Scenes polled right now. */
  scenes: string[];
  polls: number;
  failures: number;
}

export interface NotesListResult {
  notes: DeepSpaceNote[];
  /** Set when the list could not be refreshed from DeepSpace (it is the last good one, or empty). */
  offline?: true;
}

export interface NotesRelay {
  start(): void;
  stop(): void;
  /** One scheduling pass (tests); start() runs it every 250 ms. */
  tick(): Promise<void>;
  idle(): Promise<void>;
  /** For GET /api/notes/:sceneId: the cached list at once; with no list yet, one fetch (at most ~1.5 s). */
  list(sceneId: string): Promise<NotesListResult>;
  /** For POST /api/notes/:sceneId: validate, forward, cache, announce. Returns the HTTP answer for the headset. */
  create(sceneId: string, input: unknown): Promise<{ status: number; body: unknown }>;
  /** Subscribe to new notes (the WebSocket layer). Returns an unsubscribe function. */
  onNotes(listener: NotesListener): () => void;
  /** Keeps a scene polled for `watchMs` even with nobody in it (a viewer that only reads notes). */
  watch(sceneId: string): void;
  cached(sceneId: string): DeepSpaceNote[] | null;
  status(): NotesStatus;
}

export interface NotesRelayOptions {
  config: Pick<DeepSpaceConfig, 'url' | 'key' | 'notesIntervalMs' | 'notesTimeoutMs' | 'notesPostTimeoutMs'>;
  /** Scenes with people right now (the forwarder's activeScenes, or the presence layer). */
  activeScenes?: () => Iterable<string>;
  fetch?: FetchLike;
  now?: () => number;
  log?: Logger;
  onNotes?: NotesListener;
  /** How long a GET /api/notes/:sceneId keeps that scene polled. */
  watchMs?: number;
  /** On the first good read of a scene, notes newer than this are announced; older ones are taken as known. */
  announceWindowMs?: number;
  /** How long GET /api/notes/:sceneId waits for the first read. */
  firstWaitMs?: number;
  /** Author for headset notes that carry none. */
  defaultAuthor?: string;
  maxInFlight?: number;
  tickMs?: number;
}

interface NotesScene {
  inFlight: Promise<void> | null;
  nextAt: number;
  failures: number;
  notes: DeepSpaceNote[] | null;
  ok: boolean;
  seeded: boolean;
  seen: Set<string>;
  watchedUntil: number;
}

export function createNotesRelay(opts: NotesRelayOptions): NotesRelay {
  const cfg = opts.config;
  const enabled = !!cfg.url;
  const doFetch: FetchLike = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? prefixedLogger('deepspace');
  const once = onceLogger(log);
  const watchMs = opts.watchMs ?? 15_000;
  const announceWindowMs = opts.announceWindowMs ?? 15_000;
  const firstWaitMs = opts.firstWaitMs ?? 1500;
  const maxInFlight = opts.maxInFlight ?? 8;
  const tickMs = opts.tickMs ?? 250;
  const headers = keyHeaders(cfg.key);
  const listeners = new Set<NotesListener>(opts.onNotes ? [opts.onNotes] : []);
  const scenes = new Map<string, NotesScene>();
  const link: LinkState = { up: null, failures: 0, backoffUntil: 0, lastOkAt: null, lastError: null };
  const counters = { polls: 0, failures: 0 };
  let polled: string[] = [];
  let inFlight = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function state(id: string): NotesScene {
    let s = scenes.get(id);
    if (!s) {
      s = { inFlight: null, nextAt: 0, failures: 0, notes: null, ok: false, seeded: false, seen: new Set(), watchedUntil: 0 };
      scenes.set(id, s);
    }
    return s;
  }

  function emit(sceneId: string, notes: DeepSpaceNote[]) {
    if (!notes.length) return;
    for (const fn of listeners) {
      try {
        fn(sceneId, notes);
      } catch (e) {
        once.warn('listener', `a notes listener threw: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  function up(t: number) {
    if (link.up === false) log.info('DeepSpace notes are back');
    link.up = true;
    link.failures = 0;
    link.lastOkAt = t;
    link.lastError = null;
  }

  function down(reason: string) {
    link.failures++;
    counters.failures++;
    if (link.up !== false) log.warn(`DeepSpace notes unreachable (${reason}); serving the last good list`);
    link.up = false;
    link.lastError = reason;
  }

  function accept(id: string, st: NotesScene, list: DeepSpaceNote[], t: number) {
    const fresh: DeepSpaceNote[] = [];
    if (!st.seeded) {
      for (const n of list) {
        if (st.seen.has(n.id)) continue;
        const age = t - Date.parse(n.createdAt);
        if (Number.isFinite(age) && age < announceWindowMs) fresh.push(n);
      }
      st.seeded = true;
    } else {
      for (const n of list) if (!st.seen.has(n.id)) fresh.push(n);
    }
    for (const n of list) st.seen.add(n.id);
    st.notes = list;
    st.ok = true;
    emit(id, fresh);
  }

  function poll(id: string, st: NotesScene): Promise<void> {
    if (st.inFlight) return st.inFlight;
    inFlight++;
    counters.polls++;
    const target = `${cfg.url}/api/notes?sceneId=${encodeURIComponent(id)}`;
    const p = callJson(doFetch, target, { method: 'GET', headers, timeoutMs: cfg.notesTimeoutMs })
      .then((r) => {
        const t = now();
        if (r.kind === 'ok' && Array.isArray(r.body?.notes)) {
          up(t);
          st.failures = 0;
          const list = (r.body.notes as unknown[]).map((n) => sanitizeNote(n, id)).filter((n): n is DeepSpaceNote => !!n);
          accept(id, st, list, t);
          st.nextAt = t + cfg.notesIntervalMs;
          return;
        }
        st.ok = false;
        st.failures++;
        const reason =
          r.kind === 'ok'
            ? 'answer without a notes list'
            : r.kind === 'http' && (r.status === 401 || r.status === 403)
              ? `HTTP ${r.status}: DeepSpace refused the key (check DS_KEY)`
              : describeFailure(r);
        down(reason);
        st.nextAt = t + backoffMs(st.failures, cfg.notesIntervalMs, NOTES_BACKOFF_CAP_MS);
      })
      .catch((e) => {
        st.ok = false;
        st.nextAt = now() + cfg.notesIntervalMs;
        once.warn('poll-crash', `notes poll error: ${(e as Error)?.message ?? e}`);
      })
      .finally(() => {
        st.inFlight = null;
        inFlight--;
      });
    st.inFlight = p;
    return p;
  }

  async function tick(): Promise<void> {
    if (!enabled) return;
    const t = now();
    const wanted = new Set<string>();
    try {
      for (const id of opts.activeScenes?.() ?? []) if (isSceneId(id)) wanted.add(id);
    } catch (e) {
      once.warn('active', `active scenes failed: ${(e as Error)?.message ?? e}`);
    }
    for (const [id, st] of scenes) if (st.watchedUntil > t) wanted.add(id);
    polled = [...wanted];
    for (const id of wanted) {
      const st = state(id);
      if (st.inFlight || t < st.nextAt) continue;
      if (inFlight >= maxInFlight) break;
      void poll(id, st);
    }
  }

  return {
    start() {
      if (timer || !enabled) return;
      timer = setInterval(() => void tick(), tickMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    async idle() {
      for (;;) {
        const busy = [...scenes.values()].map((s) => s.inFlight).filter((p): p is Promise<void> => !!p);
        if (!busy.length) return;
        await Promise.allSettled(busy);
      }
    },
    watch(sceneId) {
      if (isSceneId(sceneId)) state(sceneId).watchedUntil = now() + watchMs;
    },
    cached: (sceneId) => (scenes.get(sceneId)?.notes ? [...scenes.get(sceneId)!.notes!] : null),
    async list(sceneId) {
      if (!isSceneId(sceneId)) return { notes: [] };
      const st = state(sceneId);
      st.watchedUntil = now() + watchMs;
      if (!enabled) return { notes: st.notes ? [...st.notes] : [] };
      if (!st.notes) {
        const p = poll(sceneId, st);
        let to: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([p, new Promise<void>((r) => (to = setTimeout(r, firstWaitMs)))]);
        clearTimeout(to);
      }
      const notes = st.notes ? [...st.notes] : [];
      return st.ok ? { notes } : { notes, offline: true };
    },
    async create(sceneId, input) {
      if (!isSceneId(sceneId)) return { status: 404, body: { error: "We couldn't find that scene." } };
      const v = validateNoteInput(input, opts.defaultAuthor);
      if (!v.ok) return { status: 400, body: { error: v.error } };
      if (!enabled) return { status: 502, body: { error: NOTE_MESSAGES.offline } };
      const r = await callJson(doFetch, `${cfg.url}/api/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sceneId, ...v.note }),
        timeoutMs: cfg.notesPostTimeoutMs,
      });
      const t = now();
      if (r.kind === 'ok') {
        up(t);
        const note = sanitizeNote(r.body?.note, sceneId);
        if (note) {
          const st = state(sceneId);
          const fresh = !st.seen.has(note.id);
          st.seen.add(note.id);
          if (st.notes && !st.notes.some((n) => n.id === note.id)) st.notes = [...st.notes, note];
          if (fresh) emit(sceneId, [note]);
        }
        return { status: r.status, body: r.body };
      }
      if (r.kind === 'http' && r.status >= 400 && r.status < 500 && ![401, 403, 404, 408, 429].includes(r.status)) {
        const msg = typeof r.body?.error === 'string' && r.body.error.trim() ? r.body.error.trim().slice(0, 200) : NOTE_MESSAGES.refused;
        return { status: r.status, body: { ...(r.body && typeof r.body === 'object' ? r.body : {}), error: msg } };
      }
      down(r.kind === 'http' && (r.status === 401 || r.status === 403) ? `HTTP ${r.status}: DeepSpace refused the key (check DS_KEY)` : describeFailure(r));
      return { status: 502, body: { error: NOTE_MESSAGES.offline } };
    },
    onNotes(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({ enabled, host: hostOf(cfg.url), up: link.up, lastOkAt: link.lastOkAt, lastError: link.lastError, scenes: [...polled], ...counters }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Both together

export interface DeepSpace {
  forwarder: DeepSpaceForwarder;
  notes: NotesRelay;
  start(): void;
  stop(): void;
  status(): { enabled: boolean; host: string | null; presence: ForwarderStatus; notes: NotesStatus };
}

export interface DeepSpaceOptions {
  config: DeepSpaceConfig;
  presence: PresenceSource;
  fetch?: FetchLike;
  now?: () => number;
  log?: Logger;
  onNotes?: NotesListener;
}

/** The forwarder plus the notes relay, polling notes for exactly the scenes the forwarder sees people in. */
export function createDeepSpace(opts: DeepSpaceOptions): DeepSpace {
  const log = opts.log ?? prefixedLogger('deepspace');
  const forwarder = createDeepSpaceForwarder({ config: opts.config, source: opts.presence, fetch: opts.fetch, now: opts.now, log });
  const notes = createNotesRelay({
    config: opts.config,
    activeScenes: () => forwarder.activeScenes(),
    fetch: opts.fetch,
    now: opts.now,
    log,
    onNotes: opts.onNotes,
  });
  return {
    forwarder,
    notes,
    start() {
      forwarder.start();
      notes.start();
    },
    stop() {
      forwarder.stop();
      notes.stop();
    },
    status: () => ({ enabled: !!opts.config.url, host: hostOf(opts.config.url), presence: forwarder.status(), notes: notes.status() }),
  };
}
