import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { createApp } from '../server/app.ts';
import { mimeFor, parseRange, safeJoin, serveFile } from '../server/files.ts';
import { JobRunner } from '../server/jobs.ts';
import { SceneStore } from '../server/store.ts';

describe('parseRange', () => {
  const size = 1000;
  test('single ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=990-5000', size)).toEqual({ start: 990, end: 999 });
    expect(parseRange(' bytes = 10 - 20 ', size)).toEqual({ start: 10, end: 20 });
  });
  test('unsatisfiable and ignored ranges', () => {
    expect(parseRange('bytes=1000-', size)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', size)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange(null, size)).toBeNull();
    expect(parseRange('items=0-1', size)).toBeNull();
    expect(parseRange('bytes=5-1', size)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', size)).toBeNull();
    expect(parseRange('bytes=abc', size)).toBeNull();
    expect(parseRange('bytes=-', size)).toBeNull();
  });
});

describe('safeJoin', () => {
  const base = '/srv/data/scenes/a';
  test('accepts nested files', () => {
    expect(safeJoin(base, 'world.spz')).toBe('/srv/data/scenes/a/world.spz');
    expect(safeJoin(base, 'input/00.jpg')).toBe('/srv/data/scenes/a/input/00.jpg');
    expect(safeJoin(base, 'my%20file.jpg')).toBe('/srv/data/scenes/a/my file.jpg');
  });
  test('rejects traversal, hidden files and junk', () => {
    for (const bad of ['../b/scene.json', '..%2Fb', '%2e%2e/x', 'input/../../x', '.hidden', 'a/.git/config', 'a\\b', '%00', '', '/', '%E0%A4%A']) {
      expect(safeJoin(base, bad)).toBeNull();
    }
  });
});

test('MIME types', () => {
  expect(mimeFor('world.spz')).toBe('application/octet-stream');
  expect(mimeFor('world.ply')).toBe('application/octet-stream');
  expect(mimeFor('tw.mp4')).toBe('video/mp4');
  expect(mimeFor('thumb.JPG')).toBe('image/jpeg');
  expect(mimeFor('x.png')).toBe('image/png');
  expect(mimeFor('scene.json')).toStartWith('application/json');
  expect(mimeFor('collider.glb')).toBe('model/gltf-binary');
  expect(mimeFor('noext')).toBe('application/octet-stream');
});

describe('serveFile (direct)', () => {
  let dir: string;
  let path: string;
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tw-range-'));
    path = join(dir, 'clip.mp4');
    await writeFile(path, bytes);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const req = (headers: Record<string, string> = {}, method = 'GET') => new Request('http://x/clip.mp4', { headers, method });

  test('206 with Content-Range and the exact bytes', async () => {
    const res = await serveFile(req({ Range: 'bytes=100-199' }), path);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/4096');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  test('200, 416, 304, HEAD, If-Range and 404', async () => {
    const full = await serveFile(req(), path);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('4096');
    const etag = full.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);

    const bad = await serveFile(req({ Range: 'bytes=5000-' }), path);
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */4096');

    expect((await serveFile(req({ 'If-None-Match': etag }), path)).status).toBe(304);

    const head = await serveFile(req({}, 'HEAD'), path);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('4096');

    expect((await serveFile(req({ Range: 'bytes=0-9', 'If-Range': etag }), path)).status).toBe(206);
    expect((await serveFile(req({ Range: 'bytes=0-9', 'If-Range': '"stale"' }), path)).status).toBe(200);

    expect((await serveFile(req(), join(dir, 'missing.mp4'))).status).toBe(404);
    expect((await serveFile(req(), dir)).status).toBe(404);
  });
});

describe('scene assets over HTTP', () => {
  let root: string;
  let server: Server<undefined>;
  let base: string;
  const video = new Uint8Array(1_000_000).map((_, i) => (i * 7) % 256);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tw-http-'));
    const store = new SceneStore(join(root, 'scenes'));
    const sceneDir = join(root, 'scenes', 'demo-aaaaa');
    await mkdir(join(sceneDir, 'input'), { recursive: true });
    await writeFile(join(sceneDir, 'tw.mp4'), video);
    await writeFile(join(sceneDir, 'world.spz'), video.slice(0, 1000));
    await writeFile(join(sceneDir, 'input', '00.jpg'), video.slice(0, 10));
    await writeFile(join(root, 'secret.txt'), 'nope');
    await store.save({ id: 'demo-aaaaa', name: 'Demo', mode: 'thirdwheel', status: 'ready', createdAt: '2026-10-16T20:00:00Z', updatedAt: '' });
    const runner = new JobRunner({ store, jobsDir: join(root, 'jobs'), drivers: [], emit: () => {} });
    const app = createApp({
      store,
      runner,
      health: { info: async () => ({}) as any },
      publish: () => {},
      maxUploadBytes: 1024,
    });
    server = Bun.serve({ port: 0, fetch: async (r) => (await app.handle(r)) ?? new Response('nf', { status: 404 }) });
    base = `http://localhost:${server.port}`;
  });
  afterAll(async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test('video Range requests seek correctly through a real server', async () => {
    for (const [a, b] of [[0, 1], [500_000, 599_999], [999_000, 999_999]] as const) {
      const res = await fetch(`${base}/data/scenes/demo-aaaaa/tw.mp4`, { headers: { Range: `bytes=${a}-${b}` } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${a}-${b}/1000000`);
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(video.slice(a, b + 1));
    }
    const open = await fetch(`${base}/data/scenes/demo-aaaaa/tw.mp4`, { headers: { Range: 'bytes=999990-' } });
    expect(open.status).toBe(206);
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const stale = await fetch(`${base}/data/scenes/demo-aaaaa/tw.mp4`, { headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(1_000_000);
  });

  test('MIME, nested paths, CORS preflight and traversal', async () => {
    const spz = await fetch(`${base}/data/scenes/demo-aaaaa/world.spz`);
    expect(spz.headers.get('content-type')).toBe('application/octet-stream');
    expect((await spz.arrayBuffer()).byteLength).toBe(1000);
    expect((await fetch(`${base}/data/scenes/demo-aaaaa/input/00.jpg`)).status).toBe(200);
    const pre = await fetch(`${base}/data/scenes/demo-aaaaa/tw.mp4`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('Range');
    expect((await fetch(`${base}/data/scenes/demo-aaaaa/..%2F..%2Fsecret.txt`)).status).toBe(400);
    expect((await fetch(`${base}/data/scenes/..%2Fsecret.txt/x`)).status).toBe(404);
    expect((await fetch(`${base}/data/scenes/demo-aaaaa/nothing.bin`)).status).toBe(404);
  });

  test('API basics: list, get, 404, oversize upload', async () => {
    const list = await (await fetch(`${base}/api/scenes`)).json();
    expect(list.map((s: any) => s.id)).toEqual(['demo-aaaaa']);
    expect((await fetch(`${base}/api/scenes/demo-aaaaa`)).status).toBe(200);
    expect((await fetch(`${base}/api/scenes/nope-zzzzz`)).status).toBe(404);
    expect((await fetch(`${base}/api/scenes/demo-aaaaa`, { method: 'PUT' })).status).toBe(405);
    const big = new FormData();
    big.set('mode', 'rentfree');
    big.set('files', new File([new Uint8Array(4096)], 'big.jpg'));
    const res = await fetch(`${base}/api/scenes`, { method: 'POST', body: big });
    expect(res.status).toBe(413);
  });
});
