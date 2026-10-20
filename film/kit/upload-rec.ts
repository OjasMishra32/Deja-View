// Records the "make your own" flow on deja-view.photo: pick a phone video on /capture, name it, press the button,
// land on the gallery with the new world in "Your worlds" and its 40-minute queue bar. The upload itself is answered
// in the browser (nothing is sent to the server or queued), so filming never adds a world to the live site.
//
//   bun film/kit/upload-rec.ts <video file>   -> film/out/upload.mp4
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = join(import.meta.dir, '../..');
const clip = process.argv[2];
const TMP = join(ROOT, 'film/out/_upload');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1152, height: 648 }, deviceScaleFactor: 1920 / 1152 });
const made = { id: 'giant-chess-take-one', name: 'Giant chess, take one', mode: 'video', status: 'queued', progress: 0,
  stage: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await page.route('**/api/scenes', async (route) => {
  if (route.request().method() === 'POST') {
    await new Promise((r) => setTimeout(r, 1600));
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(made) });
  }
  const res = await route.fetch();
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.scenes;
  list.unshift({ ...made, createdAt: new Date().toISOString() });
  return route.fulfill({ response: res, body: JSON.stringify(Array.isArray(body) ? list : { ...body, scenes: list }) });
});

// frames, as fast as the page allows; timed so the video plays back at the real pace
const frames: { t: number; f: string }[] = [];
let recording = true;
const t0 = Date.now();
const loop = (async () => {
  while (recording) {
    const f = join(TMP, `${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(f, await page.screenshot({ type: 'jpeg', quality: 92 }));
    frames.push({ t: (Date.now() - t0) / 1000, f });
  }
})();

await page.goto('https://deja-view.photo/capture?mode=video', { waitUntil: 'networkidle' });
// the phone-handoff box prints this machine's LAN address; leave it out of the film
await page.addStyleTag({ content: '#qr, #qr ~ *, .note:has(+ #qr), .note:has(+ * #qr) { display: none !important; }' });
await page.waitForTimeout(1400);
await page.setInputFiles('#pick-files', clip);
await page.waitForTimeout(2600);
await page.click('#scene-name');
await page.fill('#scene-name', '');
await page.type('#scene-name', made.name, { delay: 55 });
await page.waitForTimeout(700);
await page.locator('#submit').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.click('#submit');
await page.waitForURL(/new=|#gallery|\/$/, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById('mine')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
await page.waitForTimeout(4200);
recording = false;
await loop;
await browser.close();

// constant 30 fps from the timed frames
const list = frames.map((x, i) => `file '${x.f}'\nduration ${((frames[i + 1]?.t ?? x.t + 0.1) - x.t).toFixed(3)}`).join('\n');
writeFileSync(join(TMP, 'list.txt'), list + `\nfile '${frames[frames.length - 1].f}'\n`);
const out = join(ROOT, 'film/out/upload.mp4');
const ff = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(TMP, 'list.txt'),
  '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '17', out]);
console.log(ff.stderr.toString() || `wrote ${out}: ${frames.length} frames over ${frames[frames.length - 1].t.toFixed(1)} s`);
