// Render one film shot to an MP4, frame by frame, with no frames written to disk.
//
//   bun film/kit/render.ts <shot>                 film/out/<shot>.mp4 at 60 fps
//   bun film/kit/render.ts <shot> --still=1,3.5   film/out/stills/<shot>-<t>.jpg, for a quick look
//   bun film/kit/render.ts <shot> --fps=30
//
// Each shot (film/kit/shots/<shot>.ts) is bundled, served with the repo as the web root (so it can fetch
// film/assets and data/scenes), opened in headless Chrome at 1920x1080, and stepped through time; every frame's
// screenshot goes straight into ffmpeg.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [shot, ...rest] = process.argv.slice(2);
if (!shot) {
  console.error('usage: bun film/kit/render.ts <shot> [--still=t1,t2] [--fps=60]');
  process.exit(2);
}
const args = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const fps = Number(args.fps ?? 60);

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, 'shots', `${shot}.ts`)],
  outdir: join(import.meta.dir, 'dist'),
  target: 'browser',
  naming: '[name].[ext]',
});
if (!build.success) {
  console.error(build.logs.join('\n'));
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes('..')) return new Response('no', { status: 400 });
    const file = Bun.file(join(ROOT, path));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${server.port}/film/kit/page.html?shot=${shot}`);
  await page.waitForFunction(() => (window as any).READY === true, null, { timeout: 180_000 });
  const duration: number = await page.evaluate(() => (window as any).SHOT.duration);
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  console.log(`${shot}: ${duration}s at ${fps} fps on ${gpu}`);

  const frameAt = (t: number) =>
    page.evaluate(async (t) => {
      await (window as any).SHOT.frame(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, t);

  if (args.still) {
    mkdirSync(join(ROOT, 'film/out/stills'), { recursive: true });
    for (const s of args.still.split(',')) {
      await frameAt(Number(s));
      const path = join(ROOT, 'film/out/stills', `${shot}-${s}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 88 });
      console.log('still', path);
    }
  } else {
    const out = join(ROOT, 'film/out', `${shot}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
      { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(duration * fps);
    const started = Date.now();
    for (let i = 0; i < n; i++) {
      await frameAt(i / fps);
      const png = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % (fps * 2) === 0) console.log(`${shot} ${i}/${n} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log('wrote', out);
  }
} finally {
  await browser.close();
  server.stop(true);
}
