// Browser checks for the viewer in headless Chrome (playwright-core). Opt-in because they need
// Chrome and the sample scenes:
//   VIEWER_E2E=1 bun test tests/viewer-e2e.test.ts
// Uses a harness already listening on VIEWER_E2E_PORT (default 8790) or starts
// tests/harness/viewer-serve.ts there. Screenshots go to data/evidence/viewer/e2e-*.png.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { chromium, type Browser, type Page } from 'playwright-core';

const ENABLED = process.env.VIEWER_E2E === '1';
const ROOT = resolve(import.meta.dir, '..');
const PORT = Number(process.env.VIEWER_E2E_PORT ?? 8790);
const BASE = `http://localhost:${PORT}`;
const OUT = join(ROOT, 'data', 'evidence', 'viewer');
const HAS_SAMPLES = existsSync(join(ROOT, 'data', 'scenes', 'sample-painted-bedroom', 'world.spz'));
const T = 120_000;

let server: Subprocess | null = null;
let browser: Browser;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function open(scene: string, extra = '', viewport = { width: 1280, height: 800 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/view?scene=${scene}&intro=0${extra}`);
  await page.waitForFunction(() => (window as any).__viewer?.ready || (window as any).__viewer?.error, null, { timeout: 90_000 });
  await page.evaluate(() => {
    const h = document.getElementById('tw-help');
    if (h) h.hidden = true;
  });
  return page;
}

const viewer = (page: Page) => page.evaluate(() => (window as any).__viewer);

describe.skipIf(!ENABLED || !HAS_SAMPLES)('viewer in headless Chrome', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    if (!(await healthy())) {
      server = Bun.spawn(['bun', join(ROOT, 'tests/harness/viewer-serve.ts')], { env: { ...process.env, PORT: String(PORT) }, stdout: 'ignore', stderr: 'inherit' });
      for (let i = 0; i < 50 && !(await healthy()); i++) await Bun.sleep(200);
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  }, T);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  test('painted bedroom: upright, floor at the feet, facing the room', async () => {
    const page = await open('sample-painted-bedroom');
    const v = await viewer(page);
    expect(v.error).toBeNull();
    expect(v.info.splats).toBe(500000);
    expect(Math.abs(v.info.floorY - -1.11)).toBeLessThan(0.05);
    expect(v.info.spawn.y).toBe(0);
    expect(v.player.eyeY).toBeCloseTo(1.6, 1);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(OUT, 'e2e-bedroom-spawn.png') });
    // the picture is not a void: sample the canvas centre brightness
    const lum = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          // read the default framebuffer right after a render, before it is presented
          const r = (window as any).__viewerApp.renderer;
          const orig = r.render.bind(r);
          r.render = (s: unknown, c: unknown) => {
            orig(s, c);
            r.render = orig;
            const gl = r.getContext() as WebGL2RenderingContext;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let sum = 0, n = 0;
            for (let i = 0; i < px.length; i += 4 * 97) {
              sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
              n++;
            }
            resolve(sum / n);
          };
        }),
    );
    expect(lum).toBeGreaterThan(60);
    await page.close();
  }, T);

  test('walking: W moves forward, walls stop the walker, R returns to spawn', async () => {
    const page = await open('sample-painted-bedroom');
    await page.mouse.click(640, 400);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    let p = (await viewer(page)).player;
    expect(p.z).toBeLessThan(-1.0);
    // face the right-hand wall and keep walking into it
    await page.evaluate(() => {
      const a = (window as any).__viewerApp;
      a.player.place(a.player.pos.x, a.player.pos.y, a.player.pos.z, -Math.PI / 2, 0);
    });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(5000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    p = (await viewer(page)).player;
    const b = (await viewer(page)).info.bounds;
    expect(p.x).toBeLessThan(b.max[0] + 0.5);
    await page.screenshot({ path: join(OUT, 'e2e-bedroom-wall.png') });
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(1200);
    p = (await viewer(page)).player;
    expect(Math.hypot(p.x, p.z)).toBeLessThan(0.3);
    await page.close();
  }, T);

  test('emulated Quest: enter VR, stick walk, snap turn, B back to spawn, exit', async () => {
    const page = await open('sample-painted-bedroom', '&xremu=1');
    expect(await page.isVisible('#tw-btn-vr')).toBe(true);
    await page.click('#tw-btn-vr');
    await page.waitForFunction(() => (window as any).__viewerApp?.xr?.presenting, null, { timeout: 20_000 });
    await page.waitForTimeout(800);
    const rig = () => page.evaluate(() => {
      const a = (window as any).__viewerApp;
      return { x: a.rig.position.x, z: a.rig.position.z, yaw: a.rig.rotation.y, snaps: a.xr.debug.snapTurns };
    });
    const r0 = await rig();
    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as any).__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
    await page.waitForTimeout(300);
    const r1 = await rig();
    expect(r1.z).toBeLessThan(r0.z - 0.25);
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0));
    await page.waitForTimeout(250);
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0));
    await page.waitForTimeout(250);
    const r2 = await rig();
    expect(r2.snaps).toBe(1);
    expect(Math.abs(r2.yaw - r1.yaw + Math.PI / 6)).toBeLessThan(0.01);
    await page.screenshot({ path: join(OUT, 'e2e-xr.png') });
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('b-button', 1));
    await page.waitForTimeout(150);
    await page.evaluate(() => (window as any).__xrDevice.controllers.right.updateButtonValue('b-button', 0));
    await page.waitForTimeout(700);
    const r3 = await rig();
    expect(Math.abs(r3.z - r0.z)).toBeLessThan(0.1);
    await page.evaluate(() => (window as any).__viewerApp.xr.exit());
    await page.waitForFunction(() => !(window as any).__viewerApp.xr.presenting, null, { timeout: 10_000 });
    await page.close();
  }, T);

  test('unknown scene shows an actionable error', async () => {
    const page = await open('no-such-scene-here');
    const v = await viewer(page);
    expect(v.ready).toBe(false);
    expect(String(v.error)).toContain('no-such-scene-here');
    expect(await page.isVisible('#tw-loader-note a')).toBe(true);
    await page.close();
  }, T);

  test('synthetic PLY room with a GLB collider', async () => {
    const page = await open('viewer-test-collider');
    const v = await viewer(page);
    expect(Math.abs(v.info.floorY - -1.45)).toBeLessThan(0.03);
    expect(await page.evaluate(() => !!(window as any).__viewerApp.collider)).toBe(true);
    await page.evaluate(() => {
      const a = (window as any).__viewerApp;
      a.player.place(0, 0, 0, -Math.PI / 2, 0);
    });
    await page.mouse.click(640, 400);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    await page.keyboard.up('KeyW');
    const p = (await viewer(page)).player;
    expect(p.x).toBeGreaterThan(1.9);
    expect(p.x).toBeLessThan(2.4 - 0.2);
    await page.close();
  }, T);

  test('Third Wheel scene: play button starts the video layer', async () => {
    if (!existsSync(join(ROOT, 'data', 'scenes', 'test-thirdwheel', 'scene.json'))) return;
    const page = await open('test-thirdwheel');
    expect(await page.isVisible('#tw-transport')).toBe(true);
    await page.click('#tw-btn-play');
    await page.waitForTimeout(1200);
    const playing = await page.evaluate(() => {
      const a = (window as any).__viewerApp;
      return { playing: a.video?.playing, t: a.video?.currentTime };
    });
    expect(playing.playing).toBe(true);
    expect(playing.t).toBeGreaterThan(0.3);
    await page.screenshot({ path: join(OUT, 'e2e-thirdwheel.png') });
    await page.close();
  }, T);
});
