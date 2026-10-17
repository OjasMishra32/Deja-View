// End-to-end smoke of the live layer in the real viewer, headless Chrome, against a running server and both
// stand-ins (bun run demo:mocks; server started with DS_URL / GUIDE_URL pointing at them):
//
//   bun tests/harness/live-smoke.ts [outDir]
//   BASE=http://127.0.0.1:8787 SCENE=fortnite-brick-house DS_URL=http://127.0.0.1:8794 DS_KEY=dev-ds-key
//
// Opens /view?scene=<SCENE>, walks a fake Roblox player around at 4 Hz for 10 s, pins a note on the live map
// service, fires a tag, flips the reality check from the HUD button, and checks in the page (window.__social.debug,
// window.__viewer) that the ghost, the note and the TAGGED moment arrived. Screenshots go to outDir
// (default data/evidence/wiring). Labels the stand-in guide makes are removed again unless KEEP_LABELS=1, so a
// smoke run never leaves made-up labels in a demo world. Exit code 0 when everything arrived.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SCENE = process.env.SCENE ?? 'fortnite-brick-house';
const DS = process.env.DS_URL ?? 'http://127.0.0.1:8794';
const DS_KEY = process.env.DS_KEY ?? 'dev-ds-key';
const ROOT = resolve(import.meta.dir, '../..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'data/evidence/wiring'));
const DATA = resolve(process.env.THIRDWHEEL_DATA ?? join(ROOT, 'data'));
const FOLLOW = process.env.FOLLOW_SCENE ?? 'test-tw-local';
const NEXT = process.env.NEXT_SCENE ?? SCENE;
// labels the stand-in guide places in these worlds are removed again at the end (unless they were there before)
const LABEL_FILES = [...new Set([SCENE, FOLLOW, NEXT])].map((id) => join(DATA, 'scenes', id, 'hotspots.json'));
const STUDS = 3.57;
mkdirSync(OUT, { recursive: true });

const results: Record<string, boolean> = {};
const check = (name: string, ok: boolean, detail = '') => {
  results[name] = ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const social = (page: Page) => page.evaluate(() => (window as any).__social?.debug ?? null);
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  shot ${name}.png  social=${JSON.stringify(await social(page))}`);
}
async function waitIn(page: Page, fn: string, ms: number): Promise<boolean> {
  try {
    await page.waitForFunction(fn, null, { timeout: ms, polling: 100 });
    return true;
  } catch {
    return false;
  }
}

const labelsBefore = new Map(LABEL_FILES.map((f) => [f, existsSync(f)]));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let walker: ReturnType<typeof setInterval> | null = null;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [page error] ${m.text().slice(0, 300)}`);
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/view?scene=${SCENE}&intro=0&name=Visitor`);
  const opened = await waitIn(page, '(() => { const v = window.__viewer; return (v && v.ready && v.social) || (v && v.error); })()', 300_000);
  const err = await page.evaluate(() => (window as any).__viewer?.error ?? null);
  check('viewer opened the world', opened && !err, err ? `error: ${err}` : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!opened || err) throw new Error('viewer did not open');
  await page.evaluate(() => {
    const h = document.getElementById('tw-help');
    if (h) h.hidden = true;
    const w = window as any;
    // independent witnesses: our own /ws listener and the TAGGED flash in the DOM
    w.__smoke = { ws: [] as unknown[], tagged: false };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onmessage = (e) => w.__smoke.ws.push(JSON.parse(e.data));
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.dvs-flash__word')) if (/TAGGED/.test(el.textContent ?? '')) w.__smoke.tagged = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  check('one shared /ws connection is up', await waitIn(page, 'window.__viewer.socket === true', 10_000));
  await page.waitForTimeout(1500);
  await shot(page, 'wiring-1-open');

  // a Roblox player walking a circle 2.5 m in front of the spawn, 4 Hz for 10 s (studs on the wire)
  let ticks = 0;
  let posted = 0;
  const step = async () => {
    const a = ticks++ * 0.25 * 0.6;
    const x = Math.sin(a) * 1.2, z = -2.5 + Math.cos(a) * 1.2;
    const yaw = -a - Math.PI / 2;
    const r = await fetch(`${BASE}/api/roblox/${SCENE}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'smoke', players: [{ id: 'rbx-777', name: 'shivin', x: x * STUDS, y: 0, z: z * STUDS, yaw }] }),
    }).catch(() => null);
    if (r?.ok) posted++;
  };
  await step();
  walker = setInterval(() => void step(), 250);
  const ghost = await waitIn(page, '(window.__social?.debug?.people ?? 0) >= 1', 6000);
  await page.waitForTimeout(1200);
  check('the Roblox ghost arrived', ghost, `people=${(await social(page))?.people}`);
  await shot(page, 'wiring-2-ghost');

  // a note pinned on the live map service, 1.4 m up, in front of the spawn
  const text = "Seb's seat. He was too scared to show up.";
  const before = Number((await social(page))?.notes ?? 0);
  const noteRes = await fetch(`${DS}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DejaView-Key': DS_KEY },
    body: JSON.stringify({ sceneId: SCENE, author: 'Brianna', text, x: 0.6, y: 1.4, z: -1.8 }),
  });
  const noteId = noteRes.status === 201 ? ((await noteRes.json()) as { note?: { id?: string } }).note?.id : undefined;
  check('the live map service took the note', !!noteId, `status ${noteRes.status} id ${noteId}`);
  const tNote = Date.now();
  const note = await waitIn(page, `(window.__social?.debug?.notes ?? 0) > ${before} && window.__smoke.ws.some((m) => m.type === 'note' && m.note && m.note.id === ${JSON.stringify(noteId ?? '')})`, 8000);
  check('the note popped up in the viewer', note, `${((Date.now() - tNote) / 1000).toFixed(1)} s after posting (notes ${before} -> ${(await social(page))?.notes})`);
  await page.waitForTimeout(900);
  await shot(page, 'wiring-3-note');

  // the tag moment
  const tagRes = await fetch(`${BASE}/api/roblox/${SCENE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tag', by: 'quest-1', target: 'rbx-777' }),
  });
  check('the server took the tag', tagRes.ok, `status ${tagRes.status}`);
  const tagged = await waitIn(page, 'window.__smoke.tagged === true', 3000);
  const wsTag = await page.evaluate(() => (window as any).__smoke.ws.find((m: any) => m.type === 'roblox') ?? null);
  check('TAGGED played in the viewer', tagged, `/ws roblox=${JSON.stringify(wsTag)}`);
  await page.waitForTimeout(250);
  await shot(page, 'wiring-4-tagged');

  // keep walking until the 10 s are up
  while (ticks < 40) await Bun.sleep(100);
  if (walker) clearInterval(walker);
  walker = null;
  check('Roblox presence at 4 Hz for 10 s', posted >= 36, `${posted}/${ticks} posts accepted`);

  // the reality check from the HUD button
  const button = await page.$('#tw-btn-reality');
  check('the reality-check button is on the HUD', !!button && (await button.isVisible()));
  if (button) {
    await button.click();
    const on = await waitIn(page, "window.__social?.debug?.reality?.phase === 'on' || document.getElementById('tw-btn-reality')?.classList.contains('is-active')", 120_000);
    await page.waitForTimeout(3500);
    check('the reality check turned on', on, JSON.stringify((await social(page))?.reality));
    await shot(page, 'wiring-5-reality');
  }

  // the guide: its UI is up and it asked for labels (stand-in guide)
  const guide = await page.evaluate(() => (window as any).__viewer?.guide ?? null);
  check('the guide is running', !!guide?.started, JSON.stringify({ hotspotStatus: guide?.hotspotStatus, hotspotSource: guide?.hotspotSource, labels: guide?.labels?.length }));
  const mic = await page.$('.dvg-mic');
  check('the mic button is on the HUD', !!mic && (await mic.isVisible()));
  await page.waitForTimeout(2500);
  await shot(page, 'wiring-6-labels');
  await page.close();

  // follow mode (?follow=1, the headset in the demo): host cues flip the reality check and open another world
  const fp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  fp.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  await fp.goto(`${BASE}/view?scene=${FOLLOW}&intro=0&follow=1`);
  const fOpen = await waitIn(fp, '(() => { const v = window.__viewer; return v && v.ready && v.socket === true; })()', 300_000);
  check('follow mode: the world opened with the socket up', fOpen);
  if (fOpen) {
    await fp.waitForTimeout(4000); // the reality parts preload 3.5 s after start
    const cue = (body: unknown) => fetch(`${BASE}/api/host/cue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    check('the host cue was accepted', (await cue({ action: 'reality', on: true, by: 'host' })).ok);
    const on = await waitIn(fp, "window.__social?.debug?.reality?.phase === 'on'", 60_000);
    check('follow mode: the reality cue was obeyed', on, JSON.stringify((await social(fp))?.reality));
    await fp.waitForTimeout(2500);
    await fp.screenshot({ path: join(OUT, 'wiring-7-follow-reality.png') });
    await cue({ action: 'labels', on: false });
    await cue({ action: 'load', sceneId: NEXT, by: 'host' });
    let moved = false;
    try {
      await fp.waitForURL((u) => u.searchParams.get('scene') === NEXT, { timeout: 15_000 });
      moved = true;
    } catch {
      moved = false;
    }
    check('follow mode: the load cue opened the next world', moved, fp.url());
  }
  await fp.close();
} catch (e) {
  console.log(`smoke stopped: ${(e as Error).message}`);
} finally {
  if (walker) clearInterval(walker);
  await browser.close();
  // a moment for the last label PUT to land, then put the label files back the way they were
  await Bun.sleep(1500);
  for (const [file, existed] of labelsBefore) {
    if (!existed && existsSync(file) && process.env.KEEP_LABELS !== '1') {
      rmSync(file);
      console.log(`  removed the stand-in guide's labels (${file})`);
    }
  }
}
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k);
console.log(failed.length ? `\n${failed.length} check(s) failed: ${failed.join('; ')}` : '\nall checks passed');
process.exit(failed.length || !Object.keys(results).length ? 1 : 0);
