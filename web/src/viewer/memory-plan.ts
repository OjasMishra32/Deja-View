// The memory intro's plan, in pure math (no three.js, no DOM) so bun tests cover it:
//   - which input view to show for a reconstructed world, and where its image file may be,
//   - the relief: for a grid over the photo, how far along each pixel's ray the world's surface lies,
//   - the timeline: card opacity, travel, lift, the reveal front and the sky for entering and leaving.
// memory-intro.ts turns this into the card on screen.

import type { Scene } from '../../../shared/types.ts';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** A pinhole camera in the world frame: OpenGL axes (looks down -Z, +Y up), intrinsics in pixels of width x height. */
export interface PinholeCamera {
  position: V3;
  quaternion: Q4;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** One entry of a reconstructed world's cameras.json (pipeline/recon): every input view's pose. */
export interface CameraRecord {
  name: string;
  group?: string;
  source?: string;
  position: V3;
  quaternion: Q4;
  intrinsics: { width: number; height: number; fx: number; fy: number; cx: number; cy: number };
}

const finite = (...v: unknown[]) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function isPinhole(c: Partial<PinholeCamera> | null | undefined): c is PinholeCamera {
  if (!c || !Array.isArray(c.position) || !Array.isArray(c.quaternion)) return false;
  if (c.position.length !== 3 || c.quaternion.length !== 4) return false;
  if (!finite(...c.position, ...c.quaternion, c.width, c.height, c.fx, c.fy, c.cx, c.cy)) return false;
  const qn = Math.hypot(...c.quaternion);
  return c.width! > 8 && c.height! > 8 && c.fx! > 1 && c.fy! > 1 && qn > 0.5 && qn < 1.5;
}

/** Rotates v by the unit quaternion q (x, y, z, w). */
export function rotateVec(q: Q4, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 q x v ; v' = v + w t + q x t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

export function normalizeQuat(q: Q4): Q4 {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** The camera's viewing direction (its -Z) in the world. */
export function cameraForward(q: Q4): V3 {
  return rotateVec(normalizeQuat(q), [0, 0, -1]);
}

/** Yaw (about +Y, 0 = looking down -Z, three.js sign) and pitch (up positive) of a camera. */
export function yawPitch(q: Q4): { yaw: number; pitch: number } {
  const f = cameraForward(q);
  return { yaw: Math.atan2(-f[0], -f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export interface Stand {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Input views ordered by how well they stand in for "what you see from the spawn": close to it, facing the same
 * way, near eye level and level. Photos beat frames from video clips. `toWorld` maps a camera position into the
 * frame of `spawn` (feet on the floor; the eye is eyeY above).
 */
export function rankCameras(cams: readonly CameraRecord[], spawn: Stand, eyeY: number, toWorld: (p: V3) => V3 = (p) => p): CameraRecord[] {
  const scored: { cam: CameraRecord; score: number }[] = [];
  for (const cam of cams) {
    const i = cam?.intrinsics;
    if (!i || !isPinhole({ position: cam.position, quaternion: cam.quaternion, ...i })) continue;
    const p = toWorld(cam.position);
    const { yaw, pitch } = yawPitch(cam.quaternion);
    const dist = Math.hypot(p[0] - spawn.x, p[2] - spawn.z);
    const turn = Math.abs(wrapAngle(yaw - spawn.yaw));
    const tilt = Math.max(0, Math.abs(pitch) - 0.12);
    const height = Math.abs(p[1] - (spawn.y + eyeY));
    // a still photo is sharper than a frame from a walk-through clip, and it is what people took
    const score = dist + 0.9 * turn + 1.2 * tilt + 0.4 * height + (cam.group === 'photo' ? 0 : 0.35);
    scored.push({ cam, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.cam);
}

const IMAGE = /\.(jpe?g|png|webp|avif)$/i;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const safe = (p: string) => !!p && !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/^[a-z]+:/i.test(p);

/**
 * Where a reconstructed view's image may sit in the scene folder (relative paths, most likely first): an input file
 * of the same name, then input/<name>, then the camera's own relative name (e.g. photo/IMG_1.jpg).
 */
export function imageCandidates(scene: Pick<Scene, 'input'>, cam: Pick<CameraRecord, 'name' | 'source'>): string[] {
  const names = new Set([base(cam.name), cam.source ? base(cam.source) : ''].filter((n) => IMAGE.test(n)));
  const out: string[] = [];
  for (const f of scene.input?.files ?? []) if (names.has(base(f)) && safe(f)) out.push(f);
  for (const n of names) out.push(`input/${n}`);
  if (IMAGE.test(cam.name) && safe(cam.name)) out.push(cam.name);
  return [...new Set(out)];
}

/** The first input file that is an image (one-photo worlds). */
export function inputImage(scene: Pick<Scene, 'input'>): string | null {
  return (scene.input?.files ?? []).find((f) => IMAGE.test(f) && safe(f)) ?? null;
}

/** Scales intrinsics to an image of a different size (a resized copy of the same picture). */
export function fitIntrinsics(cam: PinholeCamera, width: number, height: number): PinholeCamera {
  if (!(width > 0 && height > 0) || (width === cam.width && height === cam.height)) return cam;
  const sx = width / cam.width, sy = height / cam.height;
  return { ...cam, width, height, fx: cam.fx * sx, cx: cam.cx * sx, fy: cam.fy * sy, cy: cam.cy * sy };
}

// ---------------------------------------------------------------------------------------------------------------
// Relief: the photo as a height field around its camera centre

export interface Relief {
  /** Grid cells across and down; vertices are (cols + 1) x (rows + 1), row-major from the top-left. */
  cols: number;
  rows: number;
  /** Per vertex: camera-space tangents (x right, y up), so the ray is (tx, ty, -1). */
  tan: Float32Array;
  /** Per vertex: z-depth of the world's surface along that ray (metres). */
  depth: Float32Array;
  /**
   * Per vertex: the distance at which the pixel may dissolve, the farthest surface around it. Next to a silhouette a
   * coarse grid blends the near object with the wall behind; waiting for the wall keeps the picture whole until the
   * world behind it is there. Never below half the median distance (faint near clouds in the voxel grid).
   */
  fade: Float32Array;
  /** Distance from the camera centre to the surface: low, middle and high percentiles. */
  near: number;
  mid: number;
  far: number;
  /** Share of vertices with a measured depth (the rest were filled). */
  coverage: number;
}

/** Grid size for a picture: about `across` cells over the long side. */
export function reliefGrid(cam: Pick<PinholeCamera, 'width' | 'height'>, across = 56): { cols: number; rows: number } {
  const a = cam.width / cam.height;
  return a >= 1 ? { cols: across, rows: Math.max(4, Math.round(across / a)) } : { cols: Math.max(4, Math.round(across * a)), rows: across };
}

/** z-depth sampler: tangents (tx, ty) and the pixel (x right, y down) -> metres, or NaN when nothing was found. */
export type DepthSampler = (tx: number, ty: number, px: number, py: number) => number;

/**
 * Samples the depth for every grid vertex, fills holes from their neighbours (or with `fill` far away), smooths
 * single-vertex spikes with a 3 x 3 median, and measures the depth steps.
 */
export function buildRelief(cam: PinholeCamera, cols: number, rows: number, sample: DepthSampler, fill: number, minDepth = 0.4): Relief {
  const W = cols + 1, H = rows + 1, n = W * H;
  const tan = new Float32Array(n * 2);
  let depth = new Float32Array(n);
  let measured = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const px = (i / cols) * cam.width, py = (j / rows) * cam.height;
      const tx = (px - cam.cx) / cam.fx, ty = -(py - cam.cy) / cam.fy;
      tan[k * 2] = tx;
      tan[k * 2 + 1] = ty;
      const d = sample(tx, ty, px, py);
      depth[k] = Number.isFinite(d) && d > 0 ? Math.max(minDepth, d) : NaN;
      if (!Number.isNaN(depth[k])) measured++;
    }
  }
  // fill holes from measured neighbours, a few rings deep
  for (let pass = 0; pass < 4; pass++) {
    const next = depth.slice();
    let left = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!Number.isNaN(depth[k])) continue;
        const v: number[] = [];
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const d = depth[jj * W + ii];
          if (!Number.isNaN(d)) v.push(d);
        }
        if (v.length >= 3) next[k] = median(v);
        else left++;
      }
    }
    depth = next;
    if (!left) break;
  }
  for (let k = 0; k < n; k++) if (Number.isNaN(depth[k])) depth[k] = fill;
  // 3 x 3 median: floaters and 8-bit noise
  const smooth = new Float32Array(n);
  const win: number[] = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      win.length = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = Math.min(W - 1, Math.max(0, i + di)), jj = Math.min(H - 1, Math.max(0, j + dj));
        win.push(depth[jj * W + ii]);
      }
      smooth[j * W + i] = median(win);
    }
  }
  const distance = new Float32Array(n);
  for (let k = 0; k < n; k++) distance[k] = smooth[k] * Math.hypot(tan[k * 2], tan[k * 2 + 1], 1);
  // farthest neighbour, then softened (a max filter alone leaves blocky plateaus), never below the pixel's own distance
  const far = windowed(distance, W, H, Math.max);
  const soft = windowed(far, W, H, (a, b) => a + b);
  const dist = Array.from(distance).sort((a, b) => a - b);
  const q = (f: number) => dist[Math.min(dist.length - 1, Math.max(0, Math.round(f * (dist.length - 1))))];
  // never before half the median distance either: the voxel grid also holds clouds of faint splats in front of the
  // camera (common in one-photo worlds) that the world barely shows, and a pixel that dissolved there would open
  // onto darkness until the real surface behind is revealed. Waiting costs nothing: by then the pixel lies on the world.
  const floor = 0.5 * q(0.5);
  const fade = new Float32Array(n);
  for (let k = 0; k < n; k++) fade[k] = Math.max(distance[k], soft[k] / 9, floor);
  return { cols, rows, tan, depth: smooth, fade, near: q(0.12), mid: q(0.5), far: q(0.88), coverage: measured / n };
}

/** Folds each 3 x 3 window (edges clamped) with `op`. */
function windowed(src: Float32Array, W: number, H: number, op: (a: number, b: number) => number): Float32Array {
  const out = new Float32Array(src.length);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let acc = Number.NaN;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const v = src[Math.min(H - 1, Math.max(0, j + dj)) * W + Math.min(W - 1, Math.max(0, i + di))];
        acc = Number.isNaN(acc) ? v : op(acc, v);
      }
      out[j * W + i] = acc;
    }
  }
  return out;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Anything with an occupancy test in the world frame (the voxel collider). */
export interface Occupancy {
  solidAt(x: number, y: number, z: number): boolean;
}

/**
 * Depth from the world itself: marches each ray from the camera centre through the occupancy grid and returns the
 * z-depth of the first solid cell (two solid samples in a row, so a lone floater does not stop it).
 */
export function occupancySampler(world: Occupancy, cam: PinholeCamera, step: number, maxDistance: number, minDistance = 0.35): DepthSampler {
  const q = normalizeQuat(cam.quaternion);
  const [ox, oy, oz] = cam.position;
  return (tx, ty) => {
    const len = Math.hypot(tx, ty, 1);
    const [dx, dy, dz] = rotateVec(q, [tx / len, ty / len, -1 / len]);
    let prev = false;
    for (let s = minDistance; s <= maxDistance; s += step) {
      const hit = world.solidAt(ox + dx * s, oy + dy * s, oz + dz * s);
      if (hit && prev) return (s - step) / len;
      prev = hit;
    }
    return NaN;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline

export const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Distances that shape the reveal for one photo (metres from its camera centre). */
export interface Shape {
  /** How far ahead of its final place the card starts (it travels this far toward you). */
  travel: number;
  /** Depth of the flat card from its own camera centre. */
  card: number;
  near: number;
  far: number;
  /** Reveal radius that covers the whole world. */
  max: number;
  /** Where the video's subject stands (video memories), else 0. */
  subject: number;
}

/** What one moment of the intro looks like. */
export interface Moment {
  /** Card opacity. */
  alpha: number;
  /** Extra distance of the card's camera centre ahead of its final place. */
  push: number;
  /** 0 = flat card, 1 = every pixel at the depth of the world behind it. */
  lift: number;
  /** Reveal front radius around the photo's camera centre (metres), and its width. */
  front: number;
  band: number;
  /** 0 = dark space, 1 = the world's own sky. */
  sky: number;
  /** 1 = rounded print corners, 0 = square. */
  corner: number;
  /** 0 = crisp frame edge, 1 = the frame edge feathered into the world. */
  feather: number;
  /** Video layer opacity. */
  video: number;
}

/** Seconds: the card fades in before t = 0, holds for a beat, and the world is complete at `end`. */
export const ENTER = { preroll: 0.25, hold: 0.7, end: 2.6 } as const;
export const ENTER_REDUCED = { preroll: 0.25, end: 1.2 } as const;
export const LEAVE = { end: 1.75 } as const;
export const LEAVE_REDUCED = { end: 0.75 } as const;

/** Reveal band: soft and proportional, so a far wall fades in as gently as the table in front of you. */
export const bandFor = (front: number) => Math.max(0.45, 0.32 * front);

/**
 * Log-space keyframes (t, radius): the front moves at a pace relative to how far it already is. A monotone cubic
 * through the keys (Fritsch-Butland tangents, flat at both ends) keeps its speed continuous: it sets off and lands
 * softly and never lurches at a key, where straight segments would change speed in a single frame.
 */
export function frontAt(t: number, keys: readonly (readonly [number, number])[]): number {
  const n = keys.length;
  if (!n) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  const ts = keys.map((k) => k[0]);
  const ys = keys.map((k) => Math.log(Math.max(1e-3, k[1])));
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, ts[i + 1] - ts[i]));
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i];
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  let i = 0;
  while (i < n - 2 && t > ts[i + 1]) i++;
  const h = Math.max(1e-6, ts[i + 1] - ts[i]);
  const s = (t - ts[i]) / h, s2 = s * s, s3 = s2 * s;
  const y = (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * m[i] + (3 * s2 - 2 * s3) * ys[i + 1] + (s3 - s2) * h * m[i + 1];
  return Math.exp(y);
}

/** Monotone reveal distances: near < far < max, with sane floors. */
export function shapeKeys(s: Shape): { near: number; far: number; max: number } {
  const near = Math.max(0.7, s.near);
  const far = Math.max(near * 1.6, s.far);
  const max = Math.max(far * 1.25, s.max);
  return { near, far, max };
}

/** The video's people fade in as the front reaches where they stand (and out as it leaves them). */
function videoAlpha(front: number, band: number, subject: number): number {
  return smooth01(subject - 0.3 * band, subject + band, front);
}

/** Entering: t from -preroll to ENTER.end. */
export function enterMoment(t: number, s: Shape, reduced = false): Moment {
  const k = shapeKeys(s);
  if (reduced) {
    // nothing moves: the picture sits at the depth of the world behind it from the start (from where it was taken
    // that is the flat photo), so it lies on the world from wherever the eye is and the crossfade never doubles
    const front = t < 0.45 ? 0 : frontAt(t, [[0.45, 0.4], [0.95, k.max]]);
    const band = Math.max(0.5, 0.5 * front);
    return {
      alpha: smooth01(-ENTER_REDUCED.preroll, 0, t) * (1 - smooth01(0.55, 1.15, t)),
      push: 0,
      lift: 1,
      front,
      band,
      sky: smooth01(0.45, 1.1, t),
      corner: 1 - smooth01(0.5, 1.0, t),
      feather: 0,
      video: smooth01(0.6, 1.1, t),
    };
  }
  const front = t < 1.0 ? 0 : frontAt(t, [[1.0, 0.2], [1.45, k.near], [2.1, k.far], [2.5, k.max]]);
  const band = bandFor(front);
  return {
    alpha: smooth01(-ENTER.preroll, 0, t) * (1 - smooth01(2.2, 2.55, t)),
    push: s.travel * (1 - easeInOutCubic((t - ENTER.hold) / 1.4)),
    lift: easeInOutCubic((t - 0.75) / 1.05),
    front,
    band,
    sky: smooth01(1.3, 2.4, t),
    corner: 1 - smooth01(0.75, 1.25, t),
    feather: smooth01(0.8, 1.6, t),
    video: s.subject > 0 ? videoAlpha(front, band, s.subject) : smooth01(1.9, 2.5, t),
  };
}

/** Leaving: t from 0 to LEAVE.end; ends on the card floating in the dark. */
export function leaveMoment(t: number, s: Shape, reduced = false): Moment {
  const k = shapeKeys(s);
  if (reduced) {
    const front = t >= 0.5 ? 0 : frontAt(t, [[0, k.max], [0.5, 0.4]]);
    return {
      alpha: smooth01(0, 0.45, t),
      push: 0,
      lift: 1,
      front,
      band: Math.max(0.5, 0.5 * front),
      sky: 1 - smooth01(0, 0.5, t),
      corner: smooth01(0.2, 0.6, t),
      feather: 0,
      video: 1 - smooth01(0, 0.3, t),
    };
  }
  const front = t >= 1.15 ? 0 : frontAt(t, [[0, k.max], [0.45, k.far], [0.85, k.near], [1.15, 0.2]]);
  const band = bandFor(front);
  return {
    alpha: 1,
    push: s.travel * easeInOutCubic((t - 0.85) / 0.6),
    lift: 1 - easeInOutCubic((t - 0.75) / 0.6),
    front,
    band,
    sky: 1 - smooth01(0.05, 0.95, t),
    corner: smooth01(1.2, 1.5, t),
    feather: 1 - smooth01(0.9, 1.4, t),
    video: s.subject > 0 ? videoAlpha(front, band, s.subject) : 1 - smooth01(0, 0.4, t),
  };
}
