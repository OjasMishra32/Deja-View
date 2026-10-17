// The /host page against fixture data (default port 8821; use 8820-8839). Independent of server/index.ts.
//   bun tests/harness/host-harness.ts                       serve http://127.0.0.1:8821/host
//   bun tests/harness/host-harness.ts --shots [outDir]      serve, screenshot every state, exit (data/evidence/host)
//
// /host is web/host.html through Bun's HTML import. /api/host/status is the real server/host.ts aggregator and
// /api/host/cue the real server/cue.ts route, both over fake dependencies: no HiPerGator, guide, DeepSpace or
// tunnel is contacted. The worlds are the scenes in data/scenes (read only) plus two fixtures: "Game night" (ready)
// and "Judge's photo" (building), whose thumbnails are borrowed from real scenes.
//
// States (POST /harness/state?name=...):
//   green      everything up: GPU awake, guide ok, DeepSpace pushing, public link live, headset + 2 Roblox players
//   down       GPU asleep, guide down, no public link (the rest as green)
//   building   as green, and "Judge's photo" building at 60% (pushed on /ws like a real job)
// Other controls (POST): /harness/progress?p=0.8   /harness/ready   /harness/feed (a tag round, a tag, a note, a cue)

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';
import type { HealthInfo, Scene, ServerEvent } from '../../shared/types.ts';
import { createCueRoute } from '../../server/cue.ts';
import { createHostRoutes } from '../../server/host.ts';
import type { WorkerStatus } from '../../server/hpg.ts';
import type { CallResult } from '../../server/integrations/config.ts';
import { PresenceStore } from '../../server/social/presence.ts';
import page from '../../web/host.html';

const ROOT = resolve(import.meta.dir, '../..');
const SCENES = join(ROOT, 'data', 'scenes');
const PORT = Number(process.env.PORT ?? 8821);
const TUNNEL = 'https://brave-otter.trycloudflare.com';

type State = 'green' | 'down' | 'building';
let state: State = 'green';
/** The first status request after a state change skips the probe caches (as ?refresh=1 does). */
let forceNext = false;

// ---- scenes ---------------------------------------------------------------------------------------

/** Fixture scenes, with the real file their thumbnail is served from. */
const fixtures = new Map<string, { scene: Scene; thumbFrom: string }>();
const now = () => new Date().toISOString();

function addFixture(scene: Scene, thumbFrom: string) {
  fixtures.set(scene.id, { scene, thumbFrom });
}

addFixture(
  { id: 'game-night-k3x9a', name: 'Game night', mode: 'thirdwheel', status: 'ready', stage: 'Ready', progress: 1, createdAt: '2026-10-17T19:30:00.000Z', updatedAt: '2026-10-17T19:40:00.000Z', thumb: 'thumb.jpg', world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'flashworld' } },
  join(SCENES, 'test-thirdwheel', 'thumb.jpg'),
);

const JUDGE = 'judge-photo-x7k2p';
function judgeScene(status: Scene['status'], progress: number, stage: string): Scene {
  return { id: JUDGE, name: "Judge's photo", mode: 'rentfree', status, stage, progress, createdAt: '2026-10-17T22:00:00.000Z', updatedAt: now(), thumb: 'thumb.jpg', input: { files: ['input/00.jpg'] }, ...(status === 'ready' ? { world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'flashworld' } } : {}) } as Scene;
}

function realScenes(): Scene[] {
  if (!existsSync(SCENES)) return [];
  const out: Scene[] = [];
  for (const id of readdirSync(SCENES)) {
    try {
      out.push(JSON.parse(readFileSync(join(SCENES, id, 'scene.json'), 'utf8')) as Scene);
    } catch {
      /* not a scene */
    }
  }
  return out;
}

function allScenes(): Scene[] {
  const list = [...realScenes(), ...[...fixtures.values()].map((f) => f.scene)];
  return list.filter((s) => s.id !== JUDGE || state === 'building').sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

const getScene = async (id: string) => allScenes().find((s) => s.id === id) ?? null;

// ---- fake dependencies ------------------------------------------------------------------------------

const BEAT = () => new Date(Date.now() - 8000).toISOString();

function health(): HealthInfo {
  const alive = state !== 'down';
  return {
    ok: true,
    version: '0.1.0',
    https: true,
    lan: ['https://192.168.1.20:8787'],
    hpg: { online: true, user: 'someone', worker: { alive, gpu: 'NVIDIA RTX 6000 Ada Generation', host: 'c0900a-s1', lastBeat: alive ? BEAT() : new Date(Date.now() - 3 * 3600_000).toISOString() } },
    space: { available: false },
    local: { python: true },
  };
}

function worker(): WorkerStatus {
  return state === 'down'
    ? { alive: false, lastBeat: new Date(Date.now() - 3 * 3600_000).toISOString(), age: 3 * 3600 }
    : { alive: true, gpu: 'NVIDIA RTX 6000 Ada Generation', host: 'c0900a-s1', lastBeat: BEAT(), age: 8, status: state === 'building' ? 'busy' : 'idle' };
}

const guideUp: CallResult = { kind: 'ok', status: 200, body: { ok: true, gemini: 'ok', mock: false }, text: '', ms: 14 };
const guideDown: CallResult = { kind: 'offline', status: 0, body: null, text: null, ms: 2, detail: 'ECONNREFUSED' };

const presence = new PresenceStore({ ttlMs: 1e9, log: () => {} });
const person = (id: string, name: string, kind: 'vr' | 'roblox' | 'web', x: number, z: number) => ({ id, name, kind, x, y: 0, z, yaw: 0 });
presence.upsert('game-night-k3x9a', person('quest-1', 'Judge', 'vr', 0, 0));
presence.upsert('game-night-k3x9a', person('rbx-12345', 'shivin', 'roblox', 1.1, -2.4));
presence.upsert('game-night-k3x9a', person('rbx-67890', 'brianna', 'roblox', -0.6, -1.9));

const okAt = () => Date.now() - 300;
const hostRoutes = createHostRoutes({
  health: async () => health(),
  worker: async () => worker(),
  listScenes: async () => allScenes(),
  presence,
  guide: {
    enabled: true,
    status: () => ({ enabled: true, host: '127.0.0.1:8795', up: state !== 'down', lastOkAt: okAt(), lastError: state === 'down' ? 'ECONNREFUSED' : null, lastMs: { ask: 1400 }, calls: 12, failures: 0 }),
    health: async () => (state === 'down' ? guideDown : guideUp),
  },
  deepspace: {
    status: () => ({
      enabled: true,
      host: 'dejaview-live.app.space',
      presence: { enabled: true, host: 'dejaview-live.app.space', up: true, lastOkAt: okAt(), lastError: null, pushes: 1840, failures: 0, skippedInFlight: 0, skippedBackoff: 0, scenes: ['game-night-k3x9a'], inFlight: 0 },
      notes: { enabled: true, host: 'dejaview-live.app.space', up: true, lastOkAt: okAt(), lastError: null, scenes: ['game-night-k3x9a'], polls: 220, failures: 0 },
    }),
  },
  publicUrl: async () => (state === 'down' ? null : TUNNEL),
  // the public link "answers" without leaving this machine
  fetch: async () => Response.json({ ok: true }),
  waitMs: 1500,
});

// ---- server ------------------------------------------------------------------------------------------

const sockets = new Set<ServerWebSocket<unknown>>();
const cues: ServerEvent[] = [];
function broadcast(m: ServerEvent | Record<string, unknown>) {
  const s = JSON.stringify(m);
  for (const ws of sockets) ws.send(s);
}
const cueRoute = createCueRoute({
  getScene,
  publish: (e) => {
    cues.push(e);
    broadcast(e);
  },
});

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

function file(path: string): Response {
  if (!existsSync(path) || !statSync(path).isFile()) return json({ error: 'Not found.' }, 404);
  return new Response(Bun.file(path), { headers: { 'content-type': MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
}

function setState(name: string): boolean {
  if (name !== 'green' && name !== 'down' && name !== 'building') return false;
  state = name;
  forceNext = true;
  if (state === 'building') {
    const s = judgeScene('running', 0.6, 'Generating the room');
    addFixture(s, join(SCENES, 'fortnite-brick-apartment', 'thumb.jpg'));
  }
  return true;
}

async function playFeed() {
  const t = () => Date.now() / 1000;
  const steps: Array<() => void> = [
    () => broadcast({ type: 'cue', action: 'load', sceneId: 'game-night-k3x9a', by: 'bot', at: t() }),
    () => broadcast({ type: 'cue', action: 'reality', on: true, by: 'host', at: t() }),
    () => broadcast({ type: 'roblox', sceneId: 'game-night-k3x9a', event: { type: 'round', state: 'start', duration: 25, scores: { 'quest-1': 0, 'rbx-12345': 0, 'rbx-67890': 0 }, t: t() } }),
    () => broadcast({ type: 'roblox', sceneId: 'game-night-k3x9a', event: { type: 'tag', by: 'quest-1', target: 'rbx-12345', targetName: 'shivin', t: t() } }),
    () => broadcast({ type: 'roblox', sceneId: 'game-night-k3x9a', event: { type: 'round', state: 'end', scores: { 'quest-1': 4, 'rbx-12345': 0, 'rbx-67890': 2 }, t: t() } }),
    () => broadcast({ type: 'note', sceneId: 'game-night-k3x9a', note: { id: 'n_8f2k1q', sceneId: 'game-night-k3x9a', author: 'Brianna', text: "Seb's seat. He was too scared to show up.", x: 1.2, y: 1.4, z: -0.8, createdAt: now() } }),
  ];
  for (const s of steps) {
    s();
    await Bun.sleep(60);
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  development: { hmr: false, console: true },
  routes: {
    '/host': page,
    '/api/host/status': (req, srv) => {
      if (!forceNext) return hostRoutes['/api/host/status']!(req, srv);
      forceNext = false;
      const url = new URL(req.url);
      url.searchParams.set('refresh', '1');
      return hostRoutes['/api/host/status']!(new Request(url, req), srv);
    },
    '/api/host/cue': (req, srv) => cueRoute(req, srv),
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/ws') return srv.upgrade(req) ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
    if (path === '/api/scenes') return json(allScenes());
    if (path === '/api/health') return json(health());
    const m = /^\/data\/scenes\/([^/]+)\/(.+)$/.exec(path);
    if (m) {
      const fx = fixtures.get(m[1]!);
      if (fx && m[2] === 'thumb.jpg') return file(fx.thumbFrom);
      if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(m[1]!) || m[2]!.includes('..')) return json({ error: 'Not found.' }, 404);
      return file(join(SCENES, m[1]!, m[2]!));
    }
    if (path.startsWith('/harness/') && req.method === 'POST') {
      const q = url.searchParams;
      if (path === '/harness/state') {
        if (!setState(q.get('name') ?? '')) return json({ error: 'unknown state' }, 400);
        if (state === 'building') broadcast({ type: 'scene', scene: fixtures.get(JUDGE)!.scene });
        return json({ ok: true, state });
      }
      if (path === '/harness/progress') {
        const s = judgeScene('running', Number(q.get('p') ?? 0.8), q.get('stage') ?? 'Generating the room');
        addFixture(s, join(SCENES, 'fortnite-brick-apartment', 'thumb.jpg'));
        broadcast({ type: 'scene', scene: s });
        return json({ ok: true });
      }
      if (path === '/harness/ready') {
        const s = judgeScene('ready', 1, 'Ready');
        addFixture(s, join(SCENES, 'fortnite-brick-apartment', 'thumb.jpg'));
        broadcast({ type: 'scene', scene: s });
        return json({ ok: true });
      }
      if (path === '/harness/feed') {
        await playFeed();
        return json({ ok: true });
      }
      if (path === '/harness/cues') return json({ cues });
      return json({ error: 'unknown control' }, 404);
    }
    if (path === '/') return Response.redirect('/host', 302);
    return json({ error: 'Not found.' }, 404);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: 'health', health: health() }));
    },
    message() {},
    close(ws) {
      sockets.delete(ws);
    },
  },
});

const BASE = `http://127.0.0.1:${server.port}`;
console.log(`host harness on ${BASE}/host (state: ${state})`);

// ---- screenshots ------------------------------------------------------------------------------------------

async function shots(outDir: string): Promise<number> {
  const { chromium } = await import('playwright-core');
  mkdirSync(outDir, { recursive: true });
  const control = (p: string) => fetch(`${BASE}/harness/${p}`, { method: 'POST' }).then((r) => r.json());
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems: string[] = [];
  const views = [
    { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    { name: 'laptop', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  ];
  const pins = JSON.stringify(['game-night-k3x9a', 'fortnite-tilted-night', 'fortnite-brick-house']);
  try {
    for (const v of views) {
      for (const st of ['green', 'down', 'building'] as const) {
        await control(`state?name=${st}`);
        const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, isMobile: v.isMobile, hasTouch: v.hasTouch });
        await ctx.addInitScript((p) => {
          try {
            localStorage.setItem('dv.host.pins', p);
          } catch {}
        }, pins);
        const pageH = await ctx.newPage();
        pageH.on('console', (m) => {
          if (m.type() === 'error') problems.push(`${v.name}/${st} console: ${m.text().slice(0, 200)}`);
        });
        pageH.on('pageerror', (e) => problems.push(`${v.name}/${st} page error: ${e.message}`));
        await pageH.goto(`${BASE}/host`);
        await pageH.waitForSelector('.h-world', { timeout: 15_000 });
        await pageH.waitForFunction(() => document.querySelector('#live-txt')?.textContent === 'live', null, { timeout: 10_000 });
        if (st === 'building') {
          // the finale: progress arrives on /ws
          await control('progress?p=0.6');
        } else {
          await control('feed');
        }
        await pageH.waitForTimeout(700);
        // body hides horizontal overflow, so measure what sticks out past the right edge
        // (a phone browser widens innerWidth to fit overflow, so compare with the viewport we asked for)
        const over = await pageH.evaluate((w) => {
          let right = 0;
          for (const el of document.querySelectorAll('header *, main *')) right = Math.max(right, el.getBoundingClientRect().right);
          return Math.round(Math.max(right, document.documentElement.scrollWidth) - w);
        }, v.viewport.width);
        if (over > 0) problems.push(`${v.name}/${st}: something sticks out ${over}px past the right edge`);
        const tiles = await pageH.$$eval('.h-tile', (els) => els.map((e) => `${(e.querySelector('.h-tile-name') as HTMLElement).innerText}: ${(e.querySelector('.h-tile-text') as HTMLElement).innerText} [${e.className.replace('h-tile ', '')}]`));
        console.log(`${v.name}/${st}: ${tiles.join(' | ')}`);
        if (st === 'building') {
          await pageH.waitForSelector('#live-section:not([hidden]) .h-world.building', { timeout: 5000 });
          // on the phone the live build sits below the status and the cues: show it
          if (v.name === 'phone') await pageH.evaluate(() => window.scrollTo(0, (document.getElementById('live-section')?.offsetTop ?? 0) - 70));
          await pageH.waitForTimeout(300);
        }
        await pageH.screenshot({ path: join(outDir, `host-${st}-${v.name}.png`) });
        if (v.name === 'phone') await pageH.screenshot({ path: join(outDir, `host-${st}-${v.name}-full.png`), fullPage: true });
        await ctx.close();
      }
    }

    // interactions on the phone: open a pinned world, flip the reality check, watch a build finish
    await control('state?name=building');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript((p) => {
      try {
        localStorage.setItem('dv.host.pins', p);
      } catch {}
    }, pins);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`interaction page error: ${e.message}`));
    await p.goto(`${BASE}/host`);
    await p.waitForSelector('.h-slot [data-open]');
    await p.waitForFunction(() => document.querySelector('#live-txt')?.textContent === 'live', null, { timeout: 10_000 });
    const before = ((await control('cues')) as { cues: unknown[] }).cues.length;
    await p.click('.h-slot[data-id="fortnite-tilted-night"] [data-open]');
    await p.waitForSelector('.h-slot[data-id="fortnite-tilted-night"] .sent', { timeout: 5000 });
    await p.click('#t-reality');
    await p.waitForFunction(() => document.querySelector('#t-reality')?.getAttribute('aria-checked') === 'true');
    await p.waitForTimeout(400);
    const after = ((await control('cues')) as { cues: Array<Record<string, unknown>> }).cues.slice(before);
    console.log(`cues the harness received: ${JSON.stringify(after.map(({ at, ...c }) => c))}`);
    if (!after.some((c) => c.action === 'load' && c.sceneId === 'fortnite-tilted-night' && c.by === 'host')) problems.push('the load cue did not arrive');
    if (!after.some((c) => c.action === 'reality' && c.on === true && c.by === 'host')) problems.push('the reality cue did not arrive');
    await p.screenshot({ path: join(outDir, 'host-interaction-sent-phone.png') });
    await control('ready');
    await p.waitForSelector(`.h-world.fresh[data-id="${JUDGE}"] [data-open]`, { timeout: 5000 });
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(outDir, 'host-interaction-ready-phone.png') });
    const feed = await p.$$eval('#feed li span:last-child', (els) => els.map((e) => (e as HTMLElement).innerText));
    console.log(`feed: ${JSON.stringify(feed)}`);
    if (!feed.includes("Judge's photo is ready")) problems.push('the feed did not say the world is ready');
    // the pin chooser
    await p.click(`.h-world[data-id="${JUDGE}"] [data-pin]`);
    await p.click(`.h-world[data-id="${JUDGE}"] [data-slot="2"]`);
    const stored = await p.evaluate(() => localStorage.getItem('dv.host.pins'));
    console.log(`pins after pinning the new world as the backup: ${stored}`);
    if (!stored?.includes(JUDGE)) problems.push('pinning did not stick');
    await ctx.close();
  } finally {
    await browser.close();
  }
  for (const pr of problems) console.log(`PROBLEM ${pr}`);
  console.log(`screenshots in ${outDir}`);
  return problems.length ? 1 : 0;
}

if (process.argv.includes('--shots')) {
  const i = process.argv.indexOf('--shots');
  const out = resolve(process.argv[i + 1] && !process.argv[i + 1]!.startsWith('-') ? process.argv[i + 1]! : join(ROOT, 'data', 'evidence', 'host'));
  const code = await shots(out);
  server.stop(true);
  process.exit(code);
}
