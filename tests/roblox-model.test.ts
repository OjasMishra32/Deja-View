import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import {
  createRobloxModelRoutes,
  MAX_UPLOAD_BYTES,
  RobloxAssetUploader,
  RobloxModelService,
  uploaderFromEnv,
  type ModelHandler,
} from '../server/social/roblox-model.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const REMOTE = { requestIP: () => ({ address: '10.0.0.5' }) };
const LOCAL = { requestIP: () => ({ address: '127.0.0.1' }) };

function scene(id: string): Scene {
  return {
    id,
    name: `Room ${id}`,
    mode: 'rentfree',
    status: 'ready',
    createdAt: '2026-10-17T00:00:00Z',
    updatedAt: '2026-10-17T00:00:00Z',
    world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'flashworld' },
  };
}

/** A tiny but real GLB header + some bytes; the routes never parse it. */
function fakeGlb(seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64);
  out.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 64, 0, 0, 0]);
  for (let i = 12; i < 64; i++) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

interface Calls {
  method: string;
  url: string;
  key: string | null;
  request?: Record<string, unknown>;
  file?: { type: string; name: string; size: number };
}

/** A fake Open Cloud: POST /assets returns an operation that is done after `pollsUntilDone` polls. */
function fakeRoblox(opts: { pollsUntilDone?: number; failCreate?: number; assetId?: string; opError?: string } = {}) {
  const calls: Calls[] = [];
  let polls = 0;
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = new Headers(init?.headers).get('x-api-key');
    const call: Calls = { method, url, key };
    calls.push(call);
    if (method === 'POST' && url.endsWith('/assets/v1/assets')) {
      const form = init!.body as FormData;
      call.request = JSON.parse(String(form.get('request')));
      const f = form.get('fileContent') as File;
      call.file = { type: f.type, name: f.name, size: f.size };
      if (opts.failCreate) return new Response(JSON.stringify({ message: 'Forbidden' }), { status: opts.failCreate });
      n++;
      polls = 0;
      return Response.json({ path: `operations/op-${n}`, operationId: `op-${n}`, done: false });
    }
    const m = url.match(/\/assets\/v1\/operations\/(op-\d+)$/);
    if (m) {
      polls++;
      if (polls < (opts.pollsUntilDone ?? 2)) return Response.json({ path: `operations/${m[1]}`, done: false });
      if (opts.opError) return Response.json({ path: `operations/${m[1]}`, done: true, error: { code: 3, message: opts.opError } });
      return Response.json({
        path: `operations/${m[1]}`,
        done: true,
        response: { assetId: opts.assetId ?? `90000${n}`, assetType: 'Model', displayName: 'x' },
      });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

interface Rig {
  dir: string;
  routes: Record<string, ModelHandler>;
  models: RobloxModelService;
  logs: string[];
}

async function rig(opts: { uploader?: RobloxAssetUploader | null; dvKey?: string } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'dv-rmodel-'));
  roots.push(dir);
  const scenes = new Map<string, Scene>();
  for (const id of ['room-a', 'room-b']) {
    scenes.set(id, scene(id));
    await mkdir(join(dir, id), { recursive: true });
  }
  const glb = fakeGlb(1);
  await writeFile(join(dir, 'room-a', 'roblox.glb'), glb);
  await writeFile(
    join(dir, 'room-a', 'roblox-model.json'),
    JSON.stringify({ version: 1, sceneId: 'room-a', name: 'Room room-a', units: 'studs', studsPerMeter: 3.57, sha1: sha1(glb), triangles: 12, chunks: [{ name: 'room_00', kind: 'room', triangles: 12 }] }),
  );
  const logs: string[] = [];
  const models = new RobloxModelService({ sceneDir: (id) => join(dir, id), uploader: opts.uploader, log: (m) => logs.push(m), failureHoldMs: 60_000 });
  const routes = createRobloxModelRoutes({ getScene: async (id) => scenes.get(id) ?? null, models, dvKey: opts.dvKey, log: (m) => logs.push(m) });
  return { dir, routes, models, logs };
}

const req = (path: string, init?: RequestInit) => new Request(`http://dv.test${path}`, init);
const GLB = '/api/roblox/:sceneId/model.glb';
const MODEL = '/api/roblox/:sceneId/model';
const FILE = '/api/roblox/:sceneId/model/:file';
const OBJECTS = '/api/roblox/:sceneId/objects';

describe('route table', () => {
  test('exports the model paths', async () => {
    const r = await rig();
    expect(Object.keys(r.routes).sort()).toEqual([MODEL, GLB, FILE, OBJECTS].sort());
  });
});

describe('object layer', () => {
  const doc = { version: 1, sceneId: 'room-a', units: 'studs', objects: [{ id: 'fridge', label: 'fridge', center: [0, 3, -8], size: [3, 6, 4], color: [245, 246, 242] }] };

  test('GET serves the layer and POST writes it', async () => {
    const r = await rig();
    expect((await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects'), LOCAL)).status).toBe(404);
    const post = await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects', { method: 'POST', body: JSON.stringify(doc), headers: { 'content-type': 'application/json' } }), LOCAL);
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ ok: true, objects: 1 });
    const get = await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects'), LOCAL);
    expect(get.status).toBe(200);
    expect((await get.json()).objects[0].id).toBe('fridge');
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('POST rejects a non-stud layer and GET is key-gated off localhost', async () => {
    const r = await rig({ dvKey: 'sekret' });
    const bad = await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects', { method: 'POST', body: JSON.stringify({ units: 'metres', objects: [] }) }), REMOTE);
    expect(bad.status).toBe(401);
    const noKey = await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects', { method: 'POST', body: JSON.stringify(doc) }), REMOTE);
    expect(noKey.status).toBe(401);
    const withKey = await r.routes[OBJECTS]!(req('/api/roblox/room-a/objects', { method: 'POST', body: JSON.stringify({ ...doc, units: 'metres' }), headers: { 'x-dejaview-key': 'sekret' } }), REMOTE);
    expect(withKey.status).toBe(400);
  });
});

describe('GET /api/roblox/:sceneId/model.glb', () => {
  test('streams the file with CORS, the glTF type, an ETag; HEAD and 304 work', async () => {
    const r = await rig();
    const res = await r.routes[GLB]!(req('/api/roblox/room-a/model.glb'), LOCAL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-length')).toBe('64');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(fakeGlb(1));
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"rg-/);

    const head = await r.routes[GLB]!(req('/api/roblox/room-a/model.glb', { method: 'HEAD' }), LOCAL);
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const again = await r.routes[GLB]!(req('/api/roblox/room-a/model.glb', { headers: { 'if-none-match': etag } }), LOCAL);
    expect(again.status).toBe(304);

    const opt = await r.routes[GLB]!(req('/api/roblox/room-a/model.glb', { method: 'OPTIONS' }), REMOTE);
    expect(opt.status).toBe(204);
    expect(opt.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('404 with a plain sentence when the world has no model, or there is no such scene', async () => {
    const r = await rig();
    const none = await r.routes[GLB]!(req('/api/roblox/room-b/model.glb'), LOCAL);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'This room has no Roblox model yet.' });
    expect(none.headers.get('access-control-allow-origin')).toBe('*');
    const missing = await r.routes[GLB]!(req('/api/roblox/nope/model.glb'), LOCAL);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No such scene' });
    const bad = await r.routes[GLB]!(req('/api/roblox/..%2Fetc/model.glb'), LOCAL);
    expect(bad.status).toBe(404);
    const post = await r.routes[GLB]!(req('/api/roblox/room-a/model.glb', { method: 'POST' }), LOCAL);
    expect(post.status).toBe(405);
  });

  test('DV_KEY is checked from other machines', async () => {
    const r = await rig({ dvKey: 'sekret' });
    expect((await r.routes[GLB]!(req('/api/roblox/room-a/model.glb'), REMOTE)).status).toBe(401);
    expect((await r.routes[GLB]!(req('/api/roblox/room-a/model.glb', { headers: { 'x-dejaview-key': 'sekret' } }), REMOTE)).status).toBe(200);
    expect((await r.routes[GLB]!(req('/api/roblox/room-a/model.glb'), LOCAL)).status).toBe(200);
  });
});

describe('GET /api/roblox/:sceneId/model', () => {
  test('the sidecar plus glbUrl; uploads off without ROBLOX_API_KEY', async () => {
    const r = await rig();
    const res = await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b).toMatchObject({ sceneId: 'room-a', units: 'studs', studsPerMeter: 3.57, glbUrl: '/api/roblox/room-a/model.glb', upload: { state: 'off' } });
    expect(b.assetId).toBeUndefined();
    const post = await r.routes[MODEL]!(req('/api/roblox/room-a/model', { method: 'POST' }), LOCAL);
    expect(post.status).toBe(409);
    expect(((await post.json()) as { error: string }).error).toContain('ROBLOX_API_KEY');
    const none = await r.routes[MODEL]!(req('/api/roblox/room-b/model'), LOCAL);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'This room has no Roblox model yet.' });
  });

  test('with an uploader: GET starts the upload, polls the operation, then reports and stores the assetId', async () => {
    const fake = fakeRoblox({ pollsUntilDone: 3, assetId: '1234567890' });
    const uploader = new RobloxAssetUploader({ apiKey: 'k-123', creatorId: '42', fetch: fake.fetchImpl, pollMs: 1, sleep: async () => {} });
    const r = await rig({ uploader });
    const first = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(first.upload.state).toBe('uploading');
    expect(first.assetId).toBeUndefined();
    await r.models.settle('room-a');

    const create = fake.calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe('https://apis.roblox.com/assets/v1/assets');
    expect(create.key).toBe('k-123');
    expect(create.request).toMatchObject({ assetType: 'Model', creationContext: { creator: { userId: '42' } } });
    expect(String(create.request!.displayName)).toContain('Room room-a');
    expect(create.file).toEqual({ type: 'model/gltf-binary', name: 'roblox.glb', size: 64 });
    const polls = fake.calls.filter((c) => c.url.includes('/operations/op-1'));
    expect(polls.length).toBe(3);
    expect(polls.every((c) => c.key === 'k-123' && c.method === 'GET')).toBe(true);

    const after = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(after.assetId).toBe('1234567890');
    expect(after.upload).toMatchObject({ state: 'done', assetId: '1234567890' });
    const stored = JSON.parse(await readFile(join(r.dir, 'room-a', 'roblox-model.json'), 'utf8'));
    expect(stored.assetId).toBe('1234567890');
    expect(stored.upload).toMatchObject({ assetId: '1234567890', sha1: sha1(fakeGlb(1)), operationId: 'op-1' });
    expect(stored.triangles).toBe(12); // the rest of the sidecar is kept
    // nothing new is uploaded while the file is unchanged
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    expect(fake.calls.filter((c) => c.method === 'POST').length).toBe(1);
  });

  test('a rebuilt model is not reported with the old assetId and goes up again', async () => {
    const fake = fakeRoblox({ pollsUntilDone: 1 });
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '7', creatorType: 'group', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    expect(fake.calls[0]!.request).toMatchObject({ creationContext: { creator: { groupId: '7' } } });
    // the pipeline writes a new model and a new sidecar (without the upload fields)
    const glb2 = fakeGlb(2);
    await writeFile(join(r.dir, 'room-a', 'roblox.glb'), glb2);
    await writeFile(join(r.dir, 'room-a', 'roblox-model.json'), JSON.stringify({ sceneId: 'room-a', name: 'Room room-a', sha1: sha1(glb2) }));
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.assetId).toBeUndefined();
    expect(b.upload.state).toBe('uploading');
    await r.models.settle('room-a');
    const c = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(c.assetId).toBe('900002');
    // a sidecar whose assetId belongs to another file never reports it
    await writeFile(join(r.dir, 'room-a', 'roblox-model.json'), JSON.stringify({ sha1: 'abc', assetId: '1', upload: { assetId: '1', sha1: 'def' } }));
    const head = await r.routes[MODEL]!(req('/api/roblox/room-a/model', { method: 'HEAD' }), LOCAL);
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const s = await r.models.sidecar('room-a');
    expect(RobloxModelService.currentAssetId(s!)).toBeUndefined();
    const e = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(e.assetId).toBeUndefined();
    await r.models.settle('room-a');
  });

  test('a refused key fails with a sentence, is held (no retry storm), and POST retries on demand', async () => {
    const fake = fakeRoblox({ failCreate: 403 });
    const uploader = new RobloxAssetUploader({ apiKey: 'bad', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.upload.state).toBe('failed');
    expect(b.upload.error).toContain('refused the API key');
    await r.models.settle('room-a');
    expect(fake.calls.filter((c) => c.method === 'POST').length).toBe(1);
    const post = await r.routes[MODEL]!(req('/api/roblox/room-a/model', { method: 'POST' }), LOCAL);
    expect(post.status).toBe(202);
    expect(((await post.json()) as Record<string, any>).upload.state).toBe('uploading');
    await r.models.settle('room-a');
    expect(fake.calls.filter((c) => c.method === 'POST').length).toBe(2);
    expect(r.logs.some((l) => l.includes('upload failed'))).toBe(true);
  });

  test('an import error from Roblox and a missing assetId are failures', async () => {
    const fake = fakeRoblox({ pollsUntilDone: 1, opError: 'Mesh has too many triangles' });
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    await expect(uploader.upload(fakeGlb(3), 'x', 'y')).rejects.toThrow('Mesh has too many triangles');
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(uploader.upload(big, 'x', 'y')).rejects.toThrow('20 MB');
  });
});

describe('uploaderFromEnv', () => {
  test('only with ROBLOX_UPLOAD=1, ROBLOX_API_KEY and a numeric ROBLOX_CREATOR_ID', () => {
    const on = { ROBLOX_UPLOAD: '1' };
    expect(uploaderFromEnv({})).toBeNull();
    expect(uploaderFromEnv({ ...on, ROBLOX_API_KEY: 'k' })).toBeNull();
    expect(uploaderFromEnv({ ...on, ROBLOX_CREATOR_ID: '42' })).toBeNull();
    expect(uploaderFromEnv({ ...on, ROBLOX_API_KEY: 'k', ROBLOX_CREATOR_ID: 'not-a-number' })).toBeNull();
    expect(uploaderFromEnv({ ...on, ROBLOX_API_KEY: 'k', ROBLOX_CREATOR_ID: '42' })).toBeInstanceOf(RobloxAssetUploader);
    // a key in .env alone never uploads: test servers load the same .env
    expect(uploaderFromEnv({ ROBLOX_API_KEY: 'k', ROBLOX_CREATOR_ID: '42' })).toBeNull();
    expect(uploaderFromEnv({ ROBLOX_UPLOAD: '0', ROBLOX_API_KEY: 'k', ROBLOX_CREATOR_ID: '42' })).toBeNull();
  });
});

// ---------------------------------------------------------------- v2: several parts and a skybox

const FACES = ['front', 'back', 'left', 'right', 'up', 'down'] as const;

function fakePng(seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(48);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < 48; i++) out[i] = (i * 13 + seed) & 0xff;
  return out;
}

/** A fake Open Cloud that records every create and fails the create calls numbered in `failAt` (1-based). */
function fakeRoblox2(opts: { failAt?: number[] } = {}) {
  const creates: { request: Record<string, any>; file: { type: string; name: string; size: number } }[] = [];
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/assets/v1/assets')) {
      n++;
      const form = init!.body as FormData;
      const f = form.get('fileContent') as File;
      creates.push({ request: JSON.parse(String(form.get('request'))), file: { type: f.type, name: f.name, size: f.size } });
      if (opts.failAt?.includes(n)) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      return Response.json({ path: `operations/op-${n}`, operationId: `op-${n}`, done: false });
    }
    const m = url.match(/\/assets\/v1\/operations\/op-(\d+)$/);
    if (m) return Response.json({ path: `operations/op-${m[1]}`, done: true, response: { assetId: `77000${m[1]}` } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { creates, fetchImpl };
}

/** room-v2: roblox.glb + roblox-2.glb and six sky faces, described by a v2 sidecar. */
async function writeV2(dir: string, seed = 10): Promise<Record<string, string>> {
  const d = join(dir, 'room-a');
  const p1 = fakeGlb(seed), p2 = fakeGlb(seed + 1);
  await writeFile(join(d, 'roblox.glb'), p1);
  await writeFile(join(d, 'roblox-2.glb'), p2);
  const sky: Record<string, { file: string; sha1: string }> = {};
  for (const [i, f] of FACES.entries()) {
    const png = fakePng(seed + i);
    await writeFile(join(d, `sky-${f}.png`), png);
    sky[f] = { file: `sky-${f}.png`, sha1: sha1(png) };
  }
  await writeFile(
    join(d, 'roblox-model.json'),
    JSON.stringify({
      version: 2, sceneId: 'room-a', name: 'Room room-a', units: 'studs', studsPerMeter: 3.57, file: 'roblox.glb', sha1: sha1(p1),
      parts: [
        { file: 'roblox.glb', sha1: sha1(p1), bytes: 64, triangles: 9 },
        { file: 'roblox-2.glb', sha1: sha1(p2), bytes: 64, triangles: 3 },
      ],
      sky,
      skyInfo: { size: 1024 },
      chunks: [],
    }),
  );
  return { p1: sha1(p1), p2: sha1(p2) };
}

describe('v2 sidecars: model parts and a skybox', () => {
  test('GET uploads every part as a Model and every face as a Decal, then reports parts, assetId and sky', async () => {
    const fake = fakeRoblox2();
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await writeV2(r.dir);
    const first = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(first.upload).toMatchObject({ state: 'uploading', done: 0, total: 8 });
    expect(first.assetId).toBeUndefined();
    expect(first.sky).toBeNull();
    expect(first.parts).toEqual([
      { file: 'roblox.glb', url: '/api/roblox/room-a/model/roblox.glb', bytes: 64, triangles: 9 },
      { file: 'roblox-2.glb', url: '/api/roblox/room-a/model/roblox-2.glb', bytes: 64, triangles: 3 },
    ]);
    expect(first.skyFiles.up).toBe('/api/roblox/room-a/model/sky-up.png');
    await r.models.settle('room-a');

    expect(fake.creates.map((c) => [c.request.assetType, c.file.type, c.file.name])).toEqual([
      ['Model', 'model/gltf-binary', 'roblox.glb'],
      ['Model', 'model/gltf-binary', 'roblox-2.glb'],
      ...FACES.map((f) => ['Decal', 'image/png', `sky-${f}.png`]),
    ]);
    expect(fake.creates[1]!.request.displayName).toContain('2/2');
    expect(fake.creates[2]!.request.displayName).toContain('sky front');
    expect(fake.creates.every((c) => c.request.creationContext.creator.userId === '42')).toBe(true);

    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.upload).toMatchObject({ state: 'done', assetId: '770001', done: 8, total: 8 });
    expect(b.assetId).toBe('770001');
    expect(b.parts.map((p: any) => [p.file, p.assetId])).toEqual([['roblox.glb', '770001'], ['roblox-2.glb', '770002']]);
    expect(b.sky).toEqual({ front: '770003', back: '770004', left: '770005', right: '770006', up: '770007', down: '770008' });
    const stored = JSON.parse(await readFile(join(r.dir, 'room-a', 'roblox-model.json'), 'utf8'));
    expect(stored.parts[1].upload).toMatchObject({ assetId: '770002', operationId: 'op-2' });
    expect(stored.sky.down.upload).toMatchObject({ assetId: '770008' });
    expect(stored.upload).toMatchObject({ assetId: '770001', sha1: stored.sha1 }); // v1 readers see the first part
    expect(stored.skyInfo).toEqual({ size: 1024 });
    // nothing goes up again while the files are unchanged
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    expect(fake.creates.length).toBe(8);
  });

  test('a half-uploaded room reports no assetId; a failed sky still lets the room load', async () => {
    const fake = fakeRoblox2({ failAt: [2] });
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await writeV2(r.dir);
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.upload).toMatchObject({ state: 'failed', done: 1, total: 8 });
    expect(b.upload.error).toContain('500');
    expect(b.assetId).toBeUndefined(); // a game must never load half a room
    expect(b.parts[0].assetId).toBe('770001');
    expect(b.parts[1].assetId).toBeUndefined();
    expect(fake.creates.length).toBe(2); // the job stops at the first failure ...
    // ... and POST resumes where it stopped
    const fake2 = fakeRoblox2({ failAt: [3] });
    const r2 = await rig({ uploader: new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake2.fetchImpl, sleep: async () => {} }) });
    await writeV2(r2.dir);
    await r2.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r2.models.settle('room-a');
    const c = (await (await r2.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(c.assetId).toBe('770001'); // both parts are up: the room loads
    expect(c.sky).toBeNull(); // the first face failed: no sky yet
    expect(c.upload.state).toBe('failed');
    const post = await r2.routes[MODEL]!(req('/api/roblox/room-a/model', { method: 'POST' }), LOCAL);
    expect(post.status).toBe(202);
    await r2.models.settle('room-a');
    const d = (await (await r2.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(d.upload.state).toBe('done');
    expect(Object.keys(d.sky).sort()).toEqual([...FACES].sort());
    expect(fake2.creates.map((x) => x.file.name).filter((n) => n === 'roblox.glb').length).toBe(1);
  });

  test('a rebuilt part goes up again on its own; the room has no assetId until it is up', async () => {
    const fake = fakeRoblox2();
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await writeV2(r.dir);
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    expect(fake.creates.length).toBe(8);
    // the pipeline rebuilds part 2 only: new file, its sha1 in the (otherwise uploaded) sidecar
    const path = join(r.dir, 'room-a', 'roblox-model.json');
    const s = JSON.parse(await readFile(path, 'utf8'));
    const p2 = fakeGlb(99);
    await writeFile(join(r.dir, 'room-a', 'roblox-2.glb'), p2);
    s.parts[1] = { file: 'roblox-2.glb', sha1: sha1(p2) };
    await writeFile(path, JSON.stringify(s));
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.assetId).toBeUndefined();
    expect(b.sky).not.toBeNull(); // the sky did not change
    expect(b.upload).toMatchObject({ state: 'uploading', done: 7, total: 8 });
    await r.models.settle('room-a');
    expect(fake.creates.length).toBe(9);
    expect(fake.creates[8]!.file.name).toBe('roblox-2.glb');
    const c = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(c.assetId).toBe('770001');
    expect(c.parts[1].assetId).toBe('770009');
  });

  test('a first part a v1 server already uploaded (top-level upload record) is not uploaded again', async () => {
    const fake = fakeRoblox2();
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    const sums = await writeV2(r.dir);
    const path = join(r.dir, 'room-a', 'roblox-model.json');
    const s = JSON.parse(await readFile(path, 'utf8'));
    // what the v1 code writes after uploading roblox.glb
    await writeFile(path, JSON.stringify({ ...s, assetId: '555', upload: { assetId: '555', sha1: sums.p1, operationId: 'op-x', at: 1 } }));
    const a = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(a.upload).toMatchObject({ state: 'uploading', done: 1, total: 8 });
    expect(a.assetId).toBeUndefined(); // part 2 is not up yet
    await r.models.settle('room-a');
    expect(fake.creates.map((c) => c.file.name)).toEqual(['roblox-2.glb', ...FACES.map((f) => `sky-${f}.png`)]);
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.assetId).toBe('555');
    expect(b.parts.map((x: any) => x.assetId)).toEqual(['555', '770001']);
  });

  test('a file on disk that is not the one the sidecar describes is not uploaded', async () => {
    const fake = fakeRoblox2();
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    await writeV2(r.dir);
    await writeFile(join(r.dir, 'room-a', 'roblox-2.glb'), fakeGlb(55)); // mid-rebuild: new file, old sidecar
    await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL);
    await r.models.settle('room-a');
    expect(fake.creates.map((c) => c.file.name)).toEqual(['roblox.glb']);
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.upload.state).toBe('failed');
    expect(b.upload.error).toContain('roblox-2.glb');
  });

  test('the file route serves listed parts and sky faces only', async () => {
    const r = await rig();
    await writeV2(r.dir);
    const part = await r.routes[FILE]!(req('/api/roblox/room-a/model/roblox-2.glb'), LOCAL);
    expect(part.status).toBe(200);
    expect(part.headers.get('content-type')).toBe('model/gltf-binary');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(fakeGlb(11));
    const face = await r.routes[FILE]!(req('/api/roblox/room-a/model/sky-up.png'), LOCAL);
    expect(face.status).toBe(200);
    expect(face.headers.get('content-type')).toBe('image/png');
    expect(face.headers.get('access-control-allow-origin')).toBe('*');
    const etag = face.headers.get('etag')!;
    expect((await r.routes[FILE]!(req('/api/roblox/room-a/model/sky-up.png', { headers: { 'if-none-match': etag } }), LOCAL)).status).toBe(304);
    for (const bad of ['roblox-model.json', 'roblox-3.glb', '..%2Fscene.json', 'sky-sideways.png', 'world.spz']) {
      const res = await r.routes[FILE]!(req(`/api/roblox/room-a/model/${bad}`), LOCAL);
      expect(res.status).toBe(404);
    }
    expect((await r.routes[FILE]!(req('/api/roblox/room-a/model/sky-up.png', { method: 'POST' }), LOCAL)).status).toBe(405);
    expect((await r.routes[FILE]!(req('/api/roblox/nope/model/roblox.glb'), LOCAL)).status).toBe(404);
    const keyed = await rig({ dvKey: 'sekret' });
    await writeV2(keyed.dir);
    expect((await keyed.routes[FILE]!(req('/api/roblox/room-a/model/roblox.glb'), REMOTE)).status).toBe(401);
  });

  test('a v1 sidecar reports one part and no sky', async () => {
    const fake = fakeRoblox2();
    const uploader = new RobloxAssetUploader({ apiKey: 'k', creatorId: '42', fetch: fake.fetchImpl, sleep: async () => {} });
    const r = await rig({ uploader });
    const a = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(a.parts).toEqual([{ file: 'roblox.glb', url: '/api/roblox/room-a/model/roblox.glb' }]);
    expect(a.sky).toBeNull();
    expect(a.skyFiles).toBeNull();
    await r.models.settle('room-a');
    const b = (await (await r.routes[MODEL]!(req('/api/roblox/room-a/model'), LOCAL)).json()) as Record<string, any>;
    expect(b.parts).toEqual([{ file: 'roblox.glb', url: '/api/roblox/room-a/model/roblox.glb', assetId: '770001' }]);
    expect(b.assetId).toBe('770001');
    expect(fake.creates.map((c) => c.request.assetType)).toEqual(['Model']);
    expect((await r.routes[FILE]!(req('/api/roblox/room-a/model/roblox.glb'), LOCAL)).status).toBe(200);
  });
});

describe('the uploader', () => {
  test('a Decal goes up as image/png with its own file name', async () => {
    const fake = fakeRoblox2();
    const up = new RobloxAssetUploader({ apiKey: 'k', creatorId: '7', creatorType: 'group', fetch: fake.fetchImpl, sleep: async () => {} });
    const res = await up.upload(fakePng(1), 'x'.repeat(80), 'd', { assetType: 'Decal', fileName: 'sky-up.png' });
    expect(res.assetId).toBe('770001');
    expect(fake.creates[0]).toMatchObject({ request: { assetType: 'Decal', creationContext: { creator: { groupId: '7' } } }, file: { type: 'image/png', name: 'sky-up.png' } });
    expect(fake.creates[0]!.request.displayName.length).toBe(50);
  });
});
