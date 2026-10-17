// Headset helpers: frame rate choice, eye-level matching and the frame-rate governor.

import { describe, expect, test } from 'bun:test';
import { FrameGovernor, XR_LEVELS } from '../web/src/viewer/perf.ts';
import { eyeLevelOffset, pickFrameRate } from '../web/src/viewer/xr.ts';

describe('frame rate', () => {
  test('72 Hz when the headset offers it', () => {
    expect(pickFrameRate([72, 80, 90, 120])).toBe(72);
    expect(pickFrameRate(new Float32Array([90, 72]))).toBe(72);
  });
  test('else the highest rate up to 90 Hz, and nothing when no list is given', () => {
    expect(pickFrameRate([60, 90, 120])).toBe(90);
    expect(pickFrameRate([120, 144])).toBe(null);
    expect(pickFrameRate(null)).toBe(null);
  });
});

describe('eye-level matching', () => {
  test('a standing wearer is lowered to the camera height', () => {
    expect(eyeLevelOffset(1.6, 1.25)).toBeCloseTo(-0.35, 9);
  });
  test('a seated wearer is lifted a little, never more than 30 cm', () => {
    expect(eyeLevelOffset(1.15, 1.25)).toBeCloseTo(0.1, 9);
    expect(eyeLevelOffset(0.8, 1.6)).toBeCloseTo(0.3, 9);
  });
  test('no offset without a wanted level or without a real head pose', () => {
    expect(eyeLevelOffset(1.7, null)).toBe(0);
    expect(eyeLevelOffset(0, 1.25)).toBe(0);
    expect(eyeLevelOffset(Number.NaN, 1.25)).toBe(0);
  });
});

describe('frame governor', () => {
  const budget = 1000 / 72;
  /** Feeds `seconds` of frames, every `dropEvery`-th one twice as long (a dropped frame). */
  const feed = (g: FrameGovernor, seconds: number, dropEvery: number) => {
    const changes: number[] = [];
    let t = 0;
    for (let i = 0; t < seconds * 1000; i++) {
      const ms = dropEvery > 0 && i % dropEvery === 0 ? budget * 2 : budget;
      t += ms;
      const c = g.push(ms, budget);
      if (c !== null) changes.push(c);
    }
    return changes;
  };

  test('levels get cheaper step by step', () => {
    for (let i = 1; i < XR_LEVELS.length; i++) {
      expect(XR_LEVELS[i].maxStdDev).toBeLessThan(XR_LEVELS[i - 1].maxStdDev);
      expect(XR_LEVELS[i].maxPixelRadius).toBeLessThan(XR_LEVELS[i - 1].maxPixelRadius);
    }
  });

  test('a steady frame rate keeps the best level', () => {
    const g = new FrameGovernor({ levels: XR_LEVELS.length });
    expect(feed(g, 20, 0)).toEqual([]);
    expect(g.level).toBe(0);
  });

  test('dropping every third frame steps down until the last level', () => {
    const g = new FrameGovernor({ levels: XR_LEVELS.length });
    const changes = feed(g, 10, 3);
    expect(changes).toEqual([1, 2, 3]);
    expect(g.level).toBe(3);
  });

  test('recovers after a calm stretch, but not to a level that failed twice', () => {
    const g = new FrameGovernor({ levels: 4, recoverAfter: 4 });
    expect(feed(g, 1.6, 3)).toEqual([1]); // 0 -> 1
    expect(feed(g, 6, 0)).toEqual([0]); // calm: back to 0
    g.reset();
    expect(feed(g, 1.6, 3)).toEqual([1]); // fails again: second failure of level 0
    expect(g.level).toBe(1);
    expect(feed(g, 20, 0)).toEqual([]); // never retries level 0
    expect(g.level).toBe(1);
  });

  test('a long stall (paused session) is ignored', () => {
    const g = new FrameGovernor({ levels: 4 });
    for (let i = 0; i < 20; i++) expect(g.push(5000, budget)).toBe(null);
    expect(g.level).toBe(0);
  });
});
