// A real run: the integrations inside a live Bun server, talking over HTTP to the stand-in DeepSpace worker
// (tests/harness/mock-deepspace.ts) and the stand-in guide (tests/harness/mock-guide.ts). About 15 s.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { integrationsConfigFromEnv } from '../server/integrations/config.ts';
import { createIntegrations, createPresenceFeed, type Integrations, type NoteMessage } from '../server/integrations/routes.ts';
import { SceneStore } from '../server/store.ts';
import { startMockDeepSpace, type MockDeepSpace } from './harness/mock-deepspace.ts';
import { startMockGuide, type MockGuide } from './harness/mock-guide.ts';

const SCENE = 'live-night-aaaaa';
const darwin = process.platform === 'darwin';
const quietConsole = { log: () => {}, warn: () => {} };

/** True when something already accepts connections on the port (on any interface: another agent's server). */
async function taken(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== 'ConnectionRefused';
  }
}

/**
 * Test servers stay inside 8793-8799. Other agents use the same range, so skip any port where something answers:
 * binding 127.0.0.1 can succeed next to another process's wildcard listener, and once ours stops, requests would
 * reach theirs.
 */
async function inRange<T>(make: (port: number) => T, skip: number[] = []): Promise<T> {
  for (let p = 8793; p <= 8799; p++) {
    if (skip.includes(p) || (await taken(p))) continue;
    try {
      return make(p);
    } catch {
      /* in use */
    }
  }
  throw new Error('no free port in 8793-8799');
}

async function until(cond: () => boolean, ms: number, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(step);
  }
  return cond();
}

let root = '';
let ds: MockDeepSpace;
let guide: MockGuide;
let server: Server<undefined>;
let base = '';
let integrations: Integrations;
const feed = createPresenceFeed();
const published: NoteMessage[] = [];
let walker: ReturnType<typeof setInterval> | null = null;
let thumbPath = '';
let viewJpeg = '';

function walk(on: boolean) {
  if (walker) clearInterval(walker);
  walker = null;
  if (!on) return;
  const t0 = performance.now();
  const step = () => {
    const a = (performance.now() - t0) / 1000;
    feed.onPresence(SCENE, [
      { id: 'quest-1', name: 'Judge', kind: 'vr', x: Math.cos(a), y: 0, z: Math.sin(a) - 1, yaw: a, hands: null, age: 0.05 },
      { id: 'rbx-12345', name: 'shivin', kind: 'roblox', x: 1.05, y: 0, z: -0.38, yaw: 1.57 },
    ]);
  };
  step();
  walker = setInterval(step, 250);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dv-live-'));
  const store = new SceneStore(join(root, 'scenes'));
  await mkdir(store.sceneDir(SCENE), { recursive: true });
  thumbPath = join(store.sceneDir(SCENE), 'thumb.jpg');
  const made = Bun.which('ffmpeg')
    ? Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=1', '-frames:v', '1', thumbPath]).exitCode === 0
    : false;
  if (!made) await writeFile(thumbPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, ...Array(200).fill(9), 0xff, 0xd9]));
  viewJpeg = `data:image/jpeg;base64,${Buffer.from(await Bun.file(thumbPath).arrayBuffer()).toString('base64')}`;
  await store.save({
    id: SCENE,
    name: 'Game night',
    mode: 'thirdwheel',
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: '',
    thumb: 'thumb.jpg',
    caption: 'A small lounge with a grey couch facing a TV on a low cabinet, snacks on the table.',
  });

  ds = await inRange((port) => startMockDeepSpace({ port, key: 'live-ds-key', quiet: true }));
  guide = await inRange((port) => startMockGuide({ port, key: 'live-gk', quiet: true }), [ds.port]);
  const config = integrationsConfigFromEnv({
    DS_URL: ds.url,
    DS_KEY: 'live-ds-key',
    GUIDE_URL: guide.url,
    GUIDE_KEY: 'live-gk',
    THIRDWHEEL_DATA: root,
  });
  integrations = createIntegrations({ store, presence: feed, publish: (m) => published.push(m), config, log: quietConsole });
  server = await inRange(
    (port) =>
      Bun.serve({
        port,
        hostname: '127.0.0.1',
        routes: integrations.routes as any,
        fetch: () => Response.json({ error: 'Not found.' }, { status: 404 }),
      }),
    [ds.port, guide.port],
  );
  base = `http://127.0.0.1:${server.port}`;
  integrations.start();
});

afterAll(async () => {
  walk(false);
  integrations?.stop();
  server?.stop(true);
  ds?.stop();
  guide?.stop();
  await rm(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('live map service (stand-in) through the real forwarder and notes relay', () => {
  test('presence arrives about 4 times a second, keyed, with exactly the 7 fields', async () => {
    walk(true);
    await Bun.sleep(2100);
    const mine = ds.ingests.filter((i) => i.sceneId === SCENE);
    const last2s = mine.filter((i) => i.at > Date.now() - 2000);
    expect(last2s.length).toBeGreaterThanOrEqual(6);
    expect(last2s.length).toBeLessThanOrEqual(10);
    expect(mine.every((i) => i.key === 'live-ds-key')).toBe(true);
    expect(mine.flatMap((i) => i.problems)).toEqual([]);
    expect(mine.at(-1)!.people.map((p) => p.id).sort()).toEqual(['quest-1', 'rbx-12345']);
    for (let i = 1; i < mine.length; i++) expect(mine[i]!.t).toBeGreaterThan(mine[i - 1]!.t);
    expect(new Set(mine.map((i) => i.people.find((p) => p.id === 'quest-1')!.x)).size).toBeGreaterThan(3);
    expect(integrations.deepspace.status().presence.up).toBe(true);
  });

  test('a note typed on the map reaches the WebSocket layer and the headset list within 2.5 s', async () => {
    const r = await fetch(`${ds.url}/ui/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId: SCENE, author: 'Brianna', text: "Seb's seat. He was too scared to show up.", x: 1.2, z: -0.8 }),
    });
    expect(r.status).toBe(201);
    const id = (await r.json()).note.id;
    const t0 = Date.now();
    expect(await until(() => published.some((m) => m.note.id === id), 2600)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2600);
    const msg = published.find((m) => m.note.id === id)!;
    expect(msg).toEqual({
      type: 'note',
      sceneId: SCENE,
      note: { id, sceneId: SCENE, author: 'Brianna', text: "Seb's seat. He was too scared to show up.", x: 1.2, y: 1.4, z: -0.8, createdAt: expect.any(String) },
    });
    const list = await (await fetch(`${base}/api/notes/${SCENE}`)).json();
    expect(list.notes.map((n: any) => n.id)).toContain(id);
  });

  test('a headset note is saved in the service and announced once', async () => {
    const res = await post(`/api/notes/${SCENE}`, { author: 'Judge', text: 'Best seat in the house', x: 0.6, y: 1.4, z: -1.1 });
    expect(res.status).toBe(201);
    const { note } = await res.json();
    expect(ds.notes(SCENE).some((n) => n.id === note.id && n.author === 'Judge')).toBe(true);
    await Bun.sleep(2300); // one more poll
    expect(published.filter((m) => m.note.id === note.id).length).toBe(1);
  });

  test('exactly one empty push when the last person leaves', async () => {
    walk(false);
    feed.onPresence(SCENE, []);
    expect(await until(() => ds.live(SCENE)?.people.length === 0, 1000)).toBe(true);
    const n = ds.ingests.length;
    await Bun.sleep(1200);
    expect(ds.ingests.length).toBe(n);
    expect(ds.ingests.filter((i) => i.sceneId === SCENE && i.people.length === 0).length).toBe(1);
  });

  test('an outage: pushes back off, notes stay served, a headset note gets "notes offline"; then it recovers', async () => {
    walk(true);
    await Bun.sleep(400);
    ds.setMode('down');
    const hitsAt = ds.hits.length;
    await Bun.sleep(2500);
    const during = ds.hits.slice(hitsAt).filter((h) => h.path === '/api/ingest').length;
    expect(during).toBeLessThanOrEqual(3); // 4 Hz would be 10
    const list = await (await fetch(`${base}/api/notes/${SCENE}`)).json();
    expect(list.notes.length).toBe(2);
    const res = await post(`/api/notes/${SCENE}`, { text: 'hello?', x: 0, z: 0 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'notes offline' });
    ds.setMode('ok');
    const okAt = ds.ingests.length;
    expect(await until(() => ds.ingests.length > okAt + 2, 6000)).toBe(true);
    expect(integrations.deepspace.status().presence.up).toBe(true);
    walk(false);
    feed.onPresence(SCENE, []);
  });
});

describe('guide (stand-in) through the real proxy', () => {
  test('narrate with only a scene id: the server adds the thumbnail and context; speech is a 24 kHz WAV', async () => {
    const res = await post('/api/guide/narrate', { scene: { id: SCENE } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBeString();
    const sent = guide.requests.at(-1)!;
    expect(sent.headers['x-guide-key']).toBe('live-gk');
    expect(sent.body.scene).toMatchObject({ id: SCENE, name: 'Game night', mode: 'video', caption: expect.stringContaining('lounge') });
    expect(sent.body.image).toStartWith('data:image/jpeg;base64,');
    if (darwin) {
      expect(body.speech).toStartWith('data:audio/wav;base64,');
      const wav = Buffer.from(body.speech.split(',')[1], 'base64');
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.subarray(8, 12).toString()).toBe('WAVE');
      expect(wav.readUInt16LE(22)).toBe(1); // mono
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(body.speechSeconds).toBeGreaterThan(0.5);
    }
  }, 15_000);

  test('ask with a typed question and with recorded audio', async () => {
    const typed = await (await post('/api/guide/ask', { image: viewJpeg, question: 'who won?', scene: { id: SCENE }, history: [] })).json();
    expect(typed).toMatchObject({ question: 'who won?', answer: expect.any(String), hotspot: { label: 'screen' } });
    const audio = 'data:audio/webm;codecs=opus;base64,' + Buffer.alloc(6000, 3).toString('base64');
    const spoken = await (await post('/api/guide/ask', { image: viewJpeg, audio, scene: { id: SCENE } })).json();
    expect(spoken.question).toBe('who won?');
    const tiny = await (await post('/api/guide/ask', { image: viewJpeg, audio: 'data:audio/webm;base64,AAAA', scene: { id: SCENE } })).json();
    expect(tiny.question).toBe('');
  }, 15_000);

  test('hotspots: 3 to 6 labels with positions inside the image', async () => {
    const body = await (await post('/api/guide/hotspots', { image: viewJpeg, scene: { id: SCENE } })).json();
    expect(body.hotspots.length).toBeGreaterThanOrEqual(3);
    expect(body.hotspots.length).toBeLessThanOrEqual(6);
    for (const h of body.hotspots) {
      expect(h.label).toBeString();
      expect(h.x).toBeGreaterThan(0);
      expect(h.x).toBeLessThan(1);
      expect(h.y).toBeGreaterThan(0);
      expect(h.y).toBeLessThan(1);
    }
    expect(body.hotspots.map((h: any) => h.label)).toContain('couch');
  });

  test('describeForJob and the narrate warm-up', async () => {
    const caption = await integrations.describeForJob(thumbPath);
    expect(caption).toBeString();
    expect(caption!.length).toBeGreaterThan(40);
    expect(await integrations.narrateWarmup(SCENE)).toBe(true);
    const again = await (await post('/api/guide/narrate', { scene: { id: SCENE } })).json();
    expect(again.cached).toBe(true);
    const health = await fetch(`${base}/api/guide/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).mock).toBe(true);
  }, 15_000);

  test('guide stopped: 502 guide offline with a canned answer, then instant answers', async () => {
    guide.stop();
    const first = await post('/api/guide/ask', { question: 'who won?', scene: { id: SCENE } });
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ error: 'guide offline', degraded: true, speech: null, question: 'who won?' });
    const t0 = performance.now();
    const second = await post('/api/guide/ask', { question: 'who won?', scene: { id: SCENE } });
    expect(second.status).toBe(502);
    expect(performance.now() - t0).toBeLessThan(100);
    expect((await fetch(`${base}/api/guide/health`)).status).toBe(502);
    const status = await integrations.status();
    expect(status.guide.up).toBe(false);
    expect(status.publicUrl).toBeNull();
  });
});
