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

describe('route table', () => {
  test('exports the two model paths', async () => {
    const r = await rig();
    expect(Object.keys(r.routes).sort()).toEqual([MODEL, GLB].sort());
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
