// Hotspots: the guide names the interesting things in an image (normalised x, y); this module puts
// a floating label on each one in the room.
//
// Placement, best first:
//   1. depth   the scene's input camera (input_camera.json) and its rendered depth (input_depth.npy):
//              unproject the pixel at its z-depth.
//   2. splats  a ray from that camera (or the video camera, or the snapshot camera when the scene has
//              no input camera) through the pixel, against the splats (SplatMesh.raycast).
//   3. voxels  the same ray marched in half-voxel steps through the collision grid.
// Each anchor sits 5 cm in front of the surface; no hit within 6 m drops the label.
//
// Frames: input_camera.json and VideoLayer.cameraPose are in the scene's viewer frame (after
// WorldAsset.transform); `toWorld` (the app's flip group matrixWorld) maps that to three.js world,
// which is the room frame (floor at y = 0). Snapshot cameras are already in world.

import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** A hotspot as the guide returns it: x right, y down, both 0..1 in the image it was sent. */
export interface GuideHotspot {
  label: string;
  x: number;
  y: number;
  blurb?: string;
}

/** A hotspot placed in the room (three.js world = room frame, metres). */
export interface PlacedHotspot {
  id: string;
  label: string;
  blurb: string;
  position: Vec3;
  /** Normalised image position it came from, when known. */
  u?: number;
  v?: number;
  source?: 'depth' | 'splats' | 'voxels' | 'stored' | 'live';
}

/** Pinhole camera, OpenGL convention (looks down -Z, +Y up), intrinsics in pixels of width x height. */
export interface PinholeCamera {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  position: Vec3;
  /** x, y, z, w */
  quaternion: Quat;
}

/** z-depth along the viewing axis, row-major, top row first; 0 or non-finite = no data. */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

// ---------------------------------------------------------------------------------------------
// .npy

export interface NpyArray {
  dtype: string;
  shape: number[];
  fortranOrder: boolean;
  /** Values converted to float32, in the file's element order. */
  data: Float32Array;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Parses a NumPy .npy file (format 1.x, 2.x or 3.x) holding floats or integers. */
export function parseNpy(input: ArrayBuffer | Uint8Array): NpyArray {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 10 || bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') throw new Error('not a .npy file');
  const major = bytes[6];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerLen: number;
  let start: number;
  if (major === 1) {
    headerLen = dv.getUint16(8, true);
    start = 10;
  } else if (major === 2 || major === 3) {
    if (bytes.length < 12) throw new Error('.npy header is truncated');
    headerLen = dv.getUint32(8, true);
    start = 12;
  } else throw new Error(`unsupported .npy version ${major}`);
  if (start + headerLen > bytes.length) throw new Error('.npy header is truncated');
  const header = new TextDecoder(major === 3 ? 'utf-8' : 'latin1').decode(bytes.subarray(start, start + headerLen));
  const descr = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  const fortran = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || fortran === undefined || shapeText === undefined) throw new Error('.npy header is not readable');
  const shape = shapeText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10));
  if (shape.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('.npy shape is not valid');
  const count = shape.reduce((a, b) => a * b, 1);
  const order = descr[0];
  const little = order === '<' || order === '|' || order === '=';
  const kind = descr.slice(1);
  const size: Record<string, number> = { f4: 4, f8: 8, f2: 2, u1: 1, i1: 1, u2: 2, i2: 2, u4: 4, i4: 4 };
  const bpe = size[kind];
  if (!bpe) throw new Error(`unsupported .npy dtype ${descr}`);
  const offset = start + headerLen;
  if (offset + count * bpe > bytes.length) throw new Error('.npy data is truncated');
  const abs = bytes.byteOffset + offset;
  let data: Float32Array;
  if (kind === 'f4' && little && abs % 4 === 0) {
    data = new Float32Array(bytes.buffer.slice(abs, abs + count * 4) as ArrayBuffer);
  } else {
    data = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const o = offset + i * bpe;
      switch (kind) {
        case 'f4': data[i] = dv.getFloat32(o, little); break;
        case 'f8': data[i] = dv.getFloat64(o, little); break;
        case 'f2': data[i] = halfToFloat(dv.getUint16(o, little)); break;
        case 'u1': data[i] = bytes[o]; break;
        case 'i1': data[i] = dv.getInt8(o); break;
        case 'u2': data[i] = dv.getUint16(o, little); break;
        case 'i2': data[i] = dv.getInt16(o, little); break;
        case 'u4': data[i] = dv.getUint32(o, little); break;
        case 'i4': data[i] = dv.getInt32(o, little); break;
      }
    }
  }
  return { dtype: descr, shape, fortranOrder: fortran === 'True', data };
}

/** A 2D (or H x W x 1) array as a row-major depth map. */
export function depthMapFromNpy(npy: NpyArray): DepthMap {
  const s = npy.shape;
  if (s.length < 2 || (s.length === 3 && s[2] !== 1) || s.length > 3) throw new Error(`depth must be H x W, got ${s.join(' x ')}`);
  const [h, w] = s;
  if (!npy.fortranOrder) return { width: w, height: h, data: npy.data };
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out[r * w + c] = npy.data[c * h + r];
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------------------------
// Cameras

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

/** input_camera.json (docs/FLASHWORLD.md) as a pinhole camera; null when it is not usable. */
export function parseInputCamera(json: unknown): (PinholeCamera & { depthWidth?: number; depthHeight?: number }) | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const width = j.width, height = j.height, fx = j.fx, fy = j.fy;
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  if (!finite(fx) || fx <= 0) return null;
  const position = vec(j.position, 3) ? (j.position as Vec3) : ([0, 0, 0] as Vec3);
  const quaternion = vec(j.quaternion, 4) ? (j.quaternion as Quat) : ([0, 0, 0, 1] as Quat);
  return {
    width,
    height,
    fx,
    fy: finite(fy) && fy > 0 ? fy : fx,
    cx: finite(j.cx) ? j.cx : width / 2,
    cy: finite(j.cy) ? j.cy : height / 2,
    position,
    quaternion,
    depthWidth: finite(j.depthWidth) ? j.depthWidth : undefined,
    depthHeight: finite(j.depthHeight) ? j.depthHeight : undefined,
  };
}

/** The video camera of a Video scene (VideoLayer intrinsics are in pixels of width x height). */
export function cameraFromVideo(v: { width: number; height: number; intrinsics: { fx: number; fy: number; cx: number; cy: number }; cameraPose: { position: Vec3; quaternion: Quat } }): PinholeCamera | null {
  return parseInputCamera({ width: v.width, height: v.height, ...v.intrinsics, position: v.cameraPose.position, quaternion: v.cameraPose.quaternion });
}

/** A three.js perspective camera as a pinhole camera in world space (square pixels, centred). */
export function cameraFromThree(cam: THREE.PerspectiveCamera, width: number, height: number): PinholeCamera {
  cam.updateMatrixWorld(true);
  const fy = height / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * (cam.zoom || 1);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  cam.matrixWorld.decompose(p, q, s);
  // a camera whose aspect differs from width/height stretches x
  const fx = fy * (width / height) / (cam.aspect || width / height);
  return { width, height, fx, fy, cx: width / 2, cy: height / 2, position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * Ray through a normalised image position (x right, y down). `dir` is scaled so its camera-space z
 * is -1: origin + dir * d is the point at z-depth d (the depth maps store z-depth, not ray length).
 */
export function pixelRay(cam: PinholeCamera, nx: number, ny: number): { origin: Vec3; dir: Vec3 } {
  const u = nx * cam.width;
  const v = ny * cam.height;
  const local: Vec3 = [(u - cam.cx) / cam.fx, -(v - cam.cy) / cam.fy, -1];
  return { origin: [...cam.position] as Vec3, dir: rotate(cam.quaternion, local) };
}

/** The point at z-depth `depth` behind normalised image position (nx, ny). */
export function unproject(cam: PinholeCamera, nx: number, ny: number, depth: number): Vec3 {
  const { origin, dir } = pixelRay(cam, nx, ny);
  return [origin[0] + dir[0] * depth, origin[1] + dir[1] * depth, origin[2] + dir[2] * depth];
}

/** Normalised image position and z-depth of a point (inverse of unproject); null behind the camera. */
export function project(cam: PinholeCamera, p: Vec3): { nx: number; ny: number; depth: number } | null {
  const rel: Vec3 = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const c = rotate(conj(cam.quaternion), rel);
  const depth = -c[2];
  if (depth <= 1e-6) return null;
  const u = cam.cx + (c[0] / depth) * cam.fx;
  const v = cam.cy - (c[1] / depth) * cam.fy;
  return { nx: u / cam.width, ny: v / cam.height, depth };
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Depth under a normalised image position: a low percentile of the valid values in a small window
 * (biased toward the nearer surface, so a label on an object's edge sticks to the object rather
 * than the wall behind it). Null when the window has no data.
 */
export function sampleDepth(map: DepthMap, nx: number, ny: number, radius = 2, percentile = 0.3): number | null {
  if (!map.width || !map.height) return null;
  const col = Math.min(map.width - 1, Math.max(0, Math.floor(nx * map.width)));
  const row = Math.min(map.height - 1, Math.max(0, Math.floor(ny * map.height)));
  for (const r of [radius, radius * 3]) {
    const vals: number[] = [];
    for (let y = Math.max(0, row - r); y <= Math.min(map.height - 1, row + r); y++) {
      for (let x = Math.max(0, col - r); x <= Math.min(map.width - 1, col + r); x++) {
        const d = map.data[y * map.width + x];
        if (Number.isFinite(d) && d > 0) vals.push(d);
      }
    }
    if (vals.length) {
      vals.sort((a, b) => a - b);
      return vals[Math.min(vals.length - 1, Math.floor(percentile * vals.length))];
    }
  }
  return null;
}

export interface MarchOptions {
  /** Skip this much right in front of the camera (floaters, the camera's own spot). */
  start: number;
  /** Step length; half a voxel. */
  step: number;
  max: number;
}

export const DEFAULT_MARCH: MarchOptions = { start: 0.25, step: 0.05, max: 6 };

/** Distance along a unit ray to the first solid point, refined by bisection; null when nothing is hit. */
export function marchRay(origin: Vec3, dir: Vec3, solid: (x: number, y: number, z: number) => boolean, opts: Partial<MarchOptions> = {}): number | null {
  const o = { ...DEFAULT_MARCH, ...opts };
  const at = (t: number) => solid(origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t);
  let prev = o.start;
  for (let t = o.start; t <= o.max + 1e-9; t += o.step) {
    if (at(t)) {
      if (t === o.start) return t;
      let lo = prev, hi = t;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Placement

export interface PlacementEnv {
  /** The camera the image was taken with. */
  camera: PinholeCamera;
  /** Whether `camera` is in the scene's viewer frame (then toWorld applies) or already in world. */
  cameraFrame: 'scene' | 'world';
  /** Scene viewer frame -> world (the app's flip group matrixWorld). */
  toWorld: THREE.Matrix4;
  depth?: DepthMap | null;
  /** Splat raycast in world: distance to the nearest splat along a unit ray, or null. */
  raycastSplats?: ((origin: Vec3, dir: Vec3, far: number) => number | null) | null;
  /** Solid test in world (the voxel grid or mesh collider). */
  solidAt?: ((x: number, y: number, z: number) => boolean) | null;
  /** Anchor this far in front of the surface. */
  standOff?: number;
  /** Farthest label from the camera. */
  maxDistance?: number;
}

const applyM = (m: THREE.Matrix4, p: Vec3): Vec3 => {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
  return [v.x, v.y, v.z];
};

let idCounter = 0;
export function hotspotId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'spot';
  return `${slug}-${(idCounter++).toString(36)}`;
}

/** Cleans what the guide sent: labels trimmed and short, positions in 0..1, duplicates dropped. */
export function cleanHotspots(raw: unknown, max = 8): GuideHotspot[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { hotspots?: unknown }).hotspots) ? (raw as { hotspots: unknown[] }).hotspots : [];
  const out: GuideHotspot[] = [];
  const seen = new Set<string>();
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    const x = Number(r.x), y = Number(r.y);
    if (!label || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), blurb: typeof r.blurb === 'string' ? r.blurb.trim().slice(0, 220) : '' });
    if (out.length >= max) break;
  }
  return out;
}

/** World ray (unit direction) through an image position of the env's camera. */
export function worldRay(env: PlacementEnv, nx: number, ny: number): { origin: Vec3; dir: Vec3; zScale: number } {
  const r = pixelRay(env.camera, nx, ny);
  const len = Math.hypot(r.dir[0], r.dir[1], r.dir[2]);
  if (env.cameraFrame === 'world') return { origin: r.origin, dir: normalize(r.dir), zScale: len };
  const o = applyM(env.toWorld, r.origin);
  const e = applyM(env.toWorld, [r.origin[0] + r.dir[0], r.origin[1] + r.dir[1], r.origin[2] + r.dir[2]]);
  const d: Vec3 = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  return { origin: o, dir: normalize(d), zScale: Math.hypot(d[0], d[1], d[2]) };
}

/** Places one hotspot; null when it cannot be anchored on anything. */
export function placeHotspot(h: GuideHotspot, env: PlacementEnv): PlacedHotspot | null {
  const back = env.standOff ?? 0.05;
  const far = env.maxDistance ?? 6;
  const ray = worldRay(env, h.x, h.y);
  const at = (dist: number): Vec3 => {
    const t = Math.max(0.15, dist - back);
    return [ray.origin[0] + ray.dir[0] * t, Math.max(0.03, ray.origin[1] + ray.dir[1] * t), ray.origin[2] + ray.dir[2] * t];
  };
  const base = { id: hotspotId(h.label), label: h.label, blurb: h.blurb ?? '', u: h.x, v: h.y };
  if (env.depth) {
    const z = sampleDepth(env.depth, h.x, h.y);
    // z-depth to distance along the unit world ray
    const dist = z !== null ? z * ray.zScale : null;
    if (dist !== null && dist > 0.15 && dist <= Math.max(far, 8)) return { ...base, position: at(dist), source: 'depth' };
  }
  if (env.raycastSplats) {
    try {
      const d = env.raycastSplats(ray.origin, ray.dir, far);
      if (d !== null && Number.isFinite(d) && d > 0.15 && d <= far) return { ...base, position: at(d), source: 'splats' };
    } catch {
      /* fall through to the voxels */
    }
  }
  if (env.solidAt) {
    const d = marchRay(ray.origin, ray.dir, env.solidAt, { max: far });
    if (d !== null) return { ...base, position: at(d), source: 'voxels' };
  }
  return null;
}

/** Stored hotspots ({hotspots:[{label, blurb, x, y, z}]} or a bare array; `position` also accepted). */
export function parseStoredHotspots(raw: unknown): PlacedHotspot[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { hotspots?: unknown }).hotspots) ? (raw as { hotspots: unknown[] }).hotspots : [];
  const out: PlacedHotspot[] = [];
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 40) : '';
    // numbers only: Number(null) would quietly put a label on the floor
    const p = vec(r.position, 3) ? (r.position as Vec3) : finite(r.x) && finite(r.y) && finite(r.z) ? [r.x, r.y, r.z] : null;
    if (!label || !p) continue;
    out.push({ id: hotspotId(label), label, blurb: typeof r.blurb === 'string' ? r.blurb : '', position: [p[0], p[1], p[2]], u: finite(r.u) ? r.u : undefined, v: finite(r.v) ? r.v : undefined, source: 'stored' });
  }
  return out;
}

/** The body for PUT /api/scenes/:id/hotspots. */
export function storedHotspotsBody(list: PlacedHotspot[]): { hotspots: Array<{ label: string; blurb: string; x: number; y: number; z: number; u?: number; v?: number; source?: string }> } {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    hotspots: list.map((h) => ({ label: h.label, blurb: h.blurb, x: r3(h.position[0]), y: r3(h.position[1]), z: r3(h.position[2]), u: h.u, v: h.v, source: h.source })),
  };
}

/** Extra lift per hotspot so labels that sit close together stack instead of overlapping. */
export function stackLifts(list: Array<{ position: Vec3 }>, near = 0.4, step = 0.13): number[] {
  const lifts = list.map(() => 0);
  const order = list.map((_, i) => i).sort((a, b) => list[a].position[1] - list[b].position[1]);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const pi = list[i].position;
    for (let m = 0; m < k; m++) {
      const j = order[m];
      const pj = list[j].position;
      const dh = Math.hypot(pi[0] - pj[0], pi[2] - pj[2]);
      const yi = pi[1] + lifts[i], yj = pj[1] + lifts[j];
      if (dh < near && Math.abs(yi - yj) < step) lifts[i] = yj - pi[1] + step;
    }
  }
  return lifts;
}

// ---------------------------------------------------------------------------------------------
// The label layer (three.js)

// Apple colours: frosted white pills with dark text, blue when you point at one.
export const ACCENT = '#007AFF';
const INK = '#1d1d1f';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", Roboto, system-ui, sans-serif';

const CW = 640;
const CH = 256;
const PILL_H = 84;
/** World height of the label canvas at scale 1 (metres). */
const LABEL_H = 0.16;
const BASE_LIFT = 0.17;

function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, h / 2, w / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Splits text into at most maxLines lines that fit maxWidth (the last one gets an ellipsis). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= maxWidth || !cur) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) {
      cur = '';
      const rest = words.slice(i).join(' ');
      let last = lines[maxLines - 1];
      if (rest) {
        while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
        lines[maxLines - 1] = `${last}…`;
      }
      return lines;
    }
  }
  if (cur) lines.push(cur);
  // a single word longer than the line
  return lines.map((l) => {
    if (measure(l) <= maxWidth) return l;
    let s = l;
    while (s.length > 1 && measure(`${s}…`) > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  });
}

interface LabelItem {
  h: PlacedHotspot;
  root: THREE.Group;
  pin: THREE.Mesh;
  halo: THREE.Mesh;
  stem: THREE.Mesh;
  holder: THREE.Group;
  plane: THREE.Mesh;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mats: THREE.MeshBasicMaterial[];
  lift: number;
  appear: number;
  hover: boolean;
  hoverAmt: number;
  pulse: number;
  ttl: number | null;
  dirty: boolean;
  /** Pill (and card, when hovered) in canvas pixels, for hit tests. */
  hitRects: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface LabelLayerOptions {
  /** Line under the label when it is pointed at. */
  actionHint: () => string;
}

/** Floating labels: a lime pin on the surface, a thin stem and a pill that faces you. */
export class HotspotLayer {
  readonly group = new THREE.Group();
  /**
   * How far labels may be (metres). Rooms keep 6 (labels fade out from 9 to 12 m and stop growing at 5 m); a bigger
   * reach keeps far labels the same apparent size and visible out to it.
   */
  reach = 6;
  private items: LabelItem[] = [];
  private visible = true;
  private fade = 1;
  private time = 0;
  private hoverId: string | null = null;
  private tmp = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private camQuat = new THREE.Quaternion();
  private faceQuat = new THREE.Quaternion();
  private basis = new THREE.Matrix4();
  private ax = new THREE.Vector3();
  private ay = new THREE.Vector3();
  private az = new THREE.Vector3();

  constructor(private opts: LabelLayerOptions = { actionHint: () => 'Ask about this' }) {
    this.group.name = 'guide-hotspots';
    this.group.renderOrder = 970;
  }

  get count(): number {
    return this.items.length;
  }

  get hotspots(): PlacedHotspot[] {
    return this.items.filter((i) => i.ttl === null).map((i) => i.h);
  }

  /** Planes to raycast against. */
  get targets(): THREE.Object3D[] {
    return this.items.filter((i) => i.root.visible).map((i) => i.plane);
  }

  setVisible(on: boolean): void {
    this.visible = on;
  }

  get shown(): boolean {
    return this.visible;
  }

  /** Replaces the labels (they pop in one after another). */
  set(list: PlacedHotspot[], stagger = 0.12): void {
    this.clear();
    const lifts = stackLifts(list);
    list.forEach((h, i) => this.items.push(this.make(h, lifts[i], -i * stagger, null)));
    for (const it of this.items) this.group.add(it.root);
  }

  /** A temporary label (an answer about something that has no label yet). */
  addTemporary(h: PlacedHotspot, seconds = 7): void {
    const it = this.make(h, 0, 0, seconds);
    it.pulse = seconds;
    this.items.push(it);
    this.group.add(it.root);
  }

  find(label: string): PlacedHotspot | null {
    const key = label.trim().toLowerCase();
    if (!key) return null;
    const exact = this.items.find((i) => i.h.label.toLowerCase() === key);
    if (exact) return exact.h;
    const loose = this.items.find((i) => i.h.label.toLowerCase().includes(key) || key.includes(i.h.label.toLowerCase()));
    return loose?.h ?? null;
  }

  /** Lights a label up for a while (the answer was about it). */
  pulse(id: string, seconds = 5): void {
    const it = this.items.find((i) => i.h.id === id);
    if (it) {
      it.pulse = seconds;
      it.dirty = true;
    }
  }

  setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    for (const it of this.items) {
      const h = it.h.id === id;
      if (h !== it.hover) {
        it.hover = h;
        it.dirty = true;
      }
    }
  }

  get hovered(): PlacedHotspot | null {
    return this.items.find((i) => i.h.id === this.hoverId)?.h ?? null;
  }

  /** The label a ray points at (its pill, not the transparent canvas around it). */
  hit(raycaster: THREE.Raycaster): { hotspot: PlacedHotspot; distance: number; point: THREE.Vector3 } | null {
    if (!this.visible || this.fade < 0.3) return null;
    const hits = raycaster.intersectObjects(this.targets, false);
    for (const hit of hits) {
      const it = this.items.find((i) => i.plane === hit.object);
      if (!it || !hit.uv) continue;
      const px = hit.uv.x * CW, py = (1 - hit.uv.y) * CH;
      if (it.hitRects.some((r) => px >= r.x - 8 && px <= r.x + r.w + 8 && py >= r.y - 8 && py <= r.y + r.h + 8)) return { hotspot: it.h, distance: hit.distance, point: hit.point };
    }
    return null;
  }

  private make(h: PlacedHotspot, extraLift: number, appear: number, ttl: number | null): LabelItem {
    const root = new THREE.Group();
    root.name = `hotspot:${h.label}`;
    root.position.set(h.position[0], h.position[1], h.position[2]);
    const mat = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...o });
    const pinMat = mat({ color: 0xffffff });
    const haloMat = mat({ color: 0xffffff, opacity: 0.45, side: THREE.DoubleSide });
    const stemMat = mat({ color: 0xffffff, opacity: 0.8 });
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 10), pinMat);
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.017, 0.022, 32), haloMat);
    const stemGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 6, 1, true);
    stemGeo.translate(0, 0.5, 0);
    const stem = new THREE.Mesh(stemGeo, stemMat);
    const canvas = document.createElement('canvas');
    canvas.width = CW;
    canvas.height = CH;
    const g = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const planeMat = mat({ map: tex, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(LABEL_H * (CW / CH), LABEL_H);
    geo.translate(0, LABEL_H / 2, 0);
    const plane = new THREE.Mesh(geo, planeMat);
    const holder = new THREE.Group();
    holder.add(plane);
    pin.renderOrder = 971;
    halo.renderOrder = 971;
    stem.renderOrder = 970;
    plane.renderOrder = 972;
    for (const o of [pin, halo, stem, plane]) o.frustumCulled = false;
    root.add(stem, pin, halo, holder);
    root.scale.setScalar(0.0001);
    return { h, root, pin, halo, stem, holder, plane, canvas, g, tex, mats: [pinMat, haloMat, stemMat, planeMat], lift: extraLift, appear, hover: false, hoverAmt: 0, pulse: 0, ttl, dirty: true, hitRects: [] };
  }

  /** Redraws every label (after the web fonts arrive). */
  invalidate(): void {
    for (const it of this.items) it.dirty = true;
  }

  private draw(it: LabelItem): void {
    const { g } = it;
    g.clearRect(0, 0, CW, CH);
    const lit = it.hover || it.pulse > 0;
    const filled = lit;
    const pillY = CH - PILL_H - 4;
    g.font = `600 44px ${FONT}`;
    let label = it.h.label;
    const maxText = CW - 120;
    while (label.length > 2 && g.measureText(label).width > maxText) label = label.slice(0, -1);
    if (label !== it.h.label) label = `${label.trimEnd()}…`;
    const tw = g.measureText(label).width;
    const pw = Math.min(CW - 8, tw + 108);
    const px = (CW - pw) / 2;
    // soft shadow
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.28)';
    g.shadowBlur = 16;
    g.shadowOffsetY = 4;
    roundRect(g, px, pillY, pw, PILL_H, PILL_H / 2);
    g.fillStyle = filled ? ACCENT : 'rgba(255,255,255,0.92)';
    g.fill();
    g.restore();
    // marker
    g.beginPath();
    g.arc(px + 44, pillY + PILL_H / 2, 10, 0, Math.PI * 2);
    g.fillStyle = filled ? '#fff' : ACCENT;
    g.fill();
    g.fillStyle = filled ? '#fff' : INK;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(label, px + 68, pillY + PILL_H / 2 + 2);
    it.hitRects = [{ x: px, y: pillY, w: pw, h: PILL_H }];

    if (it.hover) {
      // a card above the pill: the blurb and what pressing does
      const cardW = CW - 8, cardX = 4;
      g.font = `500 33px ${FONT}`;
      const lines = it.h.blurb ? wrapLines(it.h.blurb, cardW - 56, (s) => g.measureText(s).width, 2) : [];
      const cardH = 30 + lines.length * 40 + 44;
      const cardY = pillY - 10 - cardH;
      roundRect(g, cardX, cardY, cardW, cardH, 30);
      g.fillStyle = 'rgba(255,255,255,0.94)';
      g.fill();
      g.fillStyle = INK;
      g.textBaseline = 'alphabetic';
      lines.forEach((l, i) => g.fillText(l, cardX + 28, cardY + 52 + i * 40));
      g.font = `500 26px ${FONT}`;
      g.fillStyle = ACCENT;
      g.fillText(this.opts.actionHint(), cardX + 28, cardY + cardH - 20);
      it.hitRects.push({ x: cardX, y: cardY, w: cardW, h: cardH });
    }
    it.tex.needsUpdate = true;
  }

  /** Billboards, scales with distance, animates. Call every frame with the head (camera) world position. */
  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.fade += ((this.visible ? 1 : 0) - this.fade) * Math.min(1, dt * 6);
    camera.getWorldPosition(this.camPos);
    camera.getWorldQuaternion(this.camQuat);
    // labels lie in the view plane but stay upright: no perspective skew, no head roll
    this.az.set(0, 0, 1).applyQuaternion(this.camQuat);
    this.ax.set(0, 1, 0).cross(this.az);
    if (this.ax.lengthSq() < 1e-6) this.ax.set(1, 0, 0).applyQuaternion(this.camQuat);
    this.ax.normalize();
    this.ay.crossVectors(this.az, this.ax).normalize();
    this.faceQuat.setFromRotationMatrix(this.basis.makeBasis(this.ax, this.ay, this.az));
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      if (it.ttl !== null) {
        it.ttl -= dt;
        if (it.ttl <= 0) {
          this.removeAt(k);
          continue;
        }
      }
      it.appear = Math.min(1, it.appear + dt / 0.45);
      if (it.pulse > 0) {
        it.pulse = Math.max(0, it.pulse - dt);
        if (it.pulse === 0) it.dirty = true;
      }
      it.hoverAmt += ((it.hover ? 1 : 0) - it.hoverAmt) * Math.min(1, dt * 14);
      if (it.dirty) {
        it.dirty = false;
        this.draw(it);
      }
      const dist = this.tmp.copy(it.root.position).distanceTo(this.camPos);
      // about constant angular size, within limits
      const big = this.reach > 6;
      const s = THREE.MathUtils.clamp(dist / 1.5, 0.6, big ? this.reach / 1.5 : 3.5);
      const pop = it.appear <= 0 ? 0 : easeOutBack(Math.min(1, it.appear));
      const nearFade = THREE.MathUtils.smoothstep(dist, 0.35, 0.7);
      const farFade = 1 - (big ? THREE.MathUtils.smoothstep(dist, this.reach + 6, this.reach + 12) : THREE.MathUtils.smoothstep(dist, 9, 12));
      const opacity = this.fade * nearFade * farFade * Math.min(1, Math.max(0, it.appear) * 3);
      it.root.visible = opacity > 0.01 && pop > 0.001;
      if (!it.root.visible) continue;
      const pulse = it.pulse > 0 ? 1 + 0.07 * Math.sin(this.time * 7) : 1;
      const lift = (BASE_LIFT + it.lift) * s;
      it.root.scale.setScalar(Math.max(0.0001, pop));
      it.pin.scale.setScalar(s * (it.hover ? 1.25 : 1));
      const haloPhase = (this.time * 0.8 + k * 0.17) % 1;
      it.halo.scale.setScalar(s * (1 + haloPhase * 1.6));
      it.halo.quaternion.copy(this.camQuat);
      it.stem.scale.set(s, Math.max(0.001, lift - 0.012 * s), s);
      it.holder.position.set(0, lift, 0);
      it.holder.scale.setScalar(s * pulse * (1 + 0.06 * it.hoverAmt));
      it.holder.quaternion.copy(this.faceQuat);
      it.mats[0].opacity = opacity;
      it.mats[1].opacity = opacity * 0.55 * (1 - haloPhase);
      it.mats[2].opacity = opacity * 0.75;
      it.mats[3].opacity = opacity;
    }
  }

  private removeAt(k: number): void {
    const it = this.items[k];
    this.group.remove(it.root);
    this.disposeItem(it);
    this.items.splice(k, 1);
  }

  private disposeItem(it: LabelItem): void {
    it.tex.dispose();
    for (const m of it.mats) m.dispose();
    for (const o of [it.pin, it.halo, it.stem, it.plane]) o.geometry.dispose();
  }

  clear(): void {
    for (const it of this.items) {
      this.group.remove(it.root);
      this.disposeItem(it);
    }
    this.items = [];
    this.hoverId = null;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
