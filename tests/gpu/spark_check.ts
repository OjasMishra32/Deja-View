// Renders splat files written by pipeline/splat_io.py with Spark in headless Chrome and saves screenshots.
//
//   .venv/bin/python tests/gpu/spark_fixtures.py          # writes data/evidence/gpu/spark/*.spz + manifest.json
//   bun tests/gpu/spark_check.ts [manifest.json] [--port 8796]
//
// Each manifest entry: { name, file (repo-relative), quaternion, position?, scale?, eye?, yaw?, pitch? }.
// Prints one JSON line per entry (splat count, lit-pixel coverage, error) and writes <name>.png next to the manifest.
import { chromium } from 'playwright-core';
import { dirname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8796;
const manifestPath = resolve(args.find((a, i) => !a.startsWith('--') && (portIdx < 0 || i !== portIdx + 1)) ?? join(ROOT, 'data/evidence/gpu/spark/manifest.json'));
const outDir = dirname(manifestPath);

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/check') return new Response(Bun.file(join(ROOT, 'tests/gpu/spark_check.html')), { headers: { 'content-type': 'text/html' } });
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (rel.startsWith('..')) return new Response('forbidden', { status: 403 });
    const f = Bun.file(join(ROOT, rel));
    if (!(await f.exists())) return new Response('not found', { status: 404 });
    const ext = rel.slice(rel.lastIndexOf('.'));
    return new Response(f, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
  },
});

const entries: any[] = await Bun.file(manifestPath).json();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failures = 0;
try {
  for (const e of entries) {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const logs: string[] = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (err) => logs.push(`pageerror: ${err.message}`));
    const q = new URLSearchParams({
      file: e.file,
      q: (e.quaternion ?? [0, 0, 0, 1]).join(','),
      pos: (e.position ?? [0, 0, 0]).join(','),
      scale: String(e.scale ?? 1),
      eye: (e.eye ?? [0, 0, 0]).join(','),
      yaw: String(e.yaw ?? 0),
      pitch: String(e.pitch ?? 0),
    });
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/check?${q}`);
    await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 120_000 });
    const res = await page.evaluate(() => ({ n: (window as any).__numSplats, cov: (window as any).__coverage, err: (window as any).__error }));
    const shot = join(outDir, `${e.name}.png`);
    await page.screenshot({ path: shot });
    const ok = !res.err && typeof res.cov === 'number' && res.cov > 0.2;
    if (!ok) failures++;
    console.log(JSON.stringify({ name: e.name, ok, splats: res.n, coverage: res.cov, error: res.err, ms: Date.now() - t0, screenshot: shot, logs: res.err ? logs.slice(-5) : undefined }));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}
process.exit(failures ? 1 : 0);
