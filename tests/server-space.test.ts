import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  encodeTarget,
  explainSpaceError,
  intrinsicsFor,
  readSpzHeader,
  spin360,
  targetResolution,
  yawPitchQuat,
  type WxyzQuat,
} from '../server/backends/space.ts';
import { FFMPEG, imageSize } from '../server/media.ts';

/** Rotates v by a [w, x, y, z] quaternion. */
function rotate(q: WxyzQuat, v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

describe('FlashWorld request geometry', () => {
  test('yaw turns left, negative pitch looks down (OpenGL camera looks down -Z)', () => {
    const fwd = (q: WxyzQuat) => rotate(q, [0, 0, -1]).map((v) => Math.round(v * 1000) / 1000 + 0);
    expect(fwd(yawPitchQuat(0, 0))).toEqual([0, 0, -1]);
    expect(fwd(yawPitchQuat(Math.PI / 2, 0))).toEqual([-1, 0, 0]);
    const down = fwd(yawPitchQuat(0, -0.3));
    expect(down[1]).toBeLessThan(0);
    const up = rotate(yawPitchQuat(1, -0.2), [0, 1, 0]);
    expect(up[1]).toBeGreaterThan(0.9);
  });

  test('spin360: 24 views, view 0 is the photo at the origin, full turn, then a walk forward', () => {
    const K = intrinsicsFor(704, 480, 4032, 3024, 26);
    const cams = spin360(K);
    expect(cams.length).toBe(24);
    expect(cams[0]!.position).toEqual([0, 0, 0]);
    expect(cams[0]!.quaternion).toEqual([1, 0, 0, 0]);
    // T_norm must be > 0 or the Space collapses every splat onto the origin.
    const tnorm = Math.max(...cams.map((c) => Math.hypot(...c.position)));
    expect(tnorm).toBeGreaterThan(1.5);
    // View 8 looks behind the input camera.
    const behind = rotate(cams[8]!.quaternion, [0, 0, -1]);
    expect(behind[2]).toBeGreaterThan(0.9);
    // Ring views stay within 0.6 m of the start; the walk ends 1.6 m ahead.
    for (const c of cams.slice(0, 16)) expect(Math.hypot(...c.position)).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(cams[23]!.position[2]).toBeCloseTo(-1.6, 6);
    for (const c of cams) {
      expect(Math.hypot(...c.quaternion)).toBeCloseTo(1, 9);
      expect(c.cx).toBe(352);
      expect(c.cy).toBe(240);
    }
  });

  test('intrinsics from a 35 mm focal length or the default phone field of view', () => {
    // 26 mm on a 4032x3024 photo cropped to 704x480: the long side spans 2*atan(18/26) = 69.4 degrees.
    const k = intrinsicsFor(704, 480, 4032, 3024, 26);
    expect(k.fx).toBeCloseTo((2016 / (18 / 26)) * (704 / 4032), 6);
    expect(k.fx).toBe(k.fy);
    const d = intrinsicsFor(704, 480, 704, 480);
    expect(2 * Math.atan(352 / d.fx) * (180 / Math.PI)).toBeCloseTo(65, 6);
    expect(targetResolution(4032, 3024)).toEqual([24, 480, 704]);
    expect(targetResolution(3024, 4032)).toEqual([24, 704, 480]);
  });
});

describe('errors from the Space', () => {
  test('quota, GPU crash, token and other errors read as one actionable sentence', () => {
    const quota = explainSpaceError(
      "JSON processing error: 'You have exceeded your ZeroGPU quota (90s requested vs. 0s left). Try again in 0:00:00. Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens'",
      false,
    );
    expect(quota).toEqual({
      kind: 'quota',
      // What the app shows names no service; the log keeps the actionable detail.
      user: 'The free cloud GPU is used up for now. Try again later.',
      reason: 'the anonymous ZeroGPU quota is used up (90s requested vs. 0s left); put a Hugging Face read token in .env as HF_TOKEN or log in to HiPerGator',
    });
    expect(explainSpaceError('You have exceeded your GPU quota', true).reason).toContain('this Hugging Face account');
    const crash = explainSpaceError('Processing error: NVML_SUCCESS == r INTERNAL ASSERT FAILED at "/pytorch/c10/cuda/CUDACachingAllocator.cpp":1165', false);
    expect(crash.kind).toBe('crash');
    expect(crash.reason).toContain('try again later or use HiPerGator');
    expect(crash.user).toBe('The cloud GPU had a problem on its side. Try again in a minute.');
    expect(explainSpaceError('401 Unauthorized', true).reason).toContain('check HF_TOKEN');
    expect(explainSpaceError('Image decode error', false)).toEqual({ kind: 'other', reason: 'Image decode error' });
  });
});

describe('files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tw-space-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test('readSpzHeader reads the gzip header and rejects other files', async () => {
    const header = Buffer.alloc(16 + 64);
    header.writeUInt32LE(0x5053474e, 0);
    header.writeUInt32LE(3, 4);
    header.writeUInt32LE(4_055_040, 8);
    header[12] = 2;
    header[13] = 12;
    await Bun.write(join(dir, 'a.spz'), gzipSync(header));
    expect(await readSpzHeader(join(dir, 'a.spz'))).toEqual({ version: 3, numPoints: 4_055_040, shDegree: 2, fractionalBits: 12, flags: 0 });
    await Bun.write(join(dir, 'b.spz'), gzipSync(Buffer.from('definitely not a splat file')));
    await expect(readSpzHeader(join(dir, 'b.spz'))).rejects.toThrow(/not an SPZ/);
    await Bun.write(join(dir, 'c.spz'), 'plain text');
    await expect(readSpzHeader(join(dir, 'c.spz'))).rejects.toThrow();
  });

  test('the bundled sample splats parse', async () => {
    const sample = resolve(import.meta.dir, '..', 'data', 'scenes', 'sample-painted-bedroom', 'world.spz');
    if (!(await Bun.file(sample).exists())) return;
    const h = await readSpzHeader(sample);
    expect(h.numPoints).toBeGreaterThan(100_000);
    expect([2, 3]).toContain(h.version);
  });

  test('encodeTarget center-crops to exactly W x H', async () => {
    const src = join(dir, 'tall.jpg');
    const p = Bun.spawn([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=600x900', '-frames:v', '1', src]);
    await p.exited;
    const url = await encodeTarget(src, 480, 704, join(dir, 'out.jpg'));
    expect(url.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(await imageSize(join(dir, 'out.jpg'))).toEqual({ width: 480, height: 704 });
  });
});
