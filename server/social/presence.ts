// Shared presence: who is in which scene and where, for the headset, browser viewers and Roblox players.
//
// Everything stored here is in the ROOM FRAME, metres (team/contracts.md 3.1): Y up, right-handed, a camera at the
// origin looks down -Z, floor at y = 0. A person's x, y, z are their feet. yaw is radians about +Y, the three.js
// rotation.y: 0 faces -Z, positive turns left (counter-clockwise seen from above), facing = (-sin yaw, -cos yaw).
// Roblox studs are converted at the edge (server/social/roblox.ts); nothing in here knows about studs.
//
// Rules (contracts 3.3):
//  - an id is in one scene at a time: posting it to another scene removes it from the first;
//  - anyone silent for 3 s is dropped (age is computed on read, never stored);
//  - every id is rate limited (a token bucket, well above the 4 Hz stream rate), every scene and the store are capped.
//
// Subscribers (the WebSocket layer, the DeepSpace forwarder) get:
//  - onPresence(sceneId, people, t): a full snapshot whenever the scene changed, at most every `emitMs` per scene,
//    at least every `heartbeatMs` while anyone is there, and exactly once with [] when the last person leaves;
//  - onEvent(sceneId, event): Roblox moments (tag, round) with the server time `t` added.
// A throwing subscriber is logged and never breaks the store or the request that triggered it.

export type PersonKind = 'vr' | 'web' | 'roblox';
export type V3 = [number, number, number];

export const KINDS: readonly PersonKind[] = ['vr', 'web', 'roblox'];
export const ROBLOX_STATES = ['playing', 'caught', 'out', 'idle'] as const;

/** A person as posted (already validated), room frame metres. */
export interface PersonInput {
  id: string;
  name: string;
  kind: PersonKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Eye position (VR). Missing: feet + 1.6 m. */
  head?: V3 | null;
  /** Left, then right (VR). */
  hands?: [V3, V3] | null;
  /** Roblox per-player state (playing, caught, out, idle). */
  state?: string;
  /** Roblox game server (JobId) that posted this person. */
  server?: string;
}

/** A person as read: the posted fields plus `age` (seconds since last heard), rounded for the wire. */
export interface PersonView {
  id: string;
  name: string;
  kind: PersonKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  age: number;
  head?: V3;
  hands?: [V3, V3];
  state?: string;
}

/** A Roblox moment pushed to the headset (contracts 6.4). The server adds `t` (Unix seconds). */
export interface PresenceEvent {
  type: string;
  t: number;
  [key: string]: unknown;
}

export type PresenceListener = (sceneId: string, people: PersonView[], t: number) => void;
export type EventListener = (sceneId: string, event: PresenceEvent) => void;

export interface PresenceOptions {
  /** Silence after which a person is dropped. Default 3000 ms (contracts 3.3). */
  ttlMs?: number;
  /** Millisecond clock (tests inject one). Default Date.now. */
  now?: () => number;
  /** People per scene. Default 64. */
  maxPerScene?: number;
  /** Scenes with someone in them. Default 256. */
  maxScenes?: number;
  /** Per-id token bucket. Default 12 updates per second, burst 24 (the stream is 4 Hz). */
  rate?: { perSecond: number; burst: number };
  /** Minimum gap between two onPresence pushes for one scene. Default 200 ms. */
  emitMs?: number;
  /** A snapshot goes out at least this often while anyone is in a scene. Default 1000 ms. */
  heartbeatMs?: number;
  /** Tick period of start(). Default 100 ms. */
  tickMs?: number;
  log?: (msg: string) => void;
}

export type UpsertResult =
  | { ok: true; moved?: string }
  | { ok: false; reason: 'rate'; retryAfterMs: number }
  | { ok: false; reason: 'full' };

interface Stored extends PersonInput {
  seen: number;
}

interface SceneState {
  people: Map<string, Stored>;
  dirty: boolean;
  lastEmit: number;
  /** People count in the last snapshot pushed (so the last leaver triggers exactly one empty push). */
  lastCount: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

const TWO_PI = Math.PI * 2;

/** Wraps an angle into (-pi, pi]. */
export function normalizeYaw(a: number): number {
  let r = a % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r + 0;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
const r3v = (v: V3): V3 => [r3(v[0]), r3(v[1]), r3(v[2])];

export class PresenceStore {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxPerScene: number;
  private readonly maxScenes: number;
  private readonly rate: { perSecond: number; burst: number };
  private readonly emitMs: number;
  private readonly heartbeatMs: number;
  private readonly tickMs: number;
  private readonly log: (msg: string) => void;
  private scenes = new Map<string, SceneState>();
  private where = new Map<string, string>();
  private buckets = new Map<string, Bucket>();
  private presenceListeners = new Set<PresenceListener>();
  private eventListeners = new Set<EventListener>();
  private rounds = new Map<string, PresenceEvent>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PresenceOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 3000;
    this.now = opts.now ?? Date.now;
    this.maxPerScene = opts.maxPerScene ?? 64;
    this.maxScenes = opts.maxScenes ?? 256;
    this.rate = opts.rate ?? { perSecond: 12, burst: 24 };
    this.emitMs = opts.emitMs ?? 200;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
    this.tickMs = opts.tickMs ?? 100;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Server time in Unix seconds (contracts 3.4 `t`). */
  t(): number {
    return Math.round(this.now()) / 1000;
  }

  // ---------------------------------------------------------------- writes

  /** Adds or refreshes a person. Moving an id to another scene removes it from the old one. */
  upsert(sceneId: string, p: PersonInput): UpsertResult {
    const now = this.now();
    if (!this.take(p.id, now)) {
      const need = 1 - (this.buckets.get(p.id)?.tokens ?? 0);
      return { ok: false, reason: 'rate', retryAfterMs: Math.max(50, Math.ceil((need / this.rate.perSecond) * 1000)) };
    }
    let st = this.scenes.get(sceneId);
    if (!st) {
      if (this.scenes.size >= this.maxScenes) {
        this.prune(now);
        if (this.scenes.size >= this.maxScenes) return { ok: false, reason: 'full' };
      }
      st = { people: new Map(), dirty: false, lastEmit: 0, lastCount: 0 };
      this.scenes.set(sceneId, st);
    }
    if (!st.people.has(p.id) && st.people.size >= this.maxPerScene) {
      this.pruneScene(sceneId, st, now);
      if (st.people.size >= this.maxPerScene) return { ok: false, reason: 'full' };
    }
    let moved: string | undefined;
    const prev = this.where.get(p.id);
    if (prev !== undefined && prev !== sceneId) {
      const old = this.scenes.get(prev);
      if (old?.people.delete(p.id)) {
        old.dirty = true;
        moved = prev;
        this.maybeEmit(prev, old, now);
      }
    }
    const stored: Stored = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: normalizeYaw(p.yaw),
      head: p.head ?? null,
      hands: p.hands ?? null,
      state: p.state,
      server: p.server,
      seen: now,
    };
    st.people.set(p.id, stored);
    this.where.set(p.id, sceneId);
    st.dirty = true;
    this.maybeEmit(sceneId, st, now);
    return moved ? { ok: true, moved } : { ok: true };
  }

  /** Removes a person wherever they are. Returns true when they were present. */
  remove(id: string): boolean {
    const sceneId = this.where.get(id);
    if (sceneId === undefined) return false;
    this.where.delete(id);
    const st = this.scenes.get(sceneId);
    if (!st?.people.delete(id)) return false;
    st.dirty = true;
    this.maybeEmit(sceneId, st, this.now());
    return true;
  }

  /**
   * A Roblox game server listed `keep` just now: its other players in this scene left the room (contracts 6.3
   * `server`). Returns the ids removed.
   */
  syncServer(sceneId: string, server: string, keep: Iterable<string>): string[] {
    const st = this.scenes.get(sceneId);
    if (!st) return [];
    const k = new Set(keep);
    const gone: string[] = [];
    for (const [id, p] of st.people) {
      if (p.server === server && !k.has(id)) gone.push(id);
    }
    for (const id of gone) {
      st.people.delete(id);
      if (this.where.get(id) === sceneId) this.where.delete(id);
    }
    if (gone.length) {
      st.dirty = true;
      this.maybeEmit(sceneId, st, this.now());
    }
    return gone;
  }

  // ---------------------------------------------------------------- reads

  /** Everyone in a scene (expired people dropped first), optionally without some ids, metres. */
  snapshot(sceneId: string, exclude?: Iterable<string>): { t: number; people: PersonView[] } {
    const now = this.now();
    const st = this.scenes.get(sceneId);
    if (st) this.pruneScene(sceneId, st, now);
    const ex = exclude ? new Set(exclude) : null;
    const people: PersonView[] = [];
    if (st) for (const p of st.people.values()) if (!ex?.has(p.id)) people.push(this.view(p, now));
    return { t: Math.round(now) / 1000, people };
  }

  /** The scene an id is currently in (if not expired). */
  sceneOf(id: string): string | undefined {
    const s = this.where.get(id);
    if (s === undefined) return undefined;
    const p = this.scenes.get(s)?.people.get(id);
    return p && this.now() - p.seen <= this.ttlMs ? s : undefined;
  }

  /** One person's latest view (metres), or null. */
  get(id: string): PersonView | null {
    const s = this.where.get(id);
    const p = s === undefined ? undefined : this.scenes.get(s)?.people.get(id);
    const now = this.now();
    return p && now - p.seen <= this.ttlMs ? this.view(p, now) : null;
  }

  /** The most recently heard headset (kind vr), for Roblox follow mode (contracts 6.3 `active`). */
  activeHeadset(): { sceneId: string; id: string } | null {
    const now = this.now();
    // the demo headset (quest-1), then a numbered one (quest-2), then a guest headset from a shared link
    const rank = (id: string) => (id === 'quest-1' ? 0 : /^quest-\d$/.test(id) ? 1 : 2);
    let best: { sceneId: string; id: string; seen: number; rank: number } | null = null;
    for (const [sceneId, st] of this.scenes) {
      for (const p of st.people.values()) {
        if (p.kind !== 'vr' || now - p.seen > this.ttlMs) continue;
        const r = rank(p.id);
        if (!best || r < best.rank || (r === best.rank && p.seen > best.seen)) best = { sceneId, id: p.id, seen: p.seen, rank: r };
      }
    }
    return best ? { sceneId: best.sceneId, id: best.id } : null;
  }

  /** Scene ids with at least one live person. */
  activeScenes(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const [id, st] of this.scenes) {
      for (const p of st.people.values()) {
        if (now - p.seen <= this.ttlMs) {
          out.push(id);
          break;
        }
      }
    }
    return out;
  }

  /** The round in progress in a scene (the last `round start` whose duration has not run out), or null. */
  currentRound(sceneId: string): PresenceEvent | null {
    const ev = this.rounds.get(sceneId);
    if (!ev) return null;
    const dur = typeof ev.duration === 'number' && ev.duration > 0 ? ev.duration : 180;
    if (this.now() / 1000 > ev.t + dur + 5) {
      this.rounds.delete(sceneId);
      return null;
    }
    return ev;
  }

  // ---------------------------------------------------------------- events

  /** Adds `t` and hands a Roblox moment to every onEvent subscriber. Returns the event as sent. */
  publishEvent(sceneId: string, event: { type: string; [key: string]: unknown }): PresenceEvent {
    const ev: PresenceEvent = { ...event, type: event.type, t: this.t() };
    if (ev.type === 'round') {
      if (ev.state === 'start') this.rounds.set(sceneId, ev);
      else if (ev.state === 'end') this.rounds.delete(sceneId);
    } else if (ev.type === 'tag' && ev.scores && typeof ev.scores === 'object') {
      // a reloaded headset picks the round up with the latest scores, not the ones from its start
      const round = this.rounds.get(sceneId);
      if (round) this.rounds.set(sceneId, { ...round, scores: { ...(round.scores as Record<string, number> | undefined), ...(ev.scores as Record<string, number>) } });
    }
    for (const fn of this.eventListeners) {
      try {
        fn(sceneId, ev);
      } catch (e) {
        this.log(`[presence] event subscriber failed: ${(e as Error).message}`);
      }
    }
    return ev;
  }

  onPresence(fn: PresenceListener): () => void {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  // ---------------------------------------------------------------- housekeeping

  /** Drops the silent, pushes due snapshots (throttled, heartbeat, the final empty one). start() calls it. */
  tick(): void {
    const now = this.now();
    for (const [sceneId, st] of [...this.scenes]) {
      this.pruneScene(sceneId, st, now);
      const n = st.people.size;
      if (st.dirty || (n > 0 && now - st.lastEmit >= this.heartbeatMs)) {
        if (now - st.lastEmit >= this.emitMs || n === 0) this.emit(sceneId, st, now);
      }
      if (st.people.size === 0 && st.lastCount === 0 && !st.dirty) this.scenes.delete(sceneId);
    }
    for (const [id, b] of this.buckets) {
      if (now - b.last > 10_000 && !this.where.has(id)) this.buckets.delete(id);
    }
  }

  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => {
        try {
          this.tick();
        } catch (e) {
          this.log(`[presence] tick failed: ${(e as Error).message}`);
        }
      }, this.tickMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forgets everyone (tests, a scene wipe). */
  clear(): void {
    this.scenes.clear();
    this.where.clear();
    this.buckets.clear();
    this.rounds.clear();
  }

  // ---------------------------------------------------------------- internals

  private take(id: string, now: number): boolean {
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: this.rate.burst, last: now };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(this.rate.burst, b.tokens + ((now - b.last) / 1000) * this.rate.perSecond);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private prune(now: number): void {
    for (const [sceneId, st] of this.scenes) this.pruneScene(sceneId, st, now);
    for (const [sceneId, st] of [...this.scenes]) {
      if (st.people.size === 0 && st.lastCount === 0) this.scenes.delete(sceneId);
    }
  }

  private pruneScene(sceneId: string, st: SceneState, now: number): void {
    for (const [id, p] of st.people) {
      if (now - p.seen > this.ttlMs) {
        st.people.delete(id);
        if (this.where.get(id) === sceneId) this.where.delete(id);
        st.dirty = true;
      }
    }
  }

  private maybeEmit(sceneId: string, st: SceneState, now: number): void {
    if (this.presenceListeners.size === 0) {
      // nobody listens: keep the bookkeeping that decides the final empty push consistent
      st.lastCount = st.people.size;
      st.dirty = false;
      st.lastEmit = now;
      return;
    }
    if (now - st.lastEmit >= this.emitMs) this.emit(sceneId, st, now);
  }

  private emit(sceneId: string, st: SceneState, now: number): void {
    st.dirty = false;
    st.lastEmit = now;
    const n = st.people.size;
    if (n === 0 && st.lastCount === 0) return; // nothing to say: it was already empty
    st.lastCount = n;
    if (this.presenceListeners.size === 0) return;
    const people = [...st.people.values()].map((p) => this.view(p, now));
    const t = Math.round(now) / 1000;
    for (const fn of this.presenceListeners) {
      try {
        fn(sceneId, people, t);
      } catch (e) {
        this.log(`[presence] presence subscriber failed: ${(e as Error).message}`);
      }
    }
  }

  private view(p: Stored, now: number): PersonView {
    const v: PersonView = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      x: r3(p.x),
      y: r3(p.y),
      z: r3(p.z),
      yaw: r3(p.yaw),
      age: Math.max(0, Math.round(now - p.seen) / 1000),
    };
    if (p.head) v.head = r3v(p.head);
    if (p.hands) v.hands = [r3v(p.hands[0]), r3v(p.hands[1])];
    if (p.state) v.state = p.state;
    return v;
  }
}

// ---------------------------------------------------------------- validation (POST /api/presence/:sceneId)

/** Positions further than this from the room origin are a bug, not a person (metres). */
export const MAX_HORIZONTAL_M = 500;
export const MIN_Y_M = -50;
export const MAX_Y_M = 200;
export const MAX_NAME = 40;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A display name: control characters removed, trimmed; `fallback` when empty. Null when longer than 40. */
export function cleanName(raw: unknown, fallback: string, truncate = false): string | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return fallback;
  if ([...s].length > MAX_NAME) {
    if (!truncate) return null;
    s = [...s].slice(0, MAX_NAME).join('');
  }
  return s;
}

export function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** [x, y, z] of finite numbers scaled by `k`, or undefined. */
export function vec3(raw: unknown, k = 1): V3 | undefined {
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(finite)) return undefined;
  return [raw[0] * k, raw[1] * k, raw[2] * k];
}

/** hands: null/missing -> null; two valid triples -> both; anything else (a lost hand) -> null. */
export function handsOf(raw: unknown, k = 1): [V3, V3] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = vec3(raw[0], k);
  const b = vec3(raw[1], k);
  return a && b ? [a, b] : null;
}

/**
 * Reads x, y, z, yaw (scaled by `k` to metres) and checks the room limits. The error names the field, the way the
 * contract's example does ("x must be a finite number").
 */
export function positionOf(o: Record<string, unknown>, k = 1): Parsed<{ x: number; y: number; z: number; yaw: number }> {
  for (const f of ['x', 'y', 'z', 'yaw'] as const) {
    if (!finite(o[f])) return { ok: false, error: `${f} must be a finite number` };
  }
  const x = (o.x as number) * k;
  const y = (o.y as number) * k;
  const z = (o.z as number) * k;
  if (Math.abs(x) > MAX_HORIZONTAL_M || Math.abs(z) > MAX_HORIZONTAL_M || y < MIN_Y_M || y > MAX_Y_M) {
    return { ok: false, error: 'That position is far outside the room.' };
  }
  return { ok: true, value: { x, y, z, yaw: normalizeYaw(o.yaw as number) } };
}

/** Validates a headset or browser body (contracts 5.1). `kind` may be omitted: quest-* is vr, anything else web. */
export function parsePresenceBody(body: unknown): Parsed<PersonInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) {
    return { ok: false, error: 'id must be 1 to 64 letters, digits, dashes or underscores (for example quest-1).' };
  }
  if (o.id.startsWith('rbx-')) return { ok: false, error: 'Ids starting with rbx- belong to Roblox players.' };
  let kind: PersonKind;
  if (o.kind === undefined || o.kind === null) kind = o.id.startsWith('quest') ? 'vr' : 'web';
  else if (o.kind === 'vr' || o.kind === 'web') kind = o.kind;
  else return { ok: false, error: `Unknown kind "${String(o.kind).slice(0, 20)}". Use vr or web.` };
  const name = cleanName(o.name, kind === 'vr' ? 'Headset' : 'Visitor');
  if (name === null) return { ok: false, error: `name must be text of at most ${MAX_NAME} characters.` };
  const pos = positionOf(o);
  if (!pos.ok) return pos;
  const person: PersonInput = { id: o.id, name, kind, ...pos.value };
  const head = vec3(o.head);
  if (head) person.head = head;
  const hands = handsOf(o.hands);
  if (hands) person.hands = hands;
  return { ok: true, value: person };
}

// ---------------------------------------------------------------- payload helpers for subscribers

/** The DeepSpace ingest body (contracts 7.1): only the 7 fields, at most 32 people, metres. */
export function ingestPayload(sceneId: string, people: PersonView[], t: number) {
  return {
    sceneId,
    t,
    people: people.slice(0, 32).map((p) => ({ id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y, z: p.z, yaw: p.yaw })),
  };
}

/** The /ws message for a Roblox moment (contracts 6.4, 10). */
export function robloxWsMessage(sceneId: string, event: PresenceEvent) {
  return { type: 'roblox' as const, sceneId, event };
}
