// Generates a synthetic Third Wheel clip (tw-pack-v1) so the video layer can be tested without
// the pipeline: a ray-traced cook stirring a pan about 2.2 m in front of a kitchen, with the
// depth band (inverse depth), the mask band, and a tone as audio. Frames are piped raw into ffmpeg.
//
// Also writes data/scenes/test-thirdwheel/ (scene.json, tw.mp4, world.spz copied from the
// painted bedroom sample, thumb.jpg, plate.jpg) so the full viewer can be tested.
//
//   bun scripts/make-test-rgbd.ts [--out DIR] [--seconds 6] [--fps 30] [--width 1280] [--height 720]
//                                 [--sharp-depth] [--clip-only FILE]

import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Scene, VideoLayer } from '../shared/types.ts';

const ROOT = resolve(import.meta.dir, '..');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const W = Number(arg('width', '1280'));
const H = Number(arg('height', '720'));
const FPS = Number(arg('fps', '30'));
const SECONDS = Number(arg('seconds', '6'));
const SOFT_DEPTH = !process.argv.includes('--sharp-depth');
const CLIP_ONLY = arg('clip-only');
const OUT_DIR = resolve(arg('out', join(ROOT, 'data', 'scenes', 'test-thirdwheel'))!);
if (W % 4 || H % 4) throw new Error('width and height must be multiples of 4 (bands are half size, yuv420)');

const FRAMES = Math.round(FPS * SECONDS);
const PW = W;
const PH = Math.round(H * 1.5);
const BW = W / 2;
const BH = H / 2;

// Camera: a phone propped on a counter, 1.25 m up, pitched 12 degrees down. Synthetic world is
// y-up with the floor at y = 0; the camera looks down -Z.
const FOCAL = (760 / 1280) * W;
const INTR = { fx: FOCAL, fy: FOCAL, cx: W / 2 - 0.5, cy: H / 2 - 0.5 };
const CAM_H = 1.25;
const PITCH = (-12 * Math.PI) / 180;
const NEAR = 1.0;
const FAR = 6.0;
const PERSON_DIST = 2.4;

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): V => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hex = (h: number): V => [srgbToLin(((h >> 16) & 255) / 255), srgbToLin(((h >> 8) & 255) / 255), srgbToLin((h & 255) / 255)];
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const CAM_POS: V = [0, CAM_H, 0];
const FWD: V = [0, Math.sin(PITCH), -Math.cos(PITCH)];
const UP: V = [0, Math.cos(PITCH), Math.sin(PITCH)];
const RIGHT: V = [1, 0, 0];

/** Ray through OpenCV pixel (x, y), scaled so the hit parameter equals z-depth. */
function rayDir(x: number, y: number): V {
  const a = (x - INTR.cx) / INTR.fx;
  const b = (y - INTR.cy) / INTR.fy;
  return [RIGHT[0] * a - UP[0] * b + FWD[0], RIGHT[1] * a - UP[1] * b + FWD[1], RIGHT[2] * a - UP[2] * b + FWD[2]];
}

function project(p: V): [number, number, number] {
  const d = sub(p, CAM_POS);
  const z = dot(d, FWD);
  return [INTR.cx + (dot(d, RIGHT) / z) * INTR.fx, INTR.cy - (dot(d, UP) / z) * INTR.fy, z];
}

// --- Person -----------------------------------------------------------------------------------

type Mat = 'skin' | 'hair' | 'shirt' | 'apron' | 'denim' | 'shoe' | 'pan' | 'food' | 'wood';

interface Prim {
  mat: Mat;
  a: V; // endpoints in primitive space (relative to m, after dividing by s)
  b: V;
  r: number;
  m: V;
  s: V;
  bound: number; // bounding sphere radius in person space
  bx0: number; bx1: number; by0: number; by1: number; // pixel bounds this frame
}

function capsule(mat: Mat, a: V, b: V, r: number, s: V = [1, 1, 1]): Prim {
  const m = mul(add(a, b), 0.5);
  const toP = (p: V): V => [(p[0] - m[0]) / s[0], (p[1] - m[1]) / s[1], (p[2] - m[2]) / s[2]];
  const half = Math.hypot(...sub(a, b)) / 2;
  return { mat, a: toP(a), b: toP(b), r, m, s, bound: (half + r) * Math.max(...s) + 0.01, bx0: 0, bx1: 0, by0: 0, by1: 0 };
}

function personAt(time: number) {
  const tau = Math.PI * 2;
  const loop = time / SECONDS; // 0..1, every motion is periodic over the clip so it loops cleanly
  const stir = tau * Math.round(SECONDS) * loop; // one stir per second
  const sway = Math.sin(tau * loop);
  const prims: Prim[] = [];

  // Legs and shoes
  for (const sx of [-1, 1]) {
    prims.push(capsule('shoe', [sx * 0.1, 0.045, -0.03], [sx * 0.105, 0.045, 0.1], 0.048));
    prims.push(capsule('denim', [sx * 0.1, 0.1, 0], [sx * 0.095, 0.86, 0], 0.068));
  }
  prims.push(capsule('denim', [-0.1, 0.9, 0], [0.1, 0.9, 0], 0.115, [1, 1, 0.72]));
  // Torso and shoulders
  const lean = 0.015 * Math.sin(tau * 2 * loop);
  prims.push(capsule('shirt', [0, 0.98, 0], [lean, 1.29, 0.01], 0.185, [1, 1, 0.64]));
  prims.push(capsule('shirt', [-0.19, 1.33, 0], [0.19, 1.33, 0], 0.075));
  // Neck and head
  prims.push(capsule('skin', [0, 1.36, 0], [lean, 1.46, 0.01], 0.048));
  const nod = 0.012 * Math.sin(tau * 3 * loop);
  const head: V = [lean * 1.4, 1.575 + nod, 0.015];
  prims.push(capsule('skin', head, head, 1, [0.088, 0.112, 0.098]));
  // Left arm (camera right) holds the pan forward
  const panBob = 0.008 * Math.sin(tau * 2 * loop);
  const lSh: V = [0.215, 1.32, 0];
  const lEl: V = [0.27, 1.08, 0.08];
  const lWr: V = [0.2, 1.0 + panBob, 0.3];
  prims.push(capsule('shirt', lSh, lEl, 0.05));
  prims.push(capsule('skin', lEl, lWr, 0.042));
  prims.push(capsule('skin', lWr, lWr, 0.048));
  const panC: V = [0.0, 0.985 + panBob, 0.5];
  prims.push(capsule('pan', lWr, [0.09, 0.99 + panBob, 0.4], 0.014));
  prims.push(capsule('pan', panC, panC, 1, [0.14, 0.028, 0.14]));
  prims.push(capsule('food', [panC[0] - 0.03, panC[1] + 0.022, panC[2] + 0.01], [panC[0] + 0.035, panC[1] + 0.022, panC[2] - 0.02], 0.05, [1, 0.25, 1]));
  // Right arm (camera left) stirs with a wooden spoon
  const rSh: V = [-0.215, 1.32, 0];
  const rEl: V = [-0.29, 1.07, 0.12];
  const rWr: V = [-0.08 + 0.055 * Math.cos(stir), 1.09, 0.44 + 0.045 * Math.sin(stir)];
  prims.push(capsule('shirt', rSh, rEl, 0.05));
  prims.push(capsule('skin', rEl, rWr, 0.042));
  prims.push(capsule('skin', rWr, rWr, 0.047));
  prims.push(capsule('wood', rWr, [rWr[0] + 0.05, panC[1] + 0.01, rWr[2] + 0.04], 0.011));

  const yaw = (9 * Math.PI) / 180 * sway;
  const offset: V = [0.05 * Math.sin(tau * loop + 1), 0, -PERSON_DIST];
  return { prims, yaw, offset, head };
}

type Person = ReturnType<typeof personAt>;

function toWorld(p: V, person: Person): V {
  const c = Math.cos(person.yaw), s = Math.sin(person.yaw);
  return [p[0] * c + p[2] * s + person.offset[0], p[1] + person.offset[1], -p[0] * s + p[2] * c + person.offset[2]];
}
function toLocalDir(d: V, person: Person): V {
  const c = Math.cos(person.yaw), s = Math.sin(person.yaw);
  return [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
}
function toWorldDir(d: V, person: Person): V {
  const c = Math.cos(person.yaw), s = Math.sin(person.yaw);
  return [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
}

function boundPrims(person: Person) {
  for (const p of person.prims) {
    const [x, y, z] = project(toWorld(p.m, person));
    const rad = (p.bound / z) * INTR.fx + 3;
    p.bx0 = x - rad; p.bx1 = x + rad; p.by0 = y - rad; p.by1 = y + rad;
  }
}

interface Hit { t: number; prim: Prim | null; n: V; p: V }

/** Ray against a round capsule (or a sphere when a == b); rd must be unit length. */
function capHit(ro: V, rd: V, pa: V, pb: V, ra: number): number {
  const ba = sub(pb, pa);
  const baba = dot(ba, ba);
  const oa = sub(ro, pa);
  if (baba < 1e-12) {
    const b = dot(oa, rd), c = dot(oa, oa) - ra * ra, h = b * b - c;
    return h < 0 ? -1 : -b - Math.sqrt(h);
  }
  const bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  const a = baba - bard * bard;
  let b = baba * rdoa - baoa * bard;
  let c = baba * oaoa - baoa * baoa - ra * ra * baba;
  let h = b * b - a * c;
  if (h < 0) return -1;
  const t = (-b - Math.sqrt(h)) / a;
  const y = baoa + t * bard;
  if (y > 0 && y < baba) return t;
  const oc = y <= 0 ? oa : sub(ro, pb);
  b = dot(rd, oc);
  c = dot(oc, oc) - ra * ra;
  h = b * b - c;
  return h > 0 ? -b - Math.sqrt(h) : -1;
}

function hitPerson(ox: number, oy: number, ro: V, rdWorld: V, person: Person): Hit | null {
  const roL = toLocalDir(sub(ro, person.offset), person);
  const rdL = toLocalDir(rdWorld, person);
  let best: Hit | null = null;
  for (const p of person.prims) {
    if (ox < p.bx0 || ox > p.bx1 || oy < p.by0 || oy > p.by1) continue;
    const o: V = [(roL[0] - p.m[0]) / p.s[0], (roL[1] - p.m[1]) / p.s[1], (roL[2] - p.m[2]) / p.s[2]];
    const d: V = [rdL[0] / p.s[0], rdL[1] / p.s[1], rdL[2] / p.s[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const dn = mul(d, 1 / len);
    const tp = capHit(o, dn, p.a, p.b, p.r);
    if (tp <= 0) continue;
    const t = tp / len; // back to the world ray's parameter (z-depth)
    if (best && t >= best.t) continue;
    const q = add(o, mul(dn, tp));
    const ba = sub(p.b, p.a);
    const baba = dot(ba, ba);
    const hh = baba > 1e-12 ? clamp01(dot(sub(q, p.a), ba) / baba) : 0;
    const nP = sub(q, add(p.a, mul(ba, hh)));
    const nL = norm([nP[0] / p.s[0], nP[1] / p.s[1], nP[2] / p.s[2]]);
    const pL = add(roL, mul(rdL, t));
    best = { t, prim: p, n: nL, p: pL };
  }
  return best;
}

const C = {
  skin: hex(0xe0a983),
  hair: hex(0x2b1a12),
  shirtA: hex(0xd9472b),
  shirtB: hex(0xf2ead8),
  apron: hex(0x2f6f68),
  denim: hex(0x2c3e66),
  shoe: hex(0xeeeeee),
  shoeStripe: hex(0x1c1c1c),
  pan: hex(0x2a2a2e),
  yolk: hex(0xf7b928),
  white: hex(0xfaf6ec),
  wood: hex(0xb07a45),
  eye: hex(0x1a1410),
  mouth: hex(0x9b3b36),
};

const KEY = norm([-0.45, 0.75, 0.55]);

function personColor(h: Hit, person: Person): V {
  const p = h.p, n = h.n, prim = h.prim!;
  let base: V;
  switch (prim.mat) {
    case 'skin': {
      base = C.skin;
      if (prim.a[0] === prim.b[0] && prim.s[0] < 0.1) {
        // head: hair on top and back, simple face on the front
        const hy = p[1] - person.head[1];
        const hz = p[2] - person.head[2];
        if (n[1] > 0.42 || hz < -0.025 || (hy > 0.035 && n[2] < 0.75)) base = C.hair;
        else if (hz > 0) {
          for (const ex of [-0.032, 0.032]) if (Math.hypot(p[0] - person.head[0] - ex, hy - 0.012) < 0.011) base = C.eye;
          const mx = p[0] - person.head[0];
          if (Math.abs(mx) < 0.027 && Math.abs(hy + 0.052 - 9 * mx * mx) < 0.0045) base = C.mouth;
        }
      }
      break;
    }
    case 'shirt': {
      const stripe = Math.floor((p[1] + 10) / 0.045) % 2 === 0;
      base = stripe ? C.shirtA : C.shirtB;
      // apron over the front of the torso
      if (p[2] > 0.02 && Math.abs(p[0]) < 0.16 && p[1] < 1.24 && p[1] > 0.9) base = C.apron;
      break;
    }
    case 'denim':
      base = mul(C.denim, 0.85 + 0.3 * hash(Math.floor(p[1] * 60), Math.floor(p[0] * 60)) * 0.3);
      if (p[1] > 0.82 && p[2] > 0.0 && Math.abs(p[0]) < 0.16) base = C.apron;
      break;
    case 'shoe':
      base = p[1] < 0.02 || (p[1] > 0.05 && p[1] < 0.06) ? C.shoeStripe : C.shoe;
      break;
    case 'pan':
      base = C.pan;
      break;
    case 'food': {
      const r = Math.hypot(p[0] - 0.01, p[2] - 0.495);
      base = r < 0.025 ? C.yolk : C.white;
      break;
    }
    case 'wood':
      base = C.wood;
      break;
    default:
      base = C.skin;
  }
  const nW = toWorldDir(n, person);
  const diff = Math.max(0, dot(nW, KEY));
  const viewDir = norm(sub(CAM_POS, toWorld(p, person)));
  const rim = Math.pow(1 - Math.max(0, dot(nW, viewDir)), 3) * 0.35;
  const spec = prim.mat === 'pan' || prim.mat === 'skin' ? Math.pow(Math.max(0, dot(norm(add(KEY, viewDir)), nW)), 40) * 0.4 : 0;
  const amb = 0.28 + 0.12 * nW[1];
  return [base[0] * (amb + 0.9 * diff) + rim * 0.9 + spec, base[1] * (amb + 0.9 * diff) + rim * 0.85 + spec, base[2] * (amb + 0.9 * diff) + rim * 0.8 + spec];
}

// --- Kitchen background -----------------------------------------------------------------------

const BACK_Z = -4.4;
const SIDE_X = 2.6;
const CEIL = 2.7;
const COUNTER = { x0: -SIDE_X, x1: SIDE_X, y0: 0, y1: 0.92, z0: BACK_Z, z1: BACK_Z + 0.62 };

function background(ro: V, rd: V, person: Person | null): { t: number; c: V } {
  let t = Infinity;
  let kind = '';
  const test = (tt: number, k: string) => {
    if (tt > 1e-4 && tt < t) { t = tt; kind = k; }
  };
  if (rd[1] < 0) test(-ro[1] / rd[1], 'floor');
  if (rd[1] > 0) test((CEIL - ro[1]) / rd[1], 'ceil');
  if (rd[2] < 0) test((BACK_Z - ro[2]) / rd[2], 'back');
  if (rd[0] < 0) test((-SIDE_X - ro[0]) / rd[0], 'left');
  if (rd[0] > 0) test((SIDE_X - ro[0]) / rd[0], 'right');
  // counter box (slab test)
  {
    let t0 = -Infinity, t1 = Infinity, axis = -1;
    const lo = [COUNTER.x0, COUNTER.y0, COUNTER.z0], hi = [COUNTER.x1, COUNTER.y1, COUNTER.z1];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(rd[i]) < 1e-9) { if (ro[i] < lo[i] || ro[i] > hi[i]) { t0 = Infinity; } continue; }
      let a = (lo[i] - ro[i]) / rd[i], b = (hi[i] - ro[i]) / rd[i];
      if (a > b) [a, b] = [b, a];
      if (a > t0) { t0 = a; axis = i; }
      if (b < t1) t1 = b;
    }
    if (t0 <= t1 && t0 > 0) test(t0, axis === 1 ? 'top' : 'cabinet');
  }
  const p = add(ro, mul(rd, t));
  let base: V;
  let n: V = [0, 1, 0];
  switch (kind) {
    case 'floor': {
      const plank = Math.floor((p[0] + 10) / 0.16);
      const seg = Math.floor((p[2] + 10 + hash(plank, 3) * 1.2) / 1.2);
      const v = 0.75 + 0.35 * hash(plank, seg);
      const grain = 0.94 + 0.06 * Math.sin(p[2] * 40 + hash(plank, seg) * 10);
      const seam = (p[0] + 10) % 0.16 < 0.006 ? 0.55 : 1;
      base = mul(hex(0x9c6b43), v * grain * seam);
      if (person) {
        const fx = person.offset[0], fz = person.offset[2];
        const d2 = (p[0] - fx) ** 2 + ((p[2] - fz) * 1.6) ** 2;
        base = mul(base, 1 - 0.55 * Math.exp(-d2 / 0.06));
      }
      break;
    }
    case 'ceil':
      base = hex(0xd8d4cc);
      n = [0, -1, 0];
      break;
    case 'back': {
      n = [0, 0, 1];
      if (p[1] < 1.65) {
        const row = Math.floor(p[1] / 0.075);
        const col = Math.floor((p[0] + 10 + (row % 2) * 0.075) / 0.15);
        const gu = (p[1] % 0.075) < 0.006 || ((p[0] + 10 + (row % 2) * 0.075) % 0.15) < 0.006;
        base = gu ? hex(0x9a978f) : mul(hex(0xe9efe9), 0.92 + 0.08 * hash(row, col));
      } else base = hex(0x6f8f7a);
      // a shelf with jars
      if (p[1] > 1.62 && p[1] < 1.66) base = hex(0x5a3a22);
      if (p[1] > 1.66 && p[1] < 1.86) {
        const jar = Math.floor((p[0] + 10) / 0.22);
        if (((p[0] + 10) % 0.22) > 0.05 && hash(jar, 7) > 0.35) base = mul([hex(0xc1693a), hex(0x3f7aa8), hex(0xe2c25b)][jar % 3], 0.9);
      }
      break;
    }
    case 'left':
    case 'right':
      base = hex(0x7d9a86);
      n = [kind === 'left' ? 1 : -1, 0, 0];
      break;
    case 'top':
      base = mul(hex(0xd9c3a0), 0.95 + 0.05 * hash(Math.floor(p[0] * 8), 1));
      n = [0, 1, 0];
      break;
    case 'cabinet': {
      n = [0, 0, 1];
      const door = (p[0] + 10) % 0.6;
      base = door < 0.01 || p[1] > 0.86 ? hex(0x1c2a3a) : hex(0x27415c);
      if (Math.abs(door - 0.3) < 0.08 && Math.abs(p[1] - 0.72) < 0.008) base = hex(0xc9c9c9);
      break;
    }
    default:
      base = [0, 0, 0];
  }
  const diff = Math.max(0, dot(n, KEY));
  const ao = 0.75 + 0.25 * clamp01(Math.min(p[1] / 0.4, (p[2] - BACK_Z) / 0.5, (SIDE_X - Math.abs(p[0])) / 0.5));
  const k = (0.42 + 0.6 * diff) * ao;
  return { t, c: mul(base, k) };
}

// --- Frame rendering --------------------------------------------------------------------------

const SUB = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/** Renders one packed frame into `out` (rgb24, PW x PH). Returns nothing; also used for the plate. */
function renderFrame(time: number, out: Uint8Array, withPerson = true) {
  const person = personAt(time);
  boundPrims(person);
  let px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity;
  for (const p of person.prims) {
    px0 = Math.min(px0, p.bx0); px1 = Math.max(px1, p.bx1);
    py0 = Math.min(py0, p.by0); py1 = Math.max(py1, p.by1);
  }
  const invDepth = new Float32Array(W * H);
  const cover = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBox = withPerson && x >= px0 && x <= px1 && y >= py0 && y <= py1;
      const samples = inBox ? SUB : [[0, 0]];
      let r = 0, g = 0, b = 0, inv = 0, hits = 0;
      for (const [sx, sy] of samples) {
        const rd = rayDir(x + sx, y + sy);
        const bg = background(CAM_POS, rd, withPerson ? person : null);
        const h = inBox ? hitPerson(x + sx, y + sy, CAM_POS, rd, person) : null;
        let c: V, t: number;
        if (h && h.t < bg.t) {
          c = personColor(h, person);
          t = h.t;
          hits++;
        } else {
          c = bg.c;
          t = bg.t;
        }
        r += c[0]; g += c[1]; b += c[2];
        inv += 1 / t;
      }
      const ns = samples.length;
      const o = (y * PW + x) * 3;
      out[o] = Math.round(clamp01(linToSrgb(r / ns)) * 255);
      out[o + 1] = Math.round(clamp01(linToSrgb(g / ns)) * 255);
      out[o + 2] = Math.round(clamp01(linToSrgb(b / ns)) * 255);
      invDepth[y * W + x] = inv / ns;
      cover[y * W + x] = hits / ns;
    }
  }
  // Half-resolution bands. Depth is averaged in inverse depth and, by default, softened a little
  // the way a monocular depth model blurs across silhouettes.
  const dBand = new Float32Array(BW * BH);
  const mBand = new Float32Array(BW * BH);
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      let iv = 0, cv = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const k = (y * 2 + j) * W + x * 2 + i;
        iv += invDepth[k];
        cv += cover[k];
      }
      dBand[y * BW + x] = iv / 4;
      mBand[y * BW + x] = cv / 4;
    }
  }
  const dOut = SOFT_DEPTH ? blur3(dBand, BW, BH) : dBand;
  const mOut = blur3(mBand, BW, BH);
  const invN = 1 / NEAR, invF = 1 / FAR;
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const v = clamp01((dOut[y * BW + x] - invF) / (invN - invF));
      const m = clamp01(mOut[y * BW + x]);
      const dv = Math.round(v * 255);
      const mv = Math.round(m * 255);
      const od = ((H + y) * PW + x) * 3;
      out[od] = out[od + 1] = out[od + 2] = dv;
      const om = ((H + y) * PW + BW + x) * 3;
      out[om] = out[om + 1] = out[om + 2] = mv;
    }
  }
}

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      dst[y * w + x] = s / n;
    }
  }
  return dst;
}

// --- Encoding ---------------------------------------------------------------------------------

async function run(cmd: string[], input?: Uint8Array) {
  const p = Bun.spawn(cmd, { stdin: input ? 'pipe' : 'ignore', stdout: 'ignore', stderr: 'pipe' });
  if (input && p.stdin) {
    p.stdin.write(input);
    await p.stdin.end();
  }
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${(await new Response(p.stderr).text()).slice(-800)}`);
}

async function encodeClip(file: string) {
  // Audio: a 440 Hz tone with a soft tick on every stir, so A/V sync is easy to judge.
  const audio = `aevalsrc='0.18*sin(2*PI*440*t)*(0.55+0.45*cos(2*PI*t))+0.08*sin(2*PI*880*t)*exp(-30*mod(t,1))':s=48000:d=${SECONDS}`;
  const ff = Bun.spawn(
    [
      'ffmpeg', '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${PW}x${PH}`, '-r', String(FPS), '-i', 'pipe:0',
      '-f', 'lavfi', '-i', audio,
      '-map', '0:v', '-map', '1:a',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-g', String(FPS), '-bf', '2',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
      file,
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
  );
  const frame = new Uint8Array(PW * PH * 3);
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    renderFrame(i / FPS, frame);
    ff.stdin.write(frame);
    await ff.stdin.flush();
    if (i % 15 === 0 || i === FRAMES - 1) {
      const el = (performance.now() - t0) / 1000;
      process.stdout.write(`\rframe ${i + 1}/${FRAMES}  ${el.toFixed(1)} s`);
    }
  }
  await ff.stdin.end();
  const code = await ff.exited;
  process.stdout.write('\n');
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${(await new Response(ff.stderr).text()).slice(-800)}`);
}

async function writeStill(file: string, frame: Uint8Array, cropH: number, scaleW: number) {
  await run(
    [
      'ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${PW}x${PH}`, '-i', 'pipe:0',
      '-vf', `crop=${W}:${cropH}:0:0,scale=${scaleW}:-2`, '-frames:v', '1', '-q:v', '3', file,
    ],
    frame,
  );
}

function rotX(deg: number): [number, number, number, number] {
  const h = ((deg * Math.PI) / 180) / 2;
  return [Math.sin(h), 0, 0, Math.cos(h)];
}

async function main() {
  if (CLIP_ONLY) {
    await encodeClip(resolve(CLIP_ONLY));
    console.log(`wrote ${CLIP_ONLY}`);
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const clip = join(OUT_DIR, 'tw.mp4');
  console.log(`rendering ${FRAMES} frames ${PW}x${PH} -> ${clip}`);
  await encodeClip(clip);

  const still = new Uint8Array(PW * PH * 3);
  renderFrame(1.25, still);
  await writeStill(join(OUT_DIR, 'thumb.jpg'), still, H, 640);
  renderFrame(0, still, false);
  await writeStill(join(OUT_DIR, 'plate.jpg'), still, H, W);

  // Place the clip in the painted bedroom sample: open floor around x = 0.4, z = -2.4, floor at
  // y = -1.115 there (measured from the splats). The camera keeps its height and tilt.
  const bedroom = join(ROOT, 'data', 'scenes', 'sample-painted-bedroom', 'world.spz');
  const worldDest = join(OUT_DIR, 'world.spz');
  if (!(await Bun.file(worldDest).exists())) {
    if (!(await Bun.file(bedroom).exists())) throw new Error('missing painted bedroom sample: run bun run samples');
    await copyFile(bedroom, worldDest);
  }
  const floorY = -1.115;
  const camX = 0.4;
  const video: VideoLayer = {
    file: 'tw.mp4',
    layout: 'tw-pack-v1',
    width: W,
    height: H,
    fps: FPS,
    duration: SECONDS,
    hasAudio: true,
    intrinsics: INTR,
    depth: { encoding: 'inverse', near: NEAR, far: FAR },
    cameraPose: { position: [camX, floorY + CAM_H, 0], quaternion: rotX((PITCH * 180) / Math.PI) },
    plate: 'plate.jpg',
  };
  const now = new Date().toISOString();
  const scenePath = join(OUT_DIR, 'scene.json');
  let createdAt = now;
  try {
    createdAt = (JSON.parse(await Bun.file(scenePath).text()) as Scene).createdAt ?? now;
  } catch {}
  const scene: Scene = {
    id: 'test-thirdwheel',
    name: 'Test cook in the bedroom',
    mode: 'thirdwheel',
    status: 'ready',
    stage: 'Ready',
    progress: 1,
    createdAt,
    updatedAt: now,
    backend: 'bundled',
    thumb: 'thumb.jpg',
    caption: 'Synthetic RGBD clip in the painted bedroom sample',
    input: { files: ['tw.mp4'] },
    world: {
      file: 'world.spz',
      transform: { position: [0, 0, 0], quaternion: [1, 0, 0, 0], scale: 1 },
      floorY,
      spawn: { position: [camX, floorY, 0.45], yaw: 0 },
      source: 'marble-sample',
    },
    video,
  };
  await Bun.write(scenePath, JSON.stringify(scene, null, 2));
  console.log(`wrote ${scenePath}`);
}

await main();
