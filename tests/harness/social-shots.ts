// Screenshots of the social layer in headless Chrome, desktop and emulated XR (iwer), against a
// running tests/harness/social-harness.ts.
//   bun tests/harness/social-shots.ts [outDir]      BASE=http://127.0.0.1:8796 SCENE=sample-painted-bedroom
// Prints the social debug state at each step, so the run doubles as a smoke test.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8796';
const SCENE = process.env.SCENE ?? 'sample-painted-bedroom';
const OUT = resolve(process.argv[2] ?? join(import.meta.dir, '../../data/evidence/social'));
const ONLY = process.env.ONLY ?? 'desktop,xr';
mkdirSync(OUT, { recursive: true });

const control = (path: string) => fetch(`${BASE}/harness/${path}${path.includes('?') ? '&' : '?'}scene=${SCENE}`, { method: 'POST' }).then((r) => r.json());
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const dbg = await page.evaluate(() => (window as any).__social?.debug);
  console.log(`${name}: ${JSON.stringify(dbg)}`);
};

async function open(page: Page, extra = ''): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  await page.goto(`${BASE}/view?scene=${SCENE}&intro=0${extra}`);
  await page.waitForFunction(() => (window as any).__socialReady || (window as any).__viewer?.error, null, { timeout: 120_000 });
  const err = await page.evaluate(() => (window as any).__viewer?.error);
  if (err) throw new Error(`viewer failed: ${err}`);
  await page.evaluate(() => {
    const h = document.getElementById('tw-help');
    if (h) h.hidden = true;
  });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  if (ONLY.includes('desktop')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await open(page);
    await page.waitForTimeout(3500);
    await shot(page, 'desktop-1-ghosts-notes');
    await control('round?state=start&duration=25');
    await page.waitForTimeout(700);
    await shot(page, 'desktop-2-round-start');
    await page.waitForTimeout(1600);
    await control('tag?target=rbx-12345');
    await page.waitForTimeout(330);
    await shot(page, 'desktop-3-tagged');
    await page.waitForTimeout(1800);
    await control('note?text=' + encodeURIComponent("Seb's seat. He was too scared to show up.") + '&x=-0.2&y=1.35&z=-1.5');
    await page.waitForTimeout(450);
    await shot(page, 'desktop-4-note-arrives');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(3500);
    await shot(page, 'desktop-5-reality-on');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(900);
    await page.keyboard.press('KeyN');
    await page.waitForTimeout(600);
    await shot(page, 'desktop-6-note-dialog');
    await page.click('.dvs-chip >> nth=0');
    await page.waitForTimeout(900);
    await shot(page, 'desktop-7-note-posted');
    await control('round?state=end');
    await page.waitForTimeout(600);
    await shot(page, 'desktop-8-round-end');
    await control('people?on=0');
    await page.waitForTimeout(2500);
    await shot(page, 'desktop-9-everyone-left');
    await control('people?on=1');
    await page.close();
  }
  if (ONLY.includes('reality')) {
    // the reality check alone: before, mid-wave, settled
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await open(page);
    await control('people?on=0');
    await page.waitForTimeout(4000);
    await shot(page, `reality-${SCENE}-1-before`);
    await page.keyboard.press('KeyC');
    await page.waitForFunction(() => (window as any).__social?.debug?.reality?.phase === 'on', null, { timeout: 60_000 });
    await page.waitForTimeout(450);
    await shot(page, `reality-${SCENE}-2-wave`);
    await page.waitForTimeout(2600);
    await shot(page, `reality-${SCENE}-3-on`);
    await control('people?on=1');
    await page.close();
  }
  if (ONLY.includes('xr')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await open(page, '&xremu=1');
    await page.waitForTimeout(800);
    await page.click('#tw-btn-vr');
    await page.waitForFunction(() => (window as any).__viewerApp?.renderer.xr.isPresenting, null, { timeout: 20_000 });
    // stand and look toward the room; hands in front
    await page.evaluate(() => {
      const d = (window as any).__xrDevice;
      d.position.set(0, 1.6, 0.4);
      d.controllers.right.position.set(0.18, 1.35, 0.15);
      // point the right hand forward and a little down, at the room
      d.controllers.right.quaternion.set(-0.13, 0, 0, 0.99);
      d.controllers.left.position.set(-0.2, 1.3, 0.15);
    });
    await page.waitForTimeout(3500);
    await shot(page, 'xr-1-ghosts-notes');
    await control('tag?target=rbx-67890');
    await page.waitForTimeout(380);
    await shot(page, 'xr-2-tagged');
    await control('round?state=start&duration=25');
    await page.waitForTimeout(2900);
    await shot(page, 'xr-3-round');
    // aim a note with the right grip
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('squeeze', 1));
    await page.waitForTimeout(700);
    await shot(page, 'xr-4-note-aim');
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('squeeze', 0));
    await page.waitForTimeout(700);
    await shot(page, 'xr-5-note-picker');
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('squeeze', 1));
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('squeeze', 0));
    await page.waitForTimeout(1200);
    await shot(page, 'xr-6-note-posted');
    // reality check from the left Y button
    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateButtonValue('y-button', 1));
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateButtonValue('y-button', 0));
    await page.waitForTimeout(3200);
    await shot(page, 'xr-7-reality');
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`screenshots in ${OUT}`);
