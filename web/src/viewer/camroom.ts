// Rooms lifted from a single camera (a video's background plate turned into splats with its own
// depth). Such a room is exact from where the camera stood and falls apart a step away from it:
// behind every object there is nothing, and outside the frame there is only a guessed box.
// These helpers keep a visit where the room looks right:
//   - the camera frustum, to fade out what the camera never saw (the guessed box),
//   - a walk area around the camera (the region it saw, plus a margin),
//   - the camera's eye level,
//   - a repair pass for the splats hidden behind objects (disocclusion fill): they are pulled up to
//     the surface behind the object and take its colours, instead of showing a blurred ghost of the
//     object in front, which from a higher eye reads as a smeared column.
// Pure math; no three.js, so bun tests cover it.

import type { Scene, VideoLayer } from '../../../shared/types.ts';
import type { Bounds, V3 } from './analysis.ts';

/** A room that only exists as seen from the video camera. */
export function isCameraOnlyRoom(scene: Pick<Scene, 'world' | 'video'>): boolean {
  return !!scene.video && scene.world?.source === 'plate-depth';
}

export interface Frustum {
  /** Camera centre. */
  position: V3;
  /** Unit axes: right, up, and forward (the viewing direction, -Z of an OpenGL camera). */
  right: V3;
  up: V3;
  forward: V3;
  /** Image edges as tangents: x/z spans [-left, right], y/z spans [-down, up]. */
  tanLeft: number;
  tanRight: number;
  tanDown: number;
  tanUp: number;
}

/** Rotates v by the unit quaternion q (x, y, z, w). */
export function rotate(q: readonly [number, number, number, number], v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 q.xyz x v ; v' = v + w t + q.xyz x t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** Frustum of the video camera in the frame its pose is given in (the content frame). */
export function videoFrustum(video: Pick<VideoLayer, 'cameraPose' | 'intrinsics' | 'width' | 'height'>): Frustum {
  const [qx, qy, qz, qw] = video.cameraPose.quaternion;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const q: [number, number, number, number] = [qx / n, qy / n, qz / n, qw / n];
  const { fx, fy, cx, cy } = video.intrinsics;
  // pixel centres at integers: the image spans [-0.5, width - 0.5]
  return {
    position: [...video.cameraPose.position] as V3,
    right: rotate(q, [1, 0, 0]),
    up: rotate(q, [0, 1, 0]),
    forward: rotate(q, [0, 0, -1]),
    tanLeft: (cx + 0.5) / fx,
    tanRight: (video.width - 0.5 - cx) / fx,
    tanUp: (cy + 0.5) / fy,
    tanDown: (video.height - 0.5 - cy) / fy,
  };
}

/** Camera coordinates of a point: [x/z, y/z, z] with z the distance along the view direction. */
export function toCamera(f: Frustum, x: number, y: number, z: number): V3 {
  const dx = x - f.position[0], dy = y - f.position[1], dz = z - f.position[2];
  const d = dx * f.forward[0] + dy * f.forward[1] + dz * f.forward[2];
  const r = dx * f.right[0] + dy * f.right[1] + dz * f.right[2];
  const u = dx * f.up[0] + dy * f.up[1] + dz * f.up[2];
  const s = d > 1e-6 ? 1 / d : 0;
  return [r * s, u * s, d];
}

/**
 * How far a point lies outside the camera's view, in tangent units (0 inside the frame; 0.1 is
 * about 6 degrees past an edge). Points behind the camera are far outside.
 */
export function outsideView(f: Frustum, x: number, y: number, z: number): number {
  const [tx, ty, d] = toCamera(f, x, y, z);
  if (d <= 0.02) return 10;
  const ox = Math.max(-f.tanLeft - tx, tx - f.tanRight, 0);
  const oy = Math.max(-f.tanDown - ty, ty - f.tanUp, 0);
  return Math.hypot(ox, oy);
}

export interface WalkAreaOptions {
  /** Floor height in the frame of the frustum (the walk area is returned with the floor at 0). */
  floorY: number;
  /** Distance along the view to the nearest content in front of the camera. */
  nearContent: number;
  /** Half width of the area across the view (metres). */
  halfWidth?: number;
  /** How far behind the camera you may step. */
  behind?: number;
}

/**
 * Where to let people walk in a camera-only room: a box around the camera's footprint, from a step
 * behind it to a little way toward the content, with the floor at 0. The walker's soft margin is
 * added on top of this.
 */
export function cameraWalkArea(f: Frustum, o: WalkAreaOptions): Bounds {
  const halfWidth = o.halfWidth ?? 0.4;
  const behind = o.behind ?? 0.3;
  const ahead = Math.max(0.15, Math.min(1.0, 0.5 * o.nearContent));
  // horizontal view direction (a pitched camera still walks along the floor)
  let fx = f.forward[0], fz = f.forward[2];
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-3) {
    fx = 0;
    fz = -1;
  } else {
    fx /= fl;
    fz /= fl;
  }
  const rx = -fz, rz = fx;
  const [px, , pz] = f.position;
  const corners: Array<[number, number]> = [];
  for (const a of [-behind, ahead]) for (const b of [-halfWidth, halfWidth]) corners.push([px + fx * a + rx * b, pz + fz * a + rz * b]);
  const xs = corners.map((c) => c[0]), zs = corners.map((c) => c[1]);
  const eye = f.position[1] - o.floorY;
  return { min: [Math.min(...xs), 0, Math.min(...zs)], max: [Math.max(...xs), Math.max(2.2, eye + 0.6), Math.max(...zs)] };
}

/** Eye height to show a camera-only room from: the camera's own height, within human limits. */
export function cameraEyeHeight(f: Frustum, floorY: number): number {
  const h = f.position[1] - floorY;
  return Math.min(1.75, Math.max(1.0, Number.isFinite(h) ? h : 1.6));
}

/** Robust distance to the nearest content in view: a low percentile of in-frame depths. */
export function nearestContentDepth(f: Frustum, xyz: ArrayLike<number>, count: number, q = 0.02, maxSamples = 50000): number {
  const step = Math.max(1, Math.floor(count / maxSamples));
  const depths: number[] = [];
  for (let i = 0; i < count; i += step) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    if (outsideView(f, x, y, z) > 0) continue;
    depths.push(toCamera(f, x, y, z)[2]);
  }
  if (!depths.length) return 1.5;
  depths.sort((a, b) => a - b);
  return depths[Math.min(depths.length - 1, Math.floor(q * depths.length))];
}

// ---------------------------------------------------------------------------------------------
// Disocclusion fill

/** A coarse image of what the camera sees: per cell, the nearest depth and its colour. */
export class ViewGrid {
  readonly w: number;
  readonly h: number;
  readonly depth: Float32Array;
  readonly rgb: Float32Array;

  constructor(readonly f: Frustum, cellsAcross = 160) {
    const aspect = (f.tanUp + f.tanDown) / (f.tanLeft + f.tanRight);
    this.w = cellsAcross;
    this.h = Math.max(4, Math.round(cellsAcross * aspect));
    this.depth = new Float32Array(this.w * this.h).fill(Infinity);
    this.rgb = new Float32Array(this.w * this.h * 3);
  }

  /** Cell index of a camera-space point, or -1 outside the frame. */
  cell(tx: number, ty: number): number {
    const u = (tx + this.f.tanLeft) / (this.f.tanLeft + this.f.tanRight);
    const v = (this.f.tanUp - ty) / (this.f.tanUp + this.f.tanDown);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1;
    return Math.floor(v * this.h) * this.w + Math.floor(u * this.w);
  }

  /** Records a surface point seen by the camera (keeps the nearest per cell). */
  add(tx: number, ty: number, d: number, r: number, g: number, b: number): void {
    const k = this.cell(tx, ty);
    if (k < 0 || d >= this.depth[k]) return;
    this.depth[k] = d;
    this.rgb[k * 3] = r;
    this.rgb[k * 3 + 1] = g;
    this.rgb[k * 3 + 2] = b;
  }
}

/** Separable running maximum over a (2r+1) square window; Infinity cells are ignored. */
export function windowMax(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const val = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, val(src[y * w + k]));
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Push-pull hole filling: cells with weight 0 get a smooth blend of the nearest known cells.
 * `values` holds `channels` floats per cell; returns a filled copy.
 */
export function pushPull(values: Float32Array, weight: Float32Array, w: number, h: number, channels: number): Float32Array {
  if (w <= 1 && h <= 1) return values.slice();
  const cw = Math.max(1, Math.ceil(w / 2)), ch = Math.max(1, Math.ceil(h / 2));
  const cv = new Float32Array(cw * ch * channels);
  const cwt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, wt = weight[i];
      if (wt <= 0) continue;
      const j = (y >> 1) * cw + (x >> 1);
      cwt[j] += wt;
      for (let c = 0; c < channels; c++) cv[j * channels + c] += values[i * channels + c] * wt;
    }
  }
  for (let j = 0; j < cw * ch; j++) if (cwt[j] > 0) for (let c = 0; c < channels; c++) cv[j * channels + c] /= cwt[j];
  const anyMissing = cwt.some((v) => v <= 0);
  const coarse = anyMissing && (cw > 1 || ch > 1) ? pushPull(cv, cwt.map((v) => (v > 0 ? 1 : 0)), cw, ch, channels) : cv;
  const out = values.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (weight[i] > 0) continue;
      // bilinear sample of the coarse level at this cell's centre
      const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      for (let c = 0; c < channels; c++) {
        const a = coarse[(y0 * cw + x0) * channels + c], b = coarse[(y0 * cw + x1) * channels + c];
        const d = coarse[(y1 * cw + x0) * channels + c], e = coarse[(y1 * cw + x1) * channels + c];
        out[i * channels + c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
      }
    }
  }
  return out;
}

export interface Backdrop {
  /** Depth of what is probably behind each cell (the far layer, filled in behind objects). */
  depth: Float32Array;
  /** Its colour. */
  rgb: Float32Array;
  /** 1 where the cell itself is the far layer, 0 where it is an object in front of it. */
  far: Uint8Array;
}

/**
 * Estimates, for every cell, the surface hidden behind whatever the camera sees there: cells near a
 * markedly farther surface (within `radius` cells) are objects in front; everything else is the
 * backdrop, and push-pull carries the backdrop's depth and colour in behind the objects.
 */
export function estimateBackdrop(grid: ViewGrid, radius = 20, step = 1.2): Backdrop {
  const { w, h } = grid;
  const n = w * h;
  const farthest = windowMax(grid.depth, w, h, radius);
  const far = new Uint8Array(n);
  const wt = new Float32Array(n);
  const vals = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = grid.depth[i];
    if (!Number.isFinite(d)) continue;
    if (farthest[i] > d * step) continue;
    far[i] = 1;
    wt[i] = 1;
    vals[i * 4] = d;
    vals[i * 4 + 1] = grid.rgb[i * 3];
    vals[i * 4 + 2] = grid.rgb[i * 3 + 1];
    vals[i * 4 + 3] = grid.rgb[i * 3 + 2];
  }
  const filled = pushPull(vals, wt, w, h, 4);
  const depth = new Float32Array(n), rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    depth[i] = filled[i * 4];
    rgb[i * 3] = filled[i * 4 + 1];
    rgb[i * 3 + 1] = filled[i * 4 + 2];
    rgb[i * 3 + 2] = filled[i * 4 + 3];
  }
  return { depth, rgb, far };
}

export interface SplatSource {
  /** Calls back with every splat's centre (content frame), opacity and colour (0..1). */
  forEach(cb: (i: number, x: number, y: number, z: number, opacity: number, r: number, g: number, b: number) => void): void;
}

export interface HiddenFix {
  index: number;
  /** New centre (content frame). */
  position: V3;
  rgb: [number, number, number];
}

/**
 * Finds the splats the camera could not see (behind the visible surface in their own cell) and
 * says where they should go: onto the backdrop behind the object in front (never farther back
 * than they are), coloured like it. Visible splats are left alone.
 */
export function planHiddenFixes(f: Frustum, src: SplatSource, cellsAcross = 160, fineAcross = cellsAcross * 3): { fixes: HiddenFix[]; grid: ViewGrid; backdrop: Backdrop } {
  // coarse grid with colour for the backdrop estimate; a fine one (depth only) decides what the
  // camera saw, so a visible wall splat next to an object's outline is never taken for hidden
  const grid = new ViewGrid(f, cellsAcross);
  const fine = new ViewGrid(f, fineAcross);
  src.forEach((_i, x, y, z, o, r, g, b) => {
    if (o < 0.5) return;
    const [tx, ty, d] = toCamera(f, x, y, z);
    if (d <= 0.05) return;
    grid.add(tx, ty, d, r, g, b);
    fine.add(tx, ty, d, 0, 0, 0);
  });
  const backdrop = estimateBackdrop(grid);
  const fixes: HiddenFix[] = [];
  src.forEach((i, x, y, z) => {
    const [tx, ty, d] = toCamera(f, x, y, z);
    if (d <= 0.05) return;
    const k = grid.cell(tx, ty);
    const kf = fine.cell(tx, ty);
    if (k < 0 || kf < 0) return;
    const front = fine.depth[kf];
    if (!(d > front * 1.1 + 0.05)) return; // visible (or part of the visible surface)
    const target = Math.max(front * 1.04, Math.min(d, backdrop.depth[k] * 1.03));
    const s = target / d;
    fixes.push({
      index: i,
      position: [f.position[0] + (x - f.position[0]) * s, f.position[1] + (y - f.position[1]) * s, f.position[2] + (z - f.position[2]) * s],
      rgb: [backdrop.rgb[k * 3], backdrop.rgb[k * 3 + 1], backdrop.rgb[k * 3 + 2]],
    });
  });
  return { fixes, grid, backdrop };
}
