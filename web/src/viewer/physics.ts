// Walking physics against a CollisionWorld: collide-and-slide, step up, ground following,
// and a soft boundary. Pure logic; positions are feet positions in the viewer frame.

import type { Bounds } from './analysis.ts';
import type { CollisionWorld, Penetration } from './voxels.ts';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface Body {
  /** Horizontal radius of the body cylinder. */
  radius: number;
  /** Ledges up to this height are stepped onto; geometry below it never blocks. */
  step: number;
  /** Top of the body above the feet. */
  height: number;
}

export const DEFAULT_BODY: Body = { radius: 0.22, step: 0.3, height: 1.75 };

export const GRAVITY = 9.81;

/** A world with nothing in it: used before the collider is ready and in tests. */
export const EMPTY_WORLD: CollisionWorld = {
  groundAt: () => null,
  penetration: () => false,
  solidAt: () => false,
};

const scratch: Penetration = { x: 0, z: 0, depth: 0 };

/** Current penetration depth of the body at (x, z) with feet at y. */
export function overlapDepth(world: CollisionWorld, x: number, y: number, z: number, body: Body): number {
  return world.penetration(x, z, body.radius, y + body.step, y + body.height, scratch) ? scratch.depth : 0;
}

/**
 * Moves the feet position horizontally by (dx, dz), sliding along walls. The move is split into
 * sub-steps no longer than `maxSubstep` so thin (one voxel) walls are never skipped. A sub-step
 * is undone only if it leaves the body deeper inside geometry than it started, so a body that
 * starts inside clutter can always walk out of it.
 * Returns true when a collision changed the move.
 */
export function slideMove(world: CollisionWorld, pos: P3, dx: number, dz: number, body: Body, maxSubstep = 0.04): boolean {
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return false;
  const n = Math.max(1, Math.ceil(len / maxSubstep));
  const sx = dx / n, sz = dz / n;
  const y0 = pos.y + body.step, y1 = pos.y + body.height;
  const pen: Penetration = { x: 0, z: 0, depth: 0 };
  let blocked = false;
  for (let i = 0; i < n; i++) {
    const ox = pos.x, oz = pos.z;
    const before = world.penetration(ox, oz, body.radius, y0, y1, pen) ? pen.depth : 0;
    pos.x += sx;
    pos.z += sz;
    let pushed = false;
    for (let it = 0; it < 4; it++) {
      if (!world.penetration(pos.x, pos.z, body.radius, y0, y1, pen)) break;
      // never push further than the sub-step plus a little: deep overlaps are resolved over frames
      const d = Math.min(pen.depth, maxSubstep * 1.5) + 1e-4;
      pos.x += pen.x * d;
      pos.z += pen.z * d;
      pushed = true;
    }
    if (pushed) blocked = true;
    const after = world.penetration(pos.x, pos.z, body.radius, y0, y1, pen) ? pen.depth : 0;
    if (after > 0.005 && after > before + 1e-4) {
      pos.x = ox;
      pos.z = oz;
      blocked = true;
    }
  }
  return blocked;
}

export interface GroundOptions {
  /** Height of the estimated main floor (fallback ground everywhere). */
  floorY: number;
  /** Surfaces this close to the main floor snap onto it (removes splat noise). */
  snap: number;
  /** How far below the feet to look for ground. */
  maxDrop: number;
  /**
   * Highest walkable surface above the main floor. Generated rooms have one floor; without this
   * cap, lumpy furniture turns into stairs and the walker climbs sofas, beds and ceilings.
   */
  maxClimb: number;
}

export const DEFAULT_GROUND: GroundOptions = { floorY: 0, snap: 0.07, maxDrop: 4, maxClimb: 0.35 };

/**
 * Walkable height under (x, z) for feet at `feetY`: the highest surface no more than a step above
 * the feet. The main floor plane is the fallback, so holes in a generated floor never swallow the
 * player and the player never sinks below the floor.
 */
export function groundHeight(world: CollisionWorld, x: number, z: number, feetY: number, body: Body, g: GroundOptions = DEFAULT_GROUND): number {
  const top = Math.min(feetY + body.step, g.floorY + g.maxClimb);
  const found = world.groundAt(x, z, top, Math.min(top, feetY) - g.maxDrop);
  if (found === null) return g.floorY;
  if (found < g.floorY - 0.25) return g.floorY;
  if (Math.abs(found - g.floorY) < g.snap) return g.floorY;
  return found;
}

/**
 * Soft boundary: outward velocity fades to zero over `margin` beyond the inner box, and the
 * position is hard-limited at the box plus margin. Mutates pos and vel (xz only).
 */
export function softBoundary(pos: P3, vel: P3, inner: Bounds, margin: number): void {
  const axes: Array<[keyof P3, number]> = [['x', 0], ['z', 2]];
  for (const [k, i] of axes) {
    const lo = inner.min[i], hi = inner.max[i];
    if (pos[k] > hi) {
      const t = Math.min(1, (pos[k] - hi) / margin);
      if (vel[k] > 0) vel[k] *= (1 - t) * (1 - t);
      if (pos[k] > hi + margin) pos[k] = hi + margin;
    } else if (pos[k] < lo) {
      const t = Math.min(1, (lo - pos[k]) / margin);
      if (vel[k] < 0) vel[k] *= (1 - t) * (1 - t);
      if (pos[k] < lo - margin) pos[k] = lo - margin;
    }
  }
}

/** Limits a horizontal move so the result stays within the box plus margin. */
export function clampToBoundary(pos: P3, inner: Bounds, margin: number): void {
  pos.x = Math.min(inner.max[0] + margin, Math.max(inner.min[0] - margin, pos.x));
  pos.z = Math.min(inner.max[2] + margin, Math.max(inner.min[2] - margin, pos.z));
}

/**
 * Searches outward from (x, z) for a spot where the body is free and returns it (feet on the
 * ground there), with `found` false when nothing within maxRadius is free. Used to make sure the
 * spawn is never inside geometry.
 */
export function findFreeSpot(
  world: CollisionWorld,
  x: number,
  z: number,
  feetY: number,
  body: Body,
  g: GroundOptions = DEFAULT_GROUND,
  maxRadius = 2.5,
  step = body.step,
  /** Optional facing direction (xz): spots behind it cost extra distance. */
  prefer?: { x: number; z: number },
  /** Optional extra test a spot must pass (e.g. a clear view of something). */
  accept?: (p: P3) => boolean,
): P3 & { found: boolean } {
  const probe: Body = { ...body, step };
  const tryAt = (px: number, pz: number): P3 | null => {
    const y = groundHeight(world, px, pz, feetY, probe, g);
    if (overlapDepth(world, px, y, pz, body) > 0.001) return null;
    const p = { x: px, y, z: pz };
    return !accept || accept(p) ? p : null;
  };
  const here = tryAt(x, z);
  if (here) return { ...here, found: true };
  let best: P3 | null = null;
  let bestScore = Infinity;
  for (let r = 0.1; r <= maxRadius + 1e-9; r += 0.1) {
    if (best && r > bestScore) break; // no farther ring can score better
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.1));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const dx = Math.cos(a) * r, dz = Math.sin(a) * r;
      const behind = prefer ? Math.max(0, -(dx * prefer.x + dz * prefer.z)) : 0;
      const score = r + 1.5 * behind;
      if (score >= bestScore) continue;
      const p = tryAt(x + dx, z + dz);
      if (p) {
        best = p;
        bestScore = score;
        if (!prefer) return { ...p, found: true };
      }
    }
  }
  if (best) return { ...best, found: true };
  return { x, y: groundHeight(world, x, z, feetY, probe, g), z, found: false };
}

/**
 * True when the segment a-b crosses no solid cells, ignoring the last `skipEnd` metres before b
 * (the target itself may be solid, e.g. a person standing at a counter).
 */
export function lineOfSight(world: CollisionWorld, a: P3, b: P3, skipEnd = 0.3, step = 0.05): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.floor(Math.max(0, len - skipEnd) / step);
  for (let i = 1; i <= n; i++) {
    const t = (i * step) / len;
    if (world.solidAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

/** Exponential smoothing factor for rate `k` (1/s) over `dt` seconds. */
export function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}
