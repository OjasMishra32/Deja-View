// Per-frame camera of a handheld Video memory (camera-track.json next to the packed video, written by
// pipeline/recon/people.py). The video layer (thirdwheel.ts) places each frame's relief with the pose of the
// frame actually on screen:
//
//   - The packed frames carry their own frame number in the last rows of the depth band (`frameCode`: blocks
//     across the band, block 0 high, the last block low, then the bits least significant first and an even-parity
//     bit; the mask is zero there so nothing is drawn from them). A one-texel GPU pass reads it from the uploaded
//     frame and the vertex shaders fetch that frame's pose from a float texture, so picture and pose can never come
//     from different frames, whatever the browser reports about frame times (immersive WebXR gives none).
//   - Without a readable code the shaders use the frame the CPU picks from the media time (rVFC's mediaTime when
//     it is fresh, else currentTime).
//
// Pure helpers here (tests/thirdwheel-track.test.ts); GLSL in thirdwheel.ts mirrors decodeFrameCode.

import * as THREE from 'three';
import type { Quat, Vec3, VideoLayer } from '../../../shared/types.ts';

/** VideoLayer with the optional per-frame camera (shared/types.ts gains `cameraTrack` in the same shape). */
export type TrackedVideoLayer = VideoLayer & {
  /** camera-track.json relative to the scene directory: the recording camera of every frame (a handheld clip). */
  cameraTrack?: string;
};

export interface FrameCode {
  /** Rows at the bottom of the depth band that hold the code (in rows of the band as packed). */
  rows: number;
  blocks: number;
  /** Grey levels (0..255) of a low and a high block. */
  lo: number;
  hi: number;
  /** Bits of the frame number. */
  bits: number;
}

export interface CameraTrack {
  fps: number;
  /** Frame k is presented at times[k] seconds of media time. */
  times: Float64Array;
  /** Per frame, the camera-to-room transform as three rows [r00 r01 r02 tx | r10 r11 r12 ty | r20 r21 r22 tz]. */
  rows: Float32Array;
  frameCode: FrameCode | null;
  /** Rows of the depth band in the packed file (frameCode.rows are counted against it). */
  bandRows: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length === n && a.every(isNum);

/** Camera-to-room rows [R | t] for an OpenGL camera pose (quaternion xyzw, normalised here). */
export function poseRows(position: Vec3 | readonly number[], quaternion: Quat | readonly number[]): number[] {
  let [x, y, z, w] = quaternion;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), position[0],
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), position[1],
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), position[2],
  ];
}

function parseFrameCode(v: unknown): FrameCode | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (!isNum(c.rows) || !isNum(c.blocks) || !isNum(c.lo) || !isNum(c.hi) || !isNum(c.bits)) return null;
  if (c.rows < 1 || c.blocks < c.bits + 3 || c.blocks > 32 || c.hi <= c.lo || c.bits < 1 || c.bits > 16) return null;
  return { rows: c.rows, blocks: c.blocks, lo: c.lo, hi: c.hi, bits: c.bits };
}

/**
 * camera-track.json -> CameraTrack, or null when it is not usable. Frames are `track` entries with time, position
 * and quaternion (the same records <clip>-poses.json carries), in frame order.
 */
export function parseCameraTrackDoc(doc: unknown, layer: Pick<VideoLayer, 'height' | 'fps'>): CameraTrack | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const list = Array.isArray(d.track) ? d.track : null;
  if (!list || !list.length) return null;
  const frames = list.filter(
    (s): s is { time: number; position: number[]; quaternion: number[] } =>
      !!s && typeof s === 'object' && isNum((s as { time?: unknown }).time) && isVec((s as { position?: unknown }).position, 3) && isVec((s as { quaternion?: unknown }).quaternion, 4),
  );
  if (frames.length !== list.length) return null;
  const times = new Float64Array(frames.length);
  const rows = new Float32Array(frames.length * 12);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (i > 0 && !(f.time > times[i - 1])) return null;
    times[i] = f.time;
    rows.set(poseRows(f.position, f.quaternion), i * 12);
  }
  const fps = isNum(d.fps) && d.fps > 0 ? d.fps : layer.fps;
  return { fps, times, rows, frameCode: parseFrameCode(d.frameCode), bandRows: Math.round(layer.height / 2) };
}

/**
 * Frame on screen at media time t: the last frame presented at or before t. `exact` (rVFC's mediaTime, which is
 * a frame's own timestamp) takes the nearest frame instead, so rounding in the time never picks its predecessor.
 */
export function frameAt(times: ArrayLike<number>, t: number, exact = false): number {
  const n = times.length;
  if (n === 0) return 0;
  if (exact) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    return Math.abs(times[hi] - t) < Math.abs(times[lo] - t) ? hi : lo;
  }
  const eps = 1e-4;
  if (t < times[0] + eps) return 0;
  let lo = 0, hi = n - 1;
  if (t >= times[hi] - eps) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t + eps) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Grey levels of the code blocks for frame k (what the packer writes; tests and debugging). */
export function encodeFrameCode(k: number, c: FrameCode): number[] {
  const bits: number[] = [];
  for (let i = 0; i < c.bits; i++) bits.push((k >> i) & 1);
  const blocks = [1, ...bits, bits.reduce((s, b) => s + b, 0) & 1];
  while (blocks.length < c.blocks) blocks.push(0);
  return blocks.map((b) => (b ? c.hi : c.lo));
}

/** Frame number from the grey level (0..255) at each block centre, or null when the checks fail. */
export function decodeFrameCode(levels: ArrayLike<number>, c: FrameCode): number | null {
  if (levels.length < c.blocks) return null;
  const thr = (c.lo + c.hi) / 2;
  const b = (i: number) => (levels[i] > thr ? 1 : 0);
  if (b(0) !== 1 || b(c.blocks - 1) !== 0) return null;
  let k = 0, parity = 0;
  for (let i = 0; i < c.bits; i++) {
    const v = b(1 + i);
    k += v << i;
    parity ^= v;
  }
  return parity === b(1 + c.bits) ? k : null;
}

/** Texture layout of the pose rows: frames wrap at `width` texels, three texel rows per row of frames. */
export function trackTextureSize(frames: number, maxWidth = 2048): { width: number; height: number } {
  const width = Math.max(1, Math.min(frames, maxWidth));
  return { width, height: Math.ceil(frames / width) * 3 };
}

/** Float texture of the poses: texel (k mod width, floor(k / width) * 3 + r) holds row r of frame k. */
export function makeTrackTexture(track: CameraTrack, maxWidth = 2048): THREE.DataTexture {
  const n = track.times.length;
  const { width, height } = trackTextureSize(n, maxWidth);
  const data = new Float32Array(width * height * 4);
  for (let k = 0; k < n; k++) {
    const x = k % width, y0 = Math.floor(k / width) * 3;
    for (let r = 0; r < 3; r++) data.set(track.rows.subarray(k * 12 + r * 4, k * 12 + r * 4 + 4), ((y0 + r) * width + x) * 4);
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Camera-to-room Matrix4 of frame k (CPU side: fades, the subject, debugging). */
export function trackMatrix(track: CameraTrack, k: number, out: THREE.Matrix4): THREE.Matrix4 {
  const i = Math.min(Math.max(0, Math.round(k)), track.times.length - 1) * 12;
  const r = track.rows;
  return out.set(r[i], r[i + 1], r[i + 2], r[i + 3], r[i + 4], r[i + 5], r[i + 6], r[i + 7], r[i + 8], r[i + 9], r[i + 10], r[i + 11], 0, 0, 0, 1);
}
