// Downloads public demo splats into data/scenes/sample-* so the viewer has something to show
// before any generation has run. Safe to re-run: existing files are kept.

import { mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Scene } from '../shared/types.ts';

const SCENES_DIR = resolve(import.meta.dir, '..', 'data', 'scenes');

const SAMPLES: { id: string; name: string; url: string; caption: string }[] = [
  {
    id: 'sample-painted-bedroom',
    name: 'Painted bedroom',
    url: 'https://storage.googleapis.com/forge-dev-public/painted_bedroom.spz',
    caption: 'Sample world',
  },
  {
    id: 'sample-greyscale-room',
    name: 'Greyscale room',
    url: 'https://storage.googleapis.com/forge-dev-public/marble-scenes/greyscale-room.spz',
    caption: 'Sample world',
  },
];

for (const s of SAMPLES) {
  const dir = join(SCENES_DIR, s.id);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, 'world.spz');
  if (!(await Bun.file(dest).exists())) {
    process.stdout.write(`Downloading ${s.name}... `);
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(`${s.url}: ${res.status}`);
    await Bun.write(dest + '.part', new Uint8Array(await res.arrayBuffer()));
    await rename(dest + '.part', dest);
    console.log(`${(Bun.file(dest).size / 1e6).toFixed(1)} MB`);
  }
  const metaPath = join(dir, 'scene.json');
  if (await Bun.file(metaPath).exists()) continue;
  const now = new Date().toISOString();
  const scene: Scene = {
    id: s.id,
    name: s.name,
    mode: 'sample',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    backend: 'bundled',
    caption: s.caption,
    world: {
      file: 'world.spz',
      transform: { position: [0, 0, 0], quaternion: [1, 0, 0, 0], scale: 1 },
      floorY: null,
      source: 'marble-sample',
    },
  };
  await Bun.write(metaPath, JSON.stringify(scene, null, 2));
}
console.log(`Samples ready in ${SCENES_DIR}`);
