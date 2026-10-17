// Parabolic teleport arc and landing validity. Pure logic.

import { insideXZ, type Bounds } from './analysis.ts';
import { groundHeight, overlapDepth, type Body, type GroundOptions, type P3 } from './physics.ts';
import type { CollisionWorld } from './voxels.ts';

export interface ArcOptions {
  /** Launch speed in m/s along the controller direction. */
  speed: number;
  gravity: number;
  /** Integration step in seconds. */
  dt: number;
  maxSteps: number;
  /** Spatial sampling of each step against the world (metres). */
  sample: number;
}

export const DEFAULT_ARC: ArcOptions = { speed: 7.5, gravity: 9.81, dt: 0.025, maxSteps: 90, sample: 0.05 };

export interface LandingRules {
  body: Body;
  ground: GroundOptions;
  /** Allowed bounds for the landing point (xz). */
  bounds?: Bounds;
  /** Max height of the landing above the current feet. */
  maxRise: number;
  /** Max height difference across the landing footprint. */
  flatTolerance: number;
  /** Max horizontal teleport distance. */
  maxDistance: number;
}

export type TeleportReason = 'ok' | 'none' | 'wall' | 'blocked' | 'uneven' | 'outside' | 'too-high' | 'too-far';

export interface ArcResult {
  /** Arc points as xyz triples, ending at the hit point. */
  points: number[];
  /** Where the arc ends (landing or hit), null when it never reached anything. */
  end: P3 | null;
  valid: boolean;
  reason: TeleportReason;
}

/** Checks whether a body can stand at (x, y, z). */
export function landingValid(world: CollisionWorld, x: number, y: number, z: number, from: P3, rules: LandingRules): TeleportReason {
  if (rules.bounds && !insideXZ(rules.bounds, x, z)) return 'outside';
  if (Math.hypot(x - from.x, z - from.z) > rules.maxDistance) return 'too-far';
  if (y - from.y > rules.maxRise) return 'too-high';
  if (overlapDepth(world, x, y, z, rules.body) > 0.01) return 'blocked';
  const r = rules.body.radius;
  const offsets = [[r, 0], [-r, 0], [0, r], [0, -r]];
  for (const [ox, oz] of offsets) {
    const g = groundHeight(world, x + ox, z + oz, y + 0.1, rules.body, rules.ground);
    if (Math.abs(g - y) > rules.flatTolerance) return 'uneven';
  }
  return 'ok';
}

/**
 * Integrates a ballistic arc from `origin` along `dir` and finds where it lands: the first solid
 * cell it enters (a floor if there is walkable ground right there, a wall otherwise) or the main
 * floor plane.
 */
export function traceArc(world: CollisionWorld, origin: P3, dir: P3, from: P3, rules: LandingRules, opts: ArcOptions = DEFAULT_ARC): ArcResult {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  let vx = (dir.x / len) * opts.speed, vy = (dir.y / len) * opts.speed, vz = (dir.z / len) * opts.speed;
  let px = origin.x, py = origin.y, pz = origin.z;
  const points: number[] = [px, py, pz];
  const floorY = rules.ground.floorY;

  for (let s = 0; s < opts.maxSteps; s++) {
    const nx = px + vx * opts.dt;
    const ny = py + vy * opts.dt - 0.5 * opts.gravity * opts.dt * opts.dt;
    const nz = pz + vz * opts.dt;
    vy -= opts.gravity * opts.dt;
    const segLen = Math.hypot(nx - px, ny - py, nz - pz);
    const sub = Math.max(1, Math.ceil(segLen / opts.sample));
    for (let k = 1; k <= sub; k++) {
      const t = k / sub;
      const qx = px + (nx - px) * t, qy = py + (ny - py) * t, qz = pz + (nz - pz) * t;
      const descending = vy < 0;
      if (world.solidAt(qx, qy, qz)) {
        const g = world.groundAt(qx, qz, qy + 0.15, qy - 0.35);
        if (g !== null && descending) {
          const y = groundHeight(world, qx, qz, g + 0.05, rules.body, rules.ground);
          points.push(qx, y, qz);
          const reason = landingValid(world, qx, y, qz, from, rules);
          return { points, end: { x: qx, y, z: qz }, valid: reason === 'ok', reason };
        }
        points.push(qx, qy, qz);
        return { points, end: { x: qx, y: qy, z: qz }, valid: false, reason: 'wall' };
      }
      if (qy <= floorY && descending) {
        points.push(qx, floorY, qz);
        const reason = landingValid(world, qx, floorY, qz, from, rules);
        return { points, end: { x: qx, y: floorY, z: qz }, valid: reason === 'ok', reason };
      }
    }
    px = nx;
    py = ny;
    pz = nz;
    points.push(px, py, pz);
  }
  return { points, end: null, valid: false, reason: 'none' };
}
