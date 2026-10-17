// The guide in the real viewer, in headless Chrome (playwright-core), against the guide harness.
// Opt-in because it needs Chrome:
//   GUIDE_E2E=1 bun test tests/guide-e2e.test.ts
// Uses a guide harness already listening on GUIDE_E2E_PORT, or starts tests/harness/guide-harness.ts
// on the first free port in 8793-8799 (other agents' harnesses share that range). Chrome gets a fake microphone (a beep), so holding T
// records real webm/opus. Screenshots go to data/evidence/guide/.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { chromium, type Browser, type Page } from 'playwright-core';
import { freeHarnessPort, LOUNGE_SPOTS } from './harness/guide-harness.ts';

const ENABLED = process.env.GUIDE_E2E === '1';
const ROOT = resolve(import.meta.dir, '..');
let PORT = Number(process.env.GUIDE_E2E_PORT ?? 0);
let BASE = '';
const OUT = join(ROOT, 'data', 'evidence', 'guide');
const T = 150_000;

let server: Subprocess | null = null;
let browser: Browser;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok && ((await r.json()) as { version?: string }).version === 'guide-harness';
  } catch {
    return false;
  }
}

const post = (path: string, body: unknown = {}) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const requests = async () => (await (await fetch(`${BASE}/harness/requests`)).json()) as Array<Record<string, any>>;

interface PageLog {
  errors: string[];
}

async function open(scene: string, extra = ''): Promise<{ page: Page; log: PageLog }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const log: PageLog = { errors: [] };
  page.on('console', (m) => {
    // Chrome logs failed HTTP responses itself (a 404 for "no stored labels yet", 502s while the
    // guide is down); those are network facts, not script errors. Everything else counts.
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) log.errors.push(m.text());
  });
  page.on('pageerror', (e) => log.errors.push(e.message));
  await page.goto(`${BASE}/view?scene=${scene}&intro=0${extra}`);
  await page.waitForFunction(() => (window as any).__guide || (window as any).__viewer?.error, null, { timeout: 90_000 });
  await page.evaluate(() => {
    const h = document.getElementById('tw-help');
    if (h) h.hidden = true;
  });
  return { page, log };
}

const guide = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__guide.debug)));

async function waitGuide(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(`(() => { const d = window.__guide && window.__guide.debug; return !!d && (${fn}); })()`, null, { timeout });
}

/** Moves the mouse onto a label's pill: starts at its pin on screen and walks up until it hovers. */
async function hoverLabel(page: Page, label: string): Promise<boolean> {
  const pin = await page.evaluate((name) => {
    const app = (window as any).__viewerApp;
    const g = (window as any).__guide;
    const h = g.hotspots.find((x: any) => x.label === name);
    if (!h) return null;
    const V = app.camera.position.constructor;
    const v = new V(h.position[0], h.position[1], h.position[2]).project(app.camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }, label);
  if (!pin) return false;
  for (let dy = 0; dy < 260; dy += 6) {
    await page.mouse.move(pin.x, pin.y - dy);
    await page.waitForTimeout(40);
    if ((await guide(page)).hover === label) return true;
  }
  return false;
}

describe.skipIf(!ENABLED)('guide in the viewer (headless Chrome)', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    if (PORT) BASE = `http://127.0.0.1:${PORT}`;
    if (!PORT || !(await healthy())) {
      PORT = await freeHarnessPort();
      BASE = `http://127.0.0.1:${PORT}`;
      server = Bun.spawn(['bun', join(ROOT, 'tests/harness/guide-harness.ts')], { env: { ...process.env, PORT: String(PORT), GUIDE_HARNESS_QUIET: '1' }, stdout: 'ignore', stderr: 'inherit' });
      for (let i = 0; i < 60 && !(await healthy()); i++) await Bun.sleep(200);
    }
    if (!(await healthy())) throw new Error(`the guide harness did not come up on ${BASE}`);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
  }, T);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  test('labels from the input photo land on the objects; the room greets you', async () => {
    await post('/harness/reset');
    const { page, log } = await open('guide-test-room');
    await waitGuide(page, "d.hotspotStatus === 'done' && d.labels.length === 4");
    const d = await guide(page);
    expect(d.hotspotSource).toBe('input');
    for (const spot of LOUNGE_SPOTS) {
      const l = d.labels.find((x: any) => x.label === spot.label);
      expect(l).toBeTruthy();
      expect(l.source).toBe('depth');
      const err = Math.hypot(l.position[0] - spot.point[0], l.position[1] - spot.point[1], l.position[2] - spot.point[2]);
      expect(err).toBeLessThan(0.12);
    }
    await waitGuide(page, "d.requests.narrate === 1 && (d.caption.mode === 'speaking' || d.caption.mode === 'answer')");
    const r = await requests();
    const hs = r.find((x) => x.endpoint === 'hotspots')!;
    expect(hs.imageType).toBe('image/jpeg');
    expect(hs.imageBytes).toBeGreaterThan(5000);
    const nar = r.find((x) => x.endpoint === 'narrate')!;
    expect(nar.imageType).toBe('image/jpeg');
    expect(nar.sceneId).toBe('guide-test-room');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'desktop-labels-greeting.png') });
    expect(log.errors).toEqual([]);
    await page.close();
  }, T);

  test('hold T: records the mic, asks with a snapshot, speaks, highlights the TV; history grows', async () => {
    const { page, log } = await open('guide-test-room', '&narrate=never');
    await waitGuide(page, "d.labels.length === 4");
    await page.mouse.click(640, 400);
    await page.keyboard.down('KeyT');
    await waitGuide(page, "d.phase === 'listening'", 5000);
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(OUT, 'desktop-listening.png') });
    await page.keyboard.up('KeyT');
    await waitGuide(page, "d.lastAnswer.includes('Maya')");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, 'desktop-answer.png') });
    let r = (await requests()).filter((x) => x.endpoint === 'ask');
    expect(r.length).toBe(1);
    expect(r[0].audioType).toContain('audio/webm');
    expect(r[0].audioBytes).toBeGreaterThan(1000);
    expect(r[0].imageType).toBe('image/jpeg');
    expect(r[0].history).toBe(0);
    const d = await guide(page);
    expect(d.lastQuestion).toBe('Who won?');
    expect(d.mic).toBe('ready');
    // second question carries the first turn as history
    await page.keyboard.down('KeyT');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyT');
    await waitGuide(page, "d.lastAnswer.includes('Still Maya')");
    r = (await requests()).filter((x) => x.endpoint === 'ask');
    expect(r[1].history).toBe(1);
    // a tap is not a question
    const before = (await requests()).length;
    await page.keyboard.down('KeyT');
    await page.waitForTimeout(120);
    await page.keyboard.up('KeyT');
    await page.waitForTimeout(800);
    expect((await requests()).length).toBe(before);
    expect((await guide(page)).caption.answer).toContain('Hold');
    expect(log.errors).toEqual([]);
    await page.close();
  }, T);

  test('pointing at a label shows its blurb; clicking asks about it', async () => {
    const { page, log } = await open('guide-test-room', '&narrate=never');
    await waitGuide(page, "d.labelsShown === 4");
    await page.waitForTimeout(900);
    expect(await hoverLabel(page, 'Snack bowl')).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, 'desktop-hover.png') });
    await page.mouse.down();
    await page.mouse.up();
    await waitGuide(page, "d.lastAnswer.includes('crumbs')");
    const ask = (await requests()).filter((x) => x.endpoint === 'ask').pop()!;
    expect(ask.question).toBe('Tell me about the snack bowl.');
    expect(log.errors).toEqual([]);
    await page.close();
  }, T);

  test('labels are stored once and come back without asking the guide again', async () => {
    const before = (await requests()).filter((x) => x.endpoint === 'hotspots').length;
    const { page } = await open('guide-test-room', '&narrate=never');
    await waitGuide(page, "d.hotspotStatus === 'done' && d.labels.length === 4");
    const d = await guide(page);
    expect(d.hotspotSource).toBe('stored');
    expect((await requests()).filter((x) => x.endpoint === 'hotspots').length).toBe(before);
    await page.close();
  }, T);

  test('no depth map: labels from rays into the splats', async () => {
    const { page } = await open('guide-test-room-nodepth', '&narrate=never');
    await waitGuide(page, "d.hotspotStatus === 'done' && d.labels.length >= 3", 30_000);
    const d = await guide(page);
    expect(d.hotspotSource).toBe('input');
    for (const l of d.labels) {
      const spot = LOUNGE_SPOTS.find((s) => s.label === l.label)!;
      expect(['splats', 'voxels']).toContain(l.source);
      expect(Math.hypot(l.position[0] - spot.point[0], l.position[1] - spot.point[1], l.position[2] - spot.point[2])).toBeLessThan(0.35);
    }
    await page.screenshot({ path: join(OUT, 'desktop-nodepth.png') });
    await page.close();
  }, T);

  test('no input camera: labels from the overview snapshot', async () => {
    const { page } = await open('guide-test-nocam', '&narrate=never');
    await waitGuide(page, "d.hotspotStatus === 'done' || d.hotspotStatus === 'none'", 30_000);
    const d = await guide(page);
    expect(d.hotspotSource).toBe('snapshot');
    expect(d.labels.length).toBeGreaterThanOrEqual(1);
    await page.close();
  }, T);

  test('guide down: one friendly toast, a canned caption, no console errors, the world keeps running', async () => {
    await post('/harness/reset');
    await post('/harness/mode', { mode: 'down' });
    const { page, log } = await open('guide-test-room');
    await waitGuide(page, "d.offlineNotified && d.requests.narrate >= 1", 30_000);
    await page.evaluate(() => (window as any).__guide.ask('Who won?'));
    await waitGuide(page, "d.caption.mode === 'error' || d.caption.mode === 'speaking'");
    const d = await guide(page);
    expect(d.caption.answer).toContain("can't reach the guide");
    const toasts = await page.$$eval('.tw-toast', (els) => els.map((e) => e.textContent ?? ''));
    expect(toasts.filter((t) => t.includes('taking a break')).length).toBe(1);
    const fps = await page.evaluate(() => (window as any).__viewer.stats.fps);
    expect(fps).toBeGreaterThan(5);
    await page.screenshot({ path: join(OUT, 'desktop-guide-down.png') });
    expect(log.errors).toEqual([]);
    await post('/harness/mode', { mode: 'html' });
    await page.evaluate(() => (window as any).__guide.ask('Still there?'));
    await waitGuide(page, "d.lastError.includes('ask')");
    expect((await page.$$eval('.tw-toast', (els) => els.length))).toBeLessThanOrEqual(1);
    expect(log.errors).toEqual([]);
    await post('/harness/mode', { mode: 'ok' });
    await page.close();
  }, T);

  test('emulated Quest: hint panel, hold X to ask, XR snapshot, point and pull the trigger', async () => {
    await post('/harness/reset');
    const { page, log } = await open('guide-test-room', '&xremu=1&narrate=never');
    await waitGuide(page, "d.labelsShown === 4");
    await page.click('#tw-btn-vr');
    await page.waitForFunction(() => (window as any).__viewerApp?.xr?.presenting, null, { timeout: 20_000 });
    await page.waitForTimeout(1200);
    expect((await guide(page)).caption.mode).toBe('hint');
    await page.screenshot({ path: join(OUT, 'xr-hint.png') });

    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateButtonValue('x-button', 1));
    await waitGuide(page, "d.phase === 'listening'", 5000);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'xr-listening.png') });
    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateButtonValue('x-button', 0));
    await waitGuide(page, "d.lastAnswer.includes('Maya')");
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, 'xr-answer.png') });
    const d = await guide(page);
    expect(d.snapshot.xr).toBe(true);
    expect([d.snapshot.width, d.snapshot.height]).toEqual([1024, 768]);
    expect(d.snapshot.frameMs).toBeLessThan(40);
    const ask = (await requests()).filter((x) => x.endpoint === 'ask').pop()!;
    expect(ask.audioType).toContain('audio/webm');

    // aim the right controller at the TV label's pill
    await page.evaluate(() => {
      const app = (window as any).__viewerApp;
      const g = (window as any).__guide;
      const dev = (window as any).__xrDevice;
      const tv = g.hotspots.find((h: any) => h.label === 'TV screen');
      const V = app.camera.position.constructor;
      const Q = app.camera.quaternion.constructor;
      const M = app.rig.matrixWorld.constructor;
      app.rig.updateMatrixWorld();
      const inv = new M().copy(app.rig.matrixWorld).invert();
      const head = new V().setFromMatrixPosition(app.camera.matrixWorld);
      const dist = head.distanceTo(new V(...tv.position));
      const s = Math.min(3.5, Math.max(0.6, dist / 1.5));
      const target = new V(tv.position[0], tv.position[1] + 0.17 * s + 0.06 * s, tv.position[2]).applyMatrix4(inv);
      const from = new V(0.15, 1.25, -0.25);
      const dir = target.clone().sub(from).normalize();
      const q = new Q().setFromUnitVectors(new V(0, 0, -1), dir);
      dev.controllers.right.position.set(from.x, from.y, from.z);
      dev.controllers.right.quaternion.set(q.x, q.y, q.z, q.w);
    });
    await waitGuide(page, "d.hover === 'TV screen'", 5000);
    await page.screenshot({ path: join(OUT, 'xr-point.png') });
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('trigger', 1));
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('trigger', 0));
    await waitGuide(page, "d.lastAnswer.includes('scoreboard')");
    expect((await requests()).filter((x) => x.endpoint === 'ask').pop()!.question).toBe('Tell me about the TV screen.');
    expect(log.errors).toEqual([]);
    await page.evaluate(() => (window as any).__viewerApp.xr.exit());
    await page.close();
  }, T);
});
