// Loads the splat world, applies the scene transform, and analyses the splats: floor height,
// robust bounds, colour palette, voxel collider and spawn.

import * as THREE from 'three';
import { SplatMesh, isMobile, isOculus } from '@sparkjsdev/spark';
import type { VideoLayer, WorldAsset } from '../../../shared/types.ts';
import { estimateFloor, expandBounds, robustBounds, skyPalette, unionBounds, type Bounds, type RGB, type SkyPalette } from './analysis.ts';
import { cameraWalkArea, nearestContentDepth, planHiddenFixes, type Frustum } from './camroom.ts';
import { DEFAULT_BODY, findFreeSpot, lineOfSight, type Body, type GroundOptions, type P3 } from './physics.ts';
import { VoxelGrid } from './voxels.ts';

export interface LoadProgress {
  stage: string;
  /** 0..1, or null when unknown. */
  fraction: number | null;
}

export interface LoadOptions {
  /** Force LoD on/off (default: by splat count and device). */
  lod?: boolean;
  onProgress?: (p: LoadProgress) => void;
}

/** Splat count above which Spark builds a level-of-detail tree for this device. */
export function lodThreshold(): number {
  // a Quest holds 72 Hz with ~500-750k splats: bigger worlds get a level-of-detail tree there
  if (isOculus()) return 800_000;
  if (isMobile()) return 1_200_000;
  return 3_500_000;
}

export async function loadSplatMesh(url: string, opts: LoadOptions = {}): Promise<SplatMesh> {
  const lod = opts.lod;
  const report = opts.onProgress ?? (() => undefined);
  let downloaded = false;
  const mesh = new SplatMesh({
    url,
    // keep the full-resolution splats next to the LoD tree: the analysis reads them
    lod: lod === false ? undefined : true,
    nonLod: true,
    lodAbove: lod === true ? 0 : lodThreshold(),
    onProgress: (e: ProgressEvent) => {
      if (e.lengthComputable && e.total > 0) {
        const f = e.loaded / e.total;
        if (f >= 0.999 && !downloaded) {
          downloaded = true;
          // big worlds get a level-of-detail tree on headsets and phones, built on this device
          const bytesPerSplat = /\.ply(\?|$)/i.test(url) ? 60 : 15;
          const lodLikely = lod !== false && (lod === true || e.total / bytesPerSplat > lodThreshold());
          report({ stage: lodLikely ? 'Building levels of detail' : 'Decoding splats', fraction: null });
        } else if (!downloaded) {
          report({ stage: 'Downloading world', fraction: f });
        }
      } else if (!downloaded) {
        report({ stage: 'Downloading world', fraction: null });
      }
    },
  });
  await mesh.initialized;
  return mesh;
}

export function applyTransform(obj: THREE.Object3D, t: WorldAsset['transform']): void {
  const [px, py, pz] = t.position ?? [0, 0, 0];
  const [qx, qy, qz, qw] = t.quaternion ?? [0, 0, 0, 1];
  obj.position.set(px, py, pz);
  obj.quaternion.set(qx, qy, qz, qw).normalize();
  obj.scale.setScalar(t.scale || 1);
}

/** Number of splats in the mesh's full-resolution set (or its LoD tree when that is all there is). */
export function splatCount(mesh: SplatMesh): number {
  const p = mesh.packedSplats;
  if (p && p.numSplats > 0) return p.numSplats;
  if (p?.lodSplats) return p.lodSplats.numSplats;
  return mesh.extSplats?.numSplats ?? mesh.numSplats ?? 0;
}

type SplatCb = (i: number, c: THREE.Vector3, s: THREE.Vector3, q: THREE.Quaternion, o: number, col: THREE.Color) => void;

function forEachSourceSplat(mesh: SplatMesh, cb: SplatCb): void {
  const p = mesh.packedSplats;
  if (p && p.numSplats > 0) p.forEachSplat(cb);
  else if (p?.lodSplats) p.lodSplats.forEachSplat(cb);
  else mesh.forEachSplat(cb);
}

export interface Samples {
  /** xyz of opaque, not-huge splat centres in the content frame. */
  pos: Float32Array;
  count: number;
  /** Per-sample weight for the floor histogram (flat, horizontal splats count more). */
  weight: Float32Array;
  /** Subsampled (y, r, g, b) for the palette. */
  colour: Float32Array;
  colourCount: number;
  total: number;
}

/**
 * Reads every splat once through Spark's forEachSplat and keeps what the analysis needs.
 * `toContent` maps splat file coordinates into the content frame (viewer frame before the floor
 * shift). Splats with low opacity or a huge extent (background shells) are skipped.
 */
export function collectSamples(mesh: SplatMesh, toContent: THREE.Matrix4, hugeLimit = 0.6, minOpacity = 0.35): Samples {
  const total = splatCount(mesh);
  const e = toContent.elements;
  const scale = Math.cbrt(Math.abs(toContent.determinant())) || 1;
  // world-space up expressed in file coordinates, for the "is this splat horizontal" test
  const ux = e[1] / scale, uy = e[5] / scale, uz = e[9] / scale;
  let cap = Math.max(1024, total);
  let pos = new Float32Array(cap * 3);
  let weight = new Float32Array(cap);
  const colourStep = Math.max(1, Math.floor(total / 60000));
  const colour = new Float32Array(Math.ceil(total / colourStep + 1) * 4);
  let n = 0, nc = 0;
  forEachSourceSplat(mesh, (i, c, s, q, o, col) => {
    const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
    const y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
    const z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
    if (i % colourStep === 0 && o > 0.25 && nc * 4 + 3 < colour.length) {
      colour[nc * 4] = y;
      colour[nc * 4 + 1] = col.r;
      colour[nc * 4 + 2] = col.g;
      colour[nc * 4 + 3] = col.b;
      nc++;
    }
    const sx = s.x, sy = s.y, sz = s.z;
    const smax = Math.max(sx, sy, sz) * scale;
    if (o < minOpacity || smax > hugeLimit || !Number.isFinite(x + y + z)) return;
    if (n >= cap) {
      cap *= 2;
      const p2 = new Float32Array(cap * 3);
      p2.set(pos);
      pos = p2;
      const w2 = new Float32Array(cap);
      w2.set(weight);
      weight = w2;
    }
    pos[n * 3] = x;
    pos[n * 3 + 1] = y;
    pos[n * 3 + 2] = z;
    // smallest axis of the gaussian = its normal when it is a flat disc
    let w = 1;
    const smin = Math.min(sx, sy, sz);
    const smid = sx + sy + sz - smin - Math.max(sx, sy, sz);
    if (smin < 0.4 * smid) {
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      let nx: number, ny: number, nz: number;
      if (smin === sx) { nx = 1 - 2 * (qy * qy + qz * qz); ny = 2 * (qx * qy + qw * qz); nz = 2 * (qx * qz - qw * qy); }
      else if (smin === sy) { nx = 2 * (qx * qy - qw * qz); ny = 1 - 2 * (qx * qx + qz * qz); nz = 2 * (qy * qz + qw * qx); }
      else { nx = 2 * (qx * qz + qw * qy); ny = 2 * (qy * qz - qw * qx); nz = 1 - 2 * (qx * qx + qy * qy); }
      const up = Math.abs(nx * ux + ny * uy + nz * uz);
      if (up > 0.85) w = 3;
    }
    weight[n] = w;
    n++;
  });
  return { pos, count: n, weight, colour, colourCount: nc, total };
}

export interface WorldAnalysis {
  /** Camera-only rooms: distance along the camera's view to the nearest content (else 0). */
  nearContent: number;
  /** Floor height in the content frame; the content group is shifted by -floorY. */
  floorY: number;
  floorEstimated: boolean;
  floorConfidence: number;
  /** In the final frame (floor at 0). */
  bounds: Bounds;
  /** Box beyond which splats fade out. */
  fadeBounds: Bounds;
  /** Box the player is softly kept inside. */
  walkBounds: Bounds;
  grid: VoxelGrid;
  palette: SkyPalette;
  average: RGB;
  spawn: { x: number; y: number; z: number; yaw: number };
  timings: Record<string, number>;
}

export interface AnalyseOptions {
  asset: WorldAsset;
  /** Video layer: the spawn should look at the footage from near its camera. */
  video?: VideoLayer;
  /**
   * Set for a room lifted from one camera (content frame): walking is kept to the region that
   * camera saw, plus a margin, instead of the whole box around it.
   */
  cameraRoom?: Frustum | null;
  flipped: boolean;
  body?: Body;
  /** Lets the UI repaint between heavy stages. */
  yieldFrame?: () => Promise<void>;
  onStage?: (stage: string) => void;
}

/**
 * Analyses a loaded world. `toContent` maps the splat file into the content frame (scene
 * transform, plus the debug flip). Returns the floor shift and everything the physics needs.
 */
export async function analyseWorld(mesh: SplatMesh, toContent: THREE.Matrix4, opts: AnalyseOptions): Promise<WorldAnalysis> {
  const body = opts.body ?? DEFAULT_BODY;
  const yieldFrame = opts.yieldFrame ?? (async () => undefined);
  const timings: Record<string, number> = {};
  let t0 = performance.now();

  opts.onStage?.('Reading splats');
  await yieldFrame();
  const samples = collectSamples(mesh, toContent);
  timings.samples = performance.now() - t0;
  if (samples.count < 50) throw new Error('This world has almost no solid splats to stand on.');

  // ---- floor ----
  opts.onStage?.('Finding the floor');
  await yieldFrame();
  t0 = performance.now();
  const preBounds = robustBounds(samples.pos, samples.count, 0.02, 0.98)!;
  const originInside = preBounds.min[0] < 0 && preBounds.max[0] > 0 && preBounds.min[2] < 0 && preBounds.max[2] > 0 && preBounds.min[1] < 0;
  const ys = new Float32Array(samples.count);
  for (let i = 0; i < samples.count; i++) ys[i] = samples.pos[i * 3 + 1];
  let floorY: number;
  let floorEstimated = false;
  let floorConfidence = 1;
  if (opts.asset.floorY !== null && opts.asset.floorY !== undefined && !opts.flipped) {
    floorY = opts.asset.floorY;
  } else {
    // generated worlds are built around their capture camera at the origin: the floor is below it
    const est = estimateFloor(ys, { weights: samples.weight.subarray(0, samples.count), below: originInside ? -0.3 : undefined });
    floorY = est?.y ?? preBounds.min[1];
    floorConfidence = est?.confidence ?? 0;
    floorEstimated = true;
  }
  timings.floor = performance.now() - t0;
  const cameraRoom = opts.flipped ? null : opts.cameraRoom ?? null;
  const nearContent = cameraRoom ? nearestContentDepth(cameraRoom, samples.pos, samples.count) : 0;

  // move samples into the final frame (floor at 0)
  for (let i = 0; i < samples.count; i++) samples.pos[i * 3 + 1] -= floorY;

  // ---- bounds ----
  let bounds = robustBounds(samples.pos, samples.count, 0.01, 0.99)!;
  const outer = robustBounds(samples.pos, samples.count, 0.003, 0.997)!;
  if (opts.asset.bounds && !opts.flipped) {
    const b = opts.asset.bounds;
    bounds = { min: [b.min[0], b.min[1] - floorY, b.min[2]], max: [b.max[0], b.max[1] - floorY, b.max[2]] };
  }
  const fadeBounds = expandBounds(outer, [0.6, 0.6, 0.6]);
  let walkBounds = expandBounds(bounds, [0.2, 0, 0.2]);

  // ---- voxels ----
  opts.onStage?.('Building the collider');
  await yieldFrame();
  t0 = performance.now();
  const extent = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]);
  const voxel = extent > 80 ? 0.25 : extent > 35 ? 0.15 : 0.1;
  const grid = new VoxelGrid(voxel);
  const fb = fadeBounds;
  for (let i = 0; i < samples.count; i++) {
    const x = samples.pos[i * 3], y = samples.pos[i * 3 + 1], z = samples.pos[i * 3 + 2];
    if (x < fb.min[0] || x > fb.max[0] || y < fb.min[1] || y > fb.max[1] || z < fb.min[2] || z > fb.max[2]) continue;
    grid.add(x, y, z);
  }
  grid.finalize(0);
  timings.voxels = performance.now() - t0;

  // ---- spawn ----
  const ground: GroundOptions = { floorY: 0, snap: 0.07, maxDrop: 4, maxClimb: 0.35 };
  let sx = 0, sz = 0, sy = 0, yaw = 0;
  const given = opts.asset.spawn;
  // what the viewer should see from the spawn: the subject of the video, or the room ahead
  let look: P3 | null = null;
  const video = opts.flipped ? undefined : opts.video;
  if (video) {
    const [px, py, pz] = video.cameraPose.position;
    const [qx, qy, qz, qw] = video.cameraPose.quaternion;
    // camera forward (-Z) rotated by the pose quaternion
    const fx = -2 * (qx * qz + qw * qy), fy = -2 * (qy * qz - qw * qx), fz = -(1 - 2 * (qx * qx + qy * qy));
    const d = Math.min(3, Math.max(0.8, Math.sqrt(video.depth.near * video.depth.far)));
    look = { x: px + fx * d, y: py - floorY + fy * d, z: pz + fz * d };
    if (!given) {
      sx = px;
      sz = pz;
      yaw = Math.atan2(-fx, -fz);
    }
  }
  if (given && !opts.flipped) {
    sx = given.position[0];
    sy = given.position[1] - floorY;
    sz = given.position[2];
    yaw = given.yaw ?? 0;
  } else if (opts.flipped) {
    // the flip is a half turn about X: what was in front (-Z) is now at +Z
    yaw = Math.PI;
    if (given) {
      sx = given.position[0];
      sy = -given.position[1] - floorY;
      sz = -given.position[2];
      yaw = Math.PI - (given.yaw ?? 0);
    }
  }
  const facing = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  if (!look) look = { x: sx + facing.x * 2, y: 1.2, z: sz + facing.z * 2 };
  // stand on the floor under the spawn (not on whatever could be stepped onto there)
  const under = grid.groundAt(sx, sz, sy + 0.08, sy - 3);
  const feet = under === null || under < -0.25 || Math.abs(under) < ground.snap ? 0 : under;
  if (!given && !video) {
    // the capture camera stood at the origin, so this column is free space: drop stray splats
    grid.clearCylinder(sx, sz, body.radius + 0.12, feet + body.step, feet + 2.2);
  }
  // prefer a spot with room around the head and a clear view (generated worlds are blurry right
  // up against surfaces), then any roomy spot, then any spot the body fits
  const target = look;
  const sees = (p: P3) => lineOfSight(grid, { x: p.x, y: p.y + 1.55, z: p.z }, target, 0.45);
  const roomyBody: Body = { radius: 0.42, step: 0.6, height: 2.0 };
  let free = findFreeSpot(grid, sx, sz, feet, roomyBody, ground, 1.8, 0.05, facing, sees);
  if (!free.found) free = findFreeSpot(grid, sx, sz, feet, roomyBody, ground, 1.5, 0.05, facing);
  if (!free.found) free = findFreeSpot(grid, sx, sz, feet, body, ground, 2.5, 0.05, facing);
  if (video && (free.x !== sx || free.z !== sz)) {
    // moved: keep facing the subject
    yaw = Math.atan2(-(target.x - free.x), -(target.z - free.z));
  }
  // the spawn and the space around it always count as inside the world, even for thin worlds
  // (a lifted background plate) whose splats all lie in front of the camera
  const around: Bounds = { min: [free.x - 1.5, free.y, free.z - 1.5], max: [free.x + 1.5, free.y + 2.2, free.z + 1.5] };
  if (cameraRoom) {
    // only near the camera does a single-view room look right
    walkBounds = unionBounds(cameraWalkArea(cameraRoom, { floorY, nearContent }), {
      min: [free.x - 0.1, free.y, free.z - 0.1],
      max: [free.x + 0.1, free.y + 2.2, free.z + 0.1],
    });
  } else {
    walkBounds = unionBounds(walkBounds, around);
  }
  bounds = unionBounds(bounds, around);

  // ---- palette ----
  const palette = buildPalette(samples, floorY, bounds);

  return {
    nearContent,
    floorY,
    floorEstimated,
    floorConfidence,
    bounds,
    fadeBounds,
    walkBounds,
    grid,
    palette: palette.sky,
    average: palette.average,
    spawn: { x: free.x, y: free.y, z: free.z, yaw },
    timings,
  };
}

function buildPalette(s: Samples, floorY: number, b: Bounds): { sky: SkyPalette; average: RGB } {
  const lo = b.min[1], hi = b.max[1];
  const h = Math.max(0.5, hi - lo);
  const sums = { all: [0, 0, 0, 0], up: [0, 0, 0, 0], down: [0, 0, 0, 0] };
  for (let i = 0; i < s.colourCount; i++) {
    const y = s.colour[i * 4] - floorY;
    const r = s.colour[i * 4 + 1], g = s.colour[i * 4 + 2], bl = s.colour[i * 4 + 3];
    const add = (a: number[]) => { a[0] += r; a[1] += g; a[2] += bl; a[3]++; };
    add(sums.all);
    if (y > lo + h * 0.65) add(sums.up);
    if (y < lo + h * 0.25) add(sums.down);
  }
  const avg = (a: number[], fb: RGB): RGB => (a[3] > 0 ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : fb);
  const all = avg(sums.all, [0.4, 0.4, 0.42]);
  return { sky: skyPalette(avg(sums.up, all), all, avg(sums.down, all)), average: all };
}

/**
 * Rooms lifted from one camera: moves the splats the camera never saw (the box behind every object)
 * onto the surface probably hidden there and gives them its colours, so a step to the side shows a
 * soft continuation of the wall instead of a smeared ghost of the object in front.
 * `toView` maps splat file coordinates into the frame of the frustum. Returns how many moved.
 */
export function repairHiddenSplats(mesh: SplatMesh, toView: THREE.Matrix4, frustum: Frustum): number {
  const packed = mesh.packedSplats;
  if (!packed || !(packed.numSplats > 0)) return 0;
  const v = new THREE.Vector3();
  const plan = planHiddenFixes(frustum, {
    forEach(cb) {
      packed.forEachSplat((i, c, _s, _q, o, col) => {
        v.copy(c).applyMatrix4(toView);
        cb(i, v.x, v.y, v.z, o, col.r, col.g, col.b);
      });
    },
  });
  if (!plan.fixes.length) return 0;
  const fromView = toView.clone().invert();
  const center = new THREE.Vector3();
  const color = new THREE.Color();
  for (const fix of plan.fixes) {
    const s = packed.getSplat(fix.index);
    center.set(fix.position[0], fix.position[1], fix.position[2]).applyMatrix4(fromView);
    color.setRGB(fix.rgb[0], fix.rgb[1], fix.rgb[2]);
    packed.setSplat(fix.index, center, s.scales, s.quaternion, s.opacity, color);
  }
  packed.needsUpdate = true;
  mesh.updateVersion();
  return plan.fixes.length;
}
