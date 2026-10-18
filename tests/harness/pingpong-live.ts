// Cross-play ping pong against a real Roblox server (Studio play test or the live game): a headless viewer stands at
// the far end (B) with the desktop paddle (P), joins, and moves its paddle onto the ball like a perfect player. It
// reports what Roblox did with each of its hits, read from Roblox's own posts (GET /api/pingpong/:scene).
//
//   bun tests/harness/pingpong-live.ts [--seconds 45]      BASE=http://localhost:8788 (default)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:8788';
const SCENE = 'the-courts';
const S = 3.57;
const SECONDS = Number(process.argv[process.argv.indexOf('--seconds') + 1] || 45);

type Latest = { table: { c: number[]; yaw: number; len: number; wid: number }; board: any; ball?: any; headset?: any };
const latest = async (): Promise<Latest | null> => {
  const r = await fetch(`${BASE}/api/pingpong/${SCENE}`).catch(() => null);
  return r ? (((await r.json()) as { latest: Latest | null }).latest ?? null) : null;
};

const first = await latest();
if (!first?.table) {
  console.error('FAIL no table from Roblox yet: start the play test first');
  process.exit(1);
}
const T = first.table;
const cy = Math.cos(T.yaw);
const sy = Math.sin(T.yaw);
const toWorld = (x: number, y: number, z: number) => [(T.c[0]! + x * cy + z * sy) / S, (T.c[1]! + y) / S, (T.c[2]! - x * sy + z * cy) / S];
const toLocal = (w: number[]) => {
  const dx = w[0]! * S - T.c[0]!;
  const dz = w[2]! * S - T.c[2]!;
  return { x: dx * cy - dz * sy, y: w[1]! * S - T.c[1]!, z: dx * sy + dz * cy };
};
console.log('table', JSON.stringify(T), 'board', JSON.stringify(first.board));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
const posts: string[] = [];
page.on('request', (r) => {
  if (r.url().includes('/api/pingpong/') && r.method() === 'POST') {
    const b = r.postDataJSON?.() as { kind?: string; shot?: { t: number } } | undefined;
    if (b?.kind && b.kind !== 'paddle') posts.push(b.kind);
  }
});
await page.goto(`${BASE}/view?scene=${SCENE}&intro=0&narrate=never&labelsDelay=9999&name=Headset%20test`);
await page.waitForFunction(() => (window as any).__viewerApp?.player, null, { timeout: 90_000 });
await page.waitForTimeout(3000);
await page.keyboard.press('p');

const yaw = Math.atan2(sy, cy); // facing table -z
// put the paddle (0.5 m ahead, 0.2 m right, 0.15 m below the eye) on a table-frame point
const paddleTo = async (x: number, y: number, z: number) => {
  const feet = toWorld(x - 0.2 * S, 0, z + 0.5 * S);
  const eyeY = (T.c[1]! + y) / S + 0.15;
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
};
await paddleTo(0, 2.2, 6.2);

const shotsSeen = new Set<number>();
let ours = 0;
let accepted = 0;
let lastShot = -1;
let lastTo = '';
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  // follow the ball the viewer draws once it is on our side of the net
  const ball = await page.evaluate(() => {
    const g = (window as any).__viewerApp.scene.getObjectByName('pingpong');
    const b = g?.children?.[0];
    if (!g?.visible || !b?.visible) return null;
    const v = b.getWorldPosition(b.position.clone());
    return [v.x, v.y, v.z];
  });
  if (ball) {
    const l = toLocal(ball);
    if (l.z > 3) await paddleTo(l.x, Math.min(3.5, Math.max(0.6, l.y)), Math.min(7, Math.max(4.4, l.z)));
    else await paddleTo(0, 2.2, 6.2);
  }
  const d = await latest();
  const b = d?.ball;
  if (b && b.shot !== lastShot) {
    // a shot Roblox made that leaves B right after one of our hits is our hit, accepted
    if (!shotsSeen.has(b.shot)) {
      shotsSeen.add(b.shot);
      const fromUs = b.to === 'A' && lastTo === 'B';
      if (fromUs) accepted++;
      console.log(`shot ${b.shot} -> ${b.to}${b.serving ? ' (serve)' : ''}  score ${d!.board.scoreA}-${d!.board.scoreB}  sides ${JSON.stringify(d!.board.sides)}${fromUs ? '  <- our hit, accepted' : ''}`);
    }
    lastShot = b.shot;
    lastTo = b.to;
  }
  await page.waitForTimeout(40);
}
ours = posts.filter((k) => k === 'shot').length;
const d = await latest();
console.log(`posts: ${JSON.stringify(posts.reduce((m: Record<string, number>, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}))}`);
console.log(`our hits sent ${ours}, accepted by Roblox ${accepted}; board ${JSON.stringify(d?.board)}`);
await page.keyboard.press('p'); // leave
await page.waitForTimeout(800);
await browser.close();
