// Scene store: one directory per scene under data/scenes/<id>/ with a scene.json (shared/types.ts Scene).

import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Scene } from '../shared/types.ts';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

/** Lowercase ASCII slug, at most 40 characters, never empty. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'scene';
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomSuffix(len = 5): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Writes JSON via a temp file and rename so readers never see a partial file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomSuffix(6)}`;
  try {
    await Bun.write(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

type Mutator = (scene: Scene) => Scene | void | Promise<Scene | void>;

export class SceneStore {
  private cache = new Map<string, { mtimeMs: number; scene: Scene }>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string) {}

  sceneDir(id: string): string {
    if (!isValidId(id)) throw new Error(`invalid scene id: ${id}`);
    return join(this.dir, id);
  }

  private metaPath(id: string): string {
    return join(this.sceneDir(id), 'scene.json');
  }

  /** A fresh id slugged from the name with a short random suffix; never collides with an existing directory. */
  async newId(name: string): Promise<string> {
    const base = slugify(name);
    for (let i = 0; i < 20; i++) {
      const id = `${base}-${randomSuffix(i < 10 ? 5 : 8)}`;
      const exists = await stat(join(this.dir, id)).then(() => true, () => false);
      if (!exists) return id;
    }
    throw new Error('could not allocate a scene id');
  }

  async get(id: string): Promise<Scene | null> {
    if (!isValidId(id)) return null;
    const path = this.metaPath(id);
    let st;
    try {
      st = await stat(path);
    } catch {
      this.cache.delete(id);
      return null;
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs) return structuredClone(hit.scene);
    try {
      const scene = (await Bun.file(path).json()) as Scene;
      if (!scene || typeof scene !== 'object' || typeof scene.id !== 'string') return null;
      scene.id = id;
      this.cache.set(id, { mtimeMs: st.mtimeMs, scene });
      return structuredClone(scene);
    } catch (e) {
      console.warn(`[store] unreadable ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  /** All scenes, newest first. Directories without a readable scene.json are skipped. */
  async list(): Promise<Scene[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const scenes = (await Promise.all(names.filter(isValidId).map((n) => this.get(n)))).filter(
      (s): s is Scene => s !== null,
    );
    scenes.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id));
    return scenes;
  }

  /** Writes the scene as-is (sets updatedAt). */
  async save(scene: Scene): Promise<Scene> {
    return this.withLock(scene.id, () => this.write(scene));
  }

  private async write(scene: Scene): Promise<Scene> {
    const out: Scene = { ...scene, updatedAt: new Date().toISOString() };
    const path = this.metaPath(scene.id);
    await writeJsonAtomic(path, out);
    const st = await stat(path);
    this.cache.set(scene.id, { mtimeMs: st.mtimeMs, scene: structuredClone(out) });
    return structuredClone(out);
  }

  /**
   * Read-modify-write under a per-scene lock. Accepts a partial patch or a mutator.
   * Keys set to undefined in a patch are removed. Returns null if the scene no longer exists.
   */
  async update(id: string, change: Partial<Scene> | Mutator): Promise<Scene | null> {
    return this.withLock(id, async () => {
      const cur = await this.get(id);
      if (!cur) return null;
      let next: Scene;
      if (typeof change === 'function') {
        next = (await change(cur)) ?? cur;
      } else {
        next = { ...cur, ...change };
        for (const k of Object.keys(change) as (keyof Scene)[]) if (change[k] === undefined) delete next[k];
      }
      next.id = id;
      return this.write(next);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      const dir = this.sceneDir(id);
      const existed = await stat(dir).then(() => true, () => false);
      this.cache.delete(id);
      if (existed) await rm(dir, { recursive: true, force: true });
      return existed;
    });
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }
}
