// Ghost motion: interpolation 0.32 s in the past, yaw the short way, brief extrapolation, stale
// fading, fade in/out, and "never teleports" with real 4 Hz sample streams.

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  CATCHUP_SPEED,
  GLIDE_SPEED,
  GhostLayer,
  INTERP_DELAY,
  MAX_EXTRAPOLATION,
  PoseTrack,
  headOf,
  lerpAngle,
  presenceAlpha,
  smoothInto,
  staleAlpha,
  wrapText,
  type PoseSample,
} from '../web/src/viewer/social/ghosts.ts';
import { ClockSync, type PresenceSnapshot } from '../web/src/viewer/social/presence-client.ts';

const S = (t: number, x: number, z = 0, yaw = 0): PoseSample => ({ t, x, y: 0, z, yaw, head: null, hands: null });

describe('lerpAngle', () => {
  test('goes the short way across the ±pi seam', () => {
    const mid = lerpAngle(3.0, -3.0, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.01);
    expect(lerpAngle(-0.2, 0.2, 0.5)).toBeCloseTo(0, 9);
    expect(lerpAngle(0, Math.PI / 2, 0.25)).toBeCloseTo(Math.PI / 8, 9);
  });
});

describe('PoseTrack', () => {
  test('interpolates between the bracketing samples', () => {
    const tr = new PoseTrack();
    tr.push(S(10, 0, 0, 0));
    tr.push(S(10.25, 1, 2, 1));
    tr.push(S(10.5, 2, 4, 2));
    const p = tr.at(10.375)!;
    expect(p.x).toBeCloseTo(1.5, 9);
    expect(p.z).toBeCloseTo(3, 9);
    expect(p.yaw).toBeCloseTo(1.5, 9);
    expect(tr.at(9)!.x).toBe(0);
  });

  test('extrapolates briefly with the last velocity, then holds', () => {
    const tr = new PoseTrack();
    tr.push(S(0, 0));
    tr.push(S(0.25, 1)); // 4 m/s
    const soon = tr.at(0.35)!;
    expect(soon.x).toBeGreaterThan(1);
    expect(soon.x).toBeLessThan(1 + 4 * 0.1 + 1e-9);
    const later = tr.at(5)!;
    const capped = tr.at(0.25 + MAX_EXTRAPOLATION)!;
    expect(later.x).toBeCloseTo(capped.x, 9);
    expect(later.x - 1).toBeLessThan(4 * MAX_EXTRAPOLATION);
  });

  test('duplicates and slightly late samples are dropped; a big jump back restarts', () => {
    const tr = new PoseTrack();
    expect(tr.push(S(5, 0))).toBe(true);
    expect(tr.push(S(5, 9))).toBe(false);
    expect(tr.push(S(4.9, 9))).toBe(false);
    expect(tr.samples.length).toBe(1);
    expect(tr.push(S(1, 3))).toBe(true);
    expect(tr.samples.length).toBe(1);
    expect(tr.newest!.x).toBe(3);
  });

  test('hands and heads interpolate when both ends have them', () => {
    const tr = new PoseTrack();
    tr.push({ ...S(0, 0), head: [0, 1.6, 0], hands: [[0, 1, 0], [1, 1, 0]] });
    tr.push({ ...S(1, 2), head: [2, 1.8, 0], hands: [[2, 1, 0], [3, 1, 0]] });
    const p = tr.at(0.5)!;
    expect(p.head![1]).toBeCloseTo(1.7, 9);
    expect(p.hands![1][0]).toBeCloseTo(2, 9);
  });
});

describe('fading', () => {
  test('stale people fade from 1 s and settle at 0.3 by 3 s', () => {
    expect(staleAlpha(0)).toBe(1);
    expect(staleAlpha(1)).toBe(1);
    expect(staleAlpha(2)).toBeGreaterThan(0.3);
    expect(staleAlpha(2)).toBeLessThan(1);
    expect(staleAlpha(3)).toBeCloseTo(0.3, 9);
    expect(staleAlpha(30)).toBeCloseTo(0.3, 9);
    expect(staleAlpha(NaN)).toBe(1);
  });

  test('presence alpha fades in and out smoothly', () => {
    expect(presenceAlpha(0, 0, null)).toBe(0);
    expect(presenceAlpha(10, 0, null)).toBe(1);
    expect(presenceAlpha(10.35, 0, 10)).toBeCloseTo(0.5, 6);
    expect(presenceAlpha(11, 0, 10)).toBe(0);
  });

  test('head defaults to feet + 1.6 m', () => {
    expect(headOf({ x: 1, y: 0.2, z: 3 })).toEqual([1, 1.8, 3]);
    expect(headOf({ x: 1, y: 0, z: 3, head: [1, 1.2, 3] })).toEqual([1, 1.2, 3]);
  });
});

/** Drives a GhostLayer with a person walking a circle at 4 Hz and records every displayed pose. */
function walk(opts: { seconds: number; jitter?: number; dropEvery?: number; speed?: number }) {
  const clock = new ClockSync();
  const layer = new GhostLayer(clock);
  layer.visuals = false;
  const viewer = new THREE.Vector3(0, 1.6, 0);
  const shown: Array<{ t: number; x: number; z: number; yaw: number }> = [];
  const truth = (t: number) => {
    const w = (opts.speed ?? 1.2) / 2; // 2 m radius
    return { x: 2 * Math.cos(w * t), z: 2 * Math.sin(w * t), yaw: Math.atan2(2 * w * Math.sin(w * t), -2 * w * Math.cos(w * t)) };
  };
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
  const serverStart = 1_760_000_000;
  let nextPost = 0;
  let k = 0;
  for (let local = 0; local <= opts.seconds; local += 1 / 72) {
    if (local >= nextPost) {
      nextPost += 0.25;
      k++;
      if (!opts.dropEvery || k % opts.dropEvery !== 0) {
        const tr = truth(local);
        // the reply reaches us a little later, with jitter
        const delay = 0.03 + (opts.jitter ?? 0) * rand();
        const snap: PresenceSnapshot = { t: serverStart + local + delay * 0.5, people: [{ id: 'rbx-1', name: 'shivin', kind: 'roblox', x: tr.x, y: 0, z: tr.z, yaw: tr.yaw, age: delay * 0.5 }] };
        layer.applySnapshot(snap, local + delay, local + delay);
      }
    }
    layer.update(1 / 72, viewer, local);
    const d = layer.displayPose('rbx-1');
    if (d) shown.push({ t: local, x: d.x, z: d.z, yaw: d.yaw });
  }
  return { layer, shown, truth };
}

describe('GhostLayer motion', () => {
  test('never teleports: per-frame steps stay near walking speed even with jitter and drops', () => {
    const { shown } = walk({ seconds: 8, jitter: 0.12, dropEvery: 5 });
    let worst = 0;
    for (let i = 1; i < shown.length; i++) worst = Math.max(worst, Math.hypot(shown[i].x - shown[i - 1].x, shown[i].z - shown[i - 1].z));
    // 1.2 m/s at 72 fps is 1.7 cm per frame; allow 3x for catch-up after a dropped sample
    expect(worst).toBeLessThan(0.05);
    let worstYaw = 0;
    for (let i = 1; i < shown.length; i++) worstYaw = Math.max(worstYaw, Math.abs(Math.atan2(Math.sin(shown[i].yaw - shown[i - 1].yaw), Math.cos(shown[i].yaw - shown[i - 1].yaw))));
    expect(worstYaw).toBeLessThan(0.1);
  });

  test('draws about INTERP_DELAY in the past and close to the true path', () => {
    const { shown, truth } = walk({ seconds: 6 });
    const late = shown.filter((s) => s.t > 2);
    let err = 0;
    for (const s of late) {
      const tr = truth(s.t - INTERP_DELAY);
      err = Math.max(err, Math.hypot(s.x - tr.x, s.z - tr.z));
    }
    expect(err).toBeLessThan(0.08);
  });

  test('leaving fades out and removes the person; coming back cancels the fade', () => {
    const clock = new ClockSync();
    const layer = new GhostLayer(clock);
    layer.visuals = false;
    const v = new THREE.Vector3();
    const snap = (t: number, ids: string[]): PresenceSnapshot => ({ t, people: ids.map((id) => ({ id, name: id, kind: 'web' as const, x: 1, y: 0, z: 1, yaw: 0, age: 0 })) });
    layer.applySnapshot(snap(100, ['web-a', 'web-b']), 0, 0);
    layer.update(0.016, v, 0.016);
    expect(layer.count).toBe(2);
    layer.applySnapshot(snap(100.25, ['web-a']), 0.25, 0.25);
    expect(layer.count).toBe(1);
    expect(layer.ids()).toContain('web-b'); // still fading
    layer.update(0.016, v, 0.6);
    layer.applySnapshot(snap(100.5, ['web-a', 'web-b']), 0.6, 0.6);
    expect(layer.count).toBe(2);
    layer.applySnapshot(snap(101, ['web-a']), 1.0, 1.0);
    layer.update(0.016, v, 3.0);
    expect(layer.ids()).toEqual(['web-a']);
    expect(layer.nameOf('web-b')).toBe('web-b');
    expect(layer.info('web-a')!.position.x).toBeCloseTo(1, 6);
  });

  test('after a stall on a jittery tunnel the ghost hurries back instead of lurching', () => {
    // posts every 120 to 380 ms, 15% lost, and a 700 ms stall now and then (a quick tunnel on venue Wi-Fi)
    const clock = new ClockSync();
    const layer = new GhostLayer(clock);
    layer.visuals = false;
    const v = new THREE.Vector3(0, 1.6, 0);
    const R = 1.2, speed = 1.35, w = speed / R;
    let rnd = 42;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
    let next = 0;
    let prev: { x: number; z: number } | null = null;
    let worst = 0;
    let longestGap = 0, lastPost = 0;
    for (let t = 0; t <= 30; t += 1 / 72) {
      if (t >= next) {
        next += 0.12 + 0.26 * rand() + (rand() < 0.04 ? 0.7 : 0);
        if (rand() > 0.15) {
          const lat = 0.04 + 0.08 * rand();
          layer.applySnapshot({ t: 1_760_000_000 + t + lat / 2, people: [{ id: 'rbx-1', name: 's', kind: 'roblox', x: R * Math.cos(w * t), y: 0, z: R * Math.sin(w * t), yaw: 0, age: 0 }] }, t + lat, t + lat);
          longestGap = Math.max(longestGap, t - lastPost);
          lastPost = t;
        }
      }
      layer.update(1 / 72, v, t);
      const d = layer.displayPose('rbx-1');
      if (d && prev && t > 2) worst = Math.max(worst, Math.hypot(d.x - prev.x, d.z - prev.z));
      if (d) prev = { x: d.x, z: d.z };
    }
    expect(longestGap).toBeGreaterThan(0.9); // the run really had stalls
    // at most the catch-up speed (4 m/s, 5.6 cm a frame at 72 fps), never the respawn glide (14 m/s, 19 cm)
    expect(worst).toBeLessThanOrEqual(CATCHUP_SPEED / 72 + 1e-6);
  });

  test('smoothing glides a far respawn instead of snapping', () => {
    const d = S(0, 0);
    smoothInto(d, S(0, 10), 1 / 72);
    expect(d.x).toBeGreaterThan(0);
    expect(d.x).toBeLessThanOrEqual(GLIDE_SPEED / 72 + 1e-9);
    for (let i = 0; i < 72; i++) smoothInto(d, S(0, 10), 1 / 72);
    expect(d.x).toBeCloseTo(10, 1);
  });
});

describe('wrapText', () => {
  const measure = (s: string) => s.length * 10;
  test('wraps at about 22 characters and never splits short words', () => {
    const lines = wrapText(measure, "Seb's seat. He was too scared to show up.", 1000, 22);
    expect(lines).toEqual(["Seb's seat. He was too", 'scared to show up.']);
  });
  test('splits over-long words and ellipsises past the line limit', () => {
    const lines = wrapText(measure, 'a'.repeat(50), 1000, 22, 2);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines.every((l) => l.length <= 23)).toBe(true);
  });
});
