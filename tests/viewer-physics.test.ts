import { describe, expect, test } from 'bun:test';
import type { Bounds } from '../web/src/viewer/analysis.ts';
import {
  clampToBoundary,
  DEFAULT_BODY,
  DEFAULT_GROUND,
  EMPTY_WORLD,
  findFreeSpot,
  groundHeight,
  overlapDepth,
  slideMove,
  softBoundary,
  type P3,
} from '../web/src/viewer/physics.ts';
import { Player, SPEED, slideVelocity } from '../web/src/viewer/player.ts';
import { DEFAULT_ARC, landingValid, traceArc, type LandingRules } from '../web/src/viewer/teleport.ts';
import { autoMinCount, cellKey, VoxelGrid } from '../web/src/viewer/voxels.ts';

// ---------- synthetic splat-centre clouds ----------

function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Pts = number[];

function slab(out: Pts, x0: number, x1: number, z0: number, z1: number, y: number, step = 0.03): Pts {
  const r = rng(Math.round((x0 + 7) * 1000 + y * 100));
  for (let x = x0; x <= x1 + 1e-9; x += step) for (let z = z0; z <= z1 + 1e-9; z += step) out.push(x + (r() - 0.5) * step * 0.5, y + (r() - 0.5) * 0.01, z + (r() - 0.5) * step * 0.5);
  return out;
}

function wall(out: Pts, axis: 'x' | 'z', at: number, a0: number, a1: number, y0: number, y1: number, step = 0.03): Pts {
  for (let a = a0; a <= a1 + 1e-9; a += step)
    for (let y = y0; y <= y1 + 1e-9; y += step) {
      if (axis === 'x') out.push(at, y, a);
      else out.push(a, y, at);
    }
  return out;
}

/** Box room 6 x 6 m, floor at 0, walls at x = +-3 and z = +-3, ceiling 2.6. */
function room(): Pts {
  const p: Pts = [];
  slab(p, -3, 3, -3, 3, -0.02);
  slab(p, -3, 3, -3, 3, 2.6, 0.05);
  wall(p, 'x', -3, -3, 3, 0, 2.6);
  wall(p, 'x', 3, -3, 3, 0, 2.6);
  wall(p, 'z', -3, -3, 3, 0, 2.6);
  wall(p, 'z', 3, -3, 3, 0, 2.6);
  return p;
}

function gridFrom(points: Pts, minCount = 2): VoxelGrid {
  const g = new VoxelGrid(0.1);
  g.addPoints(points);
  g.finalize(minCount);
  return g;
}

const BOUNDS: Bounds = { min: [-3, 0, -3], max: [3, 2.6, 3] };

// ---------- voxel grid ----------

describe('VoxelGrid', () => {
  test('cell keys are unique and round-trip through forEachOccupied', () => {
    const keys = new Set<number>();
    for (const [x, y, z] of [[0, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [1000, -2000, 3000], [-32768, 32767, 5]])
      keys.add(cellKey(x, y, z));
    expect(keys.size).toBe(6);
    const g = new VoxelGrid(0.1);
    for (let i = 0; i < 3; i++) g.add(-0.25, 1.05, 3.31);
    g.finalize(1);
    const seen: number[][] = [];
    g.forEachOccupied((x, y, z) => seen.push([x, y, z]));
    expect(seen).toEqual([[-3, 10, 33]]);
  });

  test('floaters below the count threshold are ignored', () => {
    const p = slab([], 0, 1, 0, 1, -0.05, 0.02); // ~25 splats per 10 cm cell, like real surfaces
    p.push(0.5, 1.2, 0.5); // a single stray splat
    const g = gridFrom(p, 0);
    expect(g.stats().minCount).toBeGreaterThanOrEqual(2);
    expect(g.solidAt(0.5, 1.2, 0.5)).toBe(false);
    expect(g.solidAt(0.5, -0.05, 0.5)).toBe(true);
  });

  test('autoMinCount scales with density', () => {
    const sparse = new Map<number, number>([[1, 1], [2, 1], [3, 2]]);
    const dense = new Map<number, number>();
    for (let i = 0; i < 1000; i++) dense.set(i, 40);
    expect(autoMinCount(sparse)).toBe(1);
    expect(autoMinCount(dense)).toBe(4);
  });

  test('groundAt returns the mean surface height and respects limits', () => {
    const g = gridFrom(room());
    const y = g.groundAt(0, 0, 0.3, -2)!;
    expect(Math.abs(y - -0.02)).toBeLessThan(0.01);
    expect(g.groundAt(0, 0, -0.5, -2)).toBeNull();
    // the ceiling is not ground when searching from below it
    expect(g.groundAt(0, 0, 2.0, -1)).toBeCloseTo(y, 5);
  });

  test('ground needs headroom: a cell with solid right above it is not walkable', () => {
    const p = slab([], 0, 1, 0, 1, 0);
    slab(p, 0, 1, 0, 1, 0.5); // a shelf 0.5 m above
    const g = gridFrom(p);
    expect(g.groundAt(0.5, 0.5, 0.2, -1)).toBeNull();
    expect(g.groundAt(0.5, 0.5, 0.7, -1)).toBeCloseTo(0.5, 1);
  });

  test('penetration pushes away from a wall', () => {
    const g = gridFrom(room());
    const pen = { x: 0, z: 0, depth: 0 };
    expect(g.penetration(0, 0, 0.22, 0.3, 1.75, pen)).toBe(false);
    expect(g.penetration(2.9, 0, 0.22, 0.3, 1.75, pen)).toBe(true);
    expect(pen.x).toBeLessThan(-0.9);
    expect(pen.depth).toBeGreaterThan(0);
  });

  test('clearCylinder removes cells inside the cylinder only', () => {
    const p = wall([], 'x', 0.1, -1, 1, 0, 2);
    const g = gridFrom(p);
    expect(g.solidAt(0.1, 1, 0)).toBe(true);
    const removed = g.clearCylinder(0, 0, 0.3, 0.3, 2);
    expect(removed).toBeGreaterThan(0);
    expect(g.solidAt(0.1, 1, 0)).toBe(false);
    expect(g.solidAt(0.1, 1, 0.8)).toBe(true);
    expect(g.solidAt(0.1, 0.15, 0)).toBe(true);
  });
});

// ---------- collide and slide ----------

describe('slideMove', () => {
  const g = gridFrom(room());

  test('walking into a wall stops in front of it', () => {
    const pos: P3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) slideMove(g, pos, 0.05, 0, DEFAULT_BODY);
    expect(pos.x).toBeLessThan(3 - DEFAULT_BODY.radius + 0.02);
    expect(pos.x).toBeGreaterThan(2.5);
    expect(overlapDepth(g, pos.x, pos.y, pos.z, DEFAULT_BODY)).toBeLessThan(0.01);
  });

  test('a big step never tunnels through a one-voxel wall', () => {
    const p = slab([], -2, 2, -2, 2, -0.02);
    wall(p, 'x', 0.55, -2, 2, 0, 2.4);
    const thin = gridFrom(p);
    const pos: P3 = { x: 0, y: 0, z: 0 };
    slideMove(thin, pos, 2.0, 0, DEFAULT_BODY);
    expect(pos.x).toBeLessThan(0.55);
  });

  test('diagonal motion slides along the wall', () => {
    const pos: P3 = { x: 2.6, y: 0, z: 0 };
    const blocked = slideMove(g, pos, 0.5, -0.5, DEFAULT_BODY);
    expect(blocked).toBe(true);
    expect(pos.z).toBeLessThan(-0.45);
    expect(pos.x).toBeLessThan(2.8);
  });

  test('a body that starts inside clutter can walk out of it', () => {
    const p = slab([], -2, 2, -2, 2, -0.02);
    // a dense blob around the start position
    for (let x = -0.15; x <= 0.15; x += 0.02) for (let y = 0.4; y <= 1.6; y += 0.05) p.push(x, y, 0.05);
    const cl = gridFrom(p);
    const pos: P3 = { x: 0, y: 0, z: 0 };
    expect(overlapDepth(cl, 0, 0, 0, DEFAULT_BODY)).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) slideMove(cl, pos, 0, -0.03, DEFAULT_BODY);
    expect(pos.z).toBeLessThan(-0.5);
  });

  test('no collisions in an empty world', () => {
    const pos: P3 = { x: 0, y: 0, z: 0 };
    expect(slideMove(EMPTY_WORLD, pos, 1, 2, DEFAULT_BODY)).toBe(false);
    expect(pos.x).toBeCloseTo(1, 9);
    expect(pos.z).toBeCloseTo(2, 9);
    expect(pos.y).toBe(0);
  });
});

describe('ground following', () => {
  test('snaps to the main floor, steps up small ledges, refuses tall ones', () => {
    const p = slab([], -3, 3, -3, 3, -0.02);
    slab(p, 1, 2, -1, 1, 0.2); // a 20 cm platform
    slab(p, -2, -1, -1, 1, 0.55); // a 55 cm bed top
    const g = gridFrom(p);
    expect(groundHeight(g, 0, 0, 0, DEFAULT_BODY)).toBe(0);
    expect(groundHeight(g, 1.5, 0, 0, DEFAULT_BODY)).toBeCloseTo(0.2, 1);
    // standing next to the bed the floor is the ground, the bed top is out of reach
    expect(groundHeight(g, -1.5, 0, 0, DEFAULT_BODY)).toBeLessThan(0.05);
  });

  test('holes in the floor fall back to the floor plane, never below it', () => {
    const g = gridFrom(slab([], 2, 3, 2, 3, 0)); // floor only in one corner
    expect(groundHeight(g, 0, 0, 0, DEFAULT_BODY)).toBe(0);
    expect(groundHeight(g, 0, 0, -3, DEFAULT_BODY)).toBe(0);
  });

  test('surfaces above the climb cap are never ground, even from above (no walking on ceilings)', () => {
    const p = slab([], -2, 2, -2, 2, -0.02);
    slab(p, -2, 2, -2, 2, 2.5);
    const g = gridFrom(p);
    expect(groundHeight(g, 0, 0, 2.4, DEFAULT_BODY)).toBe(0);
    expect(groundHeight(g, 0, 0, 2.6, DEFAULT_BODY, { ...DEFAULT_GROUND, maxClimb: 0.35 })).toBe(0);
  });

  test('findFreeSpot moves the spawn out of geometry', () => {
    const p = slab([], -3, 3, -3, 3, -0.02);
    for (let x = -0.3; x <= 0.3; x += 0.03) for (let z = -0.3; z <= 0.3; z += 0.03) for (let y = 0.4; y < 1.8; y += 0.1) p.push(x, y, z);
    const g = gridFrom(p);
    expect(overlapDepth(g, 0, 0, 0, DEFAULT_BODY)).toBeGreaterThan(0);
    const s = findFreeSpot(g, 0, 0, 0, DEFAULT_BODY);
    expect(overlapDepth(g, s.x, s.y, s.z, DEFAULT_BODY)).toBe(0);
    expect(Math.hypot(s.x, s.z)).toBeLessThan(1);
  });
});

describe('boundary', () => {
  test('outward velocity fades and position is capped', () => {
    const pos: P3 = { x: 3.2, y: 0, z: 0 };
    const vel: P3 = { x: 1, y: 0, z: 1 };
    softBoundary(pos, vel, BOUNDS, 0.5);
    expect(vel.x).toBeLessThan(0.5);
    expect(vel.z).toBe(1);
    const far: P3 = { x: 9, y: 0, z: -9 };
    softBoundary(far, { x: 0, y: 0, z: 0 }, BOUNDS, 0.5);
    expect(far.x).toBe(3.5);
    expect(far.z).toBe(-3.5);
    const c: P3 = { x: -7, y: 0, z: 1 };
    clampToBoundary(c, BOUNDS, 1);
    expect(c.x).toBe(-4);
  });
});

// ---------- walker ----------

describe('Player', () => {
  const g = gridFrom(room());
  const env = { world: g, ground: DEFAULT_GROUND, walkBounds: BOUNDS, margin: 0.5 };

  test('walks at about 1.4 m/s and runs at about 3 m/s', () => {
    for (const [run, speed] of [[false, SPEED.walk], [true, SPEED.run]] as const) {
      const p = new Player();
      p.place(-2, 0, 0, -Math.PI / 2); // facing +X
      for (let i = 0; i < 60; i++) p.update(1 / 60, { forward: 1, right: 0, up: 0, run }, env);
      const x0 = p.pos.x;
      for (let i = 0; i < 30; i++) p.update(1 / 60, { forward: 1, right: 0, up: 0, run }, env);
      const v = (p.pos.x - x0) / 0.5;
      expect(Math.abs(v - speed)).toBeLessThan(0.1);
      expect(Math.abs(p.pos.z)).toBeLessThan(1e-6);
    }
  });

  test('look direction: yaw 0 walks toward -Z, right strafes +X', () => {
    const p = new Player();
    p.place(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) p.update(1 / 60, { forward: 1, right: 0, up: 0, run: false }, env);
    expect(p.pos.z).toBeLessThan(-0.2);
    p.place(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) p.update(1 / 60, { forward: 0, right: 1, up: 0, run: false }, env);
    expect(p.pos.x).toBeGreaterThan(0.2);
  });

  test('uneven frame times never launch the walker off a wall (regression)', () => {
    const p = new Player();
    p.place(2.0, 0, 0.3, -Math.PI / 2 + 0.6);
    const dts = [0.1, 0.001, 0.016, 0.1, 0.001, 0.002, 0.05, 0.001];
    let maxStep = 0;
    for (let k = 0; k < 40; k++) {
      const x = p.pos.x, z = p.pos.z;
      p.update(dts[k % dts.length], { forward: 1, right: 0, up: 0, run: true }, env);
      maxStep = Math.max(maxStep, Math.hypot(p.pos.x - x, p.pos.z - z));
    }
    expect(maxStep).toBeLessThan(SPEED.run * 0.1 + 0.05);
  });

  test('slideVelocity never increases speed', () => {
    const v: P3 = { x: 1, y: 0, z: 0 };
    slideVelocity(v, 0.05, 0.05, 0.001); // a push-out over a tiny frame
    expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(1 + 1e-9);
    const back: P3 = { x: 1, y: 0, z: 0 };
    slideVelocity(back, -0.01, 0, 0.016);
    expect(back.x).toBe(0);
  });

  test('falls with gravity onto the floor; fly mode ignores walls', () => {
    const p = new Player();
    p.place(0, 1.5, 0, 0);
    for (let i = 0; i < 120; i++) p.update(1 / 60, { forward: 0, right: 0, up: 0, run: false }, env);
    expect(p.pos.y).toBe(0);
    p.setFly(true);
    p.place(2.5, 1, 0, -Math.PI / 2);
    p.setFly(true);
    for (let i = 0; i < 60; i++) p.update(1 / 60, { forward: 1, right: 0, up: 0, run: false }, env);
    expect(p.pos.x).toBeGreaterThan(3); // passed through the wall into the boundary margin
    expect(p.pos.x).toBeLessThanOrEqual(3.5);
  });
});

// ---------- teleport ----------

describe('teleport arc', () => {
  const g = gridFrom(room());
  const rules: LandingRules = { body: DEFAULT_BODY, ground: DEFAULT_GROUND, bounds: BOUNDS, maxRise: 1.2, flatTolerance: 0.18, maxDistance: 9 };
  const from: P3 = { x: 0, y: 0, z: 2 };

  test('lands on open floor and is valid', () => {
    const r = traceArc(g, { x: 0, y: 1.2, z: 2 }, { x: 0, y: -0.25, z: -1 }, from, rules);
    expect(r.valid).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.end!.y).toBe(0);
    expect(r.end!.z).toBeLessThan(1);
    expect(r.end!.z).toBeGreaterThan(-2.8);
    expect(r.points.length).toBeGreaterThan(9);
  });

  test('aiming at a wall is invalid', () => {
    const r = traceArc(g, { x: 0, y: 1.2, z: 2 }, { x: 0, y: 0.5, z: -1 }, from, rules);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('wall');
  });

  test('pointing up into the open never lands', () => {
    const r = traceArc(EMPTY_WORLD, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { ...rules, bounds: undefined }, { ...DEFAULT_ARC, maxSteps: 20 });
    expect(r.end).toBeNull();
    expect(r.valid).toBe(false);
  });

  test('landing rules: outside bounds, too far, blocked, uneven', () => {
    expect(landingValid(EMPTY_WORLD, 5, 0, 0, { x: 0, y: 0, z: 0 }, rules)).toBe('outside');
    expect(landingValid(EMPTY_WORLD, 2.5, 0, 2.5, { x: -6, y: 0, z: -6 }, { ...rules, bounds: undefined, maxDistance: 5 })).toBe('too-far');
    expect(landingValid(g, 2.95, 0, 0, from, rules)).toBe('blocked');
    const p = slab([], -3, 3, -3, 3, -0.02);
    slab(p, 0, 1, -1, 1, 0.25); // a 25 cm platform, edge at x = 0
    const steps = gridFrom(p);
    // on the floor right at the platform edge: part of the footprint is 25 cm higher
    expect(landingValid(steps, -0.1, 0, 0, from, rules)).toBe('uneven');
    const top = groundHeight(steps, 0.6, 0, 0.3, DEFAULT_BODY);
    expect(landingValid(steps, 0.6, top, 0, from, rules)).toBe('ok');
    expect(landingValid(steps, 0.6, top, 0, from, { ...rules, maxRise: 0.2 })).toBe('too-high');
  });
});
