// Turntable evidence for the avatar GLBs (pipeline/avatar), in headless Chrome with three.js the way the viewer plays
// them: GLTFLoader, unlit material, AnimationMixer.setTime(t) on clip "video". For each time: 8 views around every
// person (yaw 0..315 deg) and the paused scene from the recording camera (over the splat world when --world is
// given) next to the real frame. --check compares three.js skinned positions with numpy (avatar-check.json from
// pipeline/avatar/run.py) and fails above 5 mm.
//
//   bun tests/harness/avatar-turntable.ts --dir data/tmp/avatars/foosball [--times 2,6,10] [--poses P.json]
//       [--world W.spz] [--frames-dir D (f<frameIndex>.jpg)] [--check avatar-check.json] [--out data/evidence/avatars]
//
// All paths are repo-relative. Output: <out>/turntable-t<time>.png and a JSON summary on stdout.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (name: string, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const dir = opt('--dir', 'data/tmp/avatars/foosball');
const times = opt('--times', '2,6,10').split(',').map(Number);
const poses = opt('--poses');
const world = opt('--world');
const framesDir = opt('--frames-dir');
const check = opt('--check');
const outDir = resolve(ROOT, opt('--out', 'data/evidence/avatars'));
const port = Number(opt('--port', '8857'));
mkdirSync(outDir, { recursive: true });
const glbs = readdirSync(join(ROOT, dir)).filter((f) => /^avatar-\d+\.glb$/.test(f)).sort().map((f) => `${dir}/${f}`);
if (!glbs.length) throw new Error(`no avatar-<k>.glb in ${dir}`);

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.spz': 'application/octet-stream',
};
const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/turntable') {
      return new Response(Bun.file(join(ROOT, 'tests/harness/avatar-turntable.html')), { headers: { 'content-type': 'text/html' } });
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (rel.startsWith('..')) return new Response('forbidden', { status: 403 });
    const f = Bun.file(join(ROOT, rel));
    if (!(await f.exists())) return new Response('not found', { status: 404 });
    return new Response(f, { headers: { 'content-type': TYPES[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream' } });
  },
});

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
const summary: any[] = [];
try {
  for (const [n, t] of times.entries()) {
    const page = await browser.newPage({ viewport: { width: 2500, height: 1600 } });
    const logs: string[] = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    const q = new URLSearchParams({ glbs: glbs.join(','), t: String(t) });
    if (poses) q.set('poses', poses);
    if (world) q.set('world', world);
    if (check && n === 0) q.set('check', check);
    if (poses && framesDir) {
      // the real frame nearest t (frames are named by their index in the file)
      const doc = await Bun.file(join(ROOT, poses)).json();
      const tr = doc.track.reduce((b: any, f: any) => (Math.abs(f.time - t) < Math.abs(b.time - t) ? f : b));
      const cands = readdirSync(join(ROOT, framesDir)).filter((f) => /^f\d+\.jpg$/.test(f));
      const best = cands.reduce((b, f) => (Math.abs(+f.slice(1, -4) - tr.frameIndex) < Math.abs(+b.slice(1, -4) - tr.frameIndex) ? f : b));
      if (existsSync(join(ROOT, framesDir, best))) q.set('frame', `${framesDir}/${best}`);
    }
    await page.goto(`http://127.0.0.1:${port}/turntable?${q}`);
    await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 240_000 });
    const res = await page.evaluate(() => ({ err: (window as any).__error, info: (window as any).__info }));
    if (res.err) {
      failed = true;
      summary.push({ t, ok: false, error: res.err, logs: logs.slice(-10) });
      await page.close();
      continue;
    }
    const path = join(outDir, `turntable-t${t.toFixed(2)}.png`);
    await page.locator('#out').screenshot({ path });
    const entry: any = { t, ok: true, png: path, avatars: res.info.avatars, paused: res.info.paused };
    if (res.info.check) {
      entry.check = res.info.check;
      const worst = Math.max(...res.info.check.map((c: any) => c.maxErrMm));
      entry.checkPassed = worst < 5;
      if (!entry.checkPassed) failed = true;
    }
    summary.push(entry);
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
console.log(JSON.stringify(summary, null, 1));
process.exit(failed ? 1 : 0);
