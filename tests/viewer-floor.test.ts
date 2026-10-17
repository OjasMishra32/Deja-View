import { describe, expect, test } from 'bun:test';
import {
  distanceOutside,
  estimateFloor,
  expandBounds,
  hslToRgb,
  insideXZ,
  quantileSorted,
  rgbToHsl,
  robustBounds,
  skyPalette,
  sortedFloat32,
} from '../web/src/viewer/analysis.ts';

function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Heights of a synthetic generated room: floor, walls, ceiling, furniture, floaters. */
function roomHeights(opts: { floor: number; ceiling: number; table?: number; reflections?: boolean; seed?: number }): number[] {
  const r = rng(opts.seed ?? 3);
  const ys: number[] = [];
  for (let i = 0; i < 30000; i++) ys.push(opts.floor + (r() - 0.5) * 0.03); // floor layer
  for (let i = 0; i < 9000; i++) ys.push(opts.ceiling + (r() - 0.5) * 0.04); // ceiling layer
  for (let i = 0; i < 40000; i++) ys.push(opts.floor + r() * (opts.ceiling - opts.floor)); // walls
  if (opts.table !== undefined) for (let i = 0; i < 12000; i++) ys.push(opts.table + (r() - 0.5) * 0.03);
  if (opts.reflections) for (let i = 0; i < 1500; i++) ys.push(opts.floor - 0.1 - r() * 0.8); // sparse mirror junk
  for (let i = 0; i < 400; i++) ys.push(opts.floor - 2 + r() * 6); // floaters everywhere
  return ys;
}

describe('estimateFloor', () => {
  test('finds the floor of a generated room around a camera at the origin', () => {
    const est = estimateFloor(roomHeights({ floor: -1.4, ceiling: 1.2 }), { below: -0.3 });
    expect(est).not.toBeNull();
    expect(Math.abs(est!.y - -1.4)).toBeLessThan(0.03);
    expect(est!.confidence).toBeGreaterThan(0.3);
  });

  test('picks the floor even when a table top is a denser layer', () => {
    const ys = roomHeights({ floor: -1.2, ceiling: 1.5, table: -0.45 });
    // make the table layer clearly stronger than the floor
    for (let i = 0; i < 25000; i++) ys.push(-0.45 + ((i % 100) / 100 - 0.5) * 0.02);
    const est = estimateFloor(ys, { below: -0.3 })!;
    expect(Math.abs(est.y - -1.2)).toBeLessThan(0.03);
  });

  test('is not fooled by sparse splats below the floor (reflections)', () => {
    const est = estimateFloor(roomHeights({ floor: -1.0, ceiling: 1.8, reflections: true }))!;
    expect(Math.abs(est.y - -1.0)).toBeLessThan(0.03);
  });

  test('flat horizontal splats can be weighted up', () => {
    const ys = roomHeights({ floor: -1.6, ceiling: 1.0, seed: 9 });
    const w = ys.map((y) => (Math.abs(y + 1.6) < 0.03 ? 3 : 1));
    const est = estimateFloor(ys, { weights: w, below: -0.3 })!;
    expect(Math.abs(est.y - -1.6)).toBeLessThan(0.03);
  });

  test('works without the camera prior (reconstructions)', () => {
    const est = estimateFloor(roomHeights({ floor: 0.2, ceiling: 2.9 }))!;
    expect(Math.abs(est.y - 0.2)).toBeLessThan(0.03);
  });

  test('a prior that excludes everything falls back to the general search', () => {
    // camera prior says "below 0.5" but the whole scene is below that: still finds the floor
    const est = estimateFloor(roomHeights({ floor: -3, ceiling: -0.5 }), { below: 0.5 })!;
    expect(Math.abs(est.y - -3)).toBeLessThan(0.03);
  });

  test('returns null for too few samples and handles a flat cloud', () => {
    expect(estimateFloor([1, 2, 3])).toBeNull();
    const flat = new Array(100).fill(0.7);
    expect(estimateFloor(flat)!.y).toBeCloseTo(0.7, 5);
  });
});

describe('statistics helpers', () => {
  test('quantileSorted interpolates', () => {
    const s = sortedFloat32([4, 1, 3, 2, 5]);
    expect(quantileSorted(s, 0)).toBe(1);
    expect(quantileSorted(s, 1)).toBe(5);
    expect(quantileSorted(s, 0.5)).toBe(3);
    expect(quantileSorted(s, 0.125)).toBeCloseTo(1.5, 6);
    expect(Number.isNaN(quantileSorted(new Float32Array(0), 0.5))).toBe(true);
  });

  test('robustBounds ignores far outliers', () => {
    const r = rng(5);
    const pts: number[] = [];
    for (let i = 0; i < 20000; i++) pts.push(r() * 4 - 2, r() * 3, r() * 6 - 4);
    for (let i = 0; i < 20; i++) pts.push(500, -300, 900);
    const b = robustBounds(pts, pts.length / 3, 0.01, 0.99)!;
    expect(b.min[0]).toBeGreaterThan(-2.1);
    expect(b.max[0]).toBeLessThan(2.1);
    expect(b.max[2]).toBeLessThan(2.1);
    expect(b.min[1]).toBeGreaterThan(-0.1);
  });

  test('box helpers', () => {
    const b = { min: [-1, 0, -1] as [number, number, number], max: [1, 2, 1] as [number, number, number] };
    expect(distanceOutside(b, 0, 1, 0)).toBe(0);
    expect(distanceOutside(b, 4, 1, 0)).toBeCloseTo(3, 6);
    expect(distanceOutside(b, 4, 6, 0)).toBeCloseTo(5, 6);
    expect(insideXZ(b, 0.5, -0.5)).toBe(true);
    expect(insideXZ(b, 1.5, 0)).toBe(false);
    const e = expandBounds(b, 0.5);
    expect(e.min).toEqual([-1.5, -0.5, -1.5]);
    expect(e.max).toEqual([1.5, 2.5, 1.5]);
  });
});

describe('sky palette', () => {
  test('hsl round trip', () => {
    for (const c of [[0.2, 0.4, 0.8], [0.9, 0.1, 0.1], [0.5, 0.5, 0.5]] as [number, number, number][]) {
      const [h, s, l] = rgbToHsl(c);
      const back = hslToRgb(h, s, l);
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(c[i], 5);
    }
  });

  test('muted gradient, never black, top darker than horizon', () => {
    const p = skyPalette([0.9, 0.6, 0.8], [0.7, 0.6, 0.5], [0.3, 0.25, 0.2]);
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(lum(p.horizon)).toBeGreaterThan(lum(p.top));
    expect(lum(p.top)).toBeGreaterThan(lum(p.bottom) - 0.05);
    for (const c of [p.top, p.horizon, p.bottom]) {
      expect(lum(c)).toBeGreaterThan(0.05);
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
