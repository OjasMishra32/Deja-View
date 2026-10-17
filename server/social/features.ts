// Table features (contracts 6.6): where a world's real objects are, measured once per world into
// data/scenes/<id>/features.json (metres, world.spz's own frame) and sent by GET /api/roblox/:sceneId/model and
// .../map as `features`, in studs in the map frame, so a game puts its table on the real one.
//
// A point goes to the map frame exactly as pipeline/roblox_map.py takes a splat there: world.transform (scale, then
// the rotation, then the position), the floor the map was built on moved to y = 0, then studsPerMeter axis for axis,
// no flips (contracts 3.2). Lengths scale by |scale| x studsPerMeter and directions turn with the rotation. A table's
// centre, length, width and yaw come from its converted corners the way the game works them out (PingPongSim
// fromCorners: the long axis is the longer of corners 1-2 and 2-3, yaw = atan2(-long.x, -long.z)), so they always
// agree with the corners it reads.
//
// The file is parsed once per mtime and size. No file means no `features`; a broken one (bad JSON, not an object)
// the same plus one log line; a table whose corners are not four finite points is left out on its own.

import { stat, readFile } from 'node:fs/promises';
import type { Scene, Transform } from '../../shared/types.ts';
import { finite, type V3 } from './presence.ts';
import { STUDS_PER_METER } from './roblox.ts';

export const FEATURES_FILE = 'features.json';

/** How metres in features.json reach the map frame: the scene's world.transform, its floor and the stud scale. */
export interface FeatureFrame {
  transform?: Partial<Transform> | null;
  /** Floor height the map (or model) was built on, in the frame after the transform; it moves to y = 0. */
  floorY: number;
  studsPerMeter?: number;
}

type Raw = Record<string, unknown>;
type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
const r4 = (n: number) => Math.round(n * 10000) / 10000 + 0;

function vec3(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  return [v[0], v[1], v[2]];
}

function points(v: unknown, n: number): V3[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out = v.map(vec3);
  return out.every((p) => p !== null) ? (out as V3[]) : null;
}

const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** The rotation of an xyzw quaternion (normalised, as pipeline/splat_io.py quat_xyzw_to_matrix does). */
function rotation(q: unknown): Mat3 {
  const v = Array.isArray(q) && q.length === 4 && q.every(finite) ? (q as number[]) : [0, 0, 0, 1];
  const n = Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!) || 1;
  const [x, y, z, w] = v.map((c) => c / n) as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

const turn = (R: Mat3, p: V3): V3 => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
];

/** Metres in features.json to studs in the map frame: points, lengths and directions. */
export class FeatureMapper {
  private readonly R: Mat3;
  private readonly t: V3;
  private readonly scale: number;
  readonly spm: number;

  constructor(private frame: FeatureFrame) {
    const tr = frame.transform ?? {};
    this.R = rotation(tr.quaternion);
    this.t = vec3(tr.position) ?? [0, 0, 0];
    // roblox_map.py: sc = abs(scale) or 1.0
    this.scale = finite(tr.scale) && tr.scale !== 0 ? Math.abs(tr.scale) : 1;
    this.spm = finite(frame.studsPerMeter) && frame.studsPerMeter > 0 ? frame.studsPerMeter : STUDS_PER_METER;
  }

  point(p: V3): V3 {
    const q = turn(this.R, [p[0] * this.scale, p[1] * this.scale, p[2] * this.scale]);
    return [
      r3((q[0] + this.t[0]) * this.spm),
      r3((q[1] + this.t[1] - this.frame.floorY) * this.spm),
      r3((q[2] + this.t[2]) * this.spm),
    ];
  }

  length(m: number): number {
    return r3(m * this.scale * this.spm);
  }

  direction(d: V3): V3 | null {
    const q = turn(this.R, d);
    const n = Math.hypot(q[0], q[1], q[2]);
    return n > 1e-9 ? [r4(q[0] / n), r4(q[1] / n), r4(q[2] / n)] : null;
  }
}

/** Centre, long-side length, short-side length and yaw of four corners (studs), as PingPongSim.fromCorners does. */
export function cornerFrame(c: V3[]): { centre: V3; length: number; width: number; yaw: number } {
  const centre: V3 = [0, 1, 2].map((k) => r3((c[0]![k]! + c[1]![k]! + c[2]![k]! + c[3]![k]!) / 4)) as V3;
  const e1: V3 = [c[1]![0] - c[0]![0], c[1]![1] - c[0]![1], c[1]![2] - c[0]![2]];
  const e2: V3 = [c[2]![0] - c[1]![0], c[2]![1] - c[1]![1], c[2]![2] - c[1]![2]];
  const n1 = Math.hypot(...e1);
  const n2 = Math.hypot(...e2);
  const [long, short] = n2 > n1 ? [e2, e1] : [e1, e2];
  return { centre, length: r3(Math.hypot(...long)), width: r3(Math.hypot(...short)), yaw: r4(Math.atan2(-long[0], -long[2])) };
}

/** Four corners in studs and the frame the game derives from them; null when the corners are not four points. */
function table(raw: Raw, map: FeatureMapper): { corners: V3[]; centre: V3; length: number; width: number; yaw: number; height: number } | null {
  const c = points(raw.corners, 4);
  if (!c) return null;
  const corners = c.map((p) => map.point(p));
  const f = cornerFrame(corners);
  return { corners, ...f, height: f.centre[1] };
}

/** The y (studs, map frame) of a height in metres measured above the table's own centre. */
function levelAt(raw: Raw, h: unknown, map: FeatureMapper): number | undefined {
  const c = points(raw.corners, 4);
  if (!c || !finite(h)) return undefined;
  const x = (c[0]![0] + c[1]![0] + c[2]![0] + c[3]![0]) / 4;
  const z = (c[0]![2] + c[1]![2] + c[2]![2] + c[3]![2]) / 4;
  return map.point([x, h, z])[1];
}

function pingPongTable(raw: unknown, map: FeatureMapper): Raw | null {
  if (!isObject(raw)) return null;
  const t = table(raw, map);
  if (!t) return null;
  const out: Raw = { corners: t.corners, height: t.height, centre: t.centre, length: t.length, width: t.width, yaw: t.yaw };
  const net = isObject(raw.net) ? points(raw.net.line, 2) : null;
  if (net) out.net = net.map((p) => map.point(p));
  return out;
}

function foosballTable(raw: unknown, map: FeatureMapper): Raw | null {
  if (!isObject(raw)) return null;
  const t = table(raw, map);
  if (!t) return null;
  const out: Raw = { corners: t.corners, height: t.height, centre: t.centre, length: t.length, width: t.width, yaw: t.yaw };
  const rods = vec3(raw.rods);
  const dir = rods ? map.direction(rods) : null;
  if (dir) out.rods = dir;
  const field = levelAt(raw, raw.fieldHeight, map);
  if (field !== undefined) out.fieldHeight = field;
  const rim = levelAt(raw, raw.rimHeight, map);
  if (rim !== undefined) out.rimHeight = rim;
  const rodY = levelAt(raw, raw.rodHeight, map);
  if (rodY !== undefined) out.rodHeight = rodY;
  if (Array.isArray(raw.rodOffsets) && raw.rodOffsets.length && raw.rodOffsets.length <= 16 && raw.rodOffsets.every(finite)) {
    out.rodOffsets = (raw.rodOffsets as number[]).map((m) => map.length(m));
  }
  return out;
}

function chessBoard(raw: unknown, map: FeatureMapper): Raw | null {
  if (!isObject(raw)) return null;
  const c = points(raw.corners, 4);
  const a1 = raw.a1;
  if (!c || typeof a1 !== 'number' || !Number.isInteger(a1) || a1 < 1 || a1 > 4) return null;
  const corners = c.map((p) => map.point(p));
  const out: Raw = { corners, a1 };
  if (Array.isArray(raw.cornerSquares) && raw.cornerSquares.length === 4 && raw.cornerSquares.every((s) => typeof s === 'string' && /^[a-h][1-8]$/.test(s))) {
    out.cornerSquares = raw.cornerSquares;
  }
  out.centre = cornerFrame(corners).centre;
  if (finite(raw.size) && raw.size > 0) out.size = map.length(raw.size);
  if (finite(raw.square) && raw.square > 0) out.square = map.length(raw.square);
  for (const k of ['files', 'whiteForward'] as const) {
    const d = vec3(raw[k]);
    const dir = d ? map.direction(d) : null;
    if (dir) out[k] = dir;
  }
  return out;
}

function poolTable(raw: unknown, map: FeatureMapper): Raw | null {
  if (!isObject(raw)) return null;
  const c = points(raw.corners, 4);
  if (!c) return null;
  const out: Raw = { corners: c.map((p) => map.point(p)) };
  const pockets = points(raw.pockets, 6);
  if (pockets) out.pockets = pockets.map((p) => map.point(p));
  if (finite(raw.railHeight) && raw.railHeight >= 0) out.railHeight = map.length(raw.railHeight);
  const col = raw.clothColor;
  if (Array.isArray(col) && col.length === 3 && col.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) out.clothColor = col;
  return out;
}

const KINDS: Record<string, (raw: unknown, map: FeatureMapper) => Raw | null> = { pingPongTable, foosballTable, chessBoard, poolTable };

/** A features.json body (metres) as `features` for the game (studs, map frame); null when no table is usable. */
export function featuresToStuds(raw: unknown, frame: FeatureFrame): Record<string, unknown> | null {
  if (!isObject(raw) || !finite(frame.floorY)) return null;
  const map = new FeatureMapper(frame);
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(KINDS)) {
    const f = fn(raw[name], map);
    if (f) out[name] = f;
  }
  return Object.keys(out).length ? out : null;
}

const cache = new Map<string, { size: number; mtimeMs: number; body: Raw | null }>();
const CACHE_MAX = 64;

/** The parsed features.json at `path` (metres), cached per size and mtime; null when it is missing or broken. */
export async function readFeatures(path: string, log?: (msg: string) => void): Promise<Raw | null> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.body;
  let body: Raw | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (isObject(parsed)) body = parsed;
    else log?.(`[features] ${path}: not a JSON object; no features sent`);
  } catch (e) {
    log?.(`[features] ${path}: ${(e as Error).message}; no features sent`);
  }
  cache.delete(path);
  cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, body });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return body;
}

/**
 * The `features` field for a scene: its features.json through the scene's world.transform, the floor the map or model
 * was built on (`floorY`, else the scene's) and `studsPerMeter`. null when there is nothing to send.
 */
export async function sceneFeatures(
  path: string,
  scene: Scene | null | undefined,
  floorY: number | null,
  studsPerMeter: number,
  log?: (msg: string) => void,
): Promise<Record<string, unknown> | null> {
  const w = scene?.world;
  const floor = finite(floorY) ? floorY : w && finite(w.floorY) ? w.floorY : null;
  if (floor === null) return null;
  const raw = await readFeatures(path, log);
  return raw ? featuresToStuds(raw, { transform: w?.transform, floorY: floor, studsPerMeter }) : null;
}
