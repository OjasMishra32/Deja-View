// The HTTP layer: who may change things (server/guard.ts), CORS only on reads, mode names, product-copy errors,
// and the one-server-per-data-folder lock (server/lock.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { createApp, MESSAGES, modeMismatch } from '../server/app.ts';
import { NOT_ALLOWED_MESSAGE, type GuardOptions } from '../server/guard.ts';
import { JobRunner } from '../server/jobs.ts';
import { acquireDataLock, DataDirLocked, LOCK_NAME } from '../server/lock.ts';
import { SceneStore } from '../server/store.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function serve(guard?: GuardOptions) {
  const root = await mkdtemp(join(tmpdir(), 'tw-api-'));
  roots.push(root);
  const store = new SceneStore(join(root, 'scenes'));
  for (const [id, mode, files] of [
    ['photo-aaaaa', 'rentfree', ['input/00.jpg']],
    ['many-aaaaa', 'reconstruct', Array.from({ length: 8 }, (_, i) => `input/0${i}.jpg`)],
    ['clip-aaaaa', 'thirdwheel', ['input/video.mp4']],
  ] as const) {
    await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
    for (const f of files) await writeFile(join(store.sceneDir(id), f), 'x');
    await store.save({ id, name: id, mode, status: 'failed', error: 'x', createdAt: new Date().toISOString(), updatedAt: '', input: { files: [...files] } });
  }
  // No backends: a queued job fails at once, which is all these tests need.
  const runner = new JobRunner({ store, jobsDir: join(root, 'jobs'), drivers: [], emit: () => {} });
  const app = createApp({ store, runner, health: { info: async () => ({}) as any }, publish: () => {}, maxUploadBytes: 1 << 20, guard });
  const server: Server<undefined> = Bun.serve({ port: 0, fetch: async (r) => (await app.handle(r)) ?? new Response('nf', { status: 404 }) });
  return { root, store, runner, server, base: `http://localhost:${server.port}` };
}

describe('cross-site protection', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve();
  });
  afterAll(() => s.server.stop(true));

  test('reads stay open to every origin', async () => {
    const list = await fetch(`${s.base}/api/scenes`, { headers: { Origin: 'http://evil.example' } });
    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe('*');
    const pre = await fetch(`${s.base}/api/scenes`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).not.toContain('DELETE');
  });

  test('a preflight for DELETE or POST gets no CORS headers, so browsers refuse the request', async () => {
    for (const method of ['DELETE', 'POST']) {
      const pre = await fetch(`${s.base}/api/scenes/photo-aaaaa`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': method },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('a simple cross-site form POST and a cross-site DELETE are refused and change nothing', async () => {
    const form = new FormData();
    form.set('mode', 'photo');
    form.set('prompt', 'a cave');
    const post = await fetch(`${s.base}/api/scenes`, { method: 'POST', body: form, headers: { Origin: 'http://evil.example' } });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: NOT_ALLOWED_MESSAGE });
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
    const del = await fetch(`${s.base}/api/scenes/photo-aaaaa`, { method: 'DELETE', headers: { Origin: 'http://192.168.1.50:5173' } });
    expect(del.status).toBe(403);
    const retry = await fetch(`${s.base}/api/scenes/photo-aaaaa/retry`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(retry.status).toBe(403);
    expect((await s.store.list()).map((x) => x.id).sort()).toEqual(['clip-aaaaa', 'many-aaaaa', 'photo-aaaaa']);
  });

  test("the app's own pages (same origin) may create and retry; deleting is off unless allowed; no CORS headers", async () => {
    const res = await fetch(`${s.base}/api/scenes`, {
      method: 'POST',
      headers: { Origin: s.base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ mode: 'photo', prompt: 'a sunlit tea room' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const scene = await res.json();
    expect(scene.mode).toBe('photo'); // contracts 4.1: responses report photo or video
    expect(scene.stage).toBe('Queued');
    expect(scene.progress).toBe(0);
    expect(scene.error).toBeNull();
    expect((await s.store.get(scene.id))?.mode).toBe('rentfree'); // stored under the internal id
    await s.runner.idle();
    const refused = await fetch(`${s.base}/api/scenes/${scene.id}`, { method: 'DELETE', headers: { Origin: s.base } });
    expect(refused.status).toBe(403);
    expect(await s.store.get(scene.id)).not.toBeNull();
    process.env.THIRDWHEEL_ALLOW_DELETE = '1';
    try {
      const del = await fetch(`${s.base}/api/scenes/${scene.id}`, { method: 'DELETE', headers: { Origin: s.base } });
      expect(del.status).toBe(200);
    } finally {
      delete process.env.THIRDWHEEL_ALLOW_DELETE;
    }
  });
});

describe('API token', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve({ token: 'sekrit-123', allowedOrigins: ['https://tunnel.example'] });
  });
  afterAll(() => s.server.stop(true));

  test('with a token configured, scripts must send it; listed origins and the same origin need none', async () => {
    const body = JSON.stringify({ mode: 'video' });
    const headers = { 'Content-Type': 'application/json' };
    expect((await fetch(`${s.base}/api/scenes`, { method: 'POST', headers, body })).status).toBe(403);
    expect((await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, 'X-DejaView-Token': 'wrong' }, body })).status).toBe(403);
    // Past the guard, the upload itself is checked: Video mode without a video is a 400 with a product sentence.
    const ok = await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, 'X-DejaView-Token': 'sekrit-123' }, body });
    expect(ok.status).toBe(400);
    expect((await ok.json()).error).toBe('Video mode needs one video, filmed from a still, propped-up phone.');
    const bearer = await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer sekrit-123' }, body });
    expect(bearer.status).toBe(400);
    expect((await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, Origin: 'https://tunnel.example' }, body })).status).toBe(400);
    expect((await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, Origin: s.base }, body })).status).toBe(400);
    expect((await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example', 'X-DejaView-Token': 'sekrit-123' }, body })).status).toBe(400);
    // Reads never need it.
    expect((await fetch(`${s.base}/api/scenes`)).status).toBe(200);
  });
});

describe('retry with a mode', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    s = await serve();
  });
  afterAll(() => s.server.stop(true));

  const retry = (id: string, q = '', body?: unknown) =>
    fetch(`${s.base}/api/scenes/${id}/retry${q}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  test('photo and video are accepted as mode names; inputs must fit the mode', async () => {
    const bad = await retry('photo-aaaaa', '?mode=hologram');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Unknown mode "hologram". Use photo or video.');
    const noVideo = await retry('photo-aaaaa', '?mode=video');
    expect(noVideo.status).toBe(400);
    expect((await noVideo.json()).error).toBe('Video mode needs a video, and this scene was made from photos.');
    const same = await retry('clip-aaaaa', '?mode=video');
    expect(same.status).toBe(200);
    expect((await same.json()).mode).toBe('video');
    await s.runner.idle();
    const switched = await retry('many-aaaaa', '', { mode: 'photo' });
    expect(switched.status).toBe(200);
    expect((await switched.json()).mode).toBe('photo');
    await s.runner.idle();
    expect((await s.store.get('many-aaaaa'))?.mode).toBe('rentfree');
    const plain = await retry('photo-aaaaa');
    expect(plain.status).toBe(200);
    await s.runner.idle();
  });

  test('modeMismatch', () => {
    const scene = (files: string[], prompt?: string) => ({ input: { files, prompt } }) as any;
    expect(modeMismatch('thirdwheel', scene(['input/video.mov']))).toBeNull();
    expect(modeMismatch('reconstruct', scene(['input/00.jpg']))).toBe('Reconstruct needs at least 8 photos or a video.');
    expect(modeMismatch('rentfree', scene([], 'a cave'))).toBeNull();
    expect(modeMismatch('rentfree', scene([]))).toBe('Photo mode needs a photo, a video or a prompt.');
  });

  test('errors are product sentences', async () => {
    const missing = await retry('nope-zzzzz');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe(MESSAGES.noSuchScene);
    const unread = await fetch(`${s.base}/api/scenes`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
    expect(unread.status).toBe(415);
    expect((await unread.json()).error).toBe(MESSAGES.notAForm);
  });
});

describe('one server per data folder', () => {
  test('a live holder refuses a second server with a clear message; a stale lock is taken over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-lock-'));
    roots.push(dir);
    await writeFile(join(dir, LOCK_NAME), JSON.stringify({ pid: 424242, port: 8789, startedAt: 'x' }));
    let err: unknown;
    try {
      acquireDataLock(dir, 8792, () => true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DataDirLocked);
    expect((err as Error).message).toContain('Another Déjà View server (pid 424242, port 8789) is already using');
    expect((err as Error).message).toContain('THIRDWHEEL_DATA=');

    const lock = acquireDataLock(dir, 8792, () => false); // holder is gone
    expect(JSON.parse(await Bun.file(join(dir, LOCK_NAME)).text())).toMatchObject({ pid: process.pid, port: 8792 });
    // The same process may take it again (bun --hot re-evaluates the module).
    expect(acquireDataLock(dir, 8792, () => true).path).toBe(lock.path);
    lock.release();
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('read-only server', () => {
  test('a read-only server shows scenes and refuses every change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tw-ro-'));
    roots.push(root);
    const store = new SceneStore(join(root, 'scenes'));
    const runner = new JobRunner({ store, jobsDir: join(root, 'jobs'), drivers: [], emit: () => {} });
    const app = createApp({ store, runner, health: { info: async () => ({}) as any }, publish: () => {}, maxUploadBytes: 1024, readOnly: true });
    expect((await app.handle(new Request('http://x/api/scenes')))!.status).toBe(200);
    const res = (await app.handle(new Request('http://x/api/scenes', { method: 'POST', body: JSON.stringify({ mode: 'photo', prompt: 'x' }), headers: { 'Content-Type': 'application/json' } })))!;
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(MESSAGES.readOnly);
  });
});

describe('unlisted scenes', () => {
  test('a test build is left out of the list of worlds but still opens by its id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tw-unlisted-'));
    roots.push(root);
    const store = new SceneStore(join(root, 'scenes'));
    const at = new Date().toISOString();
    await store.save({ id: 'home-aaaaa', name: 'Home', mode: 'rentfree', status: 'ready', createdAt: at, updatedAt: at });
    await store.save({ id: 'home-test1', name: 'Home', mode: 'rentfree', status: 'ready', createdAt: at, updatedAt: at, unlisted: true });
    const runner = new JobRunner({ store, jobsDir: join(root, 'jobs'), drivers: [], emit: () => {} });
    const app = createApp({ store, runner, health: { info: async () => ({}) as any }, publish: () => {}, maxUploadBytes: 1024, readOnly: true });
    const list = (await (await app.handle(new Request('http://x/api/scenes')))!.json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual(['home-aaaaa']);
    expect((await app.handle(new Request('http://x/api/scenes/home-test1')))!.status).toBe(200);
  });
});

describe('unlisted id prefixes', () => {
  test('a scene whose id starts with a configured prefix reads as unlisted, even when its scene.json says nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tw-prefix-'));
    roots.push(root);
    const store = new SceneStore(join(root, 'scenes'), ['oh-cand-']);
    const at = new Date().toISOString();
    await store.save({ id: 'oh-cand-refit', name: 'Home', mode: 'rentfree', status: 'ready', createdAt: at, updatedAt: at });
    await store.save({ id: 'old-house', name: 'Home', mode: 'rentfree', status: 'ready', createdAt: at, updatedAt: at });
    expect((await store.get('oh-cand-refit'))!.unlisted).toBe(true);
    expect((await store.get('old-house'))!.unlisted).toBeUndefined();
  });
});
