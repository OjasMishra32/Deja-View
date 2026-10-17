// Where a Roblox room model sits, for GET /api/roblox/:sceneId/model: the box its geometry occupies (read from the
// .glb files themselves), the walk box and the floor, all in studs in the map frame (contracts 6.2, 6.2b). The game
// centres and scales the model it loaded on `bounds`, and builds its invisible walls on `walkBounds`.
//
// A .glb box is every mesh primitive's POSITION accessor min/max (glTF 2.0 requires both), its eight corners taken
// through the world transform of each node that uses the mesh. Only the JSON chunk is read, unless an accessor lacks
// min/max: then its floats come from the BIN chunk. Boxes are cached per file size and mtime.

import { open, readFile, stat } from 'node:fs/promises';
import type { Scene } from '../../shared/types.ts';
import { finite, type V3 } from './presence.ts';
import { STUDS_PER_METER, walkBoundsOf, type StudBox } from './roblox.ts';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const FLOAT = 5126;

type Mat4 = number[]; // column-major, as glTF writes them

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

const nums = (v: unknown, n: number): number[] | null =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null;

/** A node's local matrix: `matrix`, else translation * rotation * scale. */
function localMatrix(node: Record<string, unknown>): Mat4 {
  const m = nums(node.matrix, 16);
  if (m) return m;
  const [tx, ty, tz] = nums(node.translation, 3) ?? [0, 0, 0];
  const [x, y, z, w] = nums(node.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = nums(node.scale, 3) ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx!, 2 * (x * y + z * w) * sx!, 2 * (x * z - y * w) * sx!, 0,
    2 * (x * y - z * w) * sy!, (1 - 2 * (x * x + z * z)) * sy!, 2 * (y * z + x * w) * sy!, 0,
    2 * (x * z + y * w) * sz!, 2 * (y * z - x * w) * sz!, (1 - 2 * (x * x + y * y)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: Record<string, unknown>[];
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType?: number; count?: number; type?: string; min?: unknown; max?: unknown }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength?: number }[];
}

/** An accessor's own min/max, or (when it has none) the box of its float VEC3 values in the BIN chunk. */
function accessorBox(gltf: Gltf, index: number, bin: Uint8Array | null): { min: V3; max: V3 } | 'needs-bin' | null {
  const a = gltf.accessors?.[index];
  if (!a) return null;
  const lo = nums(a.min, 3);
  const hi = nums(a.max, 3);
  if (lo && hi) return { min: lo as V3, max: hi as V3 };
  if (a.componentType !== FLOAT || a.type !== 'VEC3' || a.bufferView === undefined || !a.count) return null;
  const view = gltf.bufferViews?.[a.bufferView];
  if (!view || (view.buffer ?? 0) !== 0 || gltf.buffers?.[0]?.uri !== undefined) return null; // only the GLB's own BIN chunk
  if (!bin) return 'needs-bin';
  const stride = view.byteStride || 12;
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (start + (a.count - 1) * stride + 12 > bin.byteLength) return null;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = dv.getFloat32(start + i * stride + k * 4, true);
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * The box a glTF's geometry occupies in its own frame, or null when it has no mesh (or a POSITION accessor cannot be
 * read). 'needs-bin' when an accessor without min/max has to be read from the BIN chunk.
 */
export function gltfBounds(gltf: Gltf, bin: Uint8Array | null = null): StudBox | null | 'needs-bin' {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  let found = false;
  let needsBin = false;
  const addMesh = (meshIndex: number, world: Mat4) => {
    for (const prim of gltf.meshes?.[meshIndex]?.primitives ?? []) {
      const pos = prim.attributes?.POSITION;
      if (pos === undefined) continue;
      const box = accessorBox(gltf, pos, bin);
      if (box === 'needs-bin') {
        needsBin = true;
        continue;
      }
      if (!box) continue;
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? box.max[0] : box.min[0];
        const y = c & 2 ? box.max[1] : box.min[1];
        const z = c & 4 ? box.max[2] : box.min[2];
        const p: V3 = [
          world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
          world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
          world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
        ];
        for (let k = 0; k < 3; k++) {
          if (p[k]! < min[k]!) min[k] = p[k]!;
          if (p[k]! > max[k]!) max[k] = p[k]!;
        }
        found = true;
      }
    }
  };
  const nodes = gltf.nodes ?? [];
  const visited = new Set<number>();
  const walk = (index: number, parent: Mat4) => {
    const node = nodes[index];
    if (!node || visited.has(index)) return;
    visited.add(index);
    const world = mul(parent, localMatrix(node));
    if (typeof node.mesh === 'number') addMesh(node.mesh, world);
    if (Array.isArray(node.children)) for (const ch of node.children) if (typeof ch === 'number') walk(ch, world);
  };
  let roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes;
  if (!Array.isArray(roots)) {
    const children = new Set<number>();
    for (const n of nodes) if (Array.isArray(n.children)) for (const ch of n.children) children.add(ch as number);
    roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
  }
  for (const r of roots) walk(r, IDENTITY);
  if (!nodes.length) (gltf.meshes ?? []).forEach((_, i) => addMesh(i, IDENTITY));
  if (needsBin) return 'needs-bin';
  return found ? { min, max } : null;
}

/** The JSON (and, when asked, BIN) chunk of a .glb, or null when it is not one. */
function glbChunks(bytes: Uint8Array, withBin: boolean): { gltf: Gltf; bin: Uint8Array | null } | null {
  if (bytes.byteLength < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC || dv.getUint32(16, true) !== CHUNK_JSON) return null;
  const jsonLen = dv.getUint32(12, true);
  if (jsonLen > MAX_JSON_BYTES || 20 + jsonLen > bytes.byteLength) return null;
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as Gltf;
  let bin: Uint8Array | null = null;
  const at = 20 + jsonLen;
  if (withBin && at + 8 <= bytes.byteLength && dv.getUint32(at + 4, true) === CHUNK_BIN) {
    const len = dv.getUint32(at, true);
    bin = bytes.subarray(at + 8, Math.min(bytes.byteLength, at + 8 + len));
  }
  return { gltf, bin };
}

/** The box of a .glb in memory (tests, tools); null when it is not a .glb with geometry. */
export function glbBytesBounds(bytes: Uint8Array): StudBox | null {
  try {
    const c = glbChunks(bytes, true);
    if (!c) return null;
    const box = gltfBounds(c.gltf, c.bin);
    return box === 'needs-bin' ? null : box;
  } catch {
    return null;
  }
}

const cache = new Map<string, { size: number; mtimeMs: number; box: StudBox | null }>();
const CACHE_MAX = 64;
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;

/** The box of a .glb file (studs for a Roblox model), rounded to 0.01; cached per size and mtime. */
export async function glbBounds(path: string): Promise<StudBox | null> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) return null;
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.box;
  let box: StudBox | null = null;
  try {
    const fh = await open(path, 'r');
    let head: Uint8Array;
    try {
      const h = new Uint8Array(20);
      await fh.read(h, 0, 20, 0);
      const len = new DataView(h.buffer).getUint32(12, true);
      if (new DataView(h.buffer).getUint32(0, true) !== GLB_MAGIC || len > MAX_JSON_BYTES) throw new Error('not a glb');
      head = new Uint8Array(20 + len);
      await fh.read(head, 0, head.byteLength, 0);
    } finally {
      await fh.close();
    }
    const c = glbChunks(head, false);
    let b = c ? gltfBounds(c.gltf) : null;
    if (b === 'needs-bin') b = glbBytesBounds(new Uint8Array(await readFile(path)));
    if (b) box = { min: [r2(b.min[0]), r2(b.min[1]), r2(b.min[2])], max: [r2(b.max[0]), r2(b.max[1]), r2(b.max[2])] };
  } catch {
    box = null;
  }
  cache.delete(path);
  cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, box });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return box;
}

function boxOf(v: unknown): StudBox | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as { min?: unknown; max?: unknown };
  const lo = nums(b.min, 3);
  const hi = nums(b.max, 3);
  return lo && hi ? { min: lo as V3, max: hi as V3 } : null;
}

function union(boxes: StudBox[]): StudBox {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, b.min[k]!);
      max[k] = Math.max(max[k]!, b.max[k]!);
    }
  }
  return { min, max };
}

export interface ModelFrame {
  /** Fields for the response; they replace the sidecar's own `bounds` and `floorY` (kept as sceneFloorY). */
  fields: Record<string, unknown>;
  /** Each part file's box, in the order given (null when it could not be read). */
  partBounds: (StudBox | null)[];
}

/**
 * The model's frame for the /model response, for the part files in the order the response lists them:
 *  - bounds: the union of the part files' boxes when every file could be read (boundsSource "glb"), else the
 *    sidecar's own box (boundsSource "sidecar"), else left out.
 *  - walkBounds: scene.json world.bounds in studs (the floor the model was built on moved to y = 0, padded 0.5 m on
 *    x and z), exactly as the map maps it; left out when the scene has none.
 *  - floorY: 0 (the floor of the map frame); sceneFloorY: the scene-frame floor height the model was built on.
 *  - studsPerMeter, and spawn when the sidecar knows it.
 */
export async function modelFrame(scene: Scene, sidecar: Record<string, unknown>, partFiles: string[]): Promise<ModelFrame> {
  const partBounds = await Promise.all(partFiles.map((f) => glbBounds(f)));
  const spm = finite(sidecar.studsPerMeter) && sidecar.studsPerMeter > 0 ? sidecar.studsPerMeter : STUDS_PER_METER;
  const fields: Record<string, unknown> = { studsPerMeter: spm, floorY: 0 };
  const read = partBounds.filter((b): b is StudBox => b !== null);
  const own = boxOf(sidecar.bounds);
  if (read.length && read.length === partFiles.length) {
    fields.bounds = union(read);
    fields.boundsSource = 'glb';
  } else if (own) {
    fields.bounds = own;
    fields.boundsSource = 'sidecar';
  }
  const w = scene.world;
  const sceneFloor = finite(sidecar.floorY) ? sidecar.floorY : w && finite(w.floorY) ? w.floorY : null;
  if (sceneFloor !== null) fields.sceneFloorY = sceneFloor;
  const walk = w?.bounds && sceneFloor !== null ? walkBoundsOf(w.bounds, sceneFloor, spm) : null;
  if (walk) fields.walkBounds = walk;
  if (Array.isArray(sidecar.spawn) && nums(sidecar.spawn, 3)) fields.spawn = sidecar.spawn;
  return { fields, partBounds };
}
