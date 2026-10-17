// Decoding math of the Third Wheel video layer (tw-pack-v1). The GLSL in
// web/src/viewer/thirdwheel.ts mirrors these helpers.

import { describe, expect, test } from 'bun:test';
import {
  TW_TUNING,
  bandUv,
  cellTriangle,
  decodeInverseDepth,
  encodeInverseDepth,
  gridDims,
  gridIndices,
  gridToPixel,
  pack16,
  packLayout,
  packedSize,
  resolveSceneFile,
  unpack16,
  unprojectPixel,
} from '../web/src/viewer/thirdwheel.ts';

const near = 1;
const far = 6;

describe('inverse depth', () => {
  test('endpoints decode to far and near', () => {
    expect(decodeInverseDepth(0, near, far)).toBeCloseTo(far, 10);
    expect(decodeInverseDepth(1, near, far)).toBeCloseTo(near, 10);
  });

  test('matches 1/d = 1/far + v (1/near - 1/far)', () => {
    for (const v of [0.1, 0.25, 0.5, 0.9]) {
      const d = decodeInverseDepth(v, near, far);
      expect(1 / d).toBeCloseTo(1 / far + v * (1 / near - 1 / far), 12);
    }
    // v = 0.5 is the harmonic midpoint, not the arithmetic one.
    expect(decodeInverseDepth(0.5, near, far)).toBeCloseTo(2 / (1 / near + 1 / far), 12);
  });

  test('encode is the inverse of decode and clamps', () => {
    for (const d of [1, 1.3, 2.2, 3.7, 6]) expect(decodeInverseDepth(encodeInverseDepth(d, near, far), near, far)).toBeCloseTo(d, 9);
    expect(encodeInverseDepth(0.5, near, far)).toBe(1);
    expect(encodeInverseDepth(50, near, far)).toBe(0);
  });

  test('8-bit quantisation error at 2.4 m stays under 2 cm with near 1, far 6', () => {
    const d = 2.4;
    const q = Math.round(encodeInverseDepth(d, near, far) * 255) / 255;
    expect(Math.abs(decodeInverseDepth(q, near, far) - d)).toBeLessThan(0.02);
  });
});

describe('unprojection into the OpenGL camera frame', () => {
  const intr = { fx: 760, fy: 760, cx: 639.5, cy: 359.5 };

  test('principal point lies on -Z at the given depth', () => {
    expect(unprojectPixel(intr.cx, intr.cy, 2, intr)).toEqual([0, -0, -2]);
  });

  test('right of centre is +x, below centre is -y (image y points down)', () => {
    const [x, y, z] = unprojectPixel(intr.cx + 76, intr.cy + 38, 2, intr);
    expect(x).toBeCloseTo(0.2, 12);
    expect(y).toBeCloseTo(-0.1, 12);
    expect(z).toBe(-2);
  });

  test('depth is z-depth along the optical axis, not ray length', () => {
    const p = unprojectPixel(0, 0, 3, intr);
    expect(p[2]).toBe(-3);
    expect(Math.hypot(...p)).toBeGreaterThan(3);
  });

  test('round trip through a pinhole projection', () => {
    for (const [X, Y, Z] of [
      [0.3, 0.2, -2.4],
      [-0.5, -1.1, -2.2],
      [0, 0.6, -1.8],
    ]) {
      const d = -Z;
      const px = intr.cx + (X / d) * intr.fx;
      const py = intr.cy - (Y / d) * intr.fy;
      const [x, y, z] = unprojectPixel(px, py, d, intr);
      expect(x).toBeCloseTo(X, 10);
      expect(y).toBeCloseTo(Y, 10);
      expect(z).toBeCloseTo(Z, 10);
    }
  });

  test('normalised grid position maps to OpenCV pixel centres', () => {
    expect(gridToPixel(0, 0, 1280, 720)).toEqual([-0.5, -0.5]);
    expect(gridToPixel(1, 1, 1280, 720)).toEqual([1279.5, 719.5]);
    // centre of pixel (10, 20) is at s = 10.5 / 1280
    const [x, y] = gridToPixel(10.5 / 1280, 20.5 / 720, 1280, 720);
    expect(x).toBeCloseTo(10, 10);
    expect(y).toBeCloseTo(20, 10);
  });
});

describe('tw-pack-v1 band layout', () => {
  const size = packedSize(1280, 720);
  const L = packLayout(size.width, size.height);

  test('packed frame is width x 1.5 height', () => {
    expect(size).toEqual({ width: 1280, height: 1080 });
  });

  test('bands: RGB on top, depth bottom-left, mask bottom-right', () => {
    expect(L.rgb).toEqual({ x0: 0, y0: 0, x1: 1280, y1: 720 });
    expect(L.depth).toEqual({ x0: 0, y0: 720, x1: 640, y1: 1080 });
    expect(L.mask).toEqual({ x0: 640, y0: 720, x1: 1280, y1: 1080 });
  });

  test('UVs follow flipY = false: v = 0 is the top row', () => {
    const [u, v] = bandUv(L.rgb, 0.5, 0.5, 1280, 1080, 0);
    expect(u).toBeCloseTo(0.5, 12);
    expect(v).toBeCloseTo(360 / 1080, 12);
    const [du, dv] = bandUv(L.depth, 0.5, 0.5, 1280, 1080, 0);
    expect(du).toBeCloseTo(0.25, 12);
    expect(dv).toBeCloseTo(900 / 1080, 12);
    const [mu, mv] = bandUv(L.mask, 0.5, 0.5, 1280, 1080, 0);
    expect(mu).toBeCloseTo(0.75, 12);
    expect(mv).toBeCloseTo(900 / 1080, 12);
  });

  test('the same image point lands on the same spot in every band', () => {
    for (const [s, t] of [
      [0.2, 0.3],
      [0.71, 0.88],
    ]) {
      const [ru, rv] = bandUv(L.rgb, s, t, 1280, 1080, 0);
      const [du, dv] = bandUv(L.depth, s, t, 1280, 1080, 0);
      const [mu, mv] = bandUv(L.mask, s, t, 1280, 1080, 0);
      expect(du * 2).toBeCloseTo(ru, 12);
      expect(mu * 2 - 1).toBeCloseTo(ru, 12);
      expect((dv * 1080 - 720) * 2).toBeCloseTo(rv * 1080, 9);
      expect(mv).toBeCloseTo(dv, 12);
    }
  });

  test('samples stay at least half a texel inside their band (no bleeding)', () => {
    const inset = TW_TUNING.bandInset;
    expect(inset).toBeGreaterThanOrEqual(0.5);
    for (const band of [L.rgb, L.depth, L.mask]) {
      for (const [s, t] of [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
        [-0.1, 1.2],
      ]) {
        const [u, v] = bandUv(band, s, t, 1280, 1080, inset);
        const px = u * 1280, py = v * 1080;
        expect(px).toBeGreaterThanOrEqual(band.x0 + 0.5);
        expect(px).toBeLessThanOrEqual(band.x1 - 0.5);
        expect(py).toBeGreaterThanOrEqual(band.y0 + 0.5);
        expect(py).toBeLessThanOrEqual(band.y1 - 0.5);
      }
    }
    // With linear filtering, a sample at the bottom edge of the RGB band reads rows 718.5-719.5
    // only, never the depth band's first row (720).
    const [, v] = bandUv(L.rgb, 0.5, 1, 1280, 1080, 0.5);
    expect(v * 1080 + 0.5).toBeLessThanOrEqual(720);
  });

  test('layout follows the decoded size when a file was resized', () => {
    const r = packLayout(960, 810);
    expect(r.rgb.y1).toBe(540);
    expect(r.depth).toEqual({ x0: 0, y0: 540, x1: 480, y1: 810 });
  });
});

describe('grid', () => {
  test('dims follow the aspect, longest side capped', () => {
    expect(gridDims(1280, 720, 320)).toEqual([320, 180]);
    expect(gridDims(720, 1280, 320)).toEqual([180, 320]);
    expect(gridDims(1000, 1000, 256)).toEqual([256, 256]);
  });

  test('cellTriangle matches the index buffer for every cell parity', () => {
    const cols = 4, rows = 3;
    const idx = gridIndices(cols, rows);
    const vtx = (n: number) => [n % (cols + 1), Math.floor(n / (cols + 1))];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const base = (j * cols + i) * 6;
        const tris = [0, 3].map((o) =>
          [idx[base + o], idx[base + o + 1], idx[base + o + 2]].map((n) => {
            const [x, y] = vtx(n);
            return [x - i, y - j];
          }),
        );
        // Sample points well inside each triangle (its centroid).
        for (const tri of tris) {
          const fx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
          const fy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          const got = cellTriangle(i, j, fx, fy).map(([a, b]) => `${a},${b}`).sort();
          expect(got).toEqual(tri.map(([a, b]) => `${a},${b}`).sort());
        }
      }
    }
  });

  test('every triangle winds the same way', () => {
    const cols = 5, rows = 4;
    const idx = gridIndices(cols, rows);
    const signs = new Set<number>();
    for (let k = 0; k < idx.length; k += 3) {
      const p = [idx[k], idx[k + 1], idx[k + 2]].map((n) => [n % (cols + 1), Math.floor(n / (cols + 1))]);
      const cross = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
      expect(Math.abs(cross)).toBe(1);
      signs.add(Math.sign(cross));
    }
    expect(signs.size).toBe(1);
  });

  test('large grids switch to 32-bit indices', () => {
    expect(gridIndices(320, 180)).toBeInstanceOf(Uint16Array);
    expect(gridIndices(400, 400)).toBeInstanceOf(Uint32Array);
  });
});

describe('pre-pass depth packing', () => {
  test('16-bit split round-trips to 1/65535', () => {
    for (const u of [0, 1, 0.5, 0.123456, 0.99999]) {
      const [hi, lo] = pack16(u);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(255);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(255);
      expect(Math.abs(unpack16(hi, lo) - u)).toBeLessThanOrEqual(0.5 / 65535 + 1e-12);
    }
  });

  test('much finer than the 8-bit source', () => {
    const [hi, lo] = pack16(0.3333);
    expect(Math.abs(unpack16(hi, lo) - 0.3333)).toBeLessThan(1 / 255 / 100);
  });
});

describe('scene file URLs', () => {
  test('relative files resolve against the scene directory', () => {
    expect(resolveSceneFile('/data/scenes/a/', 'tw.mp4')).toBe('/data/scenes/a/tw.mp4');
    expect(resolveSceneFile('/data/scenes/a', './tw.mp4')).toBe('/data/scenes/a/tw.mp4');
    expect(resolveSceneFile('/data/scenes/a/', 'https://cdn.example/x.mp4')).toBe('https://cdn.example/x.mp4');
  });
});
