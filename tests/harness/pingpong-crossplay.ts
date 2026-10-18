// Cross-play ping pong, the headset half, in headless Chrome against the real server: this script plays the Roblox
// server (posts the Game Lawn table and a ball, reads the long-poll), the viewer stands at the far end with the
// desktop paddle (P) and must join, see the ball and hit it back.
//
//   bun tests/harness/pingpong-crossplay.ts            BASE=http://localhost:8788 (default)
//
// Prints each step and exits non-zero when one fails.
import { chromium } from 'playwright-core';
import { assistReturn, flyTo, newState, v3 } from '../../web/src/viewer/social/pingpong-sim.ts';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const SCENE = 'the-courts';
const S = 3.57;
const TABLE = { c: [1.88, 2.713, -16.885], yaw: 0.8484, len: 9.78, wid: 5.44 };
const now = () => Date.now() / 1000;
const fail = (msg: string): never => {
  console.error('FAIL', msg);
  process.exit(1);
};

// table frame (studs) <-> room (metres)
const cy = Math.cos(TABLE.yaw);
const sy = Math.sin(TABLE.yaw);
const toWorld = (x: number, y: number, z: number) => [
  (TABLE.c[0]! + x * cy + z * sy) / S,
  (TABLE.c[1]! + y) / S,
  (TABLE.c[2]! - x * sy + z * cy) / S,
];

async function roblox(body: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/roblox/${SCENE}/pingpong`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as { events: Array<Record<string, any>>; seq: number };
}

function payload(over: Record<string, unknown>) {
  return {
    active: true,
    table: TABLE,
    board: { A: 'Alex', B: 'Bot', scoreA: 0, scoreB: 0, serve: 'A', over: false, sides: { A: 'Alex' } },
    paddles: [{ side: 'A', p: [0, 2.5, -6.5], n: [0, 0, 1], f: [0, -1, 0] }],
    now: now(),
    ...over,
  };
}

let seq = (await roblox(payload({}))).seq;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${BASE}/view?scene=${SCENE}&intro=0&narrate=never&labelsDelay=9999`);
await page.waitForFunction(() => (window as any).__viewerApp?.player, null, { timeout: 90_000 });
await page.waitForTimeout(3000);

// the paddle sits 0.5 m ahead, 0.2 m right and 0.15 m below the eye; stand so it is over the far end of the table
const target = { x: 0.6, y: 2.2, z: 5.6 }; // where the ball should meet the paddle (table frame)
const eyeLocal = { x: target.x - 0.2 * S, z: target.z + 0.5 * S };
const eyeY = (TABLE.c[1]! + target.y) / S + 0.15; // metres
const feet = toWorld(eyeLocal.x, 0, eyeLocal.z);
const fwd = [-sy, -cy]; // table -z in the room (x, z)
const yaw = Math.atan2(-fwd[0]!, -fwd[1]!);
await page.evaluate(
  ({ feet, yaw, eyeY }) => {
    const p = (window as any).__viewerApp.player;
    p.pos.x = feet[0];
    p.pos.z = feet[2];
    p.eyeHeight = eyeY - p.pos.y;
    p.eyeY = eyeY;
    p.yaw = yaw;
    p.pitch = 0;
  },
  { feet, yaw, eyeY },
);
await page.keyboard.press('p');

// 1. the viewer joins the free end (B)
const wait = async (ms: number) => {
  const r = await fetch(`${BASE}/api/roblox/${SCENE}/pingpong/wait?after=${seq}`, { signal: AbortSignal.timeout(ms) }).catch(() => null);
  const d = r ? ((await r.json()) as { events: Array<Record<string, any>>; seq: number }) : { events: [], seq };
  return d;
};
const joined = (await wait(8000)).events.find((e) => e.kind === 'join');
if (!joined) fail('no join from the viewer');
console.log('join:', joined!.id, 'side', joined!.side);
if (joined!.side !== 'B') fail(`joined side ${joined!.side}, expected B`);
seq = joined!.seq;
const me = joined!.id as string;

// 2. Roblox takes the join and sends a ball to B that bounces on B's half and rises through the paddle
const t0 = now() + 1.2;
let best: { v: { x: number; y: number; z: number }; d: number } | null = null;
const p0 = v3(0.3, 2.6, 0.6);
for (let vz = 6; vz <= 16; vz += 0.25) {
  for (let vy = -4; vy <= 6; vy += 0.25) {
    for (let vx = -1; vx <= 1; vx += 0.25) {
      const st = newState(p0, v3(vx, vy, vz), 0);
      let bounced = false;
      let d = Infinity;
      for (let i = 0; i < 400 && st.live; i++) {
        flyTo(st, (i + 1) / 240, TABLE.len, TABLE.wid).forEach((e) => {
          if (e.table === 'B') bounced = true;
        });
        if (bounced) d = Math.min(d, Math.hypot(st.p.x - target.x, st.p.y - target.y, st.p.z - target.z));
      }
      if (bounced && (!best || d < best.d)) best = { v: v3(vx, vy, vz), d };
    }
  }
}
if (!best || best.d > 0.6) fail(`no test shot passes the paddle (best ${best?.d})`);
console.log('test shot misses the paddle point by', best!.d.toFixed(2), 'studs');
await roblox(
  payload({
    board: { A: 'Alex', B: 'Judge', scoreA: 0, scoreB: 0, serve: 'A', over: false, sides: { A: 'Alex', B: 'headset' } },
    headset: { id: me, side: 'B' },
    ball: { p: [p0.x, p0.y, p0.z], v: [best!.v.x, best!.v.y, best!.v.z], w: [0, 0, 0], t: t0, to: 'B', live: true, serving: false, shot: 7 },
    now: now(),
  }),
);

// 3. the ball shows in the room, and the viewer hits it back
await page.waitForTimeout(600);
const seen = await page.evaluate(() => {
  const g = (window as any).__viewerApp.scene.getObjectByName('pingpong');
  return g ? { visible: g.visible, children: g.children.length } : null;
});
console.log('pingpong layer:', JSON.stringify(seen));
if (!seen?.visible) fail('the ping pong layer is not visible');
const shot = (await wait(6000)).events.find((e) => e.kind === 'shot' && e.id === me);
if (!shot) fail('no shot from the viewer');
const s = shot!.shot;
console.log('shot at t0+%s s, p', (s.t - t0).toFixed(2), s.p.map((x: number) => x.toFixed(2)).join(','), 'aim', s.aim.toFixed(2), 'flight', s.flight.toFixed(2));
// where our own flight says the ball was at that time
const st = newState(p0, best!.v, t0);
flyTo(st, s.t, TABLE.len, TABLE.wid);
const off = Math.hypot(st.p.x - s.p[0], st.p.y - s.p[1], st.p.z - s.p[2]);
console.log('the hit is', off.toFixed(2), 'studs from the ball path at that time');
if (off > 3) fail('the hit is not on the ball path (Roblox would refuse it)');
const ret = assistReturn(v3(s.p[0], s.p[1], s.p[2]), 'A', s.aim, s.flight, TABLE.len, TABLE.wid);
if (ret.z >= 0) fail('the return does not go back to A');
console.log('PASS: joined B, saw the ball, hit it back toward A');
await browser.close();
