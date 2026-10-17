// Throwaway dev server for the viewer (port 8790). Independent of server/index.ts.
//   bun tests/harness/viewer-serve.ts            (PORT env overrides the port;
//                                                NODE_ENV=production for the production bundle)
//
// Routes: /view (web/view.html via Bun HTML import), /api/scenes, /api/scenes/:id,
// /data/scenes/<id>/<file> with HTTP Range support.
//
// Besides the real scenes in data/scenes it serves synthetic ones for edge cases:
//   viewer-test-ply           procedural 3DGS .ply room, identity transform (OpenGL frame), floorY null
//   viewer-test-collider      the same room with a GLB collider mesh (three-mesh-bvh path)
//   viewer-test-missing-video painted bedroom whose video file does not exist
//   viewer-test-generating    "running" with progress, becomes ready ~8 s after the first request
//   viewer-test-failed        a failed job
//   viewer-test-noworld       ready but without a world

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import viewPage from '../../web/view.html';

const ROOT = resolve(import.meta.dir, '../..');
const SCENES = join(ROOT, 'data', 'scenes');
const PORT = Number(process.env.PORT ?? 8790);
const BEDROOM = join(SCENES, 'sample-painted-bedroom', 'world.spz');

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return MIME[dot >= 0 ? path.slice(dot).toLowerCase() : ''] ?? 'application/octet-stream';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function readScene(id: string): Scene | null {
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
// Procedural test room as a standard 3DGS binary PLY (viewer frame: y up, camera at the origin
// looking down -Z, floor 1.45 m below the camera).

const ROOM = { x0: -2.4, x1: 2.4, z0: -4.2, z1: 1.4, floor: -1.45, ceil: 1.15, table: { x0: 0.5, x1: 1.5, z0: -2.6, z1: -1.8, top: -0.68 } };

function makeRoomPly(): Uint8Array<ArrayBuffer> {
  const C0 = 0.28209479177387814;
  const splats: number[][] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const SQ = Math.SQRT1_2;
  // quaternion (w, x, y, z) turning the thin local z axis onto the surface normal
  const Q = { y: [SQ, -SQ, 0, 0], x: [SQ, 0, SQ, 0], z: [1, 0, 0, 0] } as const;
  const push = (x: number, y: number, z: number, rgb: number[], axis: keyof typeof Q, size = 0.026) => {
    const j = 0.04;
    splats.push([x, y, z, ...rgb.map((c) => (Math.min(1, Math.max(0, c + (rnd() - 0.5) * j)) - 0.5) / C0), 2.9, Math.log(size), Math.log(size), Math.log(0.004), ...Q[axis]]);
  };
  const s = 0.035;
  const { x0, x1, z0, z1, floor, ceil, table: t } = ROOM;
  for (let x = x0; x <= x1; x += s)
    for (let z = z0; z <= z1; z += s) {
      const plank = Math.floor((x - x0) / 0.18) % 2 === 0 ? 0.04 : -0.03;
      const rug = Math.abs(x + 0.4) < 0.9 && Math.abs(z + 1.2) < 1.2;
      push(x, floor, z, rug ? [0.62, 0.22, 0.2] : [0.55 + plank, 0.37 + plank, 0.24], 'y');
    }
  for (let x = x0; x <= x1; x += 0.05) for (let z = z0; z <= z1; z += 0.05) push(x, ceil, z, [0.9, 0.89, 0.86], 'y', 0.035);
  const wallColor = (y: number) => (y < floor + 0.9 ? [0.32, 0.46, 0.5] : [0.84, 0.8, 0.72]);
  for (let y = floor; y <= ceil; y += s) {
    for (let z = z0; z <= z1; z += s) {
      push(x0, y, z, wallColor(y), 'x');
      push(x1, y, z, wallColor(y), 'x');
    }
    for (let x = x0; x <= x1; x += s) {
      const win = Math.abs(x + 0.3) < 0.8 && y > floor + 1.0 && y < floor + 2.1;
      push(x, y, z0, win ? [0.75, 0.88, 1.0] : wallColor(y), 'z');
      push(x, y, z1, wallColor(y), 'z');
    }
  }
  // table top and a front panel
  for (let x = t.x0; x <= t.x1; x += 0.025) for (let z = t.z0; z <= t.z1; z += 0.025) push(x, t.top, z, [0.36, 0.22, 0.14], 'y', 0.02);
  for (let x = t.x0; x <= t.x1; x += 0.025) for (let y = floor; y <= t.top; y += 0.025) push(x, y, t.z1, [0.3, 0.18, 0.11], 'z', 0.02);
  // a few floaters near the camera, like generated worlds have
  for (let i = 0; i < 40; i++) push((rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.6, [0.5, 0.5, 0.5], 'z', 0.01);

  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * props.length);
  splats.forEach((v, i) => body.set(v, i * props.length));
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body.buffer), head.length);
  return out;
}

/** Collider for the same room: floor, ceiling, four walls and the table as a box. */
function makeRoomGlb(): Uint8Array<ArrayBuffer> {
  const { x0, x1, z0, z1, floor, ceil, table: t } = ROOM;
  const pos: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const n = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  quad([x0, floor, z0], [x0, floor, z1], [x1, floor, z1], [x1, floor, z0]);
  quad([x0, ceil, z0], [x1, ceil, z0], [x1, ceil, z1], [x0, ceil, z1]);
  quad([x0, floor, z0], [x1, floor, z0], [x1, ceil, z0], [x0, ceil, z0]);
  quad([x0, floor, z1], [x0, ceil, z1], [x1, ceil, z1], [x1, floor, z1]);
  quad([x0, floor, z0], [x0, ceil, z0], [x0, ceil, z1], [x0, floor, z1]);
  quad([x1, floor, z0], [x1, floor, z1], [x1, ceil, z1], [x1, ceil, z0]);
  const [a, b, c, d, lo, hi] = [t.x0, t.x1, t.z0, t.z1, floor, t.top];
  quad([a, hi, c], [a, hi, d], [b, hi, d], [b, hi, c]);
  quad([a, lo, d], [b, lo, d], [b, hi, d], [a, hi, d]);
  quad([a, lo, c], [a, hi, c], [b, hi, c], [b, lo, c]);
  quad([a, lo, c], [a, lo, d], [a, hi, d], [a, hi, c]);
  quad([b, lo, c], [b, hi, c], [b, hi, d], [b, lo, d]);
  const posBytes = new Uint8Array(new Float32Array(pos).buffer);
  const idxBytes = new Uint8Array(new Uint32Array(idx).buffer);
  const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'collider' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: posBytes.length + idxBytes.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  let jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad(jsonBytes.length)).fill(0x20)]);
  const bin = new Uint8Array(posBytes.length + idxBytes.length + pad(posBytes.length + idxBytes.length));
  bin.set(posBytes, 0);
  bin.set(idxBytes, posBytes.length);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

let roomPly: Uint8Array<ArrayBuffer> | null = null;
let roomGlb: Uint8Array<ArrayBuffer> | null = null;
const room = () => (roomPly ??= makeRoomPly());
const roomCollider = () => (roomGlb ??= makeRoomGlb());

// ---------------------------------------------------------------------------------------------
// Synthetic scenes

const now = new Date().toISOString();
const identity = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: 1 };
const opencv = { position: [0, 0, 0] as [number, number, number], quaternion: [1, 0, 0, 0] as [number, number, number, number], scale: 1 };
let generatingSince = 0;

function virtualScene(id: string): Scene | null {
  const base = { id, createdAt: now, updatedAt: now, mode: 'rentfree' as const, status: 'ready' as const, backend: 'local' as const };
  switch (id) {
    case 'viewer-test-ply':
      return { ...base, name: 'Procedural test room', caption: 'Synthetic PLY, OpenGL frame', world: { file: 'room.ply', transform: identity, floorY: null, source: 'other' } };
    case 'viewer-test-collider':
      return { ...base, name: 'Test room with collider', world: { file: 'room.ply', transform: identity, floorY: null, collider: 'room.glb', source: 'other' } };
    case 'viewer-test-missing-video':
      return {
        ...base,
        mode: 'thirdwheel',
        name: 'Missing video',
        world: { file: 'world.spz', transform: opencv, floorY: null, source: 'marble-sample' },
        video: {
          file: 'does-not-exist.mp4',
          layout: 'tw-pack-v1',
          width: 640,
          height: 360,
          fps: 30,
          duration: 4,
          hasAudio: true,
          intrinsics: { fx: 400, fy: 400, cx: 319.5, cy: 179.5 },
          depth: { encoding: 'inverse', near: 0.8, far: 4 },
          cameraPose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        },
      };
    case 'viewer-test-generating': {
      if (!generatingSince) generatingSince = Date.now();
      const p = Math.min(1, (Date.now() - generatingSince) / 8000);
      if (p < 1) return { ...base, status: 'running', stage: p < 0.5 ? 'Generating the room' : 'Filling in what the camera missed', progress: p, name: 'Still cooking' };
      return { ...base, name: 'Still cooking', world: { file: 'world.spz', transform: opencv, floorY: null, source: 'marble-sample' } };
    }
    case 'viewer-test-failed':
      return { ...base, status: 'failed', name: 'Broken job', error: 'FlashWorld ran out of GPU memory (test scene).' };
    case 'viewer-test-noworld':
      return { ...base, name: 'No world here' };
  }
  return null;
}

function virtualFile(id: string, file: string): { path: string } | { bytes: Uint8Array<ArrayBuffer> } | null {
  if (!virtualScene(id)) return null;
  if (file === 'room.ply') return { bytes: room() };
  if (file === 'room.glb') return { bytes: roomCollider() };
  if (file === 'world.spz' && existsSync(BEDROOM)) return { path: BEDROOM };
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP

/** Parses a single "bytes=a-b" range against a size; null when absent, 'bad' when unsatisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number, end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

function serveBody(body: Blob, size: number, type: string, req: Request): Response {
  const base = { 'accept-ranges': 'bytes', 'content-type': type, 'cache-control': 'no-cache' };
  const r = parseRange(req.headers.get('range'), size);
  if (r === 'bad') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
  if (!r) return new Response(body, { headers: { ...base, 'content-length': String(size) } });
  return new Response(body.slice(r.start, r.end + 1), {
    status: 206,
    headers: { ...base, 'content-range': `bytes ${r.start}-${r.end}/${size}`, 'content-length': String(r.end - r.start + 1) },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  // NODE_ENV=production serves the minified, code-split bundle the real server ships
  development: process.env.NODE_ENV === 'production' ? false : { hmr: false, console: true },
  routes: {
    '/view': viewPage,
    '/': () => Response.redirect('/view?scene=sample-painted-bedroom', 302),
    '/api/scenes': () => {
      const list = existsSync(SCENES)
        ? readdirSync(SCENES)
            .map((id) => readScene(id))
            .filter((s): s is Scene => !!s)
        : [];
      return json(list);
    },
    '/api/scenes/:id': (req) => {
      const scene = virtualScene(req.params.id) ?? readScene(req.params.id);
      return scene ? json(scene) : json({ error: 'scene not found' }, 404);
    },
    '/api/health': () => json({ ok: true, version: 'viewer-harness' }),
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/data/scenes/')) {
      const rel = decodeURIComponent(url.pathname.slice('/data/scenes/'.length));
      const [id, ...rest] = rel.split('/');
      const v = virtualFile(id, rest.join('/'));
      if (v && 'bytes' in v) return serveBody(new Blob([v.bytes]), v.bytes.length, mimeFor(rest.join('/')), req);
      const full = v ? v.path : normalize(join(SCENES, rel));
      if (!v && !full.startsWith(SCENES + '/')) return new Response('forbidden', { status: 403 });
      if (!existsSync(full) || !statSync(full).isFile()) return new Response('not found', { status: 404 });
      const file = Bun.file(full);
      return serveBody(file, file.size, mimeFor(full), req);
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`viewer harness on http://localhost:${server.port}/view?scene=sample-painted-bedroom`);
