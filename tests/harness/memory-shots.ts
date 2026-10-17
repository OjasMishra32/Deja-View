// Frame sequences of the memory intro ("the photo becomes the world") in headless Chrome, on a screen and in the
// emulated Quest (?xremu=1). The intro is frozen at each time (MemoryIntro.hold) so every frame is exact.
//
//   bun tests/harness/memory-shots.ts [scene ...] [--modes=desktop,xr] [--out=data/evidence/intro]
//   BASE=https://localhost:8787 (default) or any running viewer server.
//
// Writes <scene>-<mode>-<enter|leave>-<t>.png and prints the intro's debug readout per scene. One browser at a time.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const ROOT = resolve(import.meta.dir, '..', '..');
const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const scenes = args.filter((a) => !a.startsWith('--'));
const SCENES = scenes.length ? scenes : ['the-courts', 'fortnite-brick-house', 'test-tw-gpu'];
const MODES = flag('modes', 'desktop,xr').split(',');
const OUT = resolve(ROOT, flag('out', 'data/evidence/intro'));
const BASE = process.env.BASE ?? 'https://localhost:8787';
const ENTER_T = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.6];
const LEAVE_T = [0, 0.4, 0.8, 1.2, 1.75];
const SETTLE = Number(flag('settle', '1400'));

mkdirSync(OUT, { recursive: true });

async function frozen(page: Page, t: number, phase: 'enter' | 'leave', file: string): Promise<void> {
  await page.evaluate(([tt, ph]) => (window as any).__viewerApp.memory.hold(tt, ph), [t, phase] as const);
  // let Spark regenerate and sort the splats for this reveal
  await page.waitForTimeout(SETTLE);
  await page.screenshot({ path: join(OUT, file) });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
});
const report: Record<string, unknown> = {};
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 }, ignoreHTTPSErrors: true });
  for (const id of SCENES) {
    for (const mode of MODES) {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error' || /memory intro/.test(m.text())) errors.push(m.text());
      });
      const q = `scene=${encodeURIComponent(id)}&narrate=never&labelsDelay=600${mode === 'xr' ? '&xremu=1' : ''}`;
      await page.goto(`${BASE}/view?${q}`);
      await page.waitForFunction(() => (window as any).__viewer?.ready || (window as any).__viewer?.error, null, { timeout: 120_000 });
      const info = await page.evaluate(() => {
        const v = (window as any).__viewer;
        return { error: v.error, memory: v.memory, memoryMs: v.stats.memoryMs, spawn: v.info.spawn, eye: v.player };
      });
      report[`${id}/${mode}`] = { ...info, errors };
      console.log(id, mode, JSON.stringify(info.memory), `prep ${Math.round(info.memoryMs ?? 0)} ms`);
      if (!info.memory) {
        await page.close();
        continue;
      }
      // let the real entry play out once (and the loader fade), then freeze frames
      await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'shown', null, { timeout: 30_000 });
      await page.evaluate(() => {
        const h = document.getElementById('tw-help');
        if (h) h.hidden = true;
      });
      if (mode === 'xr') {
        await page.click('#tw-btn-vr');
        await page.waitForFunction(() => (window as any).__viewerApp?.renderer.xr.isPresenting, null, { timeout: 20_000 });
        await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'shown', null, { timeout: 30_000 });
        await page.waitForTimeout(600);
      }
      for (const t of ENTER_T) await frozen(page, t, 'enter', `${id}-${mode}-enter-${t.toFixed(1)}.png`);
      await page.evaluate(() => (window as any).__viewerApp.memory.hold(null));
      await page.waitForFunction(() => (window as any).__viewer.memory?.phase === 'shown', null, { timeout: 30_000 });
      for (const t of LEAVE_T) await frozen(page, t, 'leave', `${id}-${mode}-leave-${t.toFixed(2)}.png`);
      await page.evaluate(() => (window as any).__viewerApp.memory.hold(null));
      report[`${id}/${mode}`] = { ...(report[`${id}/${mode}`] as object), after: await page.evaluate(() => (window as any).__viewer.memory) };
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await Bun.write(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`frames in ${OUT}`);
