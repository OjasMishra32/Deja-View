// The per-frame camera of a handheld Video memory (web/src/viewer/tw-track.ts): camera-track.json parsing, the
// frame on screen for a media time, and the frame number the packed frames carry (pipeline/recon/people.py writes
// it; the GLSL in thirdwheel.ts reads it like decodeFrameCode).

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  decodeFrameCode,
  encodeFrameCode,
  frameAt,
  parseCameraTrackDoc,
  poseRows,
  trackMatrix,
  trackTextureSize,
  type FrameCode,
} from '../web/src/viewer/tw-track.ts';

const CODE: FrameCode = { rows: 4, blocks: 16, lo: 48, hi: 208, bits: 13 };
const layer = { height: 1080, fps: 30 };

function doc(n: number, fps = 30) {
  return {
    fps,
    frameCode: { band: 'depth', ...CODE },
    track: Array.from({ length: n }, (_, k) => ({
      frame: k,
      time: k / fps,
      position: [k * 0.01, 1.6, -k * 0.02],
      quaternion: [0, Math.sin((k * 0.01) / 2), 0, Math.cos((k * 0.01) / 2)],
    })),
  };
}

describe('frame code', () => {
  test('every frame number survives encode and decode', () => {
    for (const k of [0, 1, 2, 7, 255, 256, 370, 1000, 8191]) expect(decodeFrameCode(encodeFrameCode(k, CODE), CODE)).toBe(k);
  });

  test('matches the packer layout: start block high, parity, last block low', () => {
    const v = encodeFrameCode(5, CODE); // bits 1 0 1 -> parity 0
    expect(v.length).toBe(16);
    expect(v[0]).toBe(CODE.hi);
    expect(v.slice(1, 4)).toEqual([CODE.hi, CODE.lo, CODE.hi]);
    expect(v[1 + CODE.bits]).toBe(CODE.lo);
    expect(v[15]).toBe(CODE.lo);
  });

  test('codec noise below the threshold margin is tolerated, a broken code is rejected', () => {
    const v = encodeFrameCode(371, CODE).map((x, i) => x + (i % 2 ? 30 : -30));
    expect(decodeFrameCode(v, CODE)).toBe(371);
    const flipped = encodeFrameCode(371, CODE);
    flipped[3] = flipped[3] === CODE.hi ? CODE.lo : CODE.hi; // one bit wrong: parity fails
    expect(decodeFrameCode(flipped, CODE)).toBeNull();
    expect(decodeFrameCode(new Array(16).fill(0), CODE)).toBeNull(); // a frame without a code (all dark)
    expect(decodeFrameCode(new Array(16).fill(255), CODE)).toBeNull();
  });
});

describe('camera track', () => {
  test('parses camera-track.json and keeps the frame code', () => {
    const t = parseCameraTrackDoc(doc(371), layer)!;
    expect(t.times.length).toBe(371);
    expect(t.fps).toBe(30);
    expect(t.frameCode).toEqual(CODE);
    expect(t.bandRows).toBe(540);
    expect(t.rows.length).toBe(371 * 12);
  });

  test('rejects malformed tracks', () => {
    expect(parseCameraTrackDoc(null, layer)).toBeNull();
    expect(parseCameraTrackDoc({ track: [] }, layer)).toBeNull();
    const bad = doc(5);
    (bad.track[2] as { position: unknown }).position = [0, 1];
    expect(parseCameraTrackDoc(bad, layer)).toBeNull();
    const unordered = doc(5);
    unordered.track[3].time = unordered.track[1].time;
    expect(parseCameraTrackDoc(unordered, layer)).toBeNull();
  });

  test('a track without a usable frame code still parses (the CPU frame is used)', () => {
    const d = { ...doc(10), frameCode: { rows: 4, blocks: 4, lo: 48, hi: 208, bits: 13 } };
    expect(parseCameraTrackDoc(d, layer)!.frameCode).toBeNull();
  });

  test('poseRows agrees with three for the camera-to-room transform', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 0.8, 0.1, 'YXZ'));
    const p = new THREE.Vector3(0.4, 1.6, -1.2);
    const r = poseRows([p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
    const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
    const pt = new THREE.Vector3(0.2, -0.5, -2.5);
    const want = pt.clone().applyMatrix4(m);
    const got = [0, 1, 2].map((i) => r[i * 4] * pt.x + r[i * 4 + 1] * pt.y + r[i * 4 + 2] * pt.z + r[i * 4 + 3]);
    expect(got[0]).toBeCloseTo(want.x, 6);
    expect(got[1]).toBeCloseTo(want.y, 6);
    expect(got[2]).toBeCloseTo(want.z, 6);
    // trackMatrix rebuilds the same Matrix4
    const t = parseCameraTrackDoc({ fps: 30, track: [{ time: 0, position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] }] }, layer)!;
    const back = trackMatrix(t, 0, new THREE.Matrix4());
    const e1 = back.elements, e2 = m.elements;
    for (let i = 0; i < 16; i++) expect(e1[i]).toBeCloseTo(e2[i], 6);
  });
});

describe('frame on screen', () => {
  const times = Array.from({ length: 371 }, (_, k) => k / 30);

  test('currentTime: the last frame presented at or before t', () => {
    expect(frameAt(times, 0)).toBe(0);
    expect(frameAt(times, 1 / 30 - 0.001)).toBe(0);
    expect(frameAt(times, 1 / 30)).toBe(1);
    expect(frameAt(times, 5.51)).toBe(165);
    expect(frameAt(times, 99)).toBe(370);
    expect(frameAt(times, -1)).toBe(0);
  });

  test("rVFC mediaTime: the frame's own timestamp, robust to rounding either way", () => {
    for (const k of [0, 1, 100, 200, 370]) {
      expect(frameAt(times, k / 30 - 1e-6, true)).toBe(k);
      expect(frameAt(times, k / 30 + 1e-6, true)).toBe(k);
    }
  });

  test('the pose texture wraps long clips into rows of frames', () => {
    expect(trackTextureSize(371)).toEqual({ width: 371, height: 3 });
    expect(trackTextureSize(5000, 2048)).toEqual({ width: 2048, height: 9 });
  });
});
