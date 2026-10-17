// Side-by-side previews of a world's Roblox model (roblox.glb from pipeline/roblox_mesh.py) and its splat world, from
// the same cameras, in headless Chrome: the headset spawn, the Roblox spawn facing it, behind the headset spawn, an
// overview and straight down. One PNG per scene (rows = cameras; columns = splat, mesh unlit, mesh lit) plus one
// strip per camera. Per camera it also prints how much of what the splat shows the unlit mesh covers, and the mean
// colour difference where both show something.
//
//   bun tests/harness/roblox-model-preview.ts [sceneId ...] [--model-root DIR] [--out DIR] [--port 8851]
//
// --model-root: where each scene's roblox.glb + roblox-model.json live, as DIR/<sceneId>/ (default: the scene
// directory itself). Output: data/evidence/roblox-mesh/<sceneId>.png and <sceneId>-<n>-<camera>.png.
import { mkdirSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const port = Number(opt('--port', '8851'));
const outDir = resolve(opt('--out', join(ROOT, 'data/evidence/roblox-mesh')));
const modelRoot = args.includes('--model-root') ? resolve(opt('--model-root', '')) : null;
const flagged = new Set(['--port', '--out', '--model-root']);
const scenes = args.filter((a, i) => !a.startsWith('--') && !flagged.has(args[i - 1] ?? ''));
if (!scenes.length) scenes.push('fortnite-tilted-night', 'fortnite-brick-house', 'fortnite-brick-apartment', 'sample-painted-bedroom');
mkdirSync(outDir, { recursive: true });

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/preview') {
      return new Response(Bun.file(join(ROOT, 'tests/harness/roblox-model-preview.html')), { headers: { 'content-type': 'text/html' } });
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (rel.startsWith('..')) return new Response('forbidden', { status: 403 });
    const f = Bun.file(join(ROOT, rel));
    if (!(await f.exists())) return new Response('not found', { status: 404 });
    const ext = rel.slice(rel.lastIndexOf('.'));
    return new Response(f, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
  },
});

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failures = 0;
try {
  for (const id of scenes) {
    const page = await browser.newPage({ viewport: { width: 1720, height: 2000 } });
    const logs: string[] = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    const q = new URLSearchParams({ scene: id });
    if (modelRoot) q.set('model', relative(ROOT, join(modelRoot, id)));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/preview?${q}`);
    await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 240_000 });
    const res = await page.evaluate(() => ({ err: (window as any).__error, info: (window as any).__info }));
    if (res.err) {
      failures++;
      console.log(JSON.stringify({ scene: id, ok: false, error: res.err, logs: logs.slice(-8) }));
      await page.close();
      continue;
    }
    const canvas = page.locator('#out');
    const grid = join(outDir, `${id}.png`);
    await canvas.screenshot({ path: grid });
    const box = (await canvas.boundingBox())!;
    const strips: string[] = [];
    for (let k = 0; k < res.info.rows; k++) {
      const name = res.info.views[k].name.replace(/\s+/g, '-');
      const path = join(outDir, `${id}-${k + 1}-${name}.png`);
      await page.screenshot({ path, clip: { x: box.x, y: box.y + k * res.info.rowHeight, width: box.width, height: res.info.rowHeight + 6 } });
      strips.push(path);
    }
    const metrics = res.info.views.map((v: any) => ({ camera: v.name, meshCoversSplat: v.meshCoversSplat, meanColourDiff: v.meanColourDiff }));
    console.log(JSON.stringify({ scene: id, ok: true, ms: Date.now() - t0, triangles: res.info.triangles, chunks: res.info.chunks, metrics, grid, strips }));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
process.exit(failures ? 1 : 0);
