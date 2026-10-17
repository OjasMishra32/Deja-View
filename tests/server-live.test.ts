// The server's live wiring pieces: the 3D label store (GET/PUT /api/scenes/:id/hotspots), host cues
// (POST /api/host/cue), the describe hook before a Photo job (caption -> prompt + scene.caption) and the reality
// parts a job leaves in out/ reaching the scene.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { JobResult, Scene, ServerEvent } from '../shared/types.ts';
import { createApp, MESSAGES } from '../server/app.ts';
import type { BackendDriver, RunContext } from '../server/backends/types.ts';
import { createCueRoute, parseCue } from '../server/cue.ts';
import { cleanStoredHotspots, HOTSPOTS_FILE, MAX_HOTSPOTS } from '../server/hotspots.ts';
import { jobPrompt, JobRunner } from '../server/jobs.ts';
import { wantsReality } from '../server/reality.ts';
import { SceneStore } from '../server/store.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function tempStore(prefix: string): Promise<{ root: string; store: SceneStore }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return { root, store: new SceneStore(join(root, 'scenes')) };
}

function scene(id: string, extra: Partial<Scene> = {}): Scene {
  return { id, name: id, mode: 'rentfree', status: 'ready', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/00.jpg'] }, ...extra };
}

const WORLD = { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'flashworld' } as const;

describe('hotspot store', () => {
  let server: Server<undefined>;
  let base = '';
  let store: SceneStore;
  const events: ServerEvent[] = [];
  let readOnlyBase = '';
  let readOnlyServer: Server<undefined>;

  beforeAll(async () => {
    const t = await tempStore('tw-hot-');
    store = t.store;
    await mkdir(store.sceneDir('room-aaaaa'), { recursive: true });
    await store.save(scene('room-aaaaa', { world: { ...WORLD, transform: { ...WORLD.transform, position: [0, 0, 0] } } as Scene['world'] }));
    const runner = new JobRunner({ store, jobsDir: join(t.root, 'jobs'), drivers: [], emit: () => {} });
    const app = createApp({ store, runner, health: { info: async () => ({}) as any }, publish: (e) => events.push(e), maxUploadBytes: 1 << 20 });
    server = Bun.serve({ port: 0, fetch: async (r) => (await app.handle(r)) ?? new Response('nf', { status: 404 }) });
    base = `http://localhost:${server.port}`;
    const ro = createApp({ store, runner, health: { info: async () => ({}) as any }, publish: () => {}, maxUploadBytes: 1 << 20, readOnly: true });
    readOnlyServer = Bun.serve({ port: 0, fetch: async (r) => (await ro.handle(r)) ?? new Response('nf', { status: 404 }) });
    readOnlyBase = `http://localhost:${readOnlyServer.port}`;
  });
  afterAll(() => {
    server.stop(true);
    readOnlyServer.stop(true);
  });

  test('GET answers 200 with an empty list before anything is stored, with CORS; 404 for an unknown scene', async () => {
    const r = await fetch(`${base}/api/scenes/room-aaaaa/hotspots`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toEqual({ hotspots: [] });
    const missing = await fetch(`${base}/api/scenes/nope-zzzzz/hotspots`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe(MESSAGES.noSuchScene);
  });

  test('PUT from the app stores the cleaned labels, broadcasts them, and GET returns them', async () => {
    events.length = 0;
    const body = {
      hotspots: [
        { label: '  The TV  ', blurb: 'The results screen.', x: 0.4123456, y: 1.2, z: -2.5, u: 0.5, v: 0.4, source: 'depth' },
        { label: 'the tv', blurb: 'duplicate', x: 0, y: 0, z: 0 },
        { label: 'No position', blurb: 'dropped' },
        { label: 'Couch', blurb: '', position: [1, 0.5, -1] },
        { label: 'Far away', x: 5000, y: 0, z: 0 },
      ],
    };
    const r = await fetch(`${base}/api/scenes/room-aaaaa/hotspots`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const saved = (await r.json()).hotspots;
    expect(saved).toEqual([
      { label: 'The TV', blurb: 'The results screen.', x: 0.412, y: 1.2, z: -2.5, u: 0.5, v: 0.4, source: 'depth' },
      { label: 'Couch', blurb: '', x: 1, y: 0.5, z: -1 },
    ]);
    expect(events).toEqual([{ type: 'hotspots', sceneId: 'room-aaaaa', hotspots: saved }]);
    const file = await Bun.file(join(store.sceneDir('room-aaaaa'), HOTSPOTS_FILE)).json();
    expect(file.hotspots).toEqual(saved);
    expect(typeof file.updatedAt).toBe('string');
    const again = await (await fetch(`${base}/api/scenes/room-aaaaa/hotspots`)).json();
    expect(again).toEqual({ hotspots: saved });
  });

  test('PUT is refused cross-site, on a read-only server, for bad JSON and for an unknown scene', async () => {
    const put = (b: string, headers: Record<string, string> = {}, at = base, id = 'room-aaaaa') =>
      fetch(`${at}/api/scenes/${id}/hotspots`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: b });
    expect((await put('{"hotspots":[]}', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await put('{"hotspots":[]}', {}, readOnlyBase)).status).toBe(503);
    expect((await put('not json')).status).toBe(400);
    expect((await put('{"labels":[]}')).status).toBe(400);
    // a list whose every entry is broken would wipe the stored labels: refused, the old ones stay
    expect((await put('{"hotspots":[{"label":"x","x":"1","y":0,"z":0}]}')).status).toBe(400);
    expect((await put('{"hotspots":[]}', {}, base, 'nope-zzzzz')).status).toBe(404);
    expect((await put('x'.repeat(70 * 1024))).status).toBe(413);
    // the preflight for a PUT carries no CORS headers, so browsers on other sites never send it
    const pre = await fetch(`${base}/api/scenes/room-aaaaa/hotspots`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('cleanStoredHotspots caps the list and rejects non-lists', () => {
    expect(cleanStoredHotspots({ nope: 1 })).toBeNull();
    expect(cleanStoredHotspots('x')).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `L${i}`, blurb: '', x: i, y: 1, z: 0 }));
    expect(cleanStoredHotspots(many)!.length).toBe(MAX_HOTSPOTS);
    expect(cleanStoredHotspots({ hotspots: [{ label: 'A', x: 1, y: 2, z: Number.NaN }] })).toEqual([]);
  });
});

describe('host cues', () => {
  let server: Server<undefined>;
  let base = '';
  const published: ServerEvent[] = [];

  beforeAll(async () => {
    const { store } = await tempStore('tw-cue-');
    await store.save(scene('fort-aaaaa', { world: WORLD as unknown as Scene['world'] }));
    await store.save(scene('busy-aaaaa', { status: 'running' }));
    const route = createCueRoute({
      getScene: (id) => store.get(id),
      publish: (e) => published.push(e),
      dvKey: 'k3y',
      now: () => 1760715612.4,
    });
    server = Bun.serve({ port: 0, fetch: (req, srv) => route(req, srv) });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/host/cue`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  test('parseCue: actions, defaults and the load target', () => {
    expect(parseCue({ action: 'reality' })).toEqual({ action: 'reality', on: true });
    expect(parseCue({ action: 'Labels', on: false })).toEqual({ action: 'labels', on: false });
    expect(parseCue({ action: 'load', sceneId: 'fort-aaaaa', by: 'bot' })).toEqual({ action: 'load', sceneId: 'fort-aaaaa', by: 'bot' });
    expect(typeof parseCue({ action: 'load' })).toBe('string');
    expect(typeof parseCue({ action: 'dance' })).toBe('string');
    expect(typeof parseCue({ action: 'load', sceneId: '../etc' })).toBe('string');
  });

  test('from this machine: no key needed, the cue goes out with the server time', async () => {
    published.length = 0;
    const r = await post({ action: 'reality', on: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(published).toEqual([{ type: 'cue', action: 'reality', on: true, at: 1760715612.4 }]);
    const load = await post({ action: 'load', sceneId: 'fort-aaaaa', by: 'bot' });
    expect(load.status).toBe(200);
    expect(published[1]).toEqual({ type: 'cue', action: 'load', sceneId: 'fort-aaaaa', by: 'bot', at: 1760715612.4 });
  });

  test('through the tunnel: the key is required; bad cues and unready worlds are refused', async () => {
    published.length = 0;
    const tunnel = { 'cf-connecting-ip': '203.0.113.9' };
    expect((await post({ action: 'reality' }, tunnel)).status).toBe(401);
    expect((await post({ action: 'reality' }, { ...tunnel, 'x-dejaview-key': 'wrong' })).status).toBe(401);
    expect((await post({ action: 'labels', on: false }, { ...tunnel, 'x-dejaview-key': 'k3y' })).status).toBe(200);
    expect((await post({ action: 'dance' })).status).toBe(400);
    expect((await post({ action: 'load', sceneId: 'nope-zzzzz' })).status).toBe(404);
    expect((await post({ action: 'load', sceneId: 'busy-aaaaa' })).status).toBe(409);
    expect(published).toEqual([{ type: 'cue', action: 'labels', on: false, at: 1760715612.4 }]);
  });

  test('a page on another site is refused; GET is not a cue', async () => {
    expect((await post({ action: 'reality' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ action: 'reality' }, { Origin: 'http://evil.example', 'x-dejaview-key': 'k3y' })).status).toBe(200);
    expect((await fetch(`${base}/api/host/cue`)).status).toBe(405);
  });
});

describe('describe before a Photo job', () => {
  test('jobPrompt: own prompt first, then the guide caption (Photo and Video)', () => {
    const s = (extra: Partial<Scene>) => scene('p-aaaaa', extra);
    expect(jobPrompt(s({}))).toBeUndefined();
    expect(jobPrompt(s({ input: { files: [], prompt: '  a cave ' } }))).toBe('a cave');
    expect(jobPrompt(s({ caption: 'A small lounge.', captionSource: 'guide' }))).toBe('A small lounge.');
    expect(jobPrompt(s({ caption: 'Generated from one photo.' }))).toBeUndefined();
    expect(jobPrompt(s({ input: { files: [], prompt: 'Make it night' }, caption: 'A small lounge.', captionSource: 'guide' }))).toBe('Make it night. A small lounge.');
    expect(jobPrompt(s({ mode: 'thirdwheel', caption: 'A small lounge.', captionSource: 'guide' }))).toBe('A small lounge.');
    expect(jobPrompt(s({ mode: 'sample', caption: 'A small lounge.', captionSource: 'guide' }))).toBeUndefined();
  });

  async function runOne(prepare: ConstructorParameters<typeof JobRunner>[0]['prepare'], files: Record<string, string> = {}) {
    const t = await tempStore('tw-desc-');
    const dir = t.store.sceneDir('photo-aaaaa');
    await mkdir(join(dir, 'input'), { recursive: true });
    await writeFile(join(dir, 'input', '00.jpg'), 'jpeg-bytes');
    await t.store.save(scene('photo-aaaaa', { status: 'queued' }));
    const stages: string[] = [];
    let prompt: string | undefined;
    const result: JobResult = { world: WORLD as unknown as JobResult['world'], thumb: 'thumb.jpg', caption: 'Generated from one photo: the rest of the room was imagined.' };
    const driver: BackendDriver = {
      name: 'local',
      label: 'Fake local',
      lane: 'local',
      canResume: false,
      supports: () => true,
      available: async () => ({ ok: true }),
      run: async (ctx: RunContext) => {
        prompt = (await Bun.file(join(ctx.jobDir, 'job.json')).json()).prompt;
        for (const [name, body] of Object.entries({ 'world.spz': 'SPZ', 'thumb.jpg': 'T', ...files })) await writeFile(join(ctx.outDir, name), body);
        await Bun.write(join(ctx.outDir, 'scene.json'), JSON.stringify(result));
      },
    };
    const runner = new JobRunner({ store: t.store, jobsDir: join(t.root, 'jobs'), drivers: [driver], emit: (s) => s.stage && stages.push(s.stage), prepare, reportIntervalMs: 5 });
    runner.enqueue('photo-aaaaa');
    await runner.idle();
    return { store: t.store, dir, stages, prompt: () => prompt, scene: (await t.store.get('photo-aaaaa'))! };
  }

  test('without a caption the job keeps its own; the stage shows while it reads; reality parts in out/ reach the scene', async () => {
    const parts = { 'world-seen.spz': 'SEEN', 'world-imagined.spz': 'IMAG', 'reality.json': '{"version":1}', 'input_camera.json': '{}', 'input_depth.npy': 'NPY' };
    const r = await runOne(async (_s, ctx) => {
      ctx.report('Reading your photo');
      return null;
    }, parts);
    expect(r.scene.status).toBe('ready');
    expect(r.prompt()).toBeUndefined();
    expect(r.scene.caption).toBe('Generated from one photo: the rest of the room was imagined.');
    expect(r.stages).toContain('Reading your photo');
    for (const [name, body] of Object.entries(parts)) expect(await Bun.file(join(r.dir, name)).text()).toBe(body);
  });

  test('a caption from the hook is the prompt and survives the result caption; a throwing hook never blocks the job', async () => {
    const t = await tempStore('tw-desc2-');
    const dir = t.store.sceneDir('photo-bbbbb');
    await mkdir(join(dir, 'input'), { recursive: true });
    await writeFile(join(dir, 'input', '00.jpg'), 'jpeg-bytes');
    await t.store.save(scene('photo-bbbbb', { status: 'queued', input: { files: ['input/00.jpg'], prompt: 'Make it night' } }));
    await t.store.save(scene('photo-ccccc', { status: 'queued' }));
    await mkdir(join(t.store.sceneDir('photo-ccccc'), 'input'), { recursive: true });
    await writeFile(join(t.store.sceneDir('photo-ccccc'), 'input', '00.jpg'), 'jpeg-bytes');
    const prompts: Record<string, string | undefined> = {};
    const driver: BackendDriver = {
      name: 'local',
      label: 'Fake local',
      lane: 'local',
      canResume: false,
      supports: () => true,
      available: async () => ({ ok: true }),
      run: async (ctx: RunContext) => {
        prompts[ctx.scene.id] = (await Bun.file(join(ctx.jobDir, 'job.json')).json()).prompt;
        await writeFile(join(ctx.outDir, 'world.spz'), 'SPZ');
        await Bun.write(join(ctx.outDir, 'scene.json'), JSON.stringify({ world: WORLD, caption: 'Generated from one photo.' }));
      },
    };
    const runner = new JobRunner({
      store: t.store,
      jobsDir: join(t.root, 'jobs'),
      drivers: [driver],
      emit: () => {},
      prepare: async (s) => {
        if (s.id === 'photo-ccccc') throw new Error('guide exploded');
        return t.store.update(s.id, { caption: 'A small lounge with a grey couch.', captionSource: 'guide' });
      },
    });
    runner.enqueue('photo-bbbbb');
    runner.enqueue('photo-ccccc');
    await runner.idle();
    const b = (await t.store.get('photo-bbbbb'))!;
    expect(prompts['photo-bbbbb']).toBe('Make it night. A small lounge with a grey couch.');
    expect(b.status).toBe('ready');
    expect(b.caption).toBe('A small lounge with a grey couch.');
    expect(b.captionSource).toBe('guide');
    const c = (await t.store.get('photo-ccccc'))!;
    expect(c.status).toBe('ready');
    expect(c.caption).toBe('Generated from one photo.');
    expect(prompts['photo-ccccc']).toBeUndefined();
    // a retry in another mode forgets the description
    const retried = await runner.retry('photo-bbbbb', undefined, 'thirdwheel');
    expect(retried?.captionSource).toBeUndefined();
    await runner.idle();
  });

  test('a rebuild without reality parts or labels drops the previous world\'s ones', async () => {
    const t = await tempStore('tw-stale-');
    const dir = t.store.sceneDir('photo-ddddd');
    await mkdir(join(dir, 'input'), { recursive: true });
    await writeFile(join(dir, 'input', '00.jpg'), 'jpeg-bytes');
    for (const f of ['reality.json', 'world-seen.spz', 'hotspots.json', 'input_camera.json']) await writeFile(join(dir, f), 'old');
    await t.store.save(scene('photo-ddddd', { status: 'queued' }));
    const driver: BackendDriver = {
      name: 'local',
      label: 'Fake local',
      lane: 'local',
      canResume: false,
      supports: () => true,
      available: async () => ({ ok: true }),
      run: async (ctx: RunContext) => {
        await writeFile(join(ctx.outDir, 'world.ply'), 'PLY');
        await writeFile(join(ctx.outDir, 'input_camera.json'), 'new');
        await Bun.write(join(ctx.outDir, 'scene.json'), JSON.stringify({ world: { ...WORLD, file: 'world.ply' } }));
      },
    };
    const runner = new JobRunner({ store: t.store, jobsDir: join(t.root, 'jobs'), drivers: [driver], emit: () => {} });
    runner.enqueue('photo-ddddd');
    await runner.idle();
    expect((await t.store.get('photo-ddddd'))!.status).toBe('ready');
    for (const f of ['reality.json', 'world-seen.spz', 'hotspots.json']) expect(await Bun.file(join(dir, f)).exists()).toBe(false);
    expect(await Bun.file(join(dir, 'input_camera.json')).text()).toBe('new');
  });

  test('wantsReality: Photo and Video worlds only', () => {
    expect(wantsReality(scene('a-aaaaa', { world: WORLD as unknown as Scene['world'] }))).toBe(true);
    expect(wantsReality(scene('a-aaaaa', { mode: 'thirdwheel', world: WORLD as unknown as Scene['world'] }))).toBe(true);
    expect(wantsReality(scene('a-aaaaa', { mode: 'sample', world: WORLD as unknown as Scene['world'] }))).toBe(false);
    expect(wantsReality(scene('a-aaaaa', { mode: 'reconstruct', world: WORLD as unknown as Scene['world'] }))).toBe(false);
    expect(wantsReality(scene('a-aaaaa', { status: 'running', world: WORLD as unknown as Scene['world'] }))).toBe(false);
    expect(wantsReality(scene('a-aaaaa'))).toBe(false);
  });
});
