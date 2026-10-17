// Social layer networking: JSON fetch with timeouts, the /ws event socket with reconnect, the
// server clock estimate, and the presence loop (POST our pose at 4 Hz, receive everyone else).
// Contract: team/contracts.md sections 3, 5 and 10. Everything here is metres in the room frame
// (the viewer's three.js world frame, floor at y = 0).

export type PersonKind = 'vr' | 'roblox' | 'web';
export type V3 = [number, number, number];

export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
  /** Feet on the floor, room frame metres. */
  x: number;
  y: number;
  z: number;
  /** Radians about +Y: 0 faces -Z, positive turns left (three.js rotation.y). */
  yaw: number;
  /** Eye position (VR only). Missing: feet + 1.6 m. */
  head?: V3 | null;
  /** Left then right hand (VR only). */
  hands?: [V3, V3] | null;
  /** Seconds since the server last heard from this person. */
  age: number;
}

export interface PresenceSnapshot {
  /** Server clock (Unix seconds) when the list was made, or null when the server did not say. */
  t: number | null;
  people: Person[];
}

/** What this viewer posts (5.1). */
export interface LocalPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  head?: V3 | null;
  hands?: [V3, V3] | null;
}

export const NAME_MAX = 40;
export const STUDS_PER_METER = 3.57;
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

export function validSceneId(id: string): boolean {
  return SCENE_ID.test(id);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const t = Math.atan2(Math.sin(a), Math.cos(a));
  return t === -Math.PI ? Math.PI : t;
}

/** Server times are Unix seconds; a millisecond value (a sender bug) is converted. */
export function toSeconds(t: unknown): number | null {
  if (!finite(t) || t <= 0) return null;
  return t > 1e11 ? t / 1000 : t;
}

function vec3(v: unknown, scale: number): V3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [x, y, z] = v;
  if (!finite(x) || !finite(y) || !finite(z)) return null;
  return [x / scale, y / scale, z / scale];
}

function hands(v: unknown, scale: number): [V3, V3] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const l = vec3(v[0], scale);
  const r = vec3(v[1], scale);
  if (!l && !r) return null;
  return [l ?? r!, r ?? l!];
}

/**
 * One person from a presence list, or null when it is unusable. Unknown fields are ignored.
 * `studsPerMeter` > 0 converts a studs payload (the Roblox shape) to metres; 0 or 1 means metres.
 */
export function parsePerson(raw: unknown, studsPerMeter = 1): Person | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id.trim() : typeof p.id === 'number' ? String(p.id) : '';
  if (!id || id.length > 80) return null;
  const s = studsPerMeter > 0 ? studsPerMeter : 1;
  if (!finite(p.x) || !finite(p.z)) return null;
  const y = finite(p.y) ? p.y : 0;
  let kind: PersonKind = p.kind === 'vr' || p.kind === 'roblox' || p.kind === 'web' ? p.kind : id.startsWith('rbx-') ? 'roblox' : id.startsWith('quest') ? 'vr' : 'web';
  if (p.kind === 'quest') kind = 'vr';
  const rawName = typeof p.name === 'string' ? p.name.trim() : '';
  const name = (rawName || (kind === 'roblox' ? 'Roblox player' : kind === 'vr' ? 'Headset' : 'Visitor')).slice(0, NAME_MAX);
  const age = finite(p.age) && p.age >= 0 ? Math.min(p.age, 60) : 0;
  return {
    id,
    name,
    kind,
    x: p.x / s,
    y: y / s,
    z: p.z / s,
    yaw: wrapAngle(finite(p.yaw) ? p.yaw : 0),
    head: vec3(p.head, s),
    hands: hands(p.hands, s),
    age,
  };
}

/**
 * A presence response: `{t, people}` (5.2), `{t, others}` (the Roblox shape, studs when it says so)
 * or a bare array. People whose id is in `exclude` (this viewer's own ids) are left out.
 */
export function parsePresence(raw: unknown, exclude: ReadonlySet<string> = new Set()): PresenceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(raw) ? raw : Array.isArray(o.people) ? o.people : Array.isArray(o.others) ? o.others : null;
  if (!list) return null;
  // metres (5.2) unless the payload says it is in studs (the Roblox shape, 6.3)
  const studs = !Array.isArray(raw) && (o.units === 'studs' || (Array.isArray(o.others) && finite(o.studsPerMeter)));
  const spm = studs ? (finite(o.studsPerMeter) && o.studsPerMeter > 0 ? o.studsPerMeter : STUDS_PER_METER) : 1;
  const seen = new Set<string>();
  const people: Person[] = [];
  for (const r of list) {
    const p = parsePerson(r, spm);
    if (!p || exclude.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    people.push(p);
    if (people.length >= 64) break;
  }
  return { t: Array.isArray(raw) ? null : toSeconds(o.t), people };
}

// ---------------------------------------------------------------------------------------------
// fetch with a timeout; never throws

export interface FetchResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** A person-readable reason when !ok. */
  error?: string;
  /** True when the reply was not JSON (a tunnel error page): the server or the link is down. */
  down?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchJson<T = unknown>(
  url: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<FetchResult<T>> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), opts.timeoutMs ?? 2500);
  const f: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  try {
    const init: RequestInit = { method: opts.method ?? 'GET', cache: 'no-store', signal: ctl?.signal };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await f(url, init);
    const text = await res.text();
    let data: unknown = null;
    let down = false;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      down = true;
    }
    if (!res.ok || down) {
      const msg = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: data as T, error: msg, down: down || res.status === 502 || res.status === 530 };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    return { ok: false, status: 0, data: null, error: aborted ? 'timed out' : 'unreachable', down: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Joins a base URL ('' = same origin) and a path. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return base.replace(/\/+$/, '') + path;
}

// ---------------------------------------------------------------------------------------------
// server clock

/** Local monotonic seconds. */
export const localNow = (): number => performance.now() / 1000;

/**
 * Estimates the server clock from the `t` of each response. The smallest-delay sample in the last
 * few seconds wins (a late reply only ever makes the server look behind).
 */
export class ClockSync {
  private samples: Array<{ at: number; off: number }> = [];
  private best: number | null = null;
  private cur: number | null = null;
  private lastAt = 0;

  constructor(private windowS = 8) {}

  /** Records a server time `t` received at local time `at` (seconds). */
  add(t: number | null, at = localNow()): void {
    if (t === null || !Number.isFinite(t)) return;
    const off = t - at;
    // a server restart or a big clock change: start over
    if (this.best !== null && Math.abs(off - this.best) > 30) this.samples.length = 0;
    this.samples.push({ at, off });
    while (this.samples.length && this.samples[0].at < at - this.windowS) this.samples.shift();
    if (this.samples.length > 64) this.samples.shift();
    this.best = Math.max(...this.samples.map((s) => s.off));
    // slew rather than jump, so the drawn time of everyone else never skips (except far off)
    if (this.cur === null || Math.abs(this.best - this.cur) > 1) this.cur = this.best;
    else {
      const step = 0.002 + 0.02 * Math.max(0, at - this.lastAt);
      this.cur += Math.max(-step, Math.min(step, this.best - this.cur));
    }
    this.lastAt = at;
  }

  get synced(): boolean {
    return this.cur !== null;
  }

  /** The current best offset estimate (server - local), before slewing. */
  get target(): number | null {
    return this.best;
  }

  /** Server seconds now (local clock when never synced). */
  serverNow(at = localNow()): number {
    return at + (this.cur ?? 0);
  }

  /** Server time -> local monotonic seconds. */
  toLocal(t: number): number {
    return t - (this.cur ?? 0);
  }
}

// ---------------------------------------------------------------------------------------------
// /ws

export type SocketMessage = { type: string; sceneId?: string; [k: string]: unknown };
type Listener = (m: SocketMessage) => void;

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

/**
 * The server's event socket, reconnecting with backoff. Messages for other scenes are dropped, except the types in
 * UNFILTERED: a cue's sceneId can name another world (a load cue), so its listeners decide for themselves.
 */
export class SocialSocket {
  static readonly UNFILTERED: ReadonlySet<string> = new Set(['cue']);
  private ws: SocketLike | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(connected: boolean) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  connected = false;
  lastMessageAt = 0;
  onStatus: (connected: boolean) => void = () => undefined;

  constructor(
    private url: string,
    private sceneId: string,
    private make: (url: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike,
  ) {}

  static urlFor(base: string): string {
    if (base) return base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  /** Another connection-state listener (besides onStatus); returns the unsubscribe. */
  onConnection(fn: (connected: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  on(type: string, fn: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    let ws: SocketLike;
    try {
      ws = this.make(this.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setConnected(false);
      this.schedule();
    };
  }

  private setConnected(c: boolean): void {
    if (c === this.connected) return;
    this.connected = c;
    for (const fn of [this.onStatus, ...this.statusListeners]) {
      try {
        fn(c);
      } catch (e) {
        console.warn('[social] socket status handler', e);
      }
    }
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    const delay = Math.min(10_000, 800 * 2 ** this.retry) * (0.8 + Math.random() * 0.4);
    this.retry = Math.min(this.retry + 1, 6);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** Parses and dispatches one raw message (exposed for tests). */
  handle(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: SocketMessage;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (typeof m.sceneId === 'string' && m.sceneId !== this.sceneId && !SocialSocket.UNFILTERED.has(m.type)) return;
    this.lastMessageAt = localNow();
    const set = this.listeners.get(m.type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(m);
      } catch (e) {
        console.warn(`[social] ${m.type} handler failed`, e);
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }
}

// ---------------------------------------------------------------------------------------------
// presence loop

export interface PresenceOptions {
  baseUrl: string;
  sceneId: string;
  /** Our pose in the room frame, or null to only listen. */
  getPose: () => LocalPose | null;
  /** 'vr' while presenting in XR, else 'web'. */
  getKind: () => 'vr' | 'web';
  /** Our id for the current kind (quest-1 in XR, web-xxxxxxxx otherwise). */
  getId: () => string;
  getName: () => string;
  onSnapshot: (s: PresenceSnapshot, receivedAt: number) => void;
  onStatus?: (online: boolean, why?: string) => void;
  clock: ClockSync;
  /** Every id this viewer has used, excluded from what we draw. */
  ownIds: Set<string>;
  rateHz?: number;
  fetchImpl?: FetchLike;
}

const round = (v: number, d = 1000) => Math.round(v * d) / d;
const roundV = (v: V3): V3 => [round(v[0]), round(v[1]), round(v[2])];

/** The body of POST /api/presence/:sceneId for a pose (5.1). */
export function presenceBody(id: string, name: string, kind: 'vr' | 'web', pose: LocalPose): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id,
    name: name.slice(0, NAME_MAX),
    kind,
    x: round(pose.x),
    y: round(pose.y),
    z: round(pose.z),
    yaw: round(wrapAngle(pose.yaw), 10000),
  };
  if (kind === 'vr') {
    if (pose.head) body.head = roundV(pose.head);
    body.hands = pose.hands ? [roundV(pose.hands[0]), roundV(pose.hands[1])] : null;
  }
  return body;
}

/**
 * Posts our pose about 4 times a second and hands every answer (everyone else) to onSnapshot.
 * A request still in flight skips the next tick (never queues). When posting fails it polls GET
 * instead; when both fail it backs off up to 4 s. Driven by tick(dt) from the frame loop.
 */
export class PresenceClient {
  private acc = 0;
  private inFlight = false;
  private failures = 0;
  private backoffUntil = 0;
  private online: boolean | null = null;
  private postBroken = 0;
  private lastErrorLogged = '';
  /** Snapshots that arrived by WebSocket recently: GET polling is not needed then. */
  private wsFreshUntil = 0;
  stopped = false;
  readonly stats = { posts: 0, gets: 0, failures: 0, snapshots: 0 };

  constructor(private o: PresenceOptions) {}

  get interval(): number {
    const hz = this.o.rateHz ?? 4;
    // a hidden browser tab slows to 1 Hz; never in a headset (the page can read as hidden while immersive)
    const hidden = this.o.getKind() === 'web' && typeof document !== 'undefined' && document.visibilityState === 'hidden';
    return hidden ? 1 : 1 / hz;
  }

  /** Call every frame. */
  tick(dt: number, now = localNow()): void {
    if (this.stopped) return;
    this.acc += Math.max(0, Math.min(dt, 0.5));
    if (this.acc < this.interval || this.inFlight || now < this.backoffUntil) return;
    this.acc = 0;
    void this.step(now);
  }

  /** A presence list pushed over /ws ({type:'presence', t, people}). */
  ingest(raw: unknown, now = localNow()): void {
    const snap = parsePresence(raw, this.o.ownIds);
    if (!snap) return;
    this.wsFreshUntil = now + 1.2;
    this.deliver(snap, now);
  }

  private deliver(snap: PresenceSnapshot, at: number): void {
    this.o.clock.add(snap.t, at);
    this.stats.snapshots++;
    this.o.onSnapshot(snap, at);
  }

  private async step(now: number): Promise<void> {
    this.inFlight = true;
    try {
      const pose = this.o.getPose();
      const url = joinUrl(this.o.baseUrl, `/api/presence/${encodeURIComponent(this.o.sceneId)}`);
      let res: FetchResult | null = null;
      if (pose && now >= this.postBroken) {
        const kind = this.o.getKind();
        const id = this.o.getId();
        this.o.ownIds.add(id);
        this.stats.posts++;
        res = await fetchJson(url, { method: 'POST', body: presenceBody(id, this.o.getName(), kind, pose), timeoutMs: 2000, fetchImpl: this.o.fetchImpl });
        // a 400 is a contract problem (logged once): listen by GET for a while instead
        if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 404) {
          this.logOnce(`presence POST ${res.status}: ${res.error}`);
          this.postBroken = now + 10;
        }
      }
      const unknownScene = res?.status === 404;
      if (!res && now < this.wsFreshUntil) return; // nothing to send and the socket brings everyone
      if ((!res || !res.ok) && !unknownScene) {
        this.stats.gets++;
        res = await fetchJson(url, { timeoutMs: 2000, fetchImpl: this.o.fetchImpl });
      }
      const snap = res?.ok ? parsePresence(res.data, this.o.ownIds) : null;
      if (snap) {
        this.failures = 0;
        this.setOnline(true);
        this.deliver(snap, localNow());
        return;
      }
      this.failures++;
      this.stats.failures++;
      // `now` is the tick's clock (the frame loop's), so the backoff is measured in it too
      this.backoffUntil = now + Math.min(4, 0.25 * 2 ** Math.min(this.failures, 5));
      if (this.failures >= 3) this.setOnline(false, res?.status === 404 ? 'This world is not known to the live server.' : res?.error);
    } catch (e) {
      this.failures++;
      this.logOnce(`presence: ${(e as Error)?.message ?? e}`);
    } finally {
      this.inFlight = false;
    }
  }

  private setOnline(on: boolean, why?: string): void {
    if (this.online === on) return;
    this.online = on;
    this.o.onStatus?.(on, why);
  }

  private logOnce(msg: string): void {
    if (msg === this.lastErrorLogged) return;
    this.lastErrorLogged = msg;
    console.warn(`[social] ${msg}`);
  }

  stop(): void {
    this.stopped = true;
  }
}

/** A stable random viewer id for this browser: web-<8 hex>. */
function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A browser viewer's id, web-<8 hex>, one per tab: kept in sessionStorage, so a reload (follow mode) keeps it but two
 * tabs in one browser are two people (with localStorage they shared one id and their ghost flickered between them).
 */
export function webId(storageKey = 'dv.social.webId'): string {
  try {
    const have = sessionStorage.getItem(storageKey);
    if (have && /^web-[0-9a-f]{8}$/.test(have)) return have;
  } catch {
    /* storage blocked */
  }
  const id = `web-${randomHex(4)}`;
  try {
    sessionStorage.setItem(storageKey, id);
  } catch {
    /* not persisted */
  }
  return id;
}

/**
 * The headset's id (contracts 3.3). The demo headset is quest-1: the host opens it with ?follow=1 (or ?quest=1), and
 * the device remembers it. ?quest=2 makes a second demo headset. Any other headset entering VR from a shared link is
 * a guest, quest-g<7 hex>, so it never takes over quest-1 (the player Roblox referees as "it" and the presence store
 * keeps in one world) and it sorts after quest-1 and quest-2 wherever the first headset by id is picked.
 */
export function questId(q: URLSearchParams, storageKey = 'dv.social.questId'): string {
  const n = q.get('quest');
  let id: string | null = n && /^\d$/.test(n) ? `quest-${n}` : q.get('follow') === '1' ? 'quest-1' : null;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    /* storage blocked */
  }
  if (!id) id = stored && /^quest-(\d|g[0-9a-f]{7})$/.test(stored) ? stored : `quest-g${randomHex(4).slice(0, 7)}`;
  if (id !== stored) {
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      /* not persisted */
    }
  }
  return id;
}
