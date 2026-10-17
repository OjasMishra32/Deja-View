// The memory intro's plan: which input view stands in for the spawn, where its picture lives, the relief from the
// world's occupancy, and the enter / leave timelines (web/src/viewer/memory-plan.ts).

import { describe, expect, test } from 'bun:test';
import {
  bandFor,
  buildRelief,
  cameraForward,
  ENTER,
  enterMoment,
  fitIntrinsics,
  frontAt,
  imageCandidates,
  inputImage,
  isPinhole,
  LEAVE,
  LEAVE_REDUCED,
  leaveMoment,
  occupancySampler,
  rankCameras,
  reliefGrid,
  yawPitch,
  type CameraRecord,
  type PinholeCamera,
  type Q4,
  type Shape,
} from '../web/src/viewer/memory-plan.ts';

const intr = { width: 1920, height: 1440, fx: 1390, fy: 1390, cx: 960, cy: 720 };
/** Quaternion for a camera turned by yaw (about +Y) then pitched (about its own X). */
function q(yaw: number, pitch = 0): Q4 {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  // qYaw * qPitch
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}
const cam = (name: string, position: [number, number, number], quaternion: Q4, group = 'photo'): CameraRecord => ({
  name,
  group,
  source: name.split('/').pop(),
  position,
  quaternion,
  intrinsics: intr,
});

describe('camera maths', () => {
  test('forward, yaw and pitch follow three.js conventions', () => {
    expect(cameraForward([0, 0, 0, 1]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, -1]);
    const yp = yawPitch(q(Math.PI / 2, -0.3));
    expect(yp.yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(yp.pitch).toBeCloseTo(-0.3, 5);
    // yaw +90 deg looks down -X
    const f = cameraForward(q(Math.PI / 2));
    expect(f[0]).toBeCloseTo(-1, 5);
  });

  test('pinhole validation and resized intrinsics', () => {
    const p: PinholeCamera = { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1], ...intr };
    expect(isPinhole(p)).toBe(true);
    expect(isPinhole({ ...p, fx: Number.NaN })).toBe(false);
    expect(isPinhole({ ...p, quaternion: [0, 0, 0, 0] })).toBe(false);
    const half = fitIntrinsics(p, 960, 720);
    expect(half.fx).toBe(695);
    expect(half.cx).toBe(480);
    expect(fitIntrinsics(p, 1920, 1440)).toBe(p);
  });
});

describe('choosing the photo', () => {
  const spawn = { x: 0, y: 0, z: 0, yaw: 0 };
  test('a level view near the spawn, facing its way, beats a closer one looking at the floor', () => {
    const cams = [
      cam('photo/IMG_0.jpg', [0, 1.58, 0], q(0, -0.51)),
      cam('photo/IMG_1.jpg', [0.02, 1.66, 0.08], q(0.024, -0.145)),
      cam('photo/IMG_2.jpg', [0.2, 1.6, 0.1], q(1.1, 0)),
      cam('walk/f001.jpg', [0.01, 1.6, 0.01], q(0, 0), 'walk'),
      cam('photo/far.jpg', [4, 1.6, 4], q(0, 0)),
    ];
    const ranked = rankCameras(cams, spawn, 1.6);
    expect(ranked[0].name).toBe('photo/IMG_1.jpg');
    expect(ranked.map((c) => c.name)).not.toContain(undefined);
    expect(ranked[ranked.length - 1].name).toBe('photo/far.jpg');
  });

  test('cameras without usable intrinsics are left out', () => {
    const bad = { ...cam('photo/x.jpg', [0, 1.6, 0], q(0)), intrinsics: { ...intr, fx: 0 } };
    expect(rankCameras([bad], spawn, 1.6)).toEqual([]);
  });

  test('positions go through toWorld (floor shift) before scoring', () => {
    const a = cam('photo/a.jpg', [0, 3.0, 0], q(0));
    const b = cam('photo/b.jpg', [0.3, 1.6, 0], q(0));
    // in the file frame the floor is at 1.4: a stands at eye height, b at the floor
    const ranked = rankCameras([a, b], spawn, 1.6, (p) => [p[0], p[1] - 1.4, p[2]]);
    expect(ranked[0].name).toBe('photo/a.jpg');
  });

  test('image candidates: matching input file, then input/<name>, then the camera path; never outside the folder', () => {
    const c = cam('photo/IMG_7351.jpg', [0, 0, 0], q(0));
    expect(imageCandidates({ input: { files: ['input/IMG_7351.jpg', 'input/other.jpg'] } }, c)).toEqual(['input/IMG_7351.jpg', 'photo/IMG_7351.jpg']);
    expect(imageCandidates({}, c)).toEqual(['input/IMG_7351.jpg', 'photo/IMG_7351.jpg']);
    expect(imageCandidates({}, { name: '../../secret/IMG.jpg', source: 'IMG.jpg' })).toEqual(['input/IMG.jpg']);
    expect(imageCandidates({}, { name: 'tour/f000012', source: 'tour.mp4' })).toEqual([]);
    expect(inputImage({ input: { files: ['input/video.mp4'] } })).toBeNull();
    expect(inputImage({ input: { files: ['input/00.jpg'] } })).toBe('input/00.jpg');
    expect(inputImage({ input: { files: ['/etc/x.jpg'] } })).toBeNull();
  });
});

describe('relief', () => {
  // a 6 x 3 x 8 m room: floor y = 0, ceiling 3, walls at x = +-3, z = -6 and z = 2; cells 10 cm
  const room = {
    size: 0.1,
    solidAt(x: number, y: number, z: number) {
      return y < 0.05 || y > 2.95 || x < -2.95 || x > 2.95 || z < -5.95 || z > 1.95;
    },
  };
  const camera: PinholeCamera = { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1], width: 1600, height: 1200, fx: 1200, fy: 1200, cx: 800, cy: 600 };

  test('grid follows the picture shape', () => {
    expect(reliefGrid({ width: 1920, height: 1080 })).toEqual({ cols: 56, rows: 32 });
    expect(reliefGrid({ width: 1080, height: 1920 })).toEqual({ cols: 32, rows: 56 });
  });

  test('rays marched through the grid land on the walls, floor and ceiling', () => {
    const { cols, rows } = reliefGrid(camera, 40);
    const r = buildRelief(camera, cols, rows, occupancySampler(room, camera, 0.05, 20), 15);
    const W = cols + 1;
    const at = (i: number, j: number) => r.depth[j * W + i];
    // centre ray: the far wall, 6 m ahead
    expect(at(cols / 2, rows / 2)).toBeGreaterThan(5.8);
    expect(at(cols / 2, rows / 2)).toBeLessThan(6.1);
    // bottom centre: the floor, 1.6 m down at tan 0.5 -> z = 3.2
    expect(at(cols / 2, rows)).toBeGreaterThan(3.0);
    expect(at(cols / 2, rows)).toBeLessThan(3.4);
    expect(r.coverage).toBe(1);
    expect(r.near).toBeLessThan(r.mid);
    expect(r.mid).toBeLessThan(r.far);
    // a pixel never dissolves before the surface it lands on (nor its farther neighbours) is reached
    for (let k = 0; k < r.depth.length; k++) {
      const d = r.depth[k] * Math.hypot(r.tan[k * 2], r.tan[k * 2 + 1], 1);
      expect(r.fade[k]).toBeGreaterThanOrEqual(d - 1e-4);
    }
  });

  test('a faint cloud just in front of the camera does not dissolve into darkness', () => {
    // a 1 m slab of "solid" cells 1.5 m ahead of the lower half of the view, in front of a wall 6 m away
    const cloud = { solidAt: (x: number, y: number, z: number) => room.solidAt(x, y, z) || (z < -1.4 && z > -2.4 && y < 1.4 && Math.abs(x) < 0.6) };
    const { cols, rows } = reliefGrid(camera, 40);
    const r = buildRelief(camera, cols, rows, occupancySampler(cloud, camera, 0.05, 20), 15);
    const W = cols + 1;
    // the cloud's pixels land on it, but wait for at least half the median distance before they dissolve
    const k = (rows - 4) * W + cols / 2;
    expect(r.depth[k]).toBeLessThan(2);
    expect(r.fade[k]).toBeGreaterThanOrEqual(0.5 * r.mid - 1e-4);
    expect(r.fade[k]).toBeGreaterThan(1.4 * r.depth[k]);
  });

  test('a lone floater does not stop a ray; holes are filled from neighbours', () => {
    const floaty = { solidAt: (x: number, y: number, z: number) => room.solidAt(x, y, z) || (Math.abs(x) < 0.05 && Math.abs(y - 1.6) < 0.05 && Math.abs(z + 1) < 0.02) };
    const s = occupancySampler(floaty, camera, 0.05, 20);
    expect(s(0, 0, 800, 600)).toBeGreaterThan(5.8);
    // a sampler that misses one vertex and the far corner region
    let calls = 0;
    const r = buildRelief(camera, 8, 6, (tx, ty) => (calls++ === 20 ? Number.NaN : 4 + 0 * tx * ty), 30);
    expect(Array.from(r.depth).every((d) => Math.abs(d - 4) < 1e-6)).toBe(true);
    expect(r.coverage).toBeLessThan(1);
    // nothing at all: the far fill
    const empty = buildRelief(camera, 4, 3, () => Number.NaN, 30);
    expect(empty.depth[0]).toBe(30);
  });
});

describe('timeline', () => {
  const shape: Shape = { travel: 0.5, card: 1.3, near: 2, far: 8, max: 16, subject: 0 };

  test('enter: the photo first, alone, at 1.8 m; the world complete at the end', () => {
    const pre = enterMoment(-ENTER.preroll, shape);
    expect(pre.alpha).toBe(0);
    const start = enterMoment(0, shape);
    expect(start.alpha).toBe(1);
    expect(start.push).toBeCloseTo(0.5, 6);
    expect(start.push + shape.card).toBeCloseTo(1.8, 6);
    expect(start.lift).toBe(0);
    expect(start.front).toBe(0);
    expect(start.sky).toBe(0);
    expect(start.corner).toBe(1);
    // the beat: nothing moves before it ends
    expect(enterMoment(ENTER.hold - 0.01, shape).push).toBeCloseTo(0.5, 6);
    const end = enterMoment(ENTER.end, shape);
    expect(end.alpha).toBe(0);
    expect(end.push).toBe(0);
    expect(end.lift).toBe(1);
    expect(end.front).toBeCloseTo(16, 6);
    expect(end.sky).toBe(1);
    expect(end.video).toBe(1);
  });

  test('enter: the front only grows, the card only approaches', () => {
    let lastFront = 0, lastPush = Infinity;
    for (let t = -0.25; t <= ENTER.end; t += 0.01) {
      const m = enterMoment(t, shape);
      expect(m.front).toBeGreaterThanOrEqual(lastFront - 1e-9);
      expect(m.push).toBeLessThanOrEqual(lastPush + 1e-9);
      expect(m.alpha).toBeGreaterThanOrEqual(0);
      expect(m.alpha).toBeLessThanOrEqual(1);
      lastFront = m.front;
      lastPush = m.push;
    }
    // near things are reached before far ones, while the photo is still mostly there
    expect(enterMoment(1.45, shape).front).toBeCloseTo(2, 6);
    expect(enterMoment(2.1, shape).front).toBeCloseTo(8, 6);
    expect(enterMoment(1.45, shape).alpha).toBe(1);
  });

  test('a video subject fades in when the front reaches them', () => {
    const v = { ...shape, subject: 5 };
    const before = enterMoment(1.6, v);
    expect(before.front).toBeLessThan(5);
    expect(before.video).toBeLessThan(0.2);
    expect(enterMoment(2.3, v).video).toBe(1);
  });

  test('leave: the world shrinks back into the card in the dark', () => {
    const a = leaveMoment(0, shape);
    expect(a.front).toBeCloseTo(16, 6);
    expect(a.lift).toBe(1);
    expect(a.push).toBe(0);
    const z = leaveMoment(LEAVE.end, shape);
    expect(z.front).toBe(0);
    expect(z.lift).toBe(0);
    expect(z.push).toBeCloseTo(0.5, 6);
    expect(z.alpha).toBe(1);
    expect(z.sky).toBe(0);
    expect(z.corner).toBe(1);
    let last = Infinity;
    for (let t = 0; t <= LEAVE.end; t += 0.01) {
      const m = leaveMoment(t, shape);
      expect(m.front).toBeLessThanOrEqual(last + 1e-9);
      last = m.front;
    }
  });

  test('reduced motion: a crossfade, nothing moves', () => {
    // the picture sits at the world's depth the whole time, so it lies on the world from any eye
    for (let t = -0.25; t <= 1.2; t += 0.05) {
      const m = enterMoment(t, shape, true);
      expect(m.push).toBe(0);
      expect(m.lift).toBe(1);
    }
    for (let t = 0; t <= LEAVE_REDUCED.end; t += 0.05) {
      const m = leaveMoment(t, shape, true);
      expect(m.push).toBe(0);
      expect(m.lift).toBe(1);
    }
    expect(enterMoment(0.2, shape, true).alpha).toBe(1);
    expect(enterMoment(1.2, shape, true).alpha).toBe(0);
    expect(enterMoment(1.2, shape, true).front).toBeGreaterThan(15);
    expect(leaveMoment(0.75, shape, true).alpha).toBe(1);
    expect(leaveMoment(0.75, shape, true).front).toBe(0);
  });

  test('the front never lurches: its speed changes smoothly through the keys', () => {
    const dt = 1 / 240;
    const speed = (f: (t: number) => number, t: number) => (f(t + dt) - f(t - dt)) / (2 * dt);
    const enter = (t: number) => enterMoment(t, shape).front;
    const leave = (t: number) => leaveMoment(t, shape).front;
    for (const [f, keys] of [[enter, [1.45, 2.1]], [leave, [0.45, 0.85]]] as const) {
      for (const k of keys) {
        const before = speed(f, k - 0.02), after = speed(f, k + 0.02);
        expect(Math.abs(after - before) / Math.max(Math.abs(before), Math.abs(after))).toBeLessThan(0.25);
      }
    }
    // it sets off and lands softly
    expect(Math.abs(speed(enter, 2.5 - dt))).toBeLessThan(2);
    expect(Math.abs(speed(leave, dt))).toBeLessThan(2);
  });

  test('front keys interpolate in log space and the band softens with distance', () => {
    expect(frontAt(0, [[1, 1], [2, 100]])).toBe(1);
    expect(frontAt(1.5, [[1, 1], [2, 100]])).toBeCloseTo(10, 6);
    expect(frontAt(3, [[1, 1], [2, 100]])).toBe(100);
    expect(bandFor(0.5)).toBe(0.45);
    expect(bandFor(10)).toBeCloseTo(3.2, 6);
  });
});
