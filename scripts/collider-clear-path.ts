// Clears furniture out of a scene's collider wherever the capture's camera went: a person held the phone there, so
// nothing solid stood there at body height. Keeps the floor, the fence and the roof as they are; furniture columns
// (0.1 m cells, solid from the floor to their top, as pipeline/recon/frame.py and the kitchen's walk zone build them)
// are dropped within --radius of any camera and rebuilt from the cells that are left.
//
//   bun scripts/collider-clear-path.ts --scene data/scenes/kitchen [--radius 0.45] [--exclude photo/IMG_7398.jpg,...]
//       [--out collider.glb] [--dry-run]
//
// Reads <scene>/collider.glb and <scene>/cameras.json; writes <scene>/<out> after copying the old file to
// data/archive/colliders/<scene>-<sha1 prefix>.glb.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const sceneDir = resolve(opt('--scene', ''));
if (!sceneDir) throw new Error('--scene is required');
const radius = Number(opt('--radius', '0.45'));
const exclude = new Set(opt('--exclude', '').split(',').filter(Boolean));
const outName = opt('--out', 'collider.glb');
const CELL = 0.1;

// --- read the collider --------------------------------------------------------------------------------------------
const src = readFileSync(join(sceneDir, 'collider.glb'));
const jsonLen = src.readUInt32LE(12);
const gltf = JSON.parse(src.subarray(20, 20 + jsonLen).toString());
const bin0 = 20 + jsonLen + 8;
const accessor = (i: number) => {
  const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
  const off = bin0 + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const k = a.type === 'VEC3' ? 3 : 1;
  const bytes = a.count * k * (a.componentType === 5123 ? 2 : 4);
  const buf = src.buffer.slice(src.byteOffset + off, src.byteOffset + off + bytes);
  return a.componentType === 5126 ? new Float32Array(buf) : a.componentType === 5125 ? new Uint32Array(buf) : new Uint16Array(buf);
};
if (gltf.meshes.length !== 1 || gltf.meshes[0].primitives.length !== 1) throw new Error('expected one mesh with one primitive');
const prim = gltf.meshes[0].primitives[0];
const V = accessor(prim.attributes.POSITION) as Float32Array;
const I = accessor(prim.indices);

// --- split: furniture columns vs everything else (floor, fence, roof) ------------------------------------------------
// A column is a flat top between the floor and the roof plus axis-aligned sides one cell wide on the 0.1 m grid. The
// fence can be as tall as the columns, but it runs along the walk zone's outline in long, mostly diagonal pieces.
const cells = new Map<string, number>(); // "i,k" -> top
const tri = (t: number) => [I[t]! * 3, I[t + 1]! * 3, I[t + 2]! * 3] as const;
for (let t = 0; t < I.length; t += 3) {
  const [a, b, c] = tri(t);
  const ys = [V[a + 1]!, V[b + 1]!, V[c + 1]!];
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymax - ymin < 1e-4 && ymin > 0.02 && ymin < 2.6) {
    // tops can be merged rectangles: mark every cell whose centre lies inside this triangle
    const ax = V[a]!, az = V[a + 2]!, bx = V[b]!, bz = V[b + 2]!, cx = V[c]!, cz = V[c + 2]!;
    const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(area) < 1e-9) continue;
    for (let i = Math.floor(Math.min(ax, bx, cx) / CELL); i <= Math.floor(Math.max(ax, bx, cx) / CELL); i++) {
      for (let k = Math.floor(Math.min(az, bz, cz) / CELL); k <= Math.floor(Math.max(az, bz, cz) / CELL); k++) {
        const px = (i + 0.5) * CELL, pz = (k + 0.5) * CELL;
        const w0 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / area;
        const w1 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) cells.set(`${i},${k}`, ymin);
      }
    }
  }
}
const onGrid = (v: number) => Math.abs(v / CELL - Math.round(v / CELL)) < 1e-3;
const keepTris: number[] = [];
let furnitureTris = 0;
for (let t = 0; t < I.length; t += 3) {
  const [a, b, c] = tri(t);
  const xs = [V[a]!, V[b]!, V[c]!], ys = [V[a + 1]!, V[b + 1]!, V[c + 1]!], zs = [V[a + 2]!, V[b + 2]!, V[c + 2]!];
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const dx = Math.max(...xs) - Math.min(...xs), dz = Math.max(...zs) - Math.min(...zs);
  let furniture = false;
  if (ymax - ymin < 1e-4) {
    furniture = ymin > 0.02 && ymin < 2.6;
  } else if (ymin < 0.02 && dx < 1e-4 && onGrid(xs[0]!)) {
    // a side facing x (possibly several cells long): furniture if a column stands next to it anywhere along it
    const i = Math.round(xs[0]! / CELL);
    for (let k = Math.floor((Math.min(...zs) + 1e-4) / CELL); k < Math.ceil((Math.max(...zs) - 1e-4) / CELL) && !furniture; k++) {
      furniture = cells.has(`${i - 1},${k}`) || cells.has(`${i},${k}`);
    }
  } else if (ymin < 0.02 && dz < 1e-4 && onGrid(zs[0]!)) {
    const k = Math.round(zs[0]! / CELL);
    for (let i = Math.floor((Math.min(...xs) + 1e-4) / CELL); i < Math.ceil((Math.max(...xs) - 1e-4) / CELL) && !furniture; i++) {
      furniture = cells.has(`${i},${k - 1}`) || cells.has(`${i},${k}`);
    }
  }
  if (furniture) furnitureTris++;
  else keepTris.push(I[t]!, I[t + 1]!, I[t + 2]!);
}

// --- the camera path ------------------------------------------------------------------------------------------------
const cams = JSON.parse(readFileSync(join(sceneDir, 'cameras.json'), 'utf8')).cameras as { name: string; position: number[] }[];
const path = cams.filter((c) => !exclude.has(c.name)).map((c) => [c.position[0]!, c.position[2]!] as const);
const cleared = new Set<string>();
for (const key of cells.keys()) {
  const [i, k] = key.split(',').map(Number) as [number, number];
  const cx = (i + 0.5) * CELL, cz = (k + 0.5) * CELL;
  for (const [px, pz] of path) {
    if (Math.hypot(cx - px, cz - pz) < radius) {
      cleared.add(key);
      break;
    }
  }
}
for (const k of cleared) cells.delete(k);

// --- rebuild: the kept triangles, then one column per remaining cell (top + the sides facing an empty cell) --------
const pos: number[] = Array.from(V);
const idx: number[] = keepTris.slice();
const vert = (x: number, y: number, z: number) => {
  pos.push(x, y, z);
  return pos.length / 3 - 1;
};
const quad = (p: number[][]) => {
  const [a, b, c, d] = p.map(([x, y, z]) => vert(x!, y!, z!)) as [number, number, number, number];
  idx.push(a, b, c, a, c, d);
};
for (const [key, top] of cells) {
  const [i, k] = key.split(',').map(Number) as [number, number];
  const x0 = i * CELL, x1 = x0 + CELL, z0 = k * CELL, z1 = z0 + CELL;
  quad([[x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0]]);
  if (!cells.has(`${i - 1},${k}`)) quad([[x0, 0, z0], [x0, 0, z1], [x0, top, z1], [x0, top, z0]]);
  if (!cells.has(`${i + 1},${k}`)) quad([[x1, 0, z1], [x1, 0, z0], [x1, top, z0], [x1, top, z1]]);
  if (!cells.has(`${i},${k - 1}`)) quad([[x1, 0, z0], [x0, 0, z0], [x0, top, z0], [x1, top, z0]]);
  if (!cells.has(`${i},${k + 1}`)) quad([[x0, 0, z1], [x1, 0, z1], [x1, top, z1], [x0, top, z1]]);
}

console.log(JSON.stringify({
  scene: basename(sceneDir), cameras: path.length, radius, furnitureCells: cells.size + cleared.size, cleared: cleared.size,
  kept: cells.size, trianglesBefore: I.length / 3, furnitureTrianglesBefore: furnitureTris, trianglesAfter: idx.length / 3,
}));
if (args.includes('--dry-run')) process.exit(0);

// --- write a one-mesh GLB ------------------------------------------------------------------------------------------
const P = new Float32Array(pos);
const IX = new Uint32Array(idx);
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k]!, P[i + k]!); mx[k] = Math.max(mx[k]!, P[i + k]!); }
const bin = Buffer.concat([Buffer.from(P.buffer), Buffer.from(IX.buffer)]);
const json = {
  asset: { version: '2.0', generator: 'Déjà View collider-clear-path' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'collider', mesh: 0 }],
  meshes: [{ name: 'collider', primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: mn, max: mx },
    { bufferView: 1, componentType: 5125, count: IX.length, type: 'SCALAR' },
  ],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 }, { buffer: 0, byteOffset: P.byteLength, byteLength: IX.byteLength, target: 34963 }],
  buffers: [{ byteLength: bin.length }],
};
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
const chunk = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
const out = Buffer.concat([header, chunk(js.length, 0x4e4f534a), js, chunk(binPadded.length, 0x004e4942), binPadded]);

const archive = resolve(sceneDir, '../../archive/colliders');
mkdirSync(archive, { recursive: true });
const sha = createHash('sha1').update(src).digest('hex').slice(0, 10);
copyFileSync(join(sceneDir, 'collider.glb'), join(archive, `${basename(sceneDir)}-${sha}.glb`));
writeFileSync(join(sceneDir, outName), out);
console.log(`wrote ${join(sceneDir, outName)} (old one kept as ${join(archive, `${basename(sceneDir)}-${sha}.glb`)})`);
