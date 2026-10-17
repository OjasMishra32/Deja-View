// Rooms lifted from one camera: frustum math, walk area, eye level and the hidden-splat repair.

import { describe, expect, test } from 'bun:test';
import type { VideoLayer, WorldAsset } from '../shared/types.ts';
import {
  cameraEyeHeight,
  cameraWalkArea,
  estimateBackdrop,
  isCameraOnlyRoom,
  nearestContentDepth,
  outsideView,
  planHiddenFixes,
  pushPull,
  rotate,
  toCamera,
  videoFrustum,
  ViewGrid,
  windowMax,
  type SplatSource,
} from '../web/src/viewer/camroom.ts';

const video = (over: Partial<VideoLayer> = {}): VideoLayer => ({
  file: 'tw.mp4',
  layout: 'tw-pack-v1',
  width: 1280,
  height: 720,
  fps: 30,
  duration: 10,
  hasAudio: true,
  intrinsics: { fx: 1000, fy: 1000, cx: 639.5, cy: 359.5 },
  depth: { encoding: 'inverse', near: 1, far: 4 },
  cameraPose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  ...over,
});

describe('which rooms are camera-only', () => {
  test('a lifted plate with a video is; a generated room or a photo world is not', () => {
    const world: Omit<WorldAsset, 'source'> = { file: 'w.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null };
    expect(isCameraOnlyRoom({ video: video(), world: { ...world, source: 'plate-depth' } })).toBe(true);
    expect(isCameraOnlyRoom({ video: video(), world: { ...world, source: 'flashworld' } })).toBe(false);
    expect(isCameraOnlyRoom({ world: { ...world, source: 'plate-depth' } })).toBe(false);
  });
});

describe('video frustum', () => {
  test('identity pose looks down -Z with the image edges as tangents', () => {
    const f = videoFrustum(video());
    expect(f.forward).toEqual([0, 0, -1]);
    expect(f.right[0]).toBeCloseTo(1, 12);
    expect(f.up[1]).toBeCloseTo(1, 12);
    expect(f.tanLeft).toBeCloseTo(0.64, 6);
    expect(f.tanRight).toBeCloseTo(0.64, 6);
    expect(f.tanUp).toBeCloseTo(0.36, 6);
    expect(f.tanDown).toBeCloseTo(0.36, 6);
  });

  test('a quarter turn about Y looks down -X', () => {
    const s = Math.SQRT1_2;
    const f = videoFrustum(video({ cameraPose: { position: [1, 2, 3], quaternion: [0, s, 0, s] } }));
    expect(f.forward[0]).toBeCloseTo(-1, 9);
    expect(f.forward[2]).toBeCloseTo(0, 9);
    expect(rotate([0, s, 0, s], [1, 0, 0])[2]).toBeCloseTo(-1, 9);
    const [tx, ty, d] = toCamera(f, -1, 2, 3); // 2 m straight ahead
    expect(d).toBeCloseTo(2, 9);
    expect(tx).toBeCloseTo(0, 9);
    expect(ty).toBeCloseTo(0, 9);
  });

  test('outsideView is 0 in the frame, grows past its edges, and is large behind the camera', () => {
    const f = videoFrustum(video());
    expect(outsideView(f, 0, 0, -2)).toBe(0);
    expect(outsideView(f, 1.2, 0, -2)).toBe(0); // tan 0.6 < 0.64
    expect(outsideView(f, 2, 0, -2)).toBeCloseTo(1 - 0.64, 6);
    expect(outsideView(f, 0, -1.25, -1)).toBeCloseTo(1.25 - 0.36, 6); // the floor at your feet
    expect(outsideView(f, 0, 0, 1)).toBeGreaterThan(5);
  });
});

describe('walk area and eye level', () => {
  test('a box around the camera: a step behind it, half the way to the nearest content ahead', () => {
    const f = videoFrustum(video());
    const b = cameraWalkArea(f, { floorY: -1.25, nearContent: 1.0 });
    expect(b.min[0]).toBeCloseTo(-0.4, 9);
    expect(b.max[0]).toBeCloseTo(0.4, 9);
    expect(b.max[2]).toBeCloseTo(0.3, 9);
    expect(b.min[2]).toBeCloseTo(-0.5, 9);
    expect(b.min[1]).toBe(0);
  });

  test('never reaches more than a metre forward, never less than a step', () => {
    const f = videoFrustum(video());
    expect(cameraWalkArea(f, { floorY: -1.25, nearContent: 9 }).min[2]).toBeCloseTo(-1, 9);
    expect(cameraWalkArea(f, { floorY: -1.25, nearContent: 0.1 }).min[2]).toBeCloseTo(-0.15, 9);
  });

  test('a camera turned sideways gets its box turned with it', () => {
    const s = Math.SQRT1_2;
    const f = videoFrustum(video({ cameraPose: { position: [0, 0, 0], quaternion: [0, s, 0, s] } }));
    const b = cameraWalkArea(f, { floorY: -1.2, nearContent: 2 });
    // looking down -X: forward reach along -X, the width along Z
    expect(b.min[0]).toBeCloseTo(-1, 6);
    expect(b.max[0]).toBeCloseTo(0.3, 6);
    expect(b.max[2]).toBeCloseTo(0.4, 6);
  });

  test('eye height is the camera height above the floor, within human limits', () => {
    const f = videoFrustum(video());
    expect(cameraEyeHeight(f, -1.25)).toBeCloseTo(1.25, 9);
    expect(cameraEyeHeight(f, -0.3)).toBe(1.0);
    expect(cameraEyeHeight(f, -2.4)).toBe(1.75);
  });

  test('nearest content is a low percentile of in-frame depths', () => {
    const f = videoFrustum(video());
    const pts: number[] = [];
    for (let i = 0; i < 1000; i++) pts.push(0, 0, -(1 + (i / 1000) * 3)); // 1..4 m ahead
    pts.push(0, 0, 5); // behind the camera: ignored
    expect(nearestContentDepth(f, pts, pts.length / 3, 0.02)).toBeCloseTo(1.06, 2);
  });
});

describe('grids', () => {
  test('windowMax ignores empty cells', () => {
    const w = 5, h = 1;
    const v = Float32Array.from([1, Infinity, 3, 2, Infinity]);
    expect(Array.from(windowMax(v, w, h, 1))).toEqual([1, 3, 3, 3, 2]);
  });

  test('pushPull fills holes from the nearest known cells and keeps known ones', () => {
    const w = 8, h = 1;
    const vals = new Float32Array(8);
    const wt = new Float32Array(8);
    vals[0] = 2; wt[0] = 1;
    vals[7] = 6; wt[7] = 1;
    const out = pushPull(vals, wt, w, h, 1);
    expect(out[0]).toBe(2);
    expect(out[7]).toBe(6);
    for (let i = 1; i < 7; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(out[i]).toBeLessThanOrEqual(6 + 1e-6);
    }
    expect(out[1]).toBeLessThan(out[6]);
  });
});

// A wall 3 m ahead (red), a box 1.5 m ahead in the middle of the view (blue), and a guessed shell
// wall 4 m ahead (grey) that only shows where the camera looks behind the box.
function scene(): { src: SplatSource; shellIdx: number[] } {
  const xyz: number[] = [];
  const rgb: number[] = [];
  const shellIdx: number[] = [];
  const add = (x: number, y: number, z: number, c: [number, number, number]) => {
    xyz.push(x, y, z);
    rgb.push(...c);
  };
  for (let i = -40; i <= 40; i++) {
    for (let j = -22; j <= 22; j++) {
      const tx = (i / 40) * 0.6, ty = (j / 22) * 0.33;
      const inBox = Math.abs(tx) < 0.12 && Math.abs(ty) < 0.1;
      if (inBox) add(tx * 1.5, ty * 1.5, -1.5, [0, 0, 1]);
      else add(tx * 3, ty * 3, -3, [1, 0, 0]);
      if (inBox) {
        shellIdx.push(xyz.length / 3);
        add(tx * 4, ty * 4, -4, [0.5, 0.5, 0.5]);
      }
    }
  }
  const n = xyz.length / 3;
  return {
    shellIdx,
    src: {
      forEach(cb) {
        for (let i = 0; i < n; i++) cb(i, xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], 0.97, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      },
    },
  };
}

describe('hidden splat repair', () => {
  test('the backdrop behind an object is the wall around it', () => {
    const f = videoFrustum(video());
    const { src } = scene();
    const grid = new ViewGrid(f, 64);
    src.forEach((_i, x, y, z, _o, r, g, b) => {
      const [tx, ty, d] = toCamera(f, x, y, z);
      grid.add(tx, ty, d, r, g, b);
    });
    const bd = estimateBackdrop(grid, 12);
    const centre = grid.cell(0, 0);
    expect(grid.depth[centre]).toBeCloseTo(1.5, 5); // the camera sees the box there
    expect(bd.far[centre]).toBe(0);
    expect(bd.depth[centre]).toBeCloseTo(3, 1); // the wall continues behind it
    expect(bd.rgb[centre * 3]).toBeGreaterThan(0.9); // red, not the blue box
    expect(bd.rgb[centre * 3 + 2]).toBeLessThan(0.1);
  });

  test('splats behind the object move onto the wall plane and take its colour; visible ones stay', () => {
    const f = videoFrustum(video());
    const { src, shellIdx } = scene();
    const { fixes } = planHiddenFixes(f, src, 64);
    const fixed = new Set(fixes.map((x) => x.index));
    expect(fixes.length).toBeGreaterThan(0);
    for (const i of fixed) expect(shellIdx).toContain(i);
    const centre = fixes.find((x) => Math.abs(x.position[0]) < 0.05 && Math.abs(x.position[1]) < 0.05)!;
    expect(centre).toBeDefined();
    expect(-centre.position[2]).toBeGreaterThan(2.8);
    expect(-centre.position[2]).toBeLessThan(3.3);
    expect(centre.rgb[0]).toBeGreaterThan(0.9);
    // moved along its own camera ray: still in the same place in the picture
    const [tx, ty] = toCamera(f, ...centre.position);
    expect(Math.abs(tx)).toBeLessThan(0.02);
    expect(Math.abs(ty)).toBeLessThan(0.02);
  });

  test('nothing is pulled backwards: a hidden splat in front of the backdrop stays put', () => {
    const f = videoFrustum(video());
    // a visible near surface everywhere at 1 m, and one hidden splat at 1.3 m behind it
    const pts: Array<[number, number, number]> = [];
    for (let i = -20; i <= 20; i++) for (let j = -11; j <= 11; j++) pts.push([(i / 20) * 0.6, (j / 11) * 0.33, -1]);
    pts.push([0, 0, -1.3]);
    const src: SplatSource = { forEach: (cb) => pts.forEach((p, i) => cb(i, p[0], p[1], p[2], 0.97, 0.5, 0.5, 0.5)) };
    const { fixes } = planHiddenFixes(f, src, 40);
    const fix = fixes.find((x) => x.index === pts.length - 1)!;
    expect(fix).toBeDefined();
    expect(-fix.position[2]).toBeLessThanOrEqual(1.3 + 1e-9);
  });
});
