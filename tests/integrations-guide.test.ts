// The guide relay (server/integrations/guide.ts) against a fake fetch: scene context, limits, fallbacks, fail-fast.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { integrationsConfigFromEnv, type FetchLike, type GuideConfig, type Logger } from '../server/integrations/config.ts';
import { createGuideClient, createGuideProxy, GUIDE_MESSAGES, publicMode } from '../server/integrations/guide.ts';

const GUIDE = 'http://guide.test';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const WEBM = 'data:audio/webm;codecs=opus;base64,' + Buffer.alloc(4000, 7).toString('base64');
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9, 9, 0xff, 0xd9]);

let root = '';
const scenes = new Map<string, Scene>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dv-guide-'));
  const s: Scene = {
    id: 'game-night-k3x9a',
    name: 'Game night',
    mode: 'thirdwheel',
    status: 'ready',
    createdAt: '',
    updatedAt: '',
    thumb: 'thumb.jpg',
    caption: 'A small lounge with a grey couch facing a TV.',
  };
  scenes.set(s.id, s);
  scenes.set('dorm-aaaaa', { ...s, id: 'dorm-aaaaa', name: 'Dorm', mode: 'rentfree', caption: undefined, thumb: undefined });
  await mkdir(join(root, s.id), { recursive: true });
  await writeFile(join(root, s.id, 'thumb.jpg'), THUMB);
  await writeFile(join(root, s.id, 'hotspots.json'), JSON.stringify({ hotspots: [{ label: 'screen', blurb: 'Scene of the crime', position: [0, 1, -2] }, { label: 'snacks' }] }));
});
afterAll(() => rm(root, { recursive: true, force: true }));

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function setup(handler: (c: Call, init?: RequestInit) => Response | Promise<Response>, cfg: Partial<GuideConfig> = {}) {
  const base = integrationsConfigFromEnv({});
  const config: GuideConfig = { ...base.guide, url: GUIDE, key: 'gk-1', ...cfg };
  const calls: Call[] = [];
  const f: FetchLike = async (input, init) => {
    const c = { url: String(input), headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c, init);
  };
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const client = createGuideClient({ config, fetch: f, log, probeEveryMs: 20, trialEveryMs: 5000 });
  const proxy = createGuideProxy({
    client,
    config,
    getScene: async (id) => scenes.get(id) ?? null,
    sceneDir: (id) => join(root, id),
    log,
  });
  const post = (name: string, body: unknown) =>
    proxy.handle(name, new Request(`http://dv.test/api/guide/${name}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { calls, client, proxy, post, lines };
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });
const refused = () => {
  throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' });
};

describe('guide proxy', () => {
  test('fills in the scene from the store, adds the key, returns the guide answer unchanged', async () => {
    const answer = { question: 'who won?', answer: 'Shivin, on the very last second.', speech: 'data:audio/wav;base64,UklGRg==', hotspot: { label: 'screen', x: 0.5, y: 0.3 }, extra: 1 };
    const s = setup(() => new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await s.post('ask', { image: JPEG, audio: WEBM, scene: { id: 'game-night-k3x9a' }, history: [1, 2, 3, 4, 5, 6].map((i) => ({ q: `q${i}`, a: `a${i}` })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const c = s.calls[0]!;
    expect(c.url).toBe(`${GUIDE}/ask`);
    expect(c.headers['x-guide-key']).toBe('gk-1');
    expect(c.body.scene).toEqual({
      id: 'game-night-k3x9a',
      name: 'Game night',
      mode: 'video',
      caption: 'A small lounge with a grey couch facing a TV.',
      hotspots: [{ label: 'screen', blurb: 'Scene of the crime' }, { label: 'snacks' }],
    });
    expect(c.body.history.map((h: any) => h.q)).toEqual(['q3', 'q4', 'q5', 'q6']);
    expect(c.body.audio).toBe(WEBM);
  });

  test('a photo world is "photo"; hotspots the headset sends win over stored ones', async () => {
    const s = setup(() => ok({ hotspots: [] }));
    await s.post('hotspots', { image: JPEG, scene: { id: 'dorm-aaaaa', hotspots: [{ label: 'desk', blurb: 'Homework', x: 1 }] } });
    expect(s.calls[0]!.body.scene).toEqual({ id: 'dorm-aaaaa', name: 'Dorm', mode: 'photo', hotspots: [{ label: 'desk', blurb: 'Homework' }] });
    expect(publicMode('sample')).toBe('photo');
    expect(publicMode('video')).toBe('video');
  });

  test('a scene that does not exist is a 404, like on every other route, and costs no guide call', async () => {
    const s = setup(() => ok({ answer: 'hi', speech: null }));
    const res = await s.post('narrate', { image: JPEG, scene: { id: 'nope-12345', name: 'Mystery', mode: 'video' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such scene' });
    expect((await s.post('ask', { question: 'hi', scene: 'nope-12345' })).status).toBe(404);
    expect(s.calls.length).toBe(0);
  });

  test('narrate and ask without an image get the scene thumbnail', async () => {
    const s = setup(() => ok({ answer: 'Welcome.', speech: null }));
    const res = await s.post('narrate', { scene: { id: 'game-night-k3x9a' } });
    expect(res.status).toBe(200);
    expect(s.calls[0]!.body.image).toBe(`data:image/jpeg;base64,${THUMB.toString('base64')}`);
    await s.post('ask', { question: 'where am I?', scene: 'game-night-k3x9a' });
    expect(s.calls[1]!.body.image).toStartWith('data:image/jpeg;base64,');
    expect(s.calls[1]!.body.question).toBe('where am I?');
  });

  test('describe sends {image} only', async () => {
    const s = setup(() => ok({ caption: 'A room.' }));
    await s.post('describe', { image: JPEG, scene: { id: 'game-night-k3x9a' } });
    expect(Object.keys(s.calls[0]!.body)).toEqual(['image']);
  });

  test('checks requests before they cost a guide call', async () => {
    const s = setup(() => ok({}));
    const cases: [string, unknown, number, string][] = [
      ['ask', { image: JPEG, scene: { id: 'game-night-k3x9a' } }, 400, GUIDE_MESSAGES.noQuestion],
      ['ask', { audio: 'not a data url', question: 'x' }, 400, GUIDE_MESSAGES.badAudio],
      ['hotspots', { scene: { id: 'game-night-k3x9a' } }, 400, GUIDE_MESSAGES.imageRequired],
      ['describe', {}, 400, GUIDE_MESSAGES.imageRequired],
      ['hotspots', { image: 'http://example.com/x.jpg' }, 400, GUIDE_MESSAGES.badImage],
      ['ask', '{not json', 400, GUIDE_MESSAGES.notJson],
      ['ask', '[1,2]', 400, GUIDE_MESSAGES.notJson],
      ['ask', { image: 'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024 * 1024) }, 413, GUIDE_MESSAGES.tooLarge],
      ['teleport', {}, 404, GUIDE_MESSAGES.unknown],
    ];
    for (const [name, body, status, error] of cases) {
      const res = await s.post(name, body);
      expect([name, res.status]).toEqual([name, status]);
      expect((await res.json()).error).toBe(error);
    }
    expect(s.calls.length).toBe(0);
  });

  test('an image over the per-image limit is refused with 413', async () => {
    const s = setup(() => ok({}), { maxImageBytes: 1000 });
    const res = await s.post('hotspots', { image: 'data:image/jpeg;base64,' + 'A'.repeat(2000) });
    expect(res.status).toBe(413);
  });

  test('both audio and a typed question: the audio wins (exactly one is sent)', async () => {
    const s = setup(() => ok({ question: 'q', answer: 'a', speech: null }));
    await s.post('ask', { audio: WEBM, question: 'typed', scene: { id: 'game-night-k3x9a' } });
    expect(s.calls[0]!.body.question).toBeUndefined();
    expect(s.calls[0]!.body.audio).toBe(WEBM);
  });

  test('guide down: 502 guide offline with a canned answer; the next calls answer at once without waiting', async () => {
    const s = setup(refused);
    const res = await s.post('ask', { question: 'who won?', scene: { id: 'game-night-k3x9a' } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'guide offline', question: 'who won?', speech: null, degraded: true });
    expect(typeof body.answer).toBe('string');
    const asks = () => s.calls.filter((c) => c.url.endsWith('/ask')).length;
    const n = asks();
    const t0 = performance.now();
    const again = await s.post('ask', { question: 'who won?' });
    expect(again.status).toBe(502);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(asks()).toBe(n); // failed fast: no guide call at all
    expect(s.client.isDown()).toBe(true);
    s.client.close();
  });

  test('comes back by itself when the health probe answers', async () => {
    let alive = false;
    const s = setup((c) => {
      if (!alive) return refused();
      return c.url.endsWith('/health') ? ok({ ok: true }) : ok({ hotspots: [{ label: 'screen', x: 0.5, y: 0.3, blurb: 'b' }] });
    });
    expect((await s.post('hotspots', { image: JPEG })).status).toBe(502);
    alive = true;
    for (let i = 0; i < 50 && s.client.isDown(); i++) await Bun.sleep(10);
    expect(s.client.isDown()).toBe(false);
    expect((await s.post('hotspots', { image: JPEG })).status).toBe(200);
    expect(s.lines.some((l) => l.includes('guide is back'))).toBe(true);
  });

  test('a slow guide: 504 guide timeout with the fallback, not a hang', async () => {
    const s = setup(
      (c, init) =>
        c.url.endsWith('/health')
          ? ok({ ok: true })
          : new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
      { timeouts: { describe: 50, hotspots: 50, narrate: 50, ask: 80, health: 200 } },
    );
    const t0 = performance.now();
    const res = await s.post('ask', { question: 'who won?' });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: 'guide timeout', degraded: true, speech: null });
    await Bun.sleep(30);
    expect(s.client.isDown()).toBe(false); // the health probe answered: slow, not dead
  });

  test('an HTML error page from the guide address is "guide offline"', async () => {
    const s = setup(() => new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const res = await s.post('hotspots', { image: JPEG });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'guide offline', hotspots: [], degraded: true });
    s.client.close();
  });

  test("the guide's own 400 passes through; a key it refuses becomes guide offline", async () => {
    let status = 400;
    const s = setup(() => ok({ error: status === 400 ? 'image required' : 'bad guide key' }, status));
    const a = await s.post('narrate', { image: JPEG });
    expect([a.status, (await a.json()).error]).toEqual([400, 'image required']);
    status = 401;
    const b = await s.post('narrate', { image: JPEG });
    expect([b.status, (await b.json()).error]).toEqual([502, 'guide offline']);
  });

  test('without GUIDE_URL every route answers 502 at once', async () => {
    const s = setup(() => ok({}), { url: null });
    const res = await s.post('narrate', { image: JPEG });
    expect(res.status).toBe(502);
    expect((await s.proxy.health()).status).toBe(502);
    expect(s.calls.length).toBe(0);
  });

  test('health passes the guide status through, or says offline', async () => {
    const s = setup((c) => (c.url.endsWith('/health') ? ok({ ok: true, gemini: 'ok', mock: false }) : ok({})));
    const res = await s.proxy.health();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, gemini: 'ok' });
    const d = setup(refused);
    const r2 = await d.proxy.health();
    expect(r2.status).toBe(502);
    expect(await r2.json()).toEqual({ ok: false, error: 'guide offline' });
  });

  test('narrate warm-up posts the thumbnail with the scene context', async () => {
    const s = setup(() => ok({ answer: 'Welcome.', speech: null }));
    expect(await s.proxy.narrateWarmup('game-night-k3x9a')).toBe(true);
    expect(s.calls[0]!.url).toBe(`${GUIDE}/narrate`);
    expect(s.calls[0]!.body.scene.name).toBe('Game night');
    expect(s.calls[0]!.body.image).toStartWith('data:image/jpeg;base64,');
    expect(await s.proxy.narrateWarmup('dorm-aaaaa')).toBe(false); // no thumbnail on disk
    expect(await s.proxy.narrateWarmup('../etc')).toBe(false);
  });
});

describe('guide health monitor', () => {
  test('marks a dead guide down before anyone asks, so the first question fails fast', async () => {
    const s = setup(refused);
    s.client.startMonitor(50);
    for (let i = 0; i < 50 && !s.client.isDown(); i++) await Bun.sleep(10);
    expect(s.client.isDown()).toBe(true);
    const t0 = performance.now();
    const res = await s.post('ask', { question: 'who won?' });
    expect(res.status).toBe(502);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(s.calls.filter((c) => c.url.endsWith('/ask')).length).toBe(0);
    s.client.close();
  });
});
