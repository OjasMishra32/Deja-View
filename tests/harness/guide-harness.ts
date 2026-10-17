// Test server for the viewer's guide (first free port from 8797 within 8793-8799; PORT picks one).
//   PORT=8797 bun tests/harness/guide-harness.ts
//   open http://127.0.0.1:8797/view?scene=guide-test-room          (add &xremu=1 for the emulated Quest)
//
// It serves the real viewer (web/view.html + web/src/viewer/app.ts, which attaches the guide itself; GUIDE_ENTRY only
// exposes it as window.__guide), a no-op /ws, plus:
//   - scenes: guide-test-room          procedural lounge with input/00.png, input_camera.json, input_depth.npy
//             guide-test-room-nodepth  the same without the depth map (labels from splat / voxel rays)
//             guide-test-nocam         the same without the input camera (labels from a snapshot)
//             and every scene in data/scenes (sample-painted-bedroom, test-thirdwheel for the video camera)
//   - a fake guide at /api/guide/{narrate,hotspots,ask}: canned lines, a generated 24 kHz WAV, the
//     contract's shapes; switch it with POST /harness/mode {"mode": "ok"|"down"|"html"|"slow"|"degraded"}
//   - the 3D label store: GET/PUT /api/scenes/:id/hotspots (in memory)
//   - GET /harness/requests (what the viewer sent: image sizes, audio type, history), POST /harness/reset
//
// The pure helpers (room, PNG, .npy, WAV) are exported for the unit tests; the server only starts
// when this file is run directly.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { BunPlugin } from 'bun';
import type { Scene } from '../../shared/types.ts';
import { project, type PinholeCamera, type Vec3 } from '../../web/src/viewer/guide/hotspots.ts';
import { encodeWav16, toDataUrl } from '../../web/src/viewer/guide/voice.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SCENES = join(ROOT, 'data', 'scenes');

// ---------------------------------------------------------------------------------------------
// Encoders

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA8 PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A float32 .npy (format 1.0, C order), like numpy.save writes. */
export function encodeNpyF32(data: Float32Array, shape: number[]): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += ' '.repeat(pad % 64) + '\n';
  const out = new Uint8Array(10 + header.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(out.buffer).setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header.length);
  return out;
}

/** A speech-like warble (syllables on a gliding voice), 24 kHz mono 16-bit, as the guide's TTS returns. */
export function makeSpeechWav(seconds = 1.8, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f0 = 150 + 25 * Math.sin(t * 2.1) + 18 * Math.sin(t * 7.3);
    phase += (2 * Math.PI * f0) / rate;
    const syl = Math.max(0, Math.sin(Math.PI * ((t * 5.2) % 1))) ** 1.5;
    const vowel = (Math.floor(t * 5.2) % 3) / 3;
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const formant = Math.exp(-(((h * f0 - (500 + vowel * 900)) / 380) ** 2)) + 0.5 * Math.exp(-(((h * f0 - 1600) / 500) ** 2));
      v += (formant / h) * Math.sin(phase * h);
    }
    const fade = Math.min(1, t / 0.04, (seconds - t) / 0.08);
    s[i] = 0.32 * v * syl * fade;
  }
  return encodeWav16(s, rate);
}

// ---------------------------------------------------------------------------------------------
// The test lounge (viewer frame: y up, floor at 0, input camera at 1.45 m looking down -Z)

interface Box {
  name: string;
  min: Vec3;
  max: Vec3;
  rgb: [number, number, number];
  /** The room shell is seen from inside. */
  inside?: boolean;
}

export const ROOM: Box[] = [
  { name: 'room', min: [-2.5, 0, -4.5], max: [2.5, 2.6, 1.5], rgb: [0.78, 0.74, 0.68], inside: true },
  { name: 'tv', min: [-0.8, 0.95, -4.48], max: [0.8, 1.85, -4.4], rgb: [0.12, 0.42, 0.95] },
  { name: 'stand', min: [-1.0, 0, -4.5], max: [1.0, 0.55, -4.0], rgb: [0.36, 0.24, 0.16] },
  { name: 'couch', min: [-1.9, 0, -3.0], max: [-0.7, 0.8, -2.0], rgb: [0.78, 0.3, 0.22] },
  { name: 'table', min: [0.4, 0, -2.4], max: [1.4, 0.45, -1.7], rgb: [0.5, 0.36, 0.24] },
  { name: 'bowl', min: [0.75, 0.45, -2.15], max: [1.05, 0.6, -1.95], rgb: [0.98, 0.78, 0.2] },
  { name: 'lamp', min: [1.9, 0, -3.6], max: [2.1, 1.7, -3.4], rgb: [1.0, 0.86, 0.55] },
];

export const INPUT_CAMERA: PinholeCamera & { depthWidth: number; depthHeight: number } = {
  width: 640,
  height: 480,
  fx: 430,
  fy: 430,
  cx: 320,
  cy: 240,
  position: [0, 1.45, 0],
  quaternion: [0, 0, 0, 1],
  depthWidth: 256,
  depthHeight: 192,
};

/** Where the canned labels point (a spot on each object's visible face), with the guide's words. */
export const LOUNGE_SPOTS: Array<{ label: string; point: Vec3; blurb: string }> = [
  { label: 'TV screen', point: [0, 1.4, -4.4], blurb: 'The scoreboard from the last round is still up. Someone pulled off an upset.' },
  { label: 'Couch', point: [-1.3, 0.55, -2.0], blurb: "Three seats, one of them suspiciously empty. Seb's, apparently." },
  { label: 'Snack bowl', point: [0.9, 0.6, -2.05], blurb: 'Mostly crumbs now. The good chips went first.' },
  { label: 'Floor lamp', point: [2.0, 1.3, -3.4], blurb: 'Warm light, cheap bulb, great vibes.' },
];

/** The guide's hotspots for the lounge's input photo: each spot projected through the input camera. */
export function loungeHotspots(): Array<{ label: string; x: number; y: number; blurb: string }> {
  return LOUNGE_SPOTS.map((s) => {
    const p = project(INPUT_CAMERA, s.point)!;
    return { label: s.label, x: Math.round(p.nx * 1e4) / 1e4, y: Math.round(p.ny * 1e4) / 1e4, blurb: s.blurb };
  });
}

function hitBox(o: Vec3, d: Vec3, b: Box): { t: number; n: Vec3 } | null {
  let tmin = -Infinity, tmax = Infinity;
  let nmin: Vec3 = [0, 0, 0], nmax: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return null;
      continue;
    }
    let t1 = (b.min[a] - o[a]) / d[a], t2 = (b.max[a] - o[a]) / d[a];
    let s1 = -1, s2 = 1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [s1, s2] = [s2, s1];
    }
    if (t1 > tmin) {
      tmin = t1;
      nmin = [0, 0, 0];
      nmin[a] = s1;
    }
    if (t2 < tmax) {
      tmax = t2;
      nmax = [0, 0, 0];
      nmax[a] = -s2;
    }
  }
  if (tmin > tmax) return null;
  if (b.inside) return tmax > 1e-6 ? { t: tmax, n: nmax } : null;
  return tmin > 1e-6 ? { t: tmin, n: nmin.map((v) => -v) as Vec3 } : null;
}

/** First surface along a ray: distance, normal (facing the ray) and colour. */
export function traceRoom(o: Vec3, d: Vec3): { t: number; n: Vec3; box: Box } | null {
  let best: { t: number; n: Vec3; box: Box } | null = null;
  for (const b of ROOM) {
    const h = hitBox(o, d, b);
    if (h && (!best || h.t < best.t)) best = { ...h, box: b };
  }
  if (best) {
    // normals point back toward the camera
    const dot = best.n[0] * d[0] + best.n[1] * d[1] + best.n[2] * d[2];
    if (dot > 0) best.n = best.n.map((v) => -v) as Vec3;
  }
  return best;
}

function surfaceColour(box: Box, p: Vec3, n: Vec3): [number, number, number] {
  let [r, g, b] = box.rgb;
  if (box.name === 'room') {
    if (n[1] > 0.5) {
      // floor planks
      const plank = Math.floor((p[0] + 10) / 0.22) % 2 === 0 ? 0.05 : -0.03;
      [r, g, b] = [0.5 + plank, 0.36 + plank, 0.25 + plank * 0.5];
      if (Math.abs(p[0] + 0.3) < 1.1 && p[2] > -3.4 && p[2] < -0.9) [r, g, b] = [0.2, 0.32, 0.36];
    } else if (n[1] < -0.5) [r, g, b] = [0.9, 0.9, 0.88];
    else if (p[1] < 0.9) [r, g, b] = [0.3, 0.44, 0.48];
  }
  if (box.name === 'tv') {
    // a results screen: dark with a bright winner bar
    const u = (p[0] + 0.8) / 1.6, v = (p[1] - 0.95) / 0.9;
    [r, g, b] = [0.05, 0.08, 0.16];
    if (u > 0.08 && u < 0.92 && v > 0.55 && v < 0.72) [r, g, b] = [0.78, 1.0, 0.24];
    else if (u > 0.08 && u < 0.7 && v > 0.32 && v < 0.44) [r, g, b] = [0.85, 0.85, 0.9];
    else if (u > 0.08 && u < 0.55 && v > 0.14 && v < 0.24) [r, g, b] = [0.45, 0.5, 0.62];
  }
  return [r, g, b];
}

const LIGHT = (() => {
  const l: Vec3 = [0.35, 0.8, 0.45];
  const m = Math.hypot(...l);
  return l.map((v) => v / m) as Vec3;
})();

function shade(rgb: [number, number, number], n: Vec3, t: number): [number, number, number] {
  const lam = 0.55 + 0.45 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  const fog = Math.max(0.72, 1 - t * 0.045);
  return rgb.map((c) => Math.min(1, c * lam * fog)) as [number, number, number];
}

/** The input photo (RGBA) and its z-depth map, rendered from INPUT_CAMERA. */
export function renderLounge(cam = INPUT_CAMERA): { rgba: Uint8Array; depth: Float32Array } {
  const { width: W, height: H, depthWidth: DW, depthHeight: DH } = cam;
  const rgba = new Uint8Array(W * H * 4);
  const ray = (u: number, v: number): Vec3 => [(u - cam.cx) / cam.fx, -(v - cam.cy) / cam.fy, -1];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = ray(x + 0.5, y + 0.5);
      const l = Math.hypot(...d);
      const dn = d.map((v) => v / l) as Vec3;
      const h = traceRoom(cam.position, dn);
      const i = (y * W + x) * 4;
      if (!h) {
        rgba.set([20, 20, 24, 255], i);
        continue;
      }
      const p = cam.position.map((c, k) => c + dn[k] * h.t) as Vec3;
      const c = shade(surfaceColour(h.box, p, h.n), h.n, h.t);
      const vig = 1 - 0.18 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 4;
      rgba.set([c[0] * 255 * vig, c[1] * 255 * vig, c[2] * 255 * vig, 255].map((v) => Math.round(Math.min(255, Math.max(0, v)))), i);
    }
  }
  const depth = new Float32Array(DW * DH);
  for (let r = 0; r < DH; r++) {
    for (let c = 0; c < DW; c++) {
      const u = ((c + 0.5) * W) / DW, v = ((r + 0.5) * H) / DH;
      const d = ray(u, v);
      const l = Math.hypot(...d);
      const h = traceRoom(cam.position, d.map((x) => x / l) as Vec3);
      // z-depth (distance along the view axis), as input_depth.npy stores it
      depth[r * DW + c] = h ? h.t / l : 0;
    }
  }
  return { rgba, depth };
}

/** 3DGS binary PLY of the lounge: flat splats on every visible face. */
export function makeLoungePly(spacing = 0.04): Uint8Array {
  const C0 = 0.28209479177387814;
  const SQ = Math.SQRT1_2;
  // (w, x, y, z) turning local +z onto each axis
  const Q: Record<number, number[]> = { 0: [SQ, 0, SQ, 0], 1: [SQ, -SQ, 0, 0], 2: [1, 0, 0, 0] };
  const rows: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const push = (p: Vec3, n: Vec3, box: Box, size: number) => {
    const c = shade(surfaceColour(box, p, n), n, 2.5);
    const axis = Math.abs(n[0]) > 0.5 ? 0 : Math.abs(n[1]) > 0.5 ? 1 : 2;
    rows.push(p[0], p[1], p[2], ...c.map((v) => (Math.min(1, Math.max(0, v + (rnd() - 0.5) * 0.03)) - 0.5) / C0), 3.2, Math.log(size), Math.log(size), Math.log(0.004), ...Q[axis]);
  };
  for (const b of ROOM) {
    const s = b.inside ? spacing : spacing * 0.6;
    for (let a = 0; a < 3; a++) {
      const [u, v] = [0, 1, 2].filter((k) => k !== a);
      for (const side of [0, 1]) {
        const coord = side ? b.max[a] : b.min[a];
        const n: Vec3 = [0, 0, 0];
        n[a] = (side ? 1 : -1) * (b.inside ? -1 : 1);
        for (let x = b.min[u]; x <= b.max[u] + 1e-9; x += s) {
          for (let y = b.min[v]; y <= b.max[v] + 1e-9; y += s) {
            const p: Vec3 = [0, 0, 0];
            p[a] = coord;
            p[u] = x;
            p[v] = y;
            // skip faces hidden against the floor or the walls
            if (!b.inside && a === 1 && side === 0 && b.min[1] <= 0.001) continue;
            push(p, n, b, s * 0.75);
          }
        }
      }
    }
  }
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const count = rows.length / props.length;
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + rows.length * 4);
  out.set(head, 0);
  out.set(new Uint8Array(new Float32Array(rows).buffer), head.length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scenes

const NOW = new Date().toISOString();
type Virtual = { scene: Scene; files: Record<string, () => Uint8Array> };

let loungeCache: { png: Uint8Array; npy: Uint8Array; ply: Uint8Array; cam: Uint8Array } | null = null;
function lounge() {
  if (loungeCache) return loungeCache;
  const { rgba, depth } = renderLounge();
  loungeCache = {
    png: encodePng(rgba, INPUT_CAMERA.width, INPUT_CAMERA.height),
    npy: encodeNpyF32(depth, [INPUT_CAMERA.depthHeight, INPUT_CAMERA.depthWidth]),
    ply: makeLoungePly(),
    cam: new TextEncoder().encode(JSON.stringify({ ...INPUT_CAMERA, crop: { x: 0, y: 0, w: 640, h: 480 }, convention: 'OpenGL camera (looks down -Z, +Y up) in the viewer frame; intrinsics in pixels of width x height' })),
  };
  return loungeCache;
}

function loungeScene(id: string, name: string, files: string[]): Virtual {
  const all: Record<string, () => Uint8Array> = {
    'world.ply': () => lounge().ply,
    'input/00.png': () => lounge().png,
    'thumb.png': () => lounge().png,
    'input_camera.json': () => lounge().cam,
    'input_depth.npy': () => lounge().npy,
  };
  return {
    scene: {
      id,
      name,
      mode: 'rentfree',
      status: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
      backend: 'local',
      thumb: 'thumb.png',
      caption: 'A small lounge with a couch, a TV on a low stand and a coffee table.',
      input: { files: ['input/00.png'] },
      world: { file: 'world.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, spawn: { position: [0, 0, 0], yaw: 0 }, bounds: { min: [-2.5, 0, -4.5], max: [2.5, 2.6, 1.5] }, source: 'other' },
    },
    files: Object.fromEntries(files.map((f) => [f, all[f]])),
  };
}

const VIRTUAL: Record<string, Virtual> = {
  'guide-test-room': loungeScene('guide-test-room', 'Guide test lounge', ['world.ply', 'input/00.png', 'thumb.png', 'input_camera.json', 'input_depth.npy']),
  'guide-test-room-nodepth': loungeScene('guide-test-room-nodepth', 'Guide test lounge (no depth)', ['world.ply', 'input/00.png', 'thumb.png', 'input_camera.json']),
  'guide-test-nocam': loungeScene('guide-test-nocam', 'Guide test lounge (no camera)', ['world.ply', 'input/00.png', 'thumb.png']),
};

function readScene(id: string): Scene | null {
  if (VIRTUAL[id]) return VIRTUAL[id].scene;
  if (!/^[\w.-]+$/.test(id)) return null;
  const p = join(SCENES, id, 'scene.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Scene;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The fake guide

export type GuideMode = 'ok' | 'down' | 'html' | 'slow' | 'degraded';

interface Seen {
  endpoint: string;
  at: number;
  sceneId: string | null;
  imageType: string | null;
  imageBytes: number;
  audioType: string | null;
  audioBytes: number;
  question: string | null;
  history: number;
}

function dataUrlSummary(v: unknown): { type: string | null; bytes: number } {
  if (typeof v !== 'string') return { type: null, bytes: 0 };
  const m = /^data:([^;,]+(?:;[^;,=]+=[^;,]+)*)(;base64)?,/.exec(v);
  if (!m) return { type: 'not-a-data-url', bytes: v.length };
  return { type: m[1], bytes: Math.floor(((v.length - m[0].length) * 3) / 4) };
}

let wavCache: Record<string, string> = {};
function speech(seconds: number): string {
  const k = seconds.toFixed(2);
  return (wavCache[k] ??= toDataUrl('audio/wav', makeSpeechWav(seconds)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}

function guideHotspotsFor(sceneId: string | null): Array<{ label: string; x: number; y: number; blurb: string }> {
  if (sceneId?.startsWith('guide-test-room')) return loungeHotspots();
  // a snapshot or someone else's photo: a few points that land on something in most rooms
  return [
    { label: 'Window', x: 0.5, y: 0.38, blurb: 'Soft daylight. Probably facing east.' },
    { label: 'Bed', x: 0.42, y: 0.72, blurb: 'Freshly made, which is suspicious.' },
    { label: 'Shelf', x: 0.82, y: 0.5, blurb: 'Books nobody has opened since moving in.' },
  ];
}

// ---------------------------------------------------------------------------------------------
// The viewer bundle with the guide attached (what app.ts will do once it is wired)

const GUIDE_ENTRY = `
import ${JSON.stringify(join(ROOT, 'web/src/viewer/app.ts'))};

// app.ts builds the guide itself once the world is visible (?narrate=, ?narrateDelay=, ?labelsDelay= set its
// options); the tests reach it as window.__guide
const w = window;
async function expose() {
  for (;;) {
    const v = w.__viewer;
    if (v && v.error) return;
    if (v && v.ready && w.__viewerApp && w.__viewerApp.guide) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  w.__guide = w.__viewerApp.guide;
}
void expose();
`;

let bundle: Map<string, { body: Blob; type: string }> | null = null;
let bundleError: string | null = null;

async function buildBundle(): Promise<void> {
  const virtual: BunPlugin = {
    name: 'guide-harness-entry',
    setup(b) {
      b.onResolve({ filter: /^guide-harness-entry$/ }, () => ({ path: 'guide-harness-entry', namespace: 'guide-harness' }));
      b.onLoad({ filter: /.*/, namespace: 'guide-harness' }, () => ({ contents: GUIDE_ENTRY, loader: 'js' }));
    },
  };
  const t0 = performance.now();
  const out = await Bun.build({
    entrypoints: ['guide-harness-entry'],
    plugins: [virtual],
    target: 'browser',
    format: 'esm',
    splitting: true,
    sourcemap: 'inline',
    naming: { entry: 'guide-entry.js', chunk: 'chunk-[hash].js', asset: 'asset-[hash].[ext]' },
    define: { 'process.env.NODE_ENV': '"development"' },
    throw: false,
  });
  if (!out.success) {
    bundleError = out.logs.map((l) => String(l)).join('\n');
    bundle = null;
    console.error(`guide harness: bundle failed\n${bundleError}`);
    return;
  }
  bundleError = null;
  const next = new Map<string, { body: Blob; type: string }>();
  for (const o of out.outputs) {
    const name = o.path.replace(/^.*[\\/]/, '');
    next.set(name, { body: o, type: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : o.type });
  }
  // keep chunks of the previous build too: a page that is still loading may ask for them
  bundle = new Map([...(bundle ?? []), ...next]);
  if (process.env.GUIDE_HARNESS_QUIET !== '1') console.log(`guide harness: viewer bundle ${next.size} files in ${Math.round(performance.now() - t0)} ms`);
}

function viewPage(): string {
  const html = readFileSync(join(ROOT, 'web/view.html'), 'utf8');
  return html
    .replace(/<script[^>]+src="\.\/src\/viewer\/app\.ts"[^>]*><\/script>/, '<script type="module" src="/harness/guide-entry.js"></script>')
    .replace('href="./src/viewer/viewer.css"', 'href="/src/viewer/viewer.css"');
}

// ---------------------------------------------------------------------------------------------
// HTTP

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.npy': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
};
const mimeFor = (p: string) => MIME[p.slice(p.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

function serveBody(body: Blob, type: string, req: Request): Response {
  const size = body.size;
  const base = { 'accept-ranges': 'bytes', 'content-type': type, 'cache-control': 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return new Response(body, { headers: { ...base, 'content-length': String(size) } });
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
  return new Response(body.slice(start, end + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
}

/** Ports this harness may use; PORT picks one, otherwise the first free one from 8797. */
export const HARNESS_PORTS = [8797, 8798, 8799, 8793, 8795, 8796, 8794];

/** True when something already listens on the port, over IPv4 or IPv6 (other harnesses share this range). */
export async function portBusy(port: number): Promise<boolean> {
  const probe = (hostname: string) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 400);
      Bun.connect({
        hostname,
        port,
        socket: {
          open(sock) {
            clearTimeout(timer);
            sock.end();
            resolve(true);
          },
          data() {},
          error() {
            clearTimeout(timer);
            resolve(false);
          },
          connectError() {
            clearTimeout(timer);
            resolve(false);
          },
        },
      }).catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('::1')]);
  return v4 || v6;
}

/** The first free harness port (or PORT when given and free). */
export async function freeHarnessPort(): Promise<number> {
  const wanted = process.env.PORT ? Number(process.env.PORT) : null;
  if (wanted !== null) {
    if (wanted < 8793 || wanted > 8799) throw new Error('the guide harness uses ports 8793-8799');
    if (await portBusy(wanted)) throw new Error(`port ${wanted} is already in use`);
    return wanted;
  }
  for (const p of HARNESS_PORTS) if (!(await portBusy(p))) return p;
  throw new Error('ports 8793-8799 are all busy');
}

export async function startGuideHarness(port?: number): Promise<ReturnType<typeof Bun.serve>> {
  const p = port ?? (await freeHarnessPort());
  if (p < 8793 || p > 8799) throw new Error('the guide harness uses ports 8793-8799');
  return serveOn(p);
}

function serveOn(port: number): ReturnType<typeof Bun.serve> {
  let mode: GuideMode = 'ok';
  let latency = Number(process.env.GUIDE_LATENCY_MS ?? 450);
  const seen: Seen[] = [];
  const store = new Map<string, unknown>();
  const lastImage = new Map<string, string>();

  const record = (endpoint: string, body: Record<string, unknown>) => {
    const img = dataUrlSummary(body.image);
    const aud = dataUrlSummary(body.audio);
    const scene = body.scene as { id?: string } | undefined;
    seen.push({
      endpoint,
      at: Date.now(),
      sceneId: scene?.id ?? null,
      imageType: img.type,
      imageBytes: img.bytes,
      audioType: aud.type,
      audioBytes: aud.bytes,
      question: typeof body.question === 'string' ? body.question : null,
      history: Array.isArray(body.history) ? body.history.length : -1,
    });
    if (seen.length > 200) seen.shift();
  };

  const guide = async (endpoint: 'narrate' | 'hotspots' | 'ask', req: Request): Promise<Response> => {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'The guide needs a JSON body.' }, 400);
    }
    record(endpoint, body);
    if (typeof body.image === 'string') lastImage.set(endpoint, body.image);
    if (mode === 'down') return json({ error: 'guide offline' }, 502);
    if (mode === 'html') return new Response('<html><body><h1>502 Bad gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (mode === 'slow') await sleep(30000);
    await sleep(latency);
    const sceneId = (body.scene as { id?: string } | undefined)?.id ?? null;
    const degraded = mode === 'degraded';
    if (endpoint === 'narrate') {
      if (degraded) return json({ answer: 'Welcome in. Look around, this place has stories.', speech: null, degraded: true, error: 'test' });
      return json({ answer: 'Welcome back to game night. The couch remembers everyone, especially the person who skipped.', speech: speech(2.4) });
    }
    if (endpoint === 'hotspots') {
      if (degraded) return json({ hotspots: [], degraded: true, error: 'test' });
      return json({ hotspots: guideHotspotsFor(sceneId) });
    }
    const typed = typeof body.question === 'string' ? body.question : null;
    if (degraded) return json({ question: typed ?? 'Who won?', answer: "I can't see that clearly right now, but it looked like a close one.", speech: null, degraded: true, error: 'test' });
    if (!typed && typeof body.audio !== 'string') return json({ error: 'Send audio or a question.' }, 400);
    if (typed && /tell me about/i.test(typed)) {
      const spot = LOUNGE_SPOTS.find((s) => typed.toLowerCase().includes(s.label.toLowerCase()));
      return json({ question: typed, answer: spot ? `${spot.blurb} Ask me anything else about it.` : 'That one is a mystery, even to me.', speech: speech(1.6) });
    }
    const tv = loungeHotspots()[0];
    const hist = Array.isArray(body.history) ? body.history.length : 0;
    return json({
      question: typed ?? 'Who won?',
      answer: hist ? 'Still Maya. She will not let anyone forget it.' : 'Maya won, by a single point on the very last round. Seb missed all of it.',
      speech: speech(2.0),
      hotspot: sceneId?.startsWith('guide-test-room') ? { label: 'TV screen', x: tv.x, y: tv.y } : { label: 'Window', x: 0.5, y: 0.4 },
    });
  };

  const server = Bun.serve({
    port,
    // dual stack, so a second server cannot quietly take the other address family
    hostname: '::',
    reusePort: false,
    idleTimeout: 60,
    routes: {
      '/view': async () => {
        // rebuilt per page load (about 70 ms) so edits to the viewer show up without a restart
        await buildBundle();
        if (!bundle) return new Response(`The viewer bundle did not build.\n${bundleError ?? ''}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response(viewPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      },
      '/': () => Response.redirect('/view?scene=guide-test-room', 302),
      '/api/health': () => json({ ok: true, version: 'guide-harness', guide: mode }),
      '/api/scenes': () => {
        const real = existsSync(SCENES) ? readdirSync(SCENES).map(readScene).filter((s): s is Scene => !!s) : [];
        return json([...Object.values(VIRTUAL).map((v) => v.scene), ...real]);
      },
      '/api/scenes/:id': (req) => {
        const s = readScene(req.params.id);
        return s ? json(s) : json({ error: "We couldn't find that scene." }, 404);
      },
      '/api/scenes/:id/hotspots': async (req) => {
        const id = req.params.id;
        if (!readScene(id)) return json({ error: "We couldn't find that scene." }, 404);
        if (req.method === 'PUT') {
          try {
            const body = (await req.json()) as { hotspots?: unknown };
            if (!body || !Array.isArray(body.hotspots)) return json({ error: 'Send {hotspots: [...]}.' }, 400);
            store.set(id, body);
            return json({ ok: true, count: body.hotspots.length });
          } catch {
            return json({ error: 'Send JSON.' }, 400);
          }
        }
        const v = store.get(id);
        return v ? json(v) : json({ error: 'No labels stored for this scene.' }, 404);
      },
      '/api/guide/narrate': { POST: (req) => guide('narrate', req) },
      '/api/guide/hotspots': { POST: (req) => guide('hotspots', req) },
      '/api/guide/ask': { POST: (req) => guide('ask', req) },
      '/harness/mode': {
        POST: async (req) => {
          const b = (await req.json().catch(() => ({}))) as { mode?: GuideMode; latency?: number };
          if (b.mode) mode = b.mode;
          if (typeof b.latency === 'number') latency = b.latency;
          return json({ ok: true, mode, latency });
        },
      },
      '/harness/requests': () => json(seen),
      // the last picture the viewer sent to an endpoint, as an image (to look at snapshots)
      '/harness/last-image/:endpoint': (req) => {
        const url = lastImage.get(req.params.endpoint);
        const m = url ? /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(url) : null;
        if (!m) return json({ error: 'No image yet.' }, 404);
        return new Response(Buffer.from(m[2], 'base64'), { headers: { 'content-type': m[1], 'cache-control': 'no-store' } });
      },
      '/harness/reset': {
        POST: () => {
          seen.length = 0;
          store.clear();
          mode = 'ok';
          latency = Number(process.env.GUIDE_LATENCY_MS ?? 450);
          return json({ ok: true });
        },
      },
    },
    // the viewer keeps one /ws socket open (labels, cues, notes); this bench never sends anything on it
    websocket: { message() {} },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') return srv.upgrade(req) ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 });
      if (url.pathname.startsWith('/harness/') && bundle) {
        const f = bundle.get(url.pathname.slice('/harness/'.length));
        if (f) return new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/src/viewer/viewer.css') return new Response(Bun.file(join(ROOT, 'web/src/viewer/viewer.css')), { headers: { 'content-type': 'text/css; charset=utf-8' } });
      if (url.pathname.startsWith('/data/scenes/')) {
        const rel = decodeURIComponent(url.pathname.slice('/data/scenes/'.length));
        const [id, ...rest] = rel.split('/');
        const file = rest.join('/');
        const v = VIRTUAL[id];
        if (v) {
          const make = v.files[file];
          if (!make) return json({ error: 'Not found.' }, 404);
          return serveBody(new Blob([make() as Uint8Array<ArrayBuffer>]), mimeFor(file), req);
        }
        const full = normalize(join(SCENES, rel));
        if (!full.startsWith(SCENES + '/')) return new Response('forbidden', { status: 403 });
        if (!existsSync(full) || !statSync(full).isFile()) return json({ error: 'Not found.' }, 404);
        return serveBody(Bun.file(full), mimeFor(full), req);
      }
      return json({ error: 'Not found.' }, 404);
    },
  });
  return server;
}

if (import.meta.main) {
  await buildBundle();
  const server = await startGuideHarness();
  console.log(`guide harness on http://127.0.0.1:${server.port}/view?scene=guide-test-room`);
}
