// The Roblox side of the server: studs <-> metres, the Roblox presence and event bodies, and the room map service.
//
// Units and frames (team/contracts.md 3.1, 3.2, 3.3; team/shivin.md "Coordinate frame"):
//  - studs = metres_room x STUDS_PER_METER (3.57: one stud is 28 cm, so the room is life size), axis for axis.
//  - Roblox Workspace and the room frame are both right-handed, Y up, -Z forward, and the room is built at the
//    Workspace origin with its floor at y = 0, so NO axis flips and NO offsets: only the scale changes.
//  - yaw passes through unchanged. Both sides use the same angle: three.js `rotation.y` and Roblox
//    `CFrame.Angles(0, yaw, 0)` are the same right-handed rotation about +Y, so 0 faces -Z, positive turns left
//    (counter-clockwise seen from above) and the facing direction is (-sin yaw, -cos yaw) in (x, z) on both sides.
//    (Roblox's `math.atan2(-look.X, -look.Z)` of the root part's LookVector is exactly this yaw.) The server only
//    wraps it into (-pi, pi].
//  - x, y, z are the feet. Roblox computes feetY from the root part; the headset's head and hands scale like any
//    other point.
// Only this server converts: Roblox sends and receives studs, everyone else metres.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import {
  cleanName,
  finite,
  positionOf,
  ROBLOX_STATES,
  type Parsed,
  type PersonInput,
  type PersonView,
  type V3,
} from './presence.ts';

export const STUDS_PER_METER = 3.57;

// ---------------------------------------------------------------- units

const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
const scaleV = (v: V3, k: number): V3 => [r3(v[0] * k), r3(v[1] * k), r3(v[2] * k)];

/** Metres (room frame) to studs (Roblox Workspace). */
export function metresToStuds(m: number, spm = STUDS_PER_METER): number {
  return m * spm;
}

/** Studs (Roblox Workspace) to metres (room frame). */
export function studsToMetres(s: number, spm = STUDS_PER_METER): number {
  return s / spm;
}

/** A person as Roblox sees them: positions, head and hands in studs; yaw, age and everything else unchanged. */
export function personToStuds(p: PersonView, spm = STUDS_PER_METER): PersonView {
  const out: PersonView = { ...p, x: r3(p.x * spm), y: r3(p.y * spm), z: r3(p.z * spm) };
  if (p.head) out.head = scaleV(p.head, spm);
  if (p.hands) out.hands = [scaleV(p.hands[0], spm), scaleV(p.hands[1], spm)];
  return out;
}

// ---------------------------------------------------------------- POST /api/roblox/:sceneId/presence

export const MAX_ROBLOX_PLAYERS = 100;
const RBX_ID_RE = /^rbx-[A-Za-z0-9_-]{1,40}$/;
const SERVER_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

export interface RobloxPresenceBody {
  /** Valid players, already in metres. */
  players: PersonInput[];
  /** Ids that were listed (valid or not): the response leaves them all out. */
  listed: string[];
  /** Entries that could not be used, with the reason (the response reports how many). */
  skipped: { index: number; error: string }[];
  server?: string;
}

/** A Roblox player id: "rbx-<UserId>", or a bare UserId (number or digits), which gets the prefix. */
export function robloxId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return `rbx-${raw}`;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{1,20}$/.test(s)) return `rbx-${s}`;
  return RBX_ID_RE.test(s) ? s : null;
}

/**
 * Validates `{players: [{id, name, x, y, z, yaw, state?}], server?}` (studs) and converts each player to metres.
 * A bad player is skipped (and reported), never the whole batch: one odd avatar must not freeze everyone's ghost.
 */
export function parseRobloxPresence(body: unknown, spm = STUDS_PER_METER): Parsed<RobloxPresenceBody> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const o = body as Record<string, unknown>;
  const list = o.players === undefined || o.players === null ? [] : o.players;
  // Luau encodes an empty table as {} or []: both mean "nobody in the room".
  const arr = Array.isArray(list) ? list : list && typeof list === 'object' && Object.keys(list).length === 0 ? [] : null;
  if (!arr) return { ok: false, error: 'players must be a list.' };
  if (arr.length > MAX_ROBLOX_PLAYERS) return { ok: false, error: `At most ${MAX_ROBLOX_PLAYERS} players per request.` };
  let server: string | undefined;
  if (o.server !== undefined && o.server !== null && o.server !== '') {
    if (typeof o.server !== 'string' || !SERVER_RE.test(o.server)) return { ok: false, error: 'server must be a short id (game.JobId).' };
    server = o.server;
  }
  const out: RobloxPresenceBody = { players: [], listed: [], skipped: [], server };
  const seen = new Set<string>();
  arr.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      out.skipped.push({ index, error: 'not an object' });
      return;
    }
    const p = raw as Record<string, unknown>;
    const id = robloxId(p.id);
    if (!id) {
      out.skipped.push({ index, error: 'id must look like rbx-12345' });
      return;
    }
    out.listed.push(id);
    if (seen.has(id)) {
      out.skipped.push({ index, error: 'duplicate id' });
      return;
    }
    seen.add(id);
    const pos = positionOf(p, 1 / spm);
    if (!pos.ok) {
      out.skipped.push({ index, error: pos.error });
      return;
    }
    // Roblox display names are at most 20 characters; anything longer is cut rather than refused.
    const name = cleanName(p.name, id, true) ?? id;
    const person: PersonInput = { id, name, kind: 'roblox', ...pos.value };
    if (typeof p.state === 'string' && (ROBLOX_STATES as readonly string[]).includes(p.state)) person.state = p.state;
    if (server) person.server = server;
    out.players.push(person);
  });
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- POST /api/roblox/:sceneId/event

const PERSON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_SCORES = 64;
const MAX_EXTRA_FIELDS = 16;

export type RobloxEventIn = { type: string; [key: string]: unknown };

/** A person id in an event: "quest-1", "rbx-123", or a bare Roblox UserId. */
function personId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return `rbx-${raw}`;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{1,20}$/.test(s)) return `rbx-${s}`;
  return PERSON_ID_RE.test(s) ? s : null;
}

/** Extra fields are welcome (contracts 6.4): short strings, finite numbers and booleans pass through, nothing else. */
function copyExtras(o: Record<string, unknown>, into: RobloxEventIn, known: Set<string>): void {
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (known.has(k) || k === 't' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    if (n >= MAX_EXTRA_FIELDS) break;
    if (typeof v === 'string') into[k] = v.slice(0, 120);
    else if (finite(v) || typeof v === 'boolean') into[k] = v;
    else continue;
    n++;
  }
}

/** `scores` ({id: number}, at most 64; Luau may send [] for none): the map, or an error sentence. */
function parseScores(raw: unknown): { ok: true; value: Record<string, number> } | { ok: false; error: string } {
  const scores: Record<string, number> = {};
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: scores };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'scores must map person ids to numbers.' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_SCORES) return { ok: false, error: `At most ${MAX_SCORES} scores.` };
  for (const [k, v] of entries) {
    const id = personId(k);
    if (!id || !finite(v)) return { ok: false, error: 'scores must map person ids to numbers.' };
    scores[id] = v;
  }
  return { ok: true, value: scores };
}

/**
 * Validates a Roblox moment. Known shapes are checked strictly:
 *   {type: "tag", by, target, scores?}              ids; scores (the referee's running score) pass through when valid
 *   {type: "round", state: "start"|"end", scores}   scores: {id: number}, at most 64 (Luau may send [] for none)
 * Other types (a future "toast", say) pass through with their simple fields, so new moments need no server change.
 */
export function parseRobloxEvent(body: unknown): Parsed<RobloxEventIn> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const o = body as Record<string, unknown>;
  if (typeof o.type !== 'string' || !TYPE_RE.test(o.type)) return { ok: false, error: 'type must be "tag" or "round".' };
  if (o.type === 'tag') {
    const by = personId(o.by);
    const target = personId(o.target);
    if (!by) return { ok: false, error: 'by must be a person id such as quest-1.' };
    if (!target) return { ok: false, error: 'target must be a person id such as rbx-12345.' };
    const ev: RobloxEventIn = { type: 'tag', by, target };
    // the scoreboard updates on the tag itself, not only at the round's end; a bad scores field never drops the tag
    const scores = parseScores(o.scores);
    if (scores.ok && Object.keys(scores.value).length) ev.scores = scores.value;
    copyExtras(o, ev, new Set(['type', 'by', 'target', 'scores']));
    return { ok: true, value: ev };
  }
  if (o.type === 'round') {
    if (o.state !== 'start' && o.state !== 'end') return { ok: false, error: 'state must be "start" or "end".' };
    const parsedScores = parseScores(o.scores);
    if (!parsedScores.ok) return parsedScores;
    const scores = parsedScores.value;
    const ev: RobloxEventIn = { type: 'round', state: o.state, scores };
    if (o.duration !== undefined) {
      if (!finite(o.duration) || o.duration <= 0 || o.duration > 3600) return { ok: false, error: 'duration must be seconds between 1 and 3600.' };
      ev.duration = o.duration;
    }
    if (o.it !== undefined) {
      const it = personId(o.it);
      if (it) ev.it = it;
    }
    copyExtras(o, ev, new Set(['type', 'state', 'scores', 'duration', 'it']));
    return { ok: true, value: ev };
  }
  const ev: RobloxEventIn = { type: o.type };
  copyExtras(o, ev, new Set(['type']));
  return { ok: true, value: ev };
}

// ---------------------------------------------------------------- the map service (GET /api/roblox/:sceneId/map)

export const DEFAULT_MAX_PARTS = 6000;
export const MAX_PARTS_CAP = 12000;
/** maxParts is rounded down to one of these, so a handful of cached variants cover every request. */
export const PART_BUCKETS = [100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000];
export const CHUNK_PARTS = 2500;

/** The cache bucket for a requested maxParts (default 6000, cap 12000, never above the request). */
export function partsBucket(raw: string | number | null | undefined): number {
  const n = raw === null || raw === undefined || raw === '' ? DEFAULT_MAX_PARTS : Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_PARTS;
  const c = Math.max(PART_BUCKETS[0]!, Math.min(MAX_PARTS_CAP, n));
  let best = PART_BUCKETS[0]!;
  for (const b of PART_BUCKETS) if (b <= c) best = b;
  return best;
}

/** data/scenes/<id>/roblox-map.json for the default budget, roblox-map-<N>.json for the others. */
export function mapFileName(bucket: number): string {
  return bucket === DEFAULT_MAX_PARTS ? 'roblox-map.json' : `roblox-map-${bucket}.json`;
}

export interface BuiltMap {
  key: string;
  /** Compact JSON bytes as written by pipeline/roblox_map.py. */
  body: Uint8Array;
  gzip: Uint8Array;
  etag: string;
  parts: number;
  /** Parsed lazily (only chunked requests need it). */
  parsed?: Record<string, unknown> & { parts: unknown[] };
  /** Header numbers read once from the body (mapMeta). */
  meta?: MapMeta;
  /** The body with the scene's walkBounds spliced in, for the walk box it was made for (mapResponse). */
  walk?: MapBytes & { sig: string };
}

/** What a map response sends: the bytes, gzipped, and their ETag. */
export interface MapBytes {
  body: Uint8Array;
  gzip: Uint8Array;
  etag: string;
}

export interface MapMeta {
  /** Scene-frame floor height the builder subtracted (null when the map does not say). */
  floorY: number | null;
  studsPerMeter: number;
  /** Whether the builder already wrote walkBounds itself. */
  hasWalkBounds: boolean;
}

export type MapResult =
  | { status: 200; map: BuiltMap }
  | { status: 202; retryAfter: number }
  | { status: 404; error: string }
  | { status: 409; error: string; sceneStatus: string }
  | { status: 500; error: string }
  | { status: 503; error: string; retryAfter: number };

/** Runs the builder; tests swap in a fake. Must write `out` (atomically) or throw. With `topdown` it also writes the
 * floor plan there and adds `bake` to the map (pipeline/roblox_map.py --topdown). */
export type MapBuilder = (args: { sceneDir: string; out: string; maxParts: number; key: string; signal: AbortSignal; topdown?: string }) => Promise<void>;

/** The topdown file the map bake writes into the scene directory (contracts 4.2). */
export const TOPDOWN_FILE = 'topdown.jpg';

/** What a map build learned about the room (pipeline/roblox_map.py "bake"): merged into scene.json by the server. */
export interface MapBake {
  /** Scene-frame floor height the map used (estimated when the scene had none). */
  floorY: number;
  floorEstimated?: boolean;
  /** Scene frame (y includes floorY); the viewer's own robust box when the scene had none. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  boundsComputed?: boolean;
  topdown: { file: string; min: [number, number]; max: [number, number]; px?: [number, number]; pxPerMeter?: number };
}

export interface MapServiceOptions {
  getScene: (id: string) => Promise<Scene | null>;
  sceneDir: (id: string) => string;
  /** The repo's .venv python. */
  python: string;
  /** pipeline/roblox_map.py */
  script: string;
  cwd: string;
  /** Kill a build after this long. Default 120 s. */
  timeoutMs?: number;
  /** How long a request waits for a build in progress before answering 202. Default 2500 ms. */
  waitMs?: number;
  /** After a failed build, requests get the error (no rebuild) for this long. Default 20 s. */
  failureHoldMs?: number;
  /** Builds waiting in line before new ones are refused with 503. Default 8. */
  maxQueue?: number;
  /** Built maps kept in memory. Default 24. */
  memoryEntries?: number;
  builder?: MapBuilder;
  /**
   * The map bake (contracts 11): the default-budget build also writes topdown.jpg, and this hears what it learned
   * (floor, bounds, topdown) with the build's cache key, to merge into scene.json. Without it no topdown is made.
   */
  onBaked?: (sceneId: string, bake: MapBake, key: string) => void | Promise<void>;
  log?: (msg: string) => void;
}

/** The default builder: `python pipeline/roblox_map.py --scene DIR --out OUT --max-parts N --key K --quiet`. */
export function pythonBuilder(python: string, script: string, cwd: string, timeoutMs: number): MapBuilder {
  return ({ sceneDir, out, maxParts, key, signal, topdown }) =>
    new Promise<void>((resolve, reject) => {
      const args = [script, '--scene', sceneDir, '--out', out, '--max-parts', String(maxParts), '--key', key, '--quiet'];
      if (topdown) args.push('--topdown', topdown);
      const child = spawn(python, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-4000)));
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      const kill = () => child.kill('SIGKILL');
      const timer = setTimeout(kill, timeoutMs);
      signal.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start ${python}: ${e.message}`));
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        if (code === 0) return resolve();
        const last = stdout.trim().split('\n').pop() ?? '';
        let why = '';
        try {
          why = (JSON.parse(last) as { error?: string }).error ?? '';
        } catch {
          /* not our JSON line */
        }
        reject(new Error(why || `exit ${code ?? sig}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
}

interface Failure {
  key: string;
  at: number;
  error: string;
}

/**
 * Builds and caches each scene's Roblox map. A map is built once per (scene, budget) and kept as
 * data/scenes/<id>/roblox-map.json; the cache key covers the world file (size, mtime), everything in scene.json that
 * moves the room (transform, floorY, spawn, bounds, video camera, name) and the builder script itself, so a new
 * world or a new floor height rebuilds it automatically. One build runs at a time (the Mac is shared).
 */
export class RobloxMapService {
  private mem = new Map<string, BuiltMap>();
  private inflight = new Map<string, { key: string; done: Promise<void> }>();
  private failures = new Map<string, Failure>();
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private scriptHash: { mtimeMs: number; hash: string } | null = null;
  private readonly abort = new AbortController();
  private readonly builder: MapBuilder;
  private readonly log: (msg: string) => void;

  constructor(private opts: MapServiceOptions) {
    this.builder = opts.builder ?? pythonBuilder(opts.python, opts.script, opts.cwd, opts.timeoutMs ?? 120_000);
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** The map for a scene, building it when needed (contracts 6.2 statuses). */
  async get(sceneId: string, maxParts: number | string | null = DEFAULT_MAX_PARTS, waitMs = this.opts.waitMs ?? 2500): Promise<MapResult> {
    const bucket = partsBucket(maxParts);
    const scene = await this.opts.getScene(sceneId).catch(() => null);
    if (!scene) return { status: 404, error: 'No such scene' };
    if (scene.status !== 'ready') return { status: 409, error: 'Scene is not ready', sceneStatus: scene.status };
    if (!scene.world?.file) return { status: 409, error: 'This scene has no room to build blocks from.', sceneStatus: 'no-world' };
    let key: string;
    try {
      key = await this.keyFor(scene, bucket);
    } catch (e) {
      this.log(`[roblox-map] ${sceneId}: ${(e as Error).message}`);
      return { status: 409, error: "This scene's room file is missing.", sceneStatus: 'no-world' };
    }
    const slot = `${sceneId}:${bucket}`;
    const hit = this.mem.get(slot);
    if (hit && hit.key === key) {
      this.touch(slot, hit);
      return { status: 200, map: hit };
    }
    const disk = await this.loadDisk(sceneId, bucket, key);
    if (disk) {
      this.remember(slot, disk);
      return { status: 200, map: disk };
    }
    const failed = this.failures.get(slot);
    if (failed && failed.key === key && Date.now() - failed.at < (this.opts.failureHoldMs ?? 20_000)) {
      return { status: 500, error: "We couldn't turn this room into blocks. Try again in a moment." };
    }
    const job = this.start(sceneId, bucket, key);
    if (!job) return { status: 503, error: 'The map builder is busy. Try again in a few seconds.', retryAfter: 3 };
    if (waitMs > 0) {
      const finished = await Promise.race([job.then(() => true), Bun.sleep(waitMs).then(() => false)]);
      if (finished) {
        const m = this.mem.get(slot);
        if (m && m.key === key) return { status: 200, map: m };
        const f = this.failures.get(slot);
        if (f && f.key === key) return { status: 500, error: "We couldn't turn this room into blocks. Try again in a moment." };
      }
    }
    return { status: 202, retryAfter: 2 };
  }

  /**
   * Starts a build in the background when the map is missing or stale (call it when a scene becomes ready). With the
   * bake on, a world whose floor plan is missing (no world.topdown, or the file is gone) is built again even when its
   * map is cached, so every ready world gets its topdown.jpg.
   */
  async prewarm(sceneId: string, maxParts: number = DEFAULT_MAX_PARTS): Promise<MapResult> {
    try {
      const bucket = partsBucket(maxParts);
      if (bucket === DEFAULT_MAX_PARTS && this.opts.onBaked) {
        const scene = await this.opts.getScene(sceneId).catch(() => null);
        if (scene?.status === 'ready' && scene.world?.file && !(await this.hasTopdown(sceneId, scene))) {
          const key = await this.keyFor(scene, bucket);
          const job = this.start(sceneId, bucket, key);
          if (!job) return { status: 503, error: 'The map builder is busy. Try again in a few seconds.', retryAfter: 3 };
          return { status: 202, retryAfter: 2 };
        }
      }
      return await this.get(sceneId, maxParts, 0);
    } catch (e) {
      this.log(`[roblox-map] prewarm ${sceneId}: ${(e as Error).message}`);
      return { status: 500, error: String(e) } as MapResult;
    }
  }

  /** Whether the scene's floor plan exists: world.topdown is set and its file is there. */
  async hasTopdown(sceneId: string, scene: Scene): Promise<boolean> {
    const td = scene.world?.topdown;
    if (!td?.file || td.file.includes('/') || td.file.includes('..')) return false;
    return stat(join(this.opts.sceneDir(sceneId), td.file)).then((st) => st.isFile(), () => false);
  }

  /**
   * After the bake was merged into scene.json, the scene's cache key changes (floorY, bounds) although the map built
   * from it would be the same: point the cached default map at the new key instead of building it again. Only a map
   * built under `fromKey` is adopted.
   */
  async adopt(sceneId: string, fromKey: string, bucket: number = DEFAULT_MAX_PARTS): Promise<boolean> {
    try {
      const scene = await this.opts.getScene(sceneId);
      if (!scene?.world?.file) return false;
      const key = await this.keyFor(scene, bucket);
      if (key === fromKey) return true;
      const path = join(this.opts.sceneDir(sceneId), mapFileName(bucket));
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { build?: { key?: string } };
      if (parsed?.build?.key !== fromKey) return false;
      parsed.build.key = key;
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(parsed));
      await rename(tmp, path);
      this.mem.delete(`${sceneId}:${bucket}`);
      return true;
    } catch (e) {
      this.log(`[roblox-map] ${sceneId}: could not keep the map after the bake: ${(e as Error).message}`);
      return false;
    }
  }

  /** Forgets a scene's maps in memory (a deleted scene). Files on disk go with the scene directory. */
  forget(sceneId: string): void {
    for (const k of [...this.mem.keys()]) if (k.startsWith(`${sceneId}:`)) this.mem.delete(k);
    for (const k of [...this.failures.keys()]) if (k.startsWith(`${sceneId}:`)) this.failures.delete(k);
  }

  /** Kills a running build (server shutdown). */
  stop(): void {
    this.abort.abort();
  }

  /** Whether a build for this scene is running or waiting. */
  building(sceneId: string): boolean {
    for (const k of this.inflight.keys()) if (k.startsWith(`${sceneId}:`)) return true;
    return false;
  }

  // ---------------------------------------------------------------- internals

  private async scriptVersion(): Promise<string> {
    try {
      const st = await stat(this.opts.script);
      if (this.scriptHash && this.scriptHash.mtimeMs === st.mtimeMs) return this.scriptHash.hash;
      const hash = createHash('sha1').update(await readFile(this.opts.script)).digest('hex').slice(0, 12);
      this.scriptHash = { mtimeMs: st.mtimeMs, hash };
      return hash;
    } catch {
      return 'noscript';
    }
  }

  /** Cache key: changes whenever the room the map is built from changes. */
  async keyFor(scene: Scene, bucket: number): Promise<string> {
    const dir = this.opts.sceneDir(scene.id);
    const w = scene.world!;
    const st = await stat(join(dir, w.file));
    const cam = await stat(join(dir, 'input_camera.json')).then((s) => s.mtimeMs, () => 0);
    const v = scene.video;
    const parts = [
      await this.scriptVersion(),
      bucket,
      scene.name,
      w.file,
      st.size,
      Math.floor(st.mtimeMs),
      w.transform,
      w.floorY,
      w.spawn ?? null,
      w.bounds ?? null,
      v ? [v.cameraPose, v.intrinsics, v.width, v.height] : null,
      Math.floor(cam),
    ];
    return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
  }

  private async loadDisk(sceneId: string, bucket: number, key: string): Promise<BuiltMap | null> {
    const path = join(this.opts.sceneDir(sceneId), mapFileName(bucket));
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { build?: { key?: string }; parts?: unknown[] };
      if (parsed?.build?.key !== key || !Array.isArray(parsed.parts)) return null;
      return {
        key,
        body: bytes,
        gzip: Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>, { level: 6 }),
        etag: `"rm-${key}"`,
        parts: parsed.parts.length,
      };
    } catch {
      return null;
    }
  }

  /** Queues a build (one runs at a time; the default budget also bakes the floor plan when onBaked is set). */
  private start(sceneId: string, bucket: number, key: string): Promise<void> | null {
    const slot = `${sceneId}:${bucket}`;
    const cur = this.inflight.get(slot);
    if (cur && cur.key === key) return cur.done;
    if (this.queued >= (this.opts.maxQueue ?? 8)) return null;
    this.queued++;
    const bake = bucket === DEFAULT_MAX_PARTS && !!this.opts.onBaked;
    const run = async () => {
      const dir = this.opts.sceneDir(sceneId);
      const out = join(dir, mapFileName(bucket));
      const t0 = performance.now();
      try {
        await mkdir(dir, { recursive: true });
        await this.builder({ sceneDir: dir, out, maxParts: bucket, key, signal: this.abort.signal, ...(bake ? { topdown: join(dir, TOPDOWN_FILE) } : {}) });
        const built = await this.loadDisk(sceneId, bucket, key);
        if (!built) throw new Error('the builder finished but its map is missing or has another key');
        this.remember(slot, built);
        this.failures.delete(slot);
        this.log(
          `[roblox-map] ${sceneId}: ${built.parts} parts, ${(built.body.byteLength / 1024).toFixed(0)} KB ` +
            `(${(built.gzip.byteLength / 1024).toFixed(0)} KB gzip) in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
        );
        if (bake) {
          const parsed = JSON.parse(new TextDecoder().decode(built.body)) as { bake?: MapBake };
          if (parsed.bake?.topdown) {
            try {
              await this.opts.onBaked!(sceneId, parsed.bake, key);
            } catch (e) {
              this.log(`[roblox-map] ${sceneId}: could not store the bake: ${(e as Error).message}`);
            }
          }
        }
      } catch (e) {
        const error = (e as Error).message;
        this.failures.set(slot, { key, at: Date.now(), error });
        this.log(`[roblox-map] ${sceneId}: build failed: ${error}`);
      }
    };
    const done = this.chain.then(run, run).finally(() => {
      this.queued--;
      if (this.inflight.get(slot)?.done === done) this.inflight.delete(slot);
    });
    this.chain = done;
    this.inflight.set(slot, { key, done });
    return done;
  }

  private remember(slot: string, m: BuiltMap): void {
    this.mem.delete(slot);
    this.mem.set(slot, m);
    const max = this.opts.memoryEntries ?? 24;
    while (this.mem.size > max) this.mem.delete(this.mem.keys().next().value!);
  }

  private touch(slot: string, m: BuiltMap): void {
    this.mem.delete(slot);
    this.mem.set(slot, m);
  }
}

/**
 * One chunk (1-based) of a built map: the header fields repeated, plus `chunk` and `chunks` (contracts 6.2), and
 * `walk` as walkBounds when the map has none of its own.
 */
export function mapChunk(
  map: BuiltMap,
  chunk: number,
  walk: StudBox | null = null,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!map.parsed) map.parsed = JSON.parse(new TextDecoder().decode(map.body)) as BuiltMap['parsed'];
  const all = map.parsed!.parts;
  const chunks = Math.max(1, Math.ceil(all.length / CHUNK_PARTS));
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > chunks) {
    return { ok: false, error: `chunk must be a whole number from 1 to ${chunks}.` };
  }
  const { parts: _parts, ...header } = map.parsed!;
  if (walk && header.walkBounds === undefined) header.walkBounds = walk;
  return { ok: true, body: { ...header, chunk, chunks, parts: all.slice((chunk - 1) * CHUNK_PARTS, chunk * CHUNK_PARTS) } };
}

// ---------------------------------------------------------------- walk bounds (shivin.md Update 4)

/** How far past world.bounds (where the capture camera went) people may walk, in metres on x and z. */
export const WALK_PAD_M = 0.5;

/** An axis-aligned box in studs, map frame. */
export interface StudBox {
  min: V3;
  max: V3;
}

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;

function vec3(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: V3 = [Number(v[0]), Number(v[1]), Number(v[2])];
  return out.every(Number.isFinite) ? out : null;
}

/**
 * A scene-frame box in metres (world.bounds) in the map frame, exactly as pipeline/roblox_map.py maps points: the
 * floor (`floorY`, scene frame, the one the builder subtracted) moves to y = 0, then studs axis for axis, no flips.
 * Padded `padM` metres on x and z. null when the box is missing or not three finite numbers per corner.
 */
export function walkBoundsOf(bounds: unknown, floorY: number, spm = STUDS_PER_METER, padM = WALK_PAD_M): StudBox | null {
  if (!bounds || typeof bounds !== 'object' || !finite(floorY) || !finite(spm) || spm <= 0) return null;
  const b = bounds as { min?: unknown; max?: unknown };
  const lo = vec3(b.min);
  const hi = vec3(b.max);
  if (!lo || !hi) return null;
  const min: V3 = [Math.min(lo[0], hi[0]) - padM, Math.min(lo[1], hi[1]) - floorY, Math.min(lo[2], hi[2]) - padM];
  const max: V3 = [Math.max(lo[0], hi[0]) + padM, Math.max(lo[1], hi[1]) - floorY, Math.max(lo[2], hi[2]) + padM];
  return { min: [r2(min[0] * spm), r2(min[1] * spm), r2(min[2] * spm)], max: [r2(max[0] * spm), r2(max[1] * spm), r2(max[2] * spm)] };
}

/** A built map's header numbers, read once (the body is not kept parsed: a 12000-part map is large in memory). */
export function mapMeta(map: BuiltMap): MapMeta {
  if (!map.meta) {
    const p = (map.parsed ?? JSON.parse(new TextDecoder().decode(map.body))) as Record<string, unknown>;
    const spm = p.studsPerMeter;
    map.meta = {
      floorY: finite(p.floorY) ? p.floorY : null,
      studsPerMeter: finite(spm) && spm > 0 ? spm : STUDS_PER_METER,
      hasWalkBounds: p.walkBounds !== undefined && p.walkBounds !== null,
    };
  }
  return map.meta;
}

/**
 * The scene's walk box for a built map: world.bounds through the floor the map was built with (the map's own floorY,
 * else the scene's), padded WALK_PAD_M. null when the scene has no world.bounds.
 */
export function mapWalkBounds(map: BuiltMap, scene: Scene | null | undefined): StudBox | null {
  const w = scene?.world;
  if (!w?.bounds) return null;
  const meta = mapMeta(map);
  const floor = meta.floorY ?? (finite(w.floorY) ? w.floorY : null);
  if (floor === null) return null;
  return walkBoundsOf(w.bounds, floor, meta.studsPerMeter);
}

/**
 * The bytes to serve for a map: as built, or with `"walkBounds"` spliced in as the first field when the map has none
 * of its own, so cached maps need no rebuild. The variant is kept on the map for the walk box it was made for, and
 * has its own ETag.
 */
export function mapResponse(map: BuiltMap, walk: StudBox | null): MapBytes {
  if (!walk || mapMeta(map).hasWalkBounds) return map;
  const sig = JSON.stringify(walk);
  if (map.walk && map.walk.sig === sig) return map.walk;
  const text = new TextDecoder().decode(map.body);
  const at = text.indexOf('{');
  if (at < 0) return map;
  const rest = text.slice(at + 1);
  const sep = /^\s*\}/.test(rest) ? '' : ',';
  const body = new TextEncoder().encode(`${text.slice(0, at + 1)}"walkBounds":${sig}${sep}${rest}`);
  const tag = createHash('sha1').update(sig).digest('hex').slice(0, 8);
  map.walk = { sig, body, gzip: Bun.gzipSync(body as Uint8Array<ArrayBuffer>, { level: 6 }), etag: `"rm-${map.key}-w${tag}"` };
  return map.walk;
}
