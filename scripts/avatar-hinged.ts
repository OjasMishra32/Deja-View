// Adds a door that swings on its hinge on the clip's clock to a Video memory's avatar GLB (pipeline/avatar), next to
// the people, so the viewer plays it with no code of its own: a fridge or cupboard door the person opens. While the
// door is open its panel swings out and a lit interior covers the closed door the splats still show; while it is
// closed nothing is drawn and the splats show the real door.
//
//   bun scripts/avatar-hinged.ts --glb data/scenes/kitchen-cooking/avatar-0.glb --name fridge-door \
//       --hinge -0.627,-2.846 --along -0.9171,0.3987 --out-dir 0.3987,0.9171 --width 0.8 --y 0.05,1.08 \
//       --keys 19.3:0,20.3:110,28.3:110,29.2:0 [--interior] [--handle]
//
// --hinge x,z: the hinge line (scene frame, metres). --along: the closed door's direction from the hinge to its free
// edge. --out-dir: the door's outward normal (the way it swings). --keys t:degrees,...: the opening angle over time
// (linear between keys). Writes the GLB in place (the first run keeps <name>.pre-doors.glb).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name: string, def = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1]! : def; };
const glbPath = opt('--glb');
const name = opt('--name', 'door');
const [hx, hz] = opt('--hinge').split(',').map(Number) as [number, number];
const [ax, az] = opt('--along').split(',').map(Number) as [number, number];
const [nx, nz] = opt('--out-dir').split(',').map(Number) as [number, number];
const width = Number(opt('--width', '0.8'));
const [y0, y1] = opt('--y', '0,1').split(',').map(Number) as [number, number];
const keys = opt('--keys').split(',').map((k) => k.split(':').map(Number) as [number, number]);
if (!glbPath || keys.length < 2 || [hx, hz, ax, az, nx, nz].some((v) => !Number.isFinite(v))) throw new Error('see the usage at the top');

const src = readFileSync(glbPath);
const jlen = src.readUInt32LE(12);
const gltf = JSON.parse(src.subarray(20, 20 + jlen).toString());
const binStart = 20 + jlen + 8;
let bin = Buffer.from(src.subarray(binStart, binStart + src.readUInt32LE(20 + jlen)));
if (gltf.nodes.some((n: any) => n.name === `prop:${name}`)) throw new Error(`already has prop:${name}`);
const anim = gltf.animations.find((a: any) => a.name === 'video') ?? gltf.animations[0];

// ---- geometry (unlit, shading baked into vertex colours) ------------------------------------------------------------
type V3 = [number, number, number];
const L = [0.35, 0.85, 0.4].map((v, _, a) => v / Math.hypot(...a));
const shade = (c: number[], n: number[]) => c.map((v) => Math.min(1, v * (0.62 + 0.42 * Math.max(0, n[0]! * L[0]! + n[1]! * L[1]! + n[2]! * L[2]!))));
const geo = () => ({ pos: [] as number[], col: [] as number[], idx: [] as number[] });
const quad = (g: ReturnType<typeof geo>, a: V3, b: V3, c: V3, d: V3, colour: number[], flat = false) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
  const k = g.pos.length / 3;
  const shaded = flat ? colour : shade(colour, n);
  g.pos.push(...a, ...b, ...c, ...d);
  g.col.push(...shaded, ...shaded, ...shaded, ...shaded);
  g.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
};
const box = (g: ReturnType<typeof geo>, x0: number, ya: number, z0: number, x1: number, yb: number, z1: number, out: number[], inn: number[]) => {
  // faces: outer (-z), inner (+z), the four edges
  quad(g, [x1, ya, z0], [x0, ya, z0], [x0, yb, z0], [x1, yb, z0], out);
  quad(g, [x0, ya, z1], [x1, ya, z1], [x1, yb, z1], [x0, yb, z1], inn);
  quad(g, [x0, ya, z0], [x0, ya, z1], [x0, yb, z1], [x0, yb, z0], out);
  quad(g, [x1, ya, z1], [x1, ya, z0], [x1, yb, z0], [x1, yb, z1], out);
  quad(g, [x0, yb, z0], [x0, yb, z1], [x1, yb, z1], [x1, yb, z0], out);
  quad(g, [x0, ya, z1], [x0, ya, z0], [x1, ya, z0], [x1, ya, z1], out);
};

// Local frame of a door at the hinge: +x along the closed door, +y up, +z = x cross y (= into the fridge, so the
// outward side is -z). The panel stands just outside the closed door's plane.
const STEEL = [0.3, 0.31, 0.32], LINER = [0.78, 0.78, 0.76], HANDLE = [0.16, 0.16, 0.17]; // linear colours (glTF COLOR_0)
const door = geo();
const T = 0.05;
box(door, 0, y0, -T, width, y1, 0, STEEL, LINER);
// the inside of the door: two bins on the liner
for (const yb of [y0 + 0.3, y0 + 0.65].filter((v) => v < y1 - 0.15)) box(door, 0.05, yb, 0, width - 0.05, yb + 0.12, 0.07, [0.55, 0.6, 0.64], [0.55, 0.6, 0.64]);
if (args.includes('--handle')) box(door, width - 0.09, y0 + 0.1, -T - 0.045, width - 0.06, Math.min(y1 - 0.05, y0 + 0.75), -T - 0.02, HANDLE, HANDLE);
const inside = geo();
// the lit inside of the fridge, just outside the closed door so it covers it while the door is open
const z = -0.012;
quad(inside, [width, y0, z], [0, y0, z], [0, y1, z], [width, y1, z], [0.86, 0.93, 0.99], true);
for (let s = 1; s <= 3; s++) {
  const ys = y0 + ((y1 - y0) * s) / 4;
  quad(inside, [width - 0.04, ys, z - 0.002], [0.04, ys, z - 0.002], [0.04, ys + 0.012, z - 0.002], [width - 0.04, ys + 0.012, z - 0.002], [0.55, 0.62, 0.7], true);
}

// ---- GLB plumbing -------------------------------------------------------------------------------------------------
const pad4 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const addAcc = (arr: Float32Array | Uint32Array, type: 'SCALAR' | 'VEC3' | 'VEC4', minmax = false, target?: number) => {
  bin = pad4(bin);
  const view: any = { buffer: 0, byteOffset: bin.length, byteLength: arr.byteLength };
  if (target) view.target = target;
  bin = Buffer.concat([bin, Buffer.from(arr.buffer)]);
  gltf.bufferViews.push(view);
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const acc: any = { bufferView: gltf.bufferViews.length - 1, componentType: arr instanceof Uint32Array ? 5125 : 5126, count: arr.length / n, type };
  if (minmax) {
    const mn = Array(n).fill(Infinity), mx = Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { mn[i % n] = Math.min(mn[i % n], arr[i]!); mx[i % n] = Math.max(mx[i % n], arr[i]!); }
    acc.min = mn; acc.max = mx;
  }
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
};
const material = (() => {
  gltf.materials.push({ name: `prop:${name}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, extensions: { KHR_materials_unlit: {} } });
  return gltf.materials.length - 1;
})();
const addMesh = (g: ReturnType<typeof geo>, label: string) => {
  const p = addAcc(new Float32Array(g.pos), 'VEC3', true, 34962);
  const c = addAcc(new Float32Array(g.col), 'VEC3', false, 34962);
  const i = addAcc(new Uint32Array(g.idx), 'SCALAR', false, 34963);
  gltf.meshes.push({ name: label, primitives: [{ attributes: { POSITION: p, COLOR_0: c }, indices: i, material }] });
  return gltf.meshes.length - 1;
};
const addTrack = (node: number, path: 'rotation' | 'scale', times: number[], values: number[], interpolation: 'LINEAR' | 'STEP') => {
  const tin = addAcc(new Float32Array(times), 'SCALAR', true);
  const tout = addAcc(new Float32Array(values), path === 'rotation' ? 'VEC4' : 'VEC3');
  anim.samplers.push({ input: tin, output: tout, interpolation });
  anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path } });
};

// ---- place and animate --------------------------------------------------------------------------------------------
// yaw that turns local +x onto the door's direction at opening angle a: dir(a) = cos a * along + sin a * out
const yawAt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a) * ax + Math.sin(a) * nx, dz = Math.cos(a) * az + Math.sin(a) * nz;
  return Math.atan2(-dz, dx);
};
const quatY = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const end = Math.max(...anim.samplers.map((s: any) => gltf.accessors[s.input].max?.[0] ?? 0));
const times = keys.map(([t]) => t);
const doorNode = gltf.nodes.length;
gltf.nodes.push({ name: `prop:${name}`, mesh: addMesh(door, `prop:${name}`), translation: [hx, 0, hz], rotation: quatY(yawAt(0)), scale: [0, 0, 0] });
// unwrap the yaw so the rotation keys interpolate the short way
let prev = yawAt(keys[0]![1]);
const rots: number[] = [];
for (const [, deg] of keys) {
  let y = yawAt(deg);
  while (y - prev > Math.PI) y -= 2 * Math.PI;
  while (y - prev < -Math.PI) y += 2 * Math.PI;
  rots.push(...quatY(y));
  prev = y;
}
addTrack(doorNode, 'rotation', times, rots, 'LINEAR');
// drawn only while open: from the first key that opens it to the last key that has it open
const openKeys = keys.filter(([, d]) => d > 1);
const tOpen = keys[keys.findIndex(([, d]) => d > 1) - 1]?.[0] ?? openKeys[0]![0];
const tShut = keys[keys.length - 1]![0];
addTrack(doorNode, 'scale', [0, tOpen, tShut, end], [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0], 'STEP');
if (args.includes('--interior')) {
  const inNode = gltf.nodes.length;
  gltf.nodes.push({ name: `prop:${name}-inside`, mesh: addMesh(inside, `prop:${name}-inside`), translation: [hx, 0, hz], rotation: quatY(yawAt(0)), scale: [0, 0, 0] });
  addTrack(inNode, 'scale', [0, tOpen + 0.25, tShut - 0.25, end], [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0], 'STEP');
  gltf.scenes[0].nodes.push(inNode);
}
gltf.scenes[0].nodes.push(doorNode);

bin = pad4(bin);
gltf.buffers[0].byteLength = bin.length;
let js = Buffer.from(JSON.stringify(gltf));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
const keep = glbPath.replace(/\.glb$/, '.pre-doors.glb');
if (!existsSync(keep)) copyFileSync(glbPath, keep);
writeFileSync(glbPath, Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
console.log(JSON.stringify({ glb: glbPath, door: name, open: [tOpen, tShut], yawClosedDeg: +((yawAt(0) * 180) / Math.PI).toFixed(1), triangles: door.idx.length / 3 }));
