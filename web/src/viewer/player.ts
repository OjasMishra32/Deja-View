// First-person walker for desktop and touch: damped velocity, collide-and-slide, step up,
// gravity, fly mode and the soft world boundary.

import type { Bounds } from './analysis.ts';
import { damp, DEFAULT_BODY, GRAVITY, groundHeight, slideMove, softBoundary, type Body, type GroundOptions, type P3 } from './physics.ts';
import type { CollisionWorld } from './voxels.ts';

export interface MoveInput {
  /** -1..1, forward positive. */
  forward: number;
  /** -1..1, right positive. */
  right: number;
  /** -1..1 (fly mode only), up positive. */
  up: number;
  run: boolean;
}

export const SPEED = { walk: 1.4, run: 3.0, fly: 2.2, flyRun: 5.5 };

export interface PlayerEnv {
  world: CollisionWorld;
  ground: GroundOptions;
  walkBounds: Bounds | null;
  margin: number;
}

/**
 * After a collision, turns the velocity along the direction actually travelled so it does not
 * build up against a wall. Never increases speed: dividing a push-out by a tiny frame time would
 * otherwise launch the walker.
 */
export function slideVelocity(vel: P3, mx: number, mz: number, dt: number): void {
  const ml = Math.hypot(mx, mz);
  const vl = Math.hypot(vel.x, vel.z);
  if (ml < 1e-6 || dt <= 0 || vl < 1e-6 || mx * vel.x + mz * vel.z <= 0) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const s = Math.min(vl, ml / dt);
  vel.x = (mx / ml) * s;
  vel.z = (mz / ml) * s;
}

export class Player {
  readonly pos: P3 = { x: 0, y: 0, z: 0 };
  readonly vel: P3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  fly = false;
  eyeHeight = 1.6;
  body: Body = { ...DEFAULT_BODY };
  /** Smoothed eye height above the world origin (steps feel soft, not jerky). */
  eyeY = 1.6;
  grounded = true;
  /** Last horizontal speed (m/s) actually travelled. */
  speed = 0;

  place(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.yaw = yaw;
    this.pitch = pitch;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.eyeY = y + this.eyeHeight;
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw -= dYaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dPitch));
  }

  setFly(fly: boolean): void {
    this.fly = fly;
    if (!fly) this.vel.y = 0;
  }

  update(dt: number, input: MoveInput, env: PlayerEnv): void {
    dt = Math.min(dt, 0.1);
    let f = input.forward, r = input.right;
    const m = Math.hypot(f, r);
    if (m > 1) {
      f /= m;
      r /= m;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const speed = this.fly ? (input.run ? SPEED.flyRun : SPEED.fly) : input.run ? SPEED.run : SPEED.walk;
    let tx: number, ty = 0, tz: number;
    if (this.fly) {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      tx = (-sy * cp * f + cy * r) * speed;
      tz = (-cy * cp * f - sy * r) * speed;
      ty = (sp * f + input.up) * speed;
    } else {
      tx = (-sy * f + cy * r) * speed;
      tz = (-cy * f - sy * r) * speed;
    }
    const active = m > 0.01 || (this.fly && Math.abs(input.up) > 0.01);
    const k = damp(active ? 9 : 12, dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;
    if (this.fly) this.vel.y += (ty - this.vel.y) * k;

    if (env.walkBounds) softBoundary(this.pos, this.vel, env.walkBounds, env.margin);

    const ox = this.pos.x, oz = this.pos.z;
    if (this.fly) {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vel.y * dt;
      if (env.walkBounds) {
        const lo = env.ground.floorY - 0.5, hi = env.walkBounds.max[1] + 1.5;
        this.pos.y = Math.min(hi, Math.max(lo, this.pos.y));
      }
      this.eyeY = this.pos.y + this.eyeHeight;
    } else {
      const blocked = slideMove(env.world, this.pos, this.vel.x * dt, this.vel.z * dt, this.body);
      if (blocked) slideVelocity(this.vel, this.pos.x - ox, this.pos.z - oz, dt);
      const g = groundHeight(env.world, this.pos.x, this.pos.z, this.pos.y, this.body, env.ground);
      if (g >= this.pos.y - 0.002) {
        this.pos.y = g;
        this.vel.y = 0;
        this.grounded = true;
      } else {
        this.vel.y -= GRAVITY * dt;
        this.pos.y += this.vel.y * dt;
        if (this.pos.y <= g) {
          this.pos.y = g;
          this.vel.y = 0;
          this.grounded = true;
        } else this.grounded = false;
      }
      const target = this.pos.y + this.eyeHeight;
      // rise smoothly on steps, follow falls directly
      this.eyeY = target > this.eyeY ? this.eyeY + (target - this.eyeY) * damp(14, dt) : target;
    }
    this.speed = dt > 0 ? Math.hypot(this.pos.x - ox, this.pos.z - oz) / dt : 0;
  }
}
