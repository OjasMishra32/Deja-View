import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import { isValidId, SceneStore, slugify, writeJsonAtomic } from '../server/store.ts';

const roots: string[] = [];
async function freshStore(): Promise<SceneStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tw-store-'));
  roots.push(dir);
  return new SceneStore(dir);
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

function scene(id: string, createdAt: string, extra: Partial<Scene> = {}): Scene {
  return { id, name: id, mode: 'rentfree', status: 'queued', createdAt, updatedAt: createdAt, ...extra };
}

describe('slugify and ids', () => {
  test('slugs are lowercase ascii with dashes', () => {
    expect(slugify('My Dorm Room!')).toBe('my-dorm-room');
    expect(slugify('  Café   Crème  ')).toBe('cafe-creme');
    expect(slugify("Ana's kitchen")).toBe('anas-kitchen');
    expect(slugify('***')).toBe('scene');
    expect(slugify('')).toBe('scene');
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slugify('x'.repeat(39) + ' y')).not.toEndWith('-');
  });

  test('isValidId rejects traversal and odd characters', () => {
    expect(isValidId('sample-painted-bedroom')).toBe(true);
    expect(isValidId('my-room-ab3k9')).toBe(true);
    for (const bad of ['', '..', '../etc', 'a/b', 'A', '-lead', 'a b', 'a.b', 'x'.repeat(97)]) expect(isValidId(bad)).toBe(false);
  });

  test('newId slugs the name and adds a random suffix', async () => {
    const store = await freshStore();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = await store.newId('Kitchen at Ana’s');
      expect(id).toMatch(/^kitchen-at-anas-[a-z2-9]{5}$/);
      expect(isValidId(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});

describe('SceneStore', () => {
  let store: SceneStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  test('save then get round-trips and sets updatedAt', async () => {
    const s = scene('one-aaaaa', '2026-10-16T20:00:00.000Z');
    const saved = await store.save(s);
    expect(saved.updatedAt).not.toBe(s.updatedAt);
    const got = await store.get('one-aaaaa');
    expect(got?.name).toBe('one-aaaaa');
    expect(got?.status).toBe('queued');
    expect(await store.get('missing-zzzzz')).toBeNull();
    expect(await store.get('../escape')).toBeNull();
  });

  test('list is newest first and includes samples; skips broken dirs', async () => {
    await store.save(scene('old-aaaaa', '2026-10-16T20:00:00.000Z'));
    await store.save(scene('new-bbbbb', '2026-10-16T22:00:00.000Z'));
    await store.save(scene('sample-room', '2026-10-16T21:00:00.000Z', { mode: 'sample', status: 'ready', backend: 'bundled' }));
    await mkdir(join(store.dir, 'no-json-here'));
    await mkdir(join(store.dir, 'broken-ccccc'));
    await writeFile(join(store.dir, 'broken-ccccc', 'scene.json'), '{ not json');
    await writeFile(join(store.dir, 'stray-file.txt'), 'x');
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['new-bbbbb', 'sample-room', 'old-aaaaa']);
  });

  test('update merges patches and removes keys set to undefined', async () => {
    await store.save(scene('upd-aaaaa', '2026-10-16T20:00:00.000Z', { error: 'boom', stage: 'Failed', status: 'failed' }));
    const s = await store.update('upd-aaaaa', { status: 'queued', error: undefined, progress: 0 });
    expect(s?.status).toBe('queued');
    expect(s && 'error' in s).toBe(false);
    expect(s?.stage).toBe('Failed');
    const onDisk = await Bun.file(join(store.dir, 'upd-aaaaa', 'scene.json')).json();
    expect('error' in onDisk).toBe(false);
    expect(await store.update('nope-zzzzz', { status: 'ready' })).toBeNull();
  });

  test('concurrent read-modify-write updates are serialized per scene', async () => {
    await store.save(scene('cnt-aaaaa', '2026-10-16T20:00:00.000Z', { progress: 0 }));
    await Promise.all(
      Array.from({ length: 60 }, () =>
        store.update('cnt-aaaaa', (s) => {
          s.progress = (s.progress ?? 0) + 1;
        }),
      ),
    );
    expect((await store.get('cnt-aaaaa'))?.progress).toBe(60);
    const leftovers = (await readdir(join(store.dir, 'cnt-aaaaa'))).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('external edits are picked up (mtime cache)', async () => {
    await store.save(scene('ext-aaaaa', '2026-10-16T20:00:00.000Z'));
    expect((await store.get('ext-aaaaa'))?.name).toBe('ext-aaaaa');
    await Bun.sleep(20);
    const path = join(store.dir, 'ext-aaaaa', 'scene.json');
    const raw = await Bun.file(path).json();
    await writeFile(path, JSON.stringify({ ...raw, name: 'edited' }));
    expect((await store.get('ext-aaaaa'))?.name).toBe('edited');
  });

  test('delete removes the directory', async () => {
    await store.save(scene('del-aaaaa', '2026-10-16T20:00:00.000Z'));
    await writeFile(join(store.dir, 'del-aaaaa', 'world.spz'), 'x');
    expect(await store.delete('del-aaaaa')).toBe(true);
    expect(await store.get('del-aaaaa')).toBeNull();
    expect(await store.delete('del-aaaaa')).toBe(false);
    expect(() => store.sceneDir('../x')).toThrow();
  });
});

test('writeJsonAtomic never leaves a partial file under concurrent writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-atomic-'));
  roots.push(dir);
  const path = join(dir, 'x.json');
  const big = { data: 'y'.repeat(200_000) };
  const writers = Array.from({ length: 20 }, (_, i) => writeJsonAtomic(path, { ...big, i }));
  const readers = Array.from({ length: 40 }, async () => {
    await Bun.sleep(Math.random() * 5);
    if (await Bun.file(path).exists()) {
      const j = await Bun.file(path).json();
      expect(j.data.length).toBe(200_000);
    }
  });
  await Promise.all([...writers, ...readers]);
  expect((await readdir(dir)).filter((f) => f !== 'x.json')).toEqual([]);
});
