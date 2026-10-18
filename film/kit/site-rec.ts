// Record deja-view.photo scrolling at 1920x1080, 60 fps, frame by frame. The site's hero, lens dive and story are
// driven by scroll position, so setting the exact scroll for every frame makes every frame exact; clips that play on
// their own are paused and stepped 1/60 s per frame. The scroll is one smooth spline that never stops: each stretch
// gets time by how much is happening in it (the headset turning and the dive into its lens get the most).
//
//   bun film/kit/site-rec.ts            -> film/out/site.mp4
import { chromium } from 'playwright-core';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const FPS = 60;

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('https://deja-view.photo/', { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForTimeout(2000);

// warm up: run down the page once so every clip and picture loads, then back to the top
const H = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < H; y += 400) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(120);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(3500);

// anchors: the story steps (where each is showing), then the rows below
const STEPS = ['It starts with your phone', 'Every photo, placed', 'Now it', 'Made of soft 3D', 'One phone video', 'Both players', 'Now walk in'];
const marks = await page.evaluate(() => {
  const at = (text: string) => {
    const el = [...document.querySelectorAll('h1,h2,h3')].find((e) => e.textContent!.includes(text));
    return el ? el.getBoundingClientRect().top + scrollY : null;
  };
  return { step: at('Step inside'), forIt: at('What it'), games: at('Play on the real furniture') };
});
const probe: { y: number; step: number }[] = [];
for (let y = 600; y < (marks.step ?? 6000); y += 50) {
  probe.push({ y, step: await page.evaluate(async ({ y, STEPS }) => {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 110));
    let best = -1, bestO = 0.5;
    STEPS.forEach((t, i) => {
      const h = [...document.querySelectorAll('h2')].find((e) => e.textContent!.includes(t));
      if (!h) return;
      let o = 1;
      for (let e: HTMLElement | null = h; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      const r = h.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) o = 0;
      if (o > bestO) { bestO = o; best = i; }
    });
    return best;
  }, { y, STEPS }) });
}
const centre = STEPS.map((_, i) => {
  const ys = probe.filter((p) => p.step === i).map((p) => p.y);
  return ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : null;
});
console.log('step centres', centre.map((c) => (c === null ? '-' : Math.round(c))).join(' '), marks);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(2500);

// seconds to spend reaching each anchor, by how much is happening on the way
const SECS = [7.2, 3.4, 4.6, 4.0, 4.0, 3.2, 4.4]; // into: phone (headset + lens dive), cameras, place, splats, video, players, walk in
const knots: [number, number][] = [[0, 0]];
let t = 0;
centre.forEach((c, i) => {
  if (c === null) return;
  t += SECS[i];
  knots.push([t, c]);
});
const after = [
  [3.2, (marks.step ?? 4710) - 150],
  [3.8, (marks.forIt ?? 5496) - 130],
  [4.6, (marks.games ?? (marks.forIt ?? 5496) + 1500) - 1080 * 0.42],
] as const;
for (const [d, y] of after) { t += d; knots.push([t, y]); }
const total = t;

// a monotone cubic through the knots: smooth speed, never backwards, at rest only at the two ends
function spline(k: [number, number][]) {
  const n = k.length, dx: number[] = [], m: number[] = [], s: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = k[i + 1][0] - k[i][0]; s[i] = (k[i + 1][1] - k[i][1]) / dx[i]; }
  m[0] = 0; m[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
  return (x: number) => {
    if (x <= k[0][0]) return k[0][1];
    if (x >= k[n - 1][0]) return k[n - 1][1];
    let i = 0;
    while (x > k[i + 1][0]) i++;
    const h = dx[i], u = (x - k[i][0]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    return h00 * k[i][1] + h10 * h * m[i] + h01 * k[i + 1][1] + h11 * h * m[i + 1];
  };
}
const yAt = spline(knots);

const out = join(ROOT, 'film/out/site.mp4');
const ff = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdin: 'pipe' });
const N = Math.round(total * FPS);
const started = Date.now();
for (let i = 0; i < N; i++) {
  const y = yAt(i / FPS);
  await page.evaluate(async ({ y, dt }) => {
    window.scrollTo(0, y);
    // clips that play on their own: pause them and step them by exactly one frame
    for (const v of document.querySelectorAll('video')) {
      const w = v as HTMLVideoElement & { _own?: boolean };
      if (!w.paused) { w.pause(); w._own = true; }
      if (w._own && w.duration) w.currentTime = (w.currentTime + dt) % w.duration;
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t0 = performance.now();
    while ([...document.querySelectorAll('video')].some((v) => (v as HTMLVideoElement).seeking) && performance.now() - t0 < 400) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, { y, dt: 1 / FPS });
  ff.stdin.write(await page.screenshot({ type: 'jpeg', quality: 95 }));
  if (i % (FPS * 5) === 0) console.log(`${i}/${N} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
ff.stdin.end();
await ff.exited;
await browser.close();
console.log(`wrote ${out}: ${total.toFixed(1)} s`);
