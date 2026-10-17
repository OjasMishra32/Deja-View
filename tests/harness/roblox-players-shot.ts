// Renders a world's Roblox room (unlit, with its skybox) with two blocky players in a rally on the real ping-pong
// table, from several cameras round the table, in headless Chrome. For the landing page's Roblox tile.
//
//   bun tests/harness/roblox-players-shot.ts [sceneId] [--model DIR] [--out DIR] [--w 1600] [--h 1000] [--fov 55] [--depth] [--dof]
//
// Output: <out>/<sceneId>-<camera>.png (default out: data/evidence/roblox-players); --depth adds <camera>-depth.png,
// the distance per pixel in metres / 20 (white = sky); --dof adds <camera>-dof.png, sharp on the players and table,
// soft towards the far lawn and the near floor.
import { mkdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const flagged = new Set(['--model', '--out', '--w', '--h', '--fov', '--port']);
const sceneId = args.find((a, i) => !a.startsWith('--') && !flagged.has(args[i - 1] ?? '')) ?? 'the-courts';
const outDir = resolve(opt('--out', join(ROOT, 'data/evidence/roblox-players')));
const port = Number(opt('--port', '8853'));
mkdirSync(outDir, { recursive: true });

const TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
};
const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/shot') {
      return new Response(Bun.file(join(ROOT, 'tests/harness/roblox-players-shot.html')), { headers: { 'content-type': 'text/html' } });
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (rel.startsWith('..')) return new Response('forbidden', { status: 403 });
    const f = Bun.file(join(ROOT, rel));
    if (!(await f.exists())) return new Response('not found', { status: 404 });
    return new Response(f, { headers: { 'content-type': TYPES[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream' } });
  },
});

const W = Number(opt('--w', '1600')), H = Number(opt('--h', '1000'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const q = new URLSearchParams({ scene: sceneId, w: String(W), h: String(H), fov: opt('--fov', '55') });
  if (args.includes('--model')) q.set('model', opt('--model', ''));
  await page.goto(`http://127.0.0.1:${port}/shot?${q}`);
  await page.waitForFunction(() => (window as any).__ready || (window as any).__error, null, { timeout: 120_000 });
  const err = await page.evaluate(() => (window as any).__error);
  if (err) throw new Error(err);
  const views: string[] = await page.evaluate(() => (window as any).__views);
  const bounds = await page.evaluate(() => (window as any).__bounds);
  for (let i = 0; i < views.length; i++) {
    const v = await page.evaluate((k) => (window as any).__render(k), i);
    const path = join(outDir, `${sceneId}-${views[i]}.png`);
    await page.locator('canvas').screenshot({ path });
    const [x, , z] = v.eye;
    const inside = !bounds || (x >= bounds.min[0] && x <= bounds.max[0] && z >= bounds.min[2] && z <= bounds.max[2]);
    if (args.includes('--depth')) {
      await page.evaluate((k) => (window as any).__renderDepth(k), i);
      await page.locator('canvas').screenshot({ path: path.replace(/\.png$/, '-depth.png') });
    }
    if (args.includes('--dof')) {
      await page.evaluate((k) => (window as any).__renderDof(k), i);
      await page.locator('canvas').screenshot({ path: path.replace(/\.png$/, '-dof.png') });
    }
    console.log(`${views[i]}: eye ${v.eye.map((n: number) => n.toFixed(2)).join(', ')}${inside ? '' : '  (outside the room bounds)'} -> ${path}`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
