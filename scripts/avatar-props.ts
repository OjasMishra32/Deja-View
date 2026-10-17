// Gives a person in a Video memory something to carry: a prop that rides in one hand while they hold it and rests
// where they put it down, baked into their avatar GLB (pipeline/avatar) so the viewer plays it on the same clock as
// the body with no code of its own. Today's prop is a gallon milk jug (white body, coloured cap, handle).
//
//   bun scripts/avatar-props.ts --glb data/scenes/kitchen-cooking/avatar-0.glb --bone wrist.R \
//       --carry 25.5,33.5 --pose-time 31 [--rest x,y,z,yaw] [--cap red] [--out <glb>] [--drop 0.04] [--forward 0.04]
//       [--yaw-offset 90]
//
// --carry FROM,TO: seconds of the clip the prop is in that hand. --pose-time: a moment of the carry where the arm hangs
// naturally; the prop is hung upright from the hand there (handle in the palm, --drop below the joint) and keeps that
// grip for the whole carry, its body hanging in front of the hand (turned --yaw-offset degrees from the way the body
// faces, --forward metres ahead of the hand) the way a jug carried by its handle hangs. --rest: where it stands from TO on (the floor of the scene frame is y = 0; y is the
// surface it stands on). Writes --out (default: the input, after keeping the original as <name>.pre-props.glb).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name: string, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const glbPath = opt('--glb');
if (!glbPath) throw new Error('--glb is required');
const boneName = opt('--bone', 'wrist.R');
const [carryFrom, carryTo] = opt('--carry').split(',').map(Number) as [number, number];
if (!(carryTo > carryFrom)) throw new Error('--carry FROM,TO is required');
const poseTime = Number(opt('--pose-time', String((carryFrom + carryTo) / 2)));
const rest = args.includes('--rest') ? opt('--rest').split(',').map(Number) : null;
const drop = Number(opt('--drop', '0.04'));
const forward = Number(opt('--forward', '0.04'));
const yawOffset = (Number(opt('--yaw-offset', '90')) * Math.PI) / 180;
const capColour = ({ red: [0.82, 0.1, 0.1], blue: [0.12, 0.3, 0.8], purple: [0.5, 0.2, 0.7] } as Record<string, number[]>)[opt('--cap', 'red')]!;
const outPath = opt('--out', glbPath);

// ---- read the GLB ----------------------------------------------------------------------------------------------------
const src = readFileSync(glbPath);
const jlen = src.readUInt32LE(12);
const gltf = JSON.parse(src.subarray(20, 20 + jlen).toString());
const binStart = 20 + jlen + 8;
const binLen = src.readUInt32LE(20 + jlen);
let bin = Buffer.from(src.subarray(binStart, binStart + binLen));
if (gltf.nodes.some((n: any) => typeof n.name === 'string' && n.name.startsWith('prop:'))) throw new Error('this GLB already has props; start from the .pre-props.glb');

const read = (i: number): Float32Array => {
  const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
  if (a.componentType !== 5126) throw new Error('expected float accessor');
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type as string]!;
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Float32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * n * 4));
};

// ---- forward kinematics at one moment ------------------------------------------------------------------------------
type V3 = [number, number, number];
type Q = [number, number, number, number];
const anim = gltf.animations.find((a: any) => a.name === 'video') ?? gltf.animations[0];
const sampleAt = (t: number, node: number, path: 'translation' | 'rotation'): number[] | null => {
  const ch = anim.channels.find((c: any) => c.target.node === node && c.target.path === path);
  if (!ch) return null;
  const s = anim.samplers[ch.sampler];
  const ti = read(s.input), to = read(s.output);
  const k = path === 'rotation' ? 4 : 3;
  let i = 0;
  while (i < ti.length - 1 && ti[i + 1]! < t) i++;
  const t0 = ti[i]!, t1 = ti[Math.min(i + 1, ti.length - 1)]!;
  const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const a = Array.from(to.subarray(i * k, i * k + k));
  const b = Array.from(to.subarray(Math.min(i + 1, ti.length - 1) * k, Math.min(i + 1, ti.length - 1) * k + k));
  if (k === 4 && a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]! < 0) for (let j = 0; j < 4; j++) b[j] = -b[j]!;
  const r = a.map((v, j) => v + (b[j]! - v) * u);
  if (k === 4) { const l = Math.hypot(...r); return r.map((v) => v / l); }
  return r;
};
const mat = (t: V3, q: Q, s: V3) => {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const mul = (a: number[], b: number[]) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};
const invRigid = (m: number[]) => {
  // inverse of rotation (with uniform scale) + translation
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), s2 = sx * sx;
  const r = [m[0]! / s2, m[4]! / s2, m[8]! / s2, 0, m[1]! / s2, m[5]! / s2, m[9]! / s2, 0, m[2]! / s2, m[6]! / s2, m[10]! / s2, 0, 0, 0, 0, 1];
  const t = [m[12]!, m[13]!, m[14]!];
  r[12] = -(r[0]! * t[0]! + r[4]! * t[1]! + r[8]! * t[2]!);
  r[13] = -(r[1]! * t[0]! + r[5]! * t[1]! + r[9]! * t[2]!);
  r[14] = -(r[2]! * t[0]! + r[6]! * t[1]! + r[10]! * t[2]!);
  return r;
};
const parent = new Map<number, number>();
gltf.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
const worldAt = (node: number, t: number): number[] => {
  const n = gltf.nodes[node];
  const tr = (sampleAt(t, node, 'translation') ?? n.translation ?? [0, 0, 0]) as V3;
  const ro = (sampleAt(t, node, 'rotation') ?? n.rotation ?? [0, 0, 0, 1]) as Q;
  const local = n.matrix ?? mat(tr, ro, (n.scale ?? [1, 1, 1]) as V3);
  const p = parent.get(node);
  return p == null ? local : mul(worldAt(p, t), local);
};
const bone = gltf.nodes.findIndex((n: any) => n.name === boneName);
if (bone < 0) throw new Error(`no joint named ${boneName}`);
const pelvis = gltf.nodes.findIndex((n: any) => n.name === 'root');

// the prop's world pose at --pose-time: upright, handle in the palm a little below the joint, facing the way the body
// faces (its handle side towards the body), then expressed in the joint's frame
const W = worldAt(bone, poseTime);
const P = worldAt(pelvis >= 0 ? pelvis : 0, poseTime);
const fwd = [P[8]!, 0, P[10]!]; // the body's local +Z on the floor
const yaw = Math.atan2(fwd[0]!, fwd[2]!);
const fl = Math.hypot(fwd[0]!, fwd[2]!) || 1;
const hand: V3 = [W[12]! + (forward * fwd[0]!) / fl, W[13]! - drop, W[14]! + (forward * fwd[2]!) / fl];
const jy = yaw + yawOffset;
const jugWorld = mat(hand, [0, Math.sin(jy / 2), 0, Math.cos(jy / 2)], [1, 1, 1]);
const local = mul(invRigid(W), jugWorld);

// ---- the jug ------------------------------------------------------------------------------------------------------
// Built around the top of its handle (the grip) at the origin, body below, so hanging it from the hand is natural.
const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
const L = (() => { const v = [0.35, 0.85, 0.4]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
const shade = (base: number[], n: number[]) => {
  const d = Math.max(0, n[0]! * L[0]! + n[1]! * L[1]! + n[2]! * L[2]!);
  return base.map((c) => Math.min(1, c * (0.6 + 0.45 * d)));
};
const GRIP: V3 = [0.07, 0.21, 0]; // on the handle's inner edge, so the body hangs close under the palm
const quad = (a: V3, b: V3, c: V3, d: V3, base: number[]) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
  const k = pos.length / 3;
  for (const p of [a, b, c, d]) { pos.push(p[0] - GRIP[0], p[1] - GRIP[1], p[2] - GRIP[2]); nor.push(...n); col.push(...shade(base, n)); }
  idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
};
// a rounded-square bottle: SEG sides between radius-y profiles
const SEG = 16;
const ring = (r: number, y: number, sq: number) => Array.from({ length: SEG }, (_, i) => {
  const a = (i / SEG) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
  const k = Math.pow(Math.pow(Math.abs(c), 2 + sq) + Math.pow(Math.abs(s), 2 + sq), -1 / (2 + sq)); // squircle
  return [r * c * k, y, r * s * k] as V3;
});
const loft = (profile: [number, number, number][], base: number[]) => {
  for (let p = 0; p < profile.length - 1; p++) {
    const A = ring(...profile[p]!), B = ring(...profile[p + 1]!);
    for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; quad(A[i]!, A[j]!, B[j]!, B[i]!, base); }
  }
};
const cap = (r: number, y: number, sq: number, base: number[], up: boolean) => {
  const R = ring(r, y, sq), c: V3 = [0, y, 0];
  for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; up ? quad(c, R[j]!, R[i]!, R[i]!, base) : quad(c, R[i]!, R[j]!, R[j]!, base); }
};
const WHITE = [0.95, 0.95, 0.93];
loft([[0.075, 0.0, 6], [0.08, 0.01, 6], [0.08, 0.17, 6], [0.07, 0.205, 4], [0.035, 0.235, 1], [0.022, 0.245, 0]], WHITE);
cap(0.075, 0.0, 6, WHITE, false);
loft([[0.023, 0.245, 0], [0.023, 0.27, 0]], capColour);
cap(0.023, 0.27, 0, capColour, true);
// the handle: a squared loop on +x from the shoulder down the side, thick enough to read from a few metres
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, base: number[]) => {
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], base);
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], base);
  quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], base);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], base);
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], base);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], base);
};
box(0.1, 0.1, -0.017, 0.13, 0.215, 0.017, WHITE);
box(0.06, 0.19, -0.017, 0.13, 0.215, 0.017, WHITE);
box(0.06, 0.1, -0.017, 0.13, 0.125, 0.017, WHITE);

// ---- append to the GLB ---------------------------------------------------------------------------------------------
const pad4 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const addView = (buf: Buffer, target?: number) => {
  bin = pad4(bin);
  const view: any = { buffer: 0, byteOffset: bin.length, byteLength: buf.length };
  if (target) view.target = target;
  bin = Buffer.concat([bin, buf]);
  gltf.bufferViews.push(view);
  return gltf.bufferViews.length - 1;
};
const addAccessor = (arr: Float32Array | Uint32Array, type: string, extra: any = {}) => {
  const view = addView(Buffer.from(arr.buffer), arr instanceof Uint32Array ? 34963 : extra.vertex ? 34962 : undefined);
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]!;
  const acc: any = { bufferView: view, componentType: arr instanceof Uint32Array ? 5125 : 5126, count: arr.length / n, type };
  if (extra.minmax) {
    const mn = Array(n).fill(Infinity), mx = Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { mn[i % n] = Math.min(mn[i % n], arr[i]!); mx[i % n] = Math.max(mx[i % n], arr[i]!); }
    acc.min = mn; acc.max = mx;
  }
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
};
const aPos = addAccessor(new Float32Array(pos), 'VEC3', { minmax: true, vertex: true });
const aNor = addAccessor(new Float32Array(nor), 'VEC3', { vertex: true });
const aCol = addAccessor(new Float32Array(col), 'VEC3', { vertex: true });
const aIdx = addAccessor(new Uint32Array(idx), 'SCALAR');
gltf.materials.push({ name: 'prop:jug', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } });
gltf.meshes.push({ name: 'prop:jug', primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, COLOR_0: aCol }, indices: aIdx, material: gltf.materials.length - 1 }] });
const jugMesh = gltf.meshes.length - 1;

// decompose `local` into TRS for the hand node
const sx = Math.hypot(local[0]!, local[1]!, local[2]!);
const m = local.map((v, i) => (i < 12 && i % 4 !== 3 ? v / sx : v));
const tr = m[0]! + m[5]! + m[10]!;
let q: Q;
if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m[6]! - m[9]!) / s, (m[8]! - m[2]!) / s, (m[1]! - m[4]!) / s, 0.25 * s]; }
else if (m[0]! > m[5]! && m[0]! > m[10]!) { const s = Math.sqrt(1 + m[0]! - m[5]! - m[10]!) * 2; q = [0.25 * s, (m[4]! + m[1]!) / s, (m[8]! + m[2]!) / s, (m[6]! - m[9]!) / s]; }
else if (m[5]! > m[10]!) { const s = Math.sqrt(1 + m[5]! - m[0]! - m[10]!) * 2; q = [(m[4]! + m[1]!) / s, 0.25 * s, (m[9]! + m[6]!) / s, (m[8]! - m[2]!) / s]; }
else { const s = Math.sqrt(1 + m[10]! - m[0]! - m[5]!) * 2; q = [(m[8]! + m[2]!) / s, (m[9]! + m[6]!) / s, 0.25 * s, (m[1]! - m[4]!) / s]; }
const handNode = gltf.nodes.length;
gltf.nodes.push({ name: 'prop:jug-in-hand', mesh: jugMesh, translation: [local[12], local[13], local[14]], rotation: q, scale: [0, 0, 0] });
gltf.nodes[bone].children = [...(gltf.nodes[bone].children ?? []), handNode];

const end = Math.max(...anim.samplers.map((s: any) => { const t = read(s.input); return t[t.length - 1]!; }));
const scaleTrack = (node: number, times: number[], on: number[]) => {
  const tIn = addAccessor(new Float32Array(times), 'SCALAR', { minmax: true });
  const vals = new Float32Array(on.flatMap((v) => [v, v, v]));
  const tOut = addAccessor(vals, 'VEC3');
  anim.samplers.push({ input: tIn, output: tOut, interpolation: 'STEP' });
  anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path: 'scale' } });
};
scaleTrack(handNode, [0, carryFrom, carryTo, end], [0, 1, 0, 0]);

if (rest) {
  const [x, y, z, ry] = rest as [number, number, number, number];
  const restNode = gltf.nodes.length;
  // the rest pose stands on its base: move the grip origin back up by the grip height
  gltf.nodes.push({ name: 'prop:jug-at-rest', mesh: jugMesh, translation: [x + GRIP[0] * Math.cos(ry), y + GRIP[1], z - GRIP[0] * Math.sin(ry)], rotation: [0, Math.sin(ry / 2), 0, Math.cos(ry / 2)], scale: [0, 0, 0] });
  gltf.scenes[0].nodes.push(restNode);
  scaleTrack(restNode, [0, carryTo, end], [0, 1, 1]);
}

// ---- write ---------------------------------------------------------------------------------------------------------
bin = pad4(bin);
gltf.buffers[0].byteLength = bin.length;
let js = Buffer.from(JSON.stringify(gltf));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
if (outPath === glbPath) {
  const keep = glbPath.replace(/\.glb$/, '.pre-props.glb');
  if (!existsSync(keep)) copyFileSync(glbPath, keep);
}
writeFileSync(outPath, Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
console.log(JSON.stringify({ out: outPath, bone: boneName, carry: [carryFrom, carryTo], poseTime, handAt: hand.map((v) => +v.toFixed(3)), rest, jugTriangles: idx.length / 3 }));
