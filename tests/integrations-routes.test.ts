// The integration routes (server/integrations/routes.ts) in a real Bun.serve: params, guard, CORS, errors.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createIntegrationHandler, createIntegrationRoutes, type IntegrationRoutesDeps } from '../server/integrations/routes.ts';

const quiet = { info: () => {}, warn: () => {} };

/** Test servers stay inside 8793-8799; skip ports where another agent's server already answers. */
async function serveInRange(make: (port: number) => Server<undefined>): Promise<Server<undefined>> {
  for (let p = 8793; p <= 8799; p++) {
    const busy = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(400) }).then(
      () => true,
      (e) => (e as { code?: string }).code !== 'ConnectionRefused',
    );
    if (busy) continue;
    try {
      return make(p);
    } catch {
      /* in use */
    }
  }
  throw new Error('no free port in 8793-8799');
}

const seen: { kind: string; arg: unknown }[] = [];
const deps: IntegrationRoutesDeps = {
  notes: {
    list: async (id) => {
      if (id === 'boom-room') throw new Error('kaboom');
      seen.push({ kind: 'list', arg: id });
      return { notes: [{ id: 'n_1', sceneId: id, author: 'Brianna', text: 'hi', x: 1, y: 1.4, z: 2, createdAt: '2026-10-17T22:41:07Z' }] };
    },
    create: async (id, body) => {
      seen.push({ kind: 'create', arg: { id, body } });
      return { status: 201, body: { ok: true, note: { id: 'n_2' } } };
    },
  },
  guide: {
    handle: async (name, req) => {
      seen.push({ kind: 'guide', arg: name });
      return Response.json({ name, len: (await req.text()).length });
    },
    health: async () => Response.json({ ok: true }),
  },
  log: quiet,
};

let server: Server<undefined>;
let base = '';
beforeAll(async () => {
  const routes = createIntegrationRoutes(deps);
  server = await serveInRange((port) =>
    Bun.serve({ port, hostname: '127.0.0.1', routes: routes as any, fetch: () => Response.json({ error: 'fallthrough' }, { status: 404 }) }),
  );
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));

describe('integration routes', () => {
  test('GET /api/notes/:sceneId answers any origin', async () => {
    const res = await fetch(`${base}/api/notes/game-night-k3x9a`, { headers: { Origin: 'https://dejaview-live.app.space' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).notes[0].id).toBe('n_1');
    const head = await fetch(`${base}/api/notes/game-night-k3x9a`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  test('notes for a world that does not exist are a 404 (nothing reaches DeepSpace)', async () => {
    const before = seen.length;
    const handle = createIntegrationHandler({ ...deps, sceneExists: async (id) => id === 'game-night-k3x9a' });
    const post = (id: string) => handle(new Request(`http://x/api/notes/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi","x":0,"z":0}' }));
    expect((await post('nope-scene'))!.status).toBe(404);
    expect((await handle(new Request('http://x/api/notes/nope-scene')))!.status).toBe(404);
    expect(seen.length).toBe(before);
    expect((await post('game-night-k3x9a'))!.status).toBe(201);
    expect((await handle(new Request('http://x/api/notes/game-night-k3x9a')))!.status).toBe(200);
  });

  test('a bad scene id is a 404 with a sentence', async () => {
    const res = await fetch(`${base}/api/notes/BAD%20ID`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeString();
  });

  test('POST /api/notes/:sceneId from the app itself is forwarded, with no CORS on the answer', async () => {
    const res = await fetch(`${base}/api/notes/game-night-k3x9a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ author: 'Judge', text: 'Best seat', x: 0.6, y: 1.4, z: -1.1 }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(seen.at(-1)).toEqual({ kind: 'create', arg: { id: 'game-night-k3x9a', body: { author: 'Judge', text: 'Best seat', x: 0.6, y: 1.4, z: -1.1 } } });
  });

  test('a cross-site page cannot post notes or burn guide calls', async () => {
    const before = seen.length;
    for (const path of ['/api/notes/game-night-k3x9a', '/api/guide/ask']) {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}' });
      expect(res.status).toBe(403);
    }
    expect(seen.length).toBe(before);
  });

  test('bad note bodies', async () => {
    const notJson = await fetch(`${base}/api/notes/game-night-k3x9a`, { method: 'POST', body: '{nope' });
    expect(notJson.status).toBe(400);
    const array = await fetch(`${base}/api/notes/game-night-k3x9a`, { method: 'POST', body: '[]' });
    expect(array.status).toBe(400);
    const big = await fetch(`${base}/api/notes/game-night-k3x9a`, { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
  });

  test('POST /api/guide/:name passes the name and body; GET is refused; health has CORS', async () => {
    const res = await fetch(`${base}/api/guide/hotspots`, { method: 'POST', body: '{"image":"x"}' });
    expect(await res.json()).toEqual({ name: 'hotspots', len: 13 });
    expect((await fetch(`${base}/api/guide/ask`)).status).toBe(405);
    const h = await fetch(`${base}/api/guide/health`);
    expect(h.status).toBe(200);
    expect(h.headers.get('access-control-allow-origin')).toBe('*');
    expect(await h.json()).toEqual({ ok: true });
  });

  test('preflights: reads get CORS, changes get none', async () => {
    const read = await fetch(`${base}/api/notes/game-night-k3x9a`, { method: 'OPTIONS', headers: { Origin: 'http://x', 'Access-Control-Request-Method': 'GET' } });
    expect(read.status).toBe(204);
    expect(read.headers.get('access-control-allow-origin')).toBe('*');
    const write = await fetch(`${base}/api/guide/ask`, { method: 'OPTIONS', headers: { Origin: 'http://x', 'Access-Control-Request-Method': 'POST' } });
    expect(write.status).toBe(204);
    expect(write.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('an exception inside a handler is a 500 with a sentence, and the server keeps serving', async () => {
    const res = await fetch(`${base}/api/notes/boom-room`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Try again');
    expect((await fetch(`${base}/api/notes/game-night-k3x9a`)).status).toBe(200);
  });

  test('the fetch-style handler matches the same paths and returns null for others', async () => {
    const handle = createIntegrationHandler(deps);
    expect(await handle(new Request('http://x/api/scenes'))).toBeNull();
    const r = await handle(new Request('http://x/api/notes/game-night-k3x9a'));
    expect(r?.status).toBe(200);
    const g = await handle(new Request('http://x/api/guide/narrate', { method: 'POST', body: '{}' }));
    expect(await g?.json()).toEqual({ name: 'narrate', len: 2 });
    expect((await handle(new Request('http://x/api/guide/health')))?.status).toBe(200);
  });
});
