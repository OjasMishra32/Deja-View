import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, 'cache');
const safe = (key) => encodeURIComponent(key);

export async function loadCache(kind, key) {
  try { return JSON.parse(await readFile(join(root, kind, `${safe(key)}.json`), 'utf8')); }
  catch { return null; }
}

export async function saveCache(kind, key, value) {
  const directory = join(root, kind);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${safe(key)}.json`), JSON.stringify(value));
}
