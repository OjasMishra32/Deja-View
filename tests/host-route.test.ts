// GET /api/host/status over HTTP (server/host.ts): the same guard and DV_KEY rules as POST /api/host/cue, no CORS on
// the answer, and no warm-up route (nothing on the server can start the worker).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { HealthInfo } from '../shared/types.ts';
import { createHostRoutes, type HostDeps } from '../server/host.ts';

const HEALTH: HealthInfo = {
  ok: true,
  version: '0.1.0',
  https: false,
  lan: [],
  hpg: { online: true, user: 'someone', worker: { alive: true, gpu: 'L4' } },
  space: { available: false },
  local: { python: true },
};

function serve(deps: Partial<HostDeps>): { server: Server<undefined>; base: string } {
  const routes = createHostRoutes({ health: async () => HEALTH, listScenes: async () => [], waitMs: 200, ...deps });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => {
      const fn = routes[new URL(req.url).pathname];
      return fn ? fn(req, srv) : Response.json({ error: 'Not found.' }, { status: 404 });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe('host status route with DV_KEY set', () => {
  let s: { server: Server<undefined>; base: string };
  let forced = 0;
  beforeAll(() => {
    s = serve({
      dvKey: 'k3y',
      health: async (force) => {
        if (force) forced++;
        return HEALTH;
      },
    });
  });
  afterAll(() => s.server.stop(true));
  const get = (headers: Record<string, string> = {}, q = '') => fetch(`${s.base}/api/host/status${q}`, { headers });

  test('from this machine: no key needed; private JSON (no CORS, not cached)', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.checks.gpu.text).toBe('Awake on L4');
    expect(body.gpu.canWarm).toBe(false);
  });

  test('the app page itself (same origin) is fine', async () => {
    expect((await get({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await get({ Origin: s.base })).status).toBe(200);
  });

  test('through the tunnel: the key is required', async () => {
    const tunnel = { 'cf-connecting-ip': '203.0.113.9' };
    const no = await get(tunnel);
    expect(no.status).toBe(401);
    expect(await no.json()).toEqual({ error: 'Bad key' });
    expect((await get({ ...tunnel, 'x-dejaview-key': 'wrong' })).status).toBe(401);
    expect((await get({ ...tunnel, 'x-dejaview-key': 'k3y' })).status).toBe(200);
  });

  test('a page on another site is refused, even from this machine; the key lets a script through', async () => {
    const evil = await get({ Origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: 'This action only works from the Déjà View app.' });
    expect((await get({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await get({ Origin: 'http://evil.example', 'x-dejaview-key': 'k3y' })).status).toBe(200);
  });

  test('?refresh=1 re-probes; HEAD has no body; other methods are refused', async () => {
    const before = forced;
    await get({}, '?refresh=1');
    expect(forced).toBe(before + 1);
    const head = await fetch(`${s.base}/api/host/status`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${s.base}/api/host/status`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect((await fetch(`${s.base}/api/host/status`, { method: 'OPTIONS' })).status).toBe(204);
  });

  test('there is no warm route: the page shows the command instead', async () => {
    expect((await fetch(`${s.base}/api/host/warm`, { method: 'POST' })).status).toBe(404);
    const body = await (await get()).json();
    expect(body.gpu.warmCommand).toBe('hpg/tw.sh start 3');
  });
});

describe('host status route without DV_KEY', () => {
  let s: { server: Server<undefined>; base: string };
  beforeAll(() => {
    s = serve({ dvKey: null, guard: { allowedOrigins: ['https://brave-otter.trycloudflare.com'] } });
  });
  afterAll(() => s.server.stop(true));
  const get = (headers: Record<string, string>) => fetch(`${s.base}/api/host/status`, { headers });

  test('another machine needs no key, but the cross-site rule still holds', async () => {
    expect((await get({ 'cf-connecting-ip': '203.0.113.9' })).status).toBe(200);
    expect((await get({ Origin: 'http://evil.example' })).status).toBe(403);
  });

  test('an origin listed in THIRDWHEEL_ALLOWED_ORIGINS (the tunnel) may read it', async () => {
    expect((await get({ Origin: 'https://brave-otter.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9' })).status).toBe(200);
  });

  test('a dependency that throws never turns into a 500', async () => {
    const broken = serve({
      health: async () => {
        throw new Error('nope');
      },
      listScenes: async () => {
        throw new Error('disk gone');
      },
    });
    try {
      const r = await fetch(`${broken.base}/api/host/status`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.checks.gpu.state).toBe('warn');
      expect(body.scenes.total).toBe(0);
    } finally {
      broken.server.stop(true);
    }
  });
});
