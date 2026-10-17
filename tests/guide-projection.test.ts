// Projection math for the guide's labels: pinhole rays, depth unprojection, ray marching, the
// placement chain (depth -> splats -> voxels) and frame changes.

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  cameraFromThree,
  cameraFromVideo,
  cleanHotspots,
  marchRay,
  parseInputCamera,
  parseStoredHotspots,
  pixelRay,
  placeHotspot,
  project,
  rotate,
  sampleDepth,
  stackLifts,
  storedHotspotsBody,
  unproject,
  worldRay,
  type DepthMap,
  type PinholeCamera,
  type PlacementEnv,
  type Quat,
  type Vec3,
} from '../web/src/viewer/guide/hotspots.ts';
import { INPUT_CAMERA, LOUNGE_SPOTS, loungeHotspots, renderLounge } from './harness/guide-harness.ts';

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function quatFromEuler(x: number, y: number, z: number): Quat {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
}

const CAM: PinholeCamera = { width: 1280, height: 720, fx: 900, fy: 880, cx: 650, cy: 352, position: [0.4, 1.3, -0.2], quaternion: quatFromEuler(-0.2, 0.7, 0.05) };

describe('pinhole camera', () => {
  test('rotate matches three.js', () => {
    const q = quatFromEuler(0.3, -1.1, 0.4);
    const v: Vec3 = [0.2, -0.5, 1.7];
    const t = new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(...q));
    expect(close(rotate(q, v), [t.x, t.y, t.z], 1e-9)).toBe(true);
  });

  test('the principal point looks down the camera axis', () => {
    const r = pixelRay(CAM, CAM.cx / CAM.width, CAM.cy / CAM.height);
    const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...CAM.quaternion));
    expect(close(r.dir, [axis.x, axis.y, axis.z], 1e-9)).toBe(true);
    expect(close(r.origin, CAM.position)).toBe(true);
  });

  test('image x right and y down map to camera right and down', () => {
    const id: PinholeCamera = { ...CAM, position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const right = pixelRay(id, 0.9, CAM.cy / CAM.height).dir;
    const down = pixelRay(id, CAM.cx / CAM.width, 0.9).dir;
    expect(right[0]).toBeGreaterThan(0);
    expect(down[1]).toBeLessThan(0);
    expect(right[2]).toBe(-1);
  });

  test('unproject then project is the identity, for points at z-depth', () => {
    for (const [nx, ny, d] of [[0.5, 0.5, 2], [0.1, 0.85, 3.7], [0.93, 0.04, 0.6], [0, 1, 9]]) {
      const p = unproject(CAM, nx, ny, d);
      const back = project(CAM, p)!;
      expect(back.nx).toBeCloseTo(nx, 9);
      expect(back.ny).toBeCloseTo(ny, 9);
      expect(back.depth).toBeCloseTo(d, 9);
    }
  });

  test('project agrees with a three.js camera with the same intrinsics', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 100);
    cam.position.set(1, 1.6, 2);
    cam.rotation.set(-0.15, 0.4, 0, 'YXZ');
    cam.updateMatrixWorld(true);
    const pin = cameraFromThree(cam, 1600, 900);
    for (const p of [[0, 1, -2], [2, 0.5, -1], [-1, 2.2, -3]] as Vec3[]) {
      const ours = project(pin, p)!;
      const ndc = new THREE.Vector3(...p).project(cam);
      expect(ours.nx).toBeCloseTo((ndc.x + 1) / 2, 6);
      expect(ours.ny).toBeCloseTo((1 - ndc.y) / 2, 6);
    }
  });

  test('cameraFromThree handles a snapshot whose aspect differs from the camera it copied', () => {
    // the snapshot camera has its own aspect (768 x 576) and fov: projections must match it
    const cam = new THREE.PerspectiveCamera(78, 768 / 576, 0.05, 50);
    cam.position.set(0, 1.6, 0);
    cam.updateMatrixWorld(true);
    const pin = cameraFromThree(cam, 768, 576);
    const p: Vec3 = [0.8, 1.1, -2];
    const ndc = new THREE.Vector3(...p).project(cam);
    const ours = project(pin, p)!;
    expect(ours.nx).toBeCloseTo((ndc.x + 1) / 2, 6);
    expect(ours.ny).toBeCloseTo((1 - ndc.y) / 2, 6);
  });

  test('input_camera.json and VideoLayer become cameras; junk does not', () => {
    const c = parseInputCamera({ width: 4032, height: 3024, fx: 3022.1, fy: 3022.1, cx: 2016, cy: 1512, position: [0, 1.45, 0], quaternion: [0, 0, 0, 1], depthWidth: 1024, depthHeight: 768 })!;
    expect(c.fx).toBe(3022.1);
    expect(c.depthWidth).toBe(1024);
    expect(parseInputCamera({ width: 640, height: 480, fx: 500 })!.cx).toBe(320);
    expect(parseInputCamera({ width: 0, height: 480, fx: 500 })).toBeNull();
    expect(parseInputCamera({ width: 640, height: 480 })).toBeNull();
    expect(parseInputCamera('nope')).toBeNull();
    const v = cameraFromVideo({ width: 1280, height: 720, intrinsics: { fx: 760, fy: 760, cx: 639.5, cy: 359.5 }, cameraPose: { position: [0.4, 0.135, 0], quaternion: [-0.1045, 0, 0, 0.9945] } })!;
    expect(v.width).toBe(1280);
    expect(v.position).toEqual([0.4, 0.135, 0]);
  });
});

describe('depth sampling', () => {
  const W = 8, H = 6;
  const map: DepthMap = { width: W, height: H, data: new Float32Array(W * H).fill(4) };

  test('reads the cell under the position', () => {
    expect(sampleDepth(map, 0.5, 0.5)).toBe(4);
  });

  test('prefers the nearer surface at an edge', () => {
    const m: DepthMap = { width: W, height: H, data: new Float32Array(W * H).fill(4) };
    for (let r = 0; r < H; r++) for (let c = 0; c < 4; c++) m.data[r * W + c] = 1.5;
    expect(sampleDepth(m, 4.2 / W, 0.5, 1)).toBe(1.5);
  });

  test('skips holes and gives up when there is no data at all', () => {
    const m: DepthMap = { width: W, height: H, data: new Float32Array(W * H) };
    m.data[0] = 2.5;
    expect(sampleDepth(m, 1.5 / W, 1.5 / H, 1)).toBe(2.5);
    expect(sampleDepth({ width: W, height: H, data: new Float32Array(W * H) }, 0.5, 0.5)).toBeNull();
    m.data.fill(NaN);
    expect(sampleDepth(m, 0.5, 0.5)).toBeNull();
  });

  test('clamps positions on and past the image edge', () => {
    expect(sampleDepth(map, 1, 1)).toBe(4);
    expect(sampleDepth(map, -0.01, 1.01)).toBe(4);
  });
});

describe('ray marching', () => {
  const sphere = (c: Vec3, r: number) => (x: number, y: number, z: number) => Math.hypot(x - c[0], y - c[1], z - c[2]) <= r;

  test('finds the surface to within a few millimetres', () => {
    const t = marchRay([0, 0, 0], [0, 0, -1], sphere([0, 0, -3], 0.5))!;
    expect(t).toBeCloseTo(2.5, 2);
  });

  test('misses return null, and nothing beyond max counts', () => {
    expect(marchRay([0, 0, 0], [0, 1, 0], sphere([0, 0, -3], 0.5))).toBeNull();
    expect(marchRay([0, 0, 0], [0, 0, -1], sphere([0, 0, -8], 0.5), { max: 6 })).toBeNull();
  });

  test('a camera standing inside solid stops at the start distance', () => {
    expect(marchRay([0, 0, 0], [1, 0, 0], () => true)).toBe(0.25);
  });
});

describe('placement', () => {
  const identity = new THREE.Matrix4();
  const floorShift = new THREE.Matrix4().makeTranslation(0, 1.25, 0);

  let rendered: ReturnType<typeof renderLounge> | null = null;
  function loungeEnv(over: Partial<PlacementEnv> = {}): PlacementEnv {
    const { depth } = (rendered ??= renderLounge());
    return { camera: INPUT_CAMERA, cameraFrame: 'scene', toWorld: identity, depth: { width: INPUT_CAMERA.depthWidth, height: INPUT_CAMERA.depthHeight, data: depth }, ...over };
  }

  test('the harness depth map is z-depth of the analytic room', () => {
    const { depth } = (rendered ??= renderLounge());
    const W = INPUT_CAMERA.depthWidth;
    // the centre pixel looks straight at the far wall behind the TV (z = -4.4 for the TV face)
    const z = depth[(INPUT_CAMERA.depthHeight / 2) * W + W / 2];
    expect(z).toBeCloseTo(4.4, 2);
  });

  test('depth: every lounge label lands within 10 cm of the spot it names (5 cm of that is the stand-off)', () => {
    const env = loungeEnv();
    for (const [i, h] of loungeHotspots().entries()) {
      const p = placeHotspot(h, env)!;
      expect(p.source).toBe('depth');
      expect(dist(p.position, LOUNGE_SPOTS[i].point)).toBeLessThan(0.1);
    }
  });

  test('the anchor sits in front of the surface, toward the camera', () => {
    const tv = loungeHotspots()[0];
    const p = placeHotspot(tv, loungeEnv())!;
    expect(dist(INPUT_CAMERA.position, p.position)).toBeLessThan(dist(INPUT_CAMERA.position, LOUNGE_SPOTS[0].point));
  });

  test('scene frame to world: the floor shift moves labels with the room', () => {
    const tv = loungeHotspots()[0];
    const p = placeHotspot(tv, loungeEnv({ toWorld: floorShift }))!;
    expect(p.position[1] - 1.25).toBeCloseTo(placeHotspot(tv, loungeEnv())!.position[1], 6);
  });

  test('a flipped world turns the ray over too', () => {
    const flip = new THREE.Matrix4().makeRotationX(Math.PI);
    const r = worldRay({ ...loungeEnv(), toWorld: flip }, 0.5, 0.5);
    expect(r.origin[1]).toBeCloseTo(-1.45, 6);
    expect(r.dir[2]).toBeCloseTo(1, 6);
  });

  test('no depth: splat rays, then voxel marching, then nothing', () => {
    // a voxel world: the TV wall, the floor and the couch
    const solid = (x: number, y: number, z: number) => z < -4.39 || y < 0.001 || (x > -1.9 && x < -0.7 && y < 0.8 && z > -3 && z < -2);
    const h = loungeHotspots()[0];
    const splats = placeHotspot(h, loungeEnv({ depth: null, raycastSplats: () => 4.4 }))!;
    expect(splats.source).toBe('splats');
    const vox = placeHotspot(h, loungeEnv({ depth: null, solidAt: solid }))!;
    expect(vox.source).toBe('voxels');
    expect(dist(vox.position, LOUNGE_SPOTS[0].point)).toBeLessThan(0.1);
    // a splat raycast that throws falls through to the voxels
    const fallback = placeHotspot(h, loungeEnv({ depth: null, raycastSplats: () => { throw new Error('wasm not ready'); }, solidAt: solid }))!;
    expect(fallback.source).toBe('voxels');
    expect(placeHotspot(h, loungeEnv({ depth: null }))).toBeNull();
    expect(placeHotspot(h, loungeEnv({ depth: null, raycastSplats: () => 50 }))).toBeNull();
  });

  test('a hole in the depth map falls back to the rays', () => {
    const env = loungeEnv();
    env.depth = { ...env.depth!, data: new Float32Array(env.depth!.data.length) };
    const p = placeHotspot(loungeHotspots()[0], { ...env, raycastSplats: () => 4.4 })!;
    expect(p.source).toBe('splats');
  });

  test('snapshot cameras are already in world', () => {
    const cam = new THREE.PerspectiveCamera(70, 4 / 3, 0.05, 50);
    cam.position.set(0, 1.6, 0);
    cam.updateMatrixWorld(true);
    const pin = cameraFromThree(cam, 768, 576);
    const target: Vec3 = [0.5, 1.2, -3];
    const pr = project(pin, target)!;
    const env: PlacementEnv = { camera: pin, cameraFrame: 'world', toWorld: floorShift, raycastSplats: (o, d) => {
      // distance along the ray to the plane z = -3
      return (-3 - o[2]) / d[2];
    } };
    const p = placeHotspot({ label: 'Thing', x: pr.nx, y: pr.ny }, env)!;
    expect(dist(p.position, target)).toBeLessThan(0.06);
  });
});

describe('hotspot lists', () => {
  test('cleanHotspots trims, clamps, dedupes and caps', () => {
    const list = cleanHotspots({
      hotspots: [
        { label: '  TV   screen ', x: 0.5, y: 0.4, blurb: 'Big.' },
        { label: 'tv screen', x: 0.1, y: 0.1 },
        { label: 'Edge', x: 1.01, y: -0.01 },
        { label: 'Way off', x: 1.5, y: 0.5 },
        { label: '', x: 0.5, y: 0.5 },
        { label: 'NaN', x: 'a', y: 0.5 },
        null,
      ],
    });
    expect(list.map((h) => h.label)).toEqual(['TV screen', 'Edge']);
    expect(list[1]).toMatchObject({ x: 1, y: 0 });
    expect(cleanHotspots(Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, x: 0.5, y: 0.5 }))).length).toBe(8);
    expect(cleanHotspots(null)).toEqual([]);
  });

  test('stored labels round-trip through the PUT body', () => {
    const placed = [{ id: 'a', label: 'Couch', blurb: 'Comfy.', position: [1.23456, 0.5, -2] as Vec3, u: 0.2, v: 0.8, source: 'depth' as const }];
    const body = storedHotspotsBody(placed);
    expect(body.hotspots[0]).toMatchObject({ label: 'Couch', x: 1.235, y: 0.5, z: -2, u: 0.2, v: 0.8 });
    const back = parseStoredHotspots(JSON.parse(JSON.stringify(body)));
    expect(back[0]).toMatchObject({ label: 'Couch', blurb: 'Comfy.', position: [1.235, 0.5, -2], source: 'stored' });
    expect(parseStoredHotspots([{ label: 'P', position: [1, 2, 3] }])[0].position).toEqual([1, 2, 3]);
    expect(parseStoredHotspots({ hotspots: [{ label: 'Bad', x: 1, y: null, z: 2 }] })).toEqual([]);
    expect(parseStoredHotspots({ error: 'No labels stored for this scene.' })).toEqual([]);
  });

  test('labels close together stack instead of overlapping', () => {
    const lifts = stackLifts([{ position: [0, 1, -2] }, { position: [0.1, 1.02, -2] }, { position: [3, 1, -2] }]);
    expect(lifts[0]).toBe(0);
    expect(lifts[1]).toBeGreaterThan(0.1);
    expect(lifts[2]).toBe(0);
  });
});
