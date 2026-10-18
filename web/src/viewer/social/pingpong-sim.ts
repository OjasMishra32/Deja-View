// The Roblox ping pong physics (roblox/src/shared/PingPongSim.luau), step for step, so the headset flies the ball
// exactly as the Roblox server and its players do. Everything is in the table frame: long axis Z, net at z = 0,
// table top at y = 0, studs. Keep the two files in step: tests/pingpong-sim.test.ts checks this one.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const len3 = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const lerp = (a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const ZERO = v3(0, 0, 0);

export const SIM = {
  LEN: 9.78,
  WID: 5.44,
  TOP_Y: 0,
  NET_H: 0.54,
  NET_L: 6.53,
  BALL_R: 0.15,
  GRAVITY: 35.0,
  MAX_SPEED: 107,
  REST_TABLE: 0.88,
  DRAG: 0.02,
  DEAD_Y: -2.5,
  DEAD_AFTER: 1.5,
  REAL_R: 0.071,
  MAGNUS: 0.0012,
  SPIN_DECAY: 0.25,
  GRIP: 0.45,
  MAX_SPIN: 900,
  BOUNCE_KICK: 0.4,
} as const;

export interface BallState {
  p: V3;
  v: V3;
  w: V3;
  t: number;
  live: boolean;
  lastTouch: number;
  bounces: number;
  lastBounceAt: number;
}

export interface StepEvent {
  table?: 'A' | 'B';
  net?: boolean;
  dead?: boolean;
}

export function newState(p: V3, v: V3, t: number, w: V3 = ZERO): BallState {
  return { p, v, w, t, live: true, lastTouch: t, bounces: 0, lastBounceAt: -1 };
}

export function overTable(p: V3, len: number, wid: number): boolean {
  return Math.abs(p.x) <= wid / 2 && Math.abs(p.z) <= len / 2;
}

/** One step of the ball (Sim.step): moves it and reports what it touched; the caller decides points. */
export function step(st: BallState, dt: number, len: number, wid: number): StepEvent {
  const ev: StepEvent = {};
  if (!st.live) return ev;
  let p = st.p;
  let v = st.v;
  let w = st.w ?? ZERO;
  const p0 = p;
  v = add(v, v3(0, -SIM.GRAVITY * dt, 0));
  v = sub(v, mul(v, SIM.DRAG * len3(v) * dt));
  if (len3(w) > 1e-3) {
    v = add(v, mul(cross(w, v), SIM.MAGNUS * dt));
    w = mul(w, Math.max(0, 1 - SIM.SPIN_DECAY * dt));
  }
  p = add(p, mul(v, dt));

  if (v.y < 0 && p.y - SIM.BALL_R <= SIM.TOP_Y + 0.06 && p0.y - SIM.BALL_R > SIM.TOP_Y - 0.06) {
    const a = (p0.y - SIM.BALL_R - SIM.TOP_Y) / Math.max(1e-6, p0.y - SIM.BALL_R - (p.y - SIM.BALL_R));
    const hit = lerp(p0, p, clamp(a, 0, 1));
    if (overTable(hit, len, wid)) {
      p = v3(hit.x, SIM.TOP_Y + SIM.BALL_R, hit.z);
      v = v3(v.x * 0.95, -v.y * SIM.REST_TABLE, v.z * 0.95);
      if (len3(w) > 1e-3) {
        const slip = cross(w, v3(0, -SIM.REAL_R, 0));
        v = sub(v, mul(v3(slip.x, 0, slip.z), SIM.BOUNCE_KICK));
        w = mul(w, 0.55);
      }
      st.bounces += 1;
      if (st.t - (st.lastBounceAt ?? -1) > 0.12) {
        st.lastBounceAt = st.t;
        ev.table = hit.z < 0 ? 'A' : 'B';
      }
    }
  }

  const crossed = (p0.z < 0 && p.z >= 0) || (p0.z > 0 && p.z <= 0);
  if (crossed && Math.abs(p.x) <= SIM.NET_L / 2 && p.y - SIM.BALL_R < SIM.NET_H) {
    const a = (0 - p0.z) / Math.max(1e-6, p.z - p0.z);
    const hit = lerp(p0, p, clamp(a, 0, 1));
    if (hit.y - SIM.BALL_R < SIM.NET_H) {
      p = v3(hit.x, hit.y, 0);
      v = v3(v.x * 0.5, v.y * 0.5, -v.z * 0.2);
      ev.net = true;
    }
  }

  if (p.y < SIM.DEAD_Y) {
    st.live = false;
    ev.dead = true;
  }
  if (st.t - st.lastTouch > SIM.DEAD_AFTER) {
    st.live = false;
    ev.dead = true;
  }
  st.p = p;
  st.v = v;
  st.w = w;
  st.t = st.t + dt;
  return ev;
}

function assistVelocity(p0: V3, target: V3, t: number): V3 {
  return sub(mul(sub(target, p0), 1 / t), mul(v3(0, -SIM.GRAVITY, 0), 0.5 * t));
}

/** Sim.assistReturn: aim x across the far half, a depth from the flight time, lifted over the net if needed. */
export function assistReturn(p0: V3, side: 'A' | 'B', aim: number, flight: number, len: number, wid: number): V3 {
  const dir = side === 'A' ? -1 : 1;
  const x = clamp(aim, -1, 1) * (wid / 2 - 0.4);
  const target = v3(x, SIM.TOP_Y + SIM.BALL_R, dir * (len / 2 - 0.6));
  let v = assistVelocity(p0, target, clamp(flight, 0.5, 0.9));
  const zCross = Math.abs(p0.z);
  const tCross = Math.abs(v.z) > 0.01 ? zCross / Math.abs(v.z) : 1;
  const yAtNet = p0.y + v.y * tCross - 0.5 * SIM.GRAVITY * tCross * tCross;
  const need = SIM.NET_H + SIM.BALL_R + 0.3;
  if (yAtNet < need) v = add(v, v3(0, (need - yAtNet) / Math.max(0.2, tCross), 0));
  const m = len3(v);
  if (m > SIM.MAX_SPEED) v = mul(v, SIM.MAX_SPEED / m);
  return v;
}

/** Advances a flight to time `t` in steps of at most 1/240 s; returns every event on the way. */
export function flyTo(st: BallState, t: number, len: number, wid: number, maxSteps = 600): StepEvent[] {
  const out: StepEvent[] = [];
  let n = 0;
  while (st.live && st.t < t && n < maxSteps) {
    const ev = step(st, Math.min(1 / 240, t - st.t), len, wid);
    if (ev.table || ev.net || ev.dead) out.push(ev);
    n++;
  }
  return out;
}
