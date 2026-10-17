// Behaviour checks for the memory intro in headless Chrome: it plays in real time and hands over to the world, any
// key skips it, the back arrow shrinks the world into the photo before it goes, prefers-reduced-motion gets the
// crossfade, the headset's Exit VR plays the exit and the screen gets the world back, and ?intro=0 turns it off.
//
//   BASE=http://localhost:8873 bun tests/harness/memory-checks.ts [scene] [--out=data/evidence/intro]
// Prints one line per check and writes checks.json (plus a few reduced-motion frames) to the out folder.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);
const SCENE = args.find((a) => !a.startsWith('--')) ?? 'the-courts';
const OUT = resolve(ROOT, args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'data/evidence/intro');
const BASE = process.env.BASE ?? 'https://localhost:8787';
mkdirSync(OUT, { recursive: true });

type Phase = string | null;
const results: { check: string; ok: boolean; detail: unknown }[] = [];
const record = (check: string, ok: boolean, detail: unknown) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}  ${JSON.stringify(detail)}`);
};

async function open(context: BrowserContext, extra = ''): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${BASE}/view?scene=${encodeURIComponent(SCENE)}&narrate=never&labelsDelay=600${extra}`);
  await page.waitForFunction(() => (window as any).__viewer?.ready || (window as any).__viewer?.error, null, { timeout: 120_000 });
  return { page, errors };
}

const phase = (page: Page): Promise<Phase> => page.evaluate(() => (window as any).__viewer.memory?.phase ?? null);

/** Samples the phase every 50 ms until `until` (or the timeout); returns [ms since start, phase] at each change. */
async function watch(page: Page, until: string, timeoutMs: number): Promise<[number, Phase][]> {
  return page.evaluate(
    ([u, to]) =>
      new Promise<[number, Phase][]>((done) => {
        const t0 = performance.now();
        const seen: [number, Phase][] = [];
        const tick = () => {
          const p = (window as any).__viewer.memory?.phase ?? null;
          if (!seen.length || seen[seen.length - 1][1] !== p) seen.push([Math.round(performance.now() - t0), p]);
          if (p === u || performance.now() - t0 > (to as number)) done(seen);
          else setTimeout(tick, 50);
        };
        tick();
      }),
    [until, timeoutMs] as const,
  );
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 }, ignoreHTTPSErrors: true });

  // 1. real-time entry, then the world
  {
    const { page, errors } = await open(context);
    const timeline = await watch(page, 'shown', 20_000);
    const fps = await page.evaluate(() => (window as any).__viewer.stats.fps);
    const reveal = await page.evaluate(() => (window as any).__viewerApp.fx.reveal.value);
    const hudOff = await page.evaluate(() => document.body.classList.contains('dv-memory'));
    record('entry plays and hands over to the world', timeline.at(-1)?.[1] === 'shown' && reveal > 1e4 && !hudOff, { timeline, fps: Math.round(fps), reveal, errors });

    // 2. any key skips (replay the entry, press a key 0.5 s in)
    await page.evaluate(() => {
      const a = (window as any).__viewerApp;
      void a.beginIntro(0);
    });
    await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'enter' && (window as any).__viewer.memory.t > 0.4, null, { timeout: 10_000 });
    const pressedAt = await page.evaluate(() => (window as any).__viewer.memory.t);
    await page.keyboard.press('KeyK');
    const skip = await watch(page, 'shown', 5000);
    record('a key skips the entry', skip.at(-1)?.[1] === 'shown' && skip.at(-1)![0] < 1200, { pressedAt, skip });

    // 3. the back arrow shrinks the world into the photo, then goes to the gallery
    const t0 = Date.now();
    const nav = page.waitForURL((u) => !u.search.includes('scene='), { timeout: 15_000 });
    await page.click('.tw-back');
    const during = await page.evaluate(() => (window as any).__viewer?.memory?.phase).catch(() => 'navigated');
    await nav;
    record('back arrow: world shrinks into the photo, then the gallery', during === 'leave', { phaseAfterClick: during, msToNavigate: Date.now() - t0, url: page.url() });
    await page.close();
  }

  // 4. prefers-reduced-motion: a crossfade, nothing moves
  {
    const reduced = await browser.newContext({ viewport: { width: 960, height: 600 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
    const { page } = await open(reduced);
    await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'shown', null, { timeout: 20_000 });
    const info = await page.evaluate(() => (window as any).__viewer.memory);
    for (const t of [0, 0.5, 0.8, 1.2]) {
      await page.evaluate((tt) => (window as any).__viewerApp.memory.hold(tt, 'enter'), t);
      await page.waitForTimeout(1300);
      await page.screenshot({ path: join(OUT, `${SCENE}-reduced-enter-${t.toFixed(1)}.png`) });
    }
    const pushLift = await page.evaluate(() => {
      const u = (window as any).__viewerApp.memory.u;
      return { push: u.uPush.value, lift: u.uLift.value };
    });
    // nothing moves: no travel, and the picture sits at the world's depth the whole time (lift 1)
    record('reduced motion: crossfade only', info.reduced === true && pushLift.push === 0 && pushLift.lift === 1, { info: { reduced: info.reduced }, pushLift });
    await reduced.close();
  }

  // 5. headset: the entry plays on Enter VR, Exit VR shrinks the world first, the screen gets the world back
  {
    const { page, errors } = await open(context, '&xremu=1');
    await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'shown', null, { timeout: 20_000 });
    await page.click('#tw-btn-vr');
    await page.waitForFunction(() => (window as any).__viewerApp?.renderer.xr.isPresenting, null, { timeout: 20_000 });
    const enterVr = await watch(page, 'shown', 20_000);
    const rigBefore = await page.evaluate(() => (window as any).__viewerApp.rig.position.toArray());
    const exitStart = await page.evaluate(() => {
      (window as any).__viewerApp.xr.exit();
      return (window as any).__viewer.memory.phase;
    });
    const exitTimeline = await watch(page, 'enter', 15_000);
    await page.waitForFunction(() => !(window as any).__viewerApp.renderer.xr.isPresenting, null, { timeout: 10_000 });
    const back = await watch(page, 'shown', 20_000);
    record(
      'headset: entry on Enter VR, Exit VR shrinks the world first, screen gets it back',
      enterVr.some(([, p]) => p === 'enter') && enterVr.at(-1)?.[1] === 'shown' && exitStart === 'leave' && back.at(-1)?.[1] === 'shown',
      { enterVr, rigBefore, exitStart, exitTimeline, back, errors },
    );
    await page.close();
  }

  // 6. ?intro=0: no memory, the plain reveal
  {
    const { page } = await open(context, '&intro=0');
    const m = await page.evaluate(() => (window as any).__viewer.memory ?? null);
    record('?intro=0 turns it off', m === null, { memory: m });
    await page.close();
  }
} finally {
  await browser.close();
}
await Bun.write(join(OUT, `checks-${SCENE}.json`), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
