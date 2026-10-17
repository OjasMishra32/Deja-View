// Landing page: hero animation, compute health strip, live gallery, and the same-Wi-Fi panel.

import {
  ApiError,
  LiveEvents,
  deleteScene,
  getHealth,
  lanUrls,
  listScenes,
  productCopy,
  retryScene,
  sceneAssetUrl,
  splitErrorMessage,
  summarizeHealth,
  viewUrl,
  type HealthInfo,
  type Scene,
} from './api.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------------------------
// Point-cloud room, used by the hero and for placeholder thumbnails: a cutaway "dollhouse" of
// dots. Dots inside the photo's frustum are what the camera saw; the rest is what gets generated.

interface RoomPoint {
  x: number;
  y: number;
  z: number;
  shot: boolean; // inside the original photo's frustum
  tone: number; // 0..1 brightness variation
  phase: number;
  reveal: number; // how far outside the photo, for the reveal animation
  wall: number; // -1 floor or furniture, else index into WALLS
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

interface Basis {
  eye: V3;
  f: V3;
  r: V3;
  u: V3;
}

function lookAt(eye: V3, target: V3): Basis {
  const f = norm3(sub3(target, eye));
  const r = norm3(cross3(f, [0, 1, 0]));
  return { eye, f, r, u: cross3(r, f) };
}

interface Room {
  pts: RoomPoint[];
  half: [number, number]; // half extents x, z
  height: number;
  photo: Basis & { tanX: number; tanY: number };
}

/** Walls by outward normal axis: back (-z), front (+z), left (-x), right (+x). */
const WALLS: { axis: 0 | 2; sign: number }[] = [
  { axis: 2, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 0, sign: 1 },
];

function buildRoom(seed: number, count: number): Room {
  const r = rng(seed);
  const X = 2.3 + r() * 0.4, Z = 1.9 + r() * 0.4, H = 2.5;
  // The photo is taken from the front-right corner, looking into the room.
  const eye: V3 = [X - 0.55, 1.35, Z - 0.5];
  const target: V3 = [-X * 0.35, 0.95, -Z * 0.6];
  const photo = { ...lookAt(eye, target), tanX: Math.tan((32 * Math.PI) / 180), tanY: Math.tan((23 * Math.PI) / 180) };
  const pts: RoomPoint[] = [];
  const add = (x: number, y: number, z: number, tone: number, wall = -1) => {
    const d = sub3([x, y, z], eye);
    const fz = dot3(d, photo.f);
    const ax = fz > 0 ? Math.abs(dot3(d, photo.r) / fz) / photo.tanX : 9;
    const ay = fz > 0 ? Math.abs(dot3(d, photo.u) / fz) / photo.tanY : 9;
    const out = Math.max(ax, ay);
    pts.push({ x, y, z, shot: fz > 0.3 && out < 1, tone, phase: r() * Math.PI * 2, reveal: Math.max(0, out - 1), wall });
  };
  const n = (k: number) => Math.round(count * k);
  // Floor: planks along x with per-plank tone.
  for (let i = 0; i < n(0.3); i++) {
    const x = (r() * 2 - 1) * X, z = (r() * 2 - 1) * Z;
    const plank = Math.floor((z + 10) / 0.32);
    add(x, 0, z, 0.35 + 0.35 * rng(plank * 7 + seed)() + r() * 0.12);
  }
  // Rug
  for (let i = 0; i < n(0.05); i++) add(-0.4 + (r() * 2 - 1) * 1.0, 0.01, 0.2 + (r() * 2 - 1) * 0.7, 0.8 + r() * 0.2);
  // Walls with a window on the back wall and a door on the left wall.
  const winX0 = -0.2 + r() * 0.5;
  for (let w = 0; w < 4; w++) {
    const { axis, sign } = WALLS[w];
    const len = axis === 2 ? X : Z;
    const share = axis === 2 ? (sign < 0 ? 0.13 : 0.08) : 0.1;
    for (let i = 0; i < n(share); i++) {
      const s = (r() * 2 - 1) * len, y = r() * H;
      let tone = 0.45 + r() * 0.35;
      if (w === 0 && s > winX0 && s < winX0 + 1.2 && y > 0.95 && y < 2.0) {
        // window: brighter glass with a cross bar
        const bar = Math.abs(s - (winX0 + 0.6)) < 0.03 || Math.abs(y - 1.48) < 0.03;
        tone = bar ? 0.3 : 0.95;
      }
      if (w === 2 && s > -0.2 && s < 0.7 && y < 2.0) {
        if (Math.abs(s + 0.2) > 0.04 && Math.abs(s - 0.7) > 0.04 && Math.abs(y - 2.0) > 0.04) continue;
        tone = 0.9;
      }
      const p: V3 = axis === 2 ? [s, y, sign * Z] : [sign * X, y, s];
      add(p[0], p[1], p[2], tone, w);
    }
    // Edges where walls meet the floor read as lines.
    for (let i = 0; i < n(0.01); i++) {
      const s = (r() * 2 - 1) * len;
      const p: V3 = axis === 2 ? [s, 0, sign * Z] : [sign * X, 0, s];
      add(p[0], p[1], p[2], 1, w);
    }
  }
  const box = (cx: number, cz: number, w: number, d: number, h: number, k: number, top = 0.9) => {
    for (let i = 0; i < n(k); i++) {
      const face = r();
      const u = r() * 2 - 1, v = r();
      if (face < 0.5) add(cx + u * w, h, cz + (r() * 2 - 1) * d, top - r() * 0.15);
      else if (face < 0.75) add(cx + u * w, v * h, cz + (r() < 0.5 ? -d : d), 0.55 + r() * 0.2);
      else add(cx + (r() < 0.5 ? -w : w), v * h, cz + u * d, 0.5 + r() * 0.2);
    }
  };
  // Bed against the back-left, nightstand, desk on the right.
  box(-X + 0.85, -Z + 1.05, 0.75, 1.0, 0.5, 0.09, 0.95);
  box(-X + 0.85, -Z + 0.12, 0.75, 0.1, 0.9, 0.02, 0.8);
  box(-X + 2.0, -Z + 0.3, 0.25, 0.25, 0.55, 0.015);
  box(X - 0.45, -0.6, 0.35, 0.7, 0.75, 0.04);
  // Lamp and plant.
  const ball = (cx: number, cy: number, cz: number, rad: number, k: number, tone: number) => {
    for (let i = 0; i < n(k); i++) {
      const a = r() * Math.PI * 2, b = Math.acos(2 * r() - 1);
      add(cx + rad * Math.sin(b) * Math.cos(a), cy + rad * Math.cos(b), cz + rad * Math.sin(b) * Math.sin(a), tone);
    }
  };
  ball(-X + 2.0, 0.85, -Z + 0.3, 0.16, 0.012, 1);
  ball(X - 0.35, 1.0, Z - 1.2, 0.3, 0.02, 0.7);
  box(X - 0.35, Z - 1.2, 0.15, 0.15, 0.6, 0.008);
  return { pts, half: [X, Z], height: H, photo };
}

interface View {
  az: number; // radians around +y, 0 = looking from +z
  el: number;
  dist: number;
  fov: number;
}

function drawRoom(ctx: CanvasRenderingContext2D, w: number, h: number, room: Room, view: View, t: number, reveal: number, scale: number, frame = true) {
  ctx.clearRect(0, 0, w, h);
  const center: V3 = [0, 0.9, 0];
  const eye: V3 = [
    center[0] + view.dist * Math.cos(view.el) * Math.sin(view.az),
    center[1] + view.dist * Math.sin(view.el),
    center[2] + view.dist * Math.cos(view.el) * Math.cos(view.az),
  ];
  const cam = lookAt(eye, center);
  const F = (0.5 * h) / Math.tan((view.fov * Math.PI) / 360);
  const proj = (p: V3) => {
    const d = sub3(p, eye);
    const z = dot3(d, cam.f);
    return { sx: w / 2 + (dot3(d, cam.r) / z) * F, sy: h / 2 - (dot3(d, cam.u) / z) * F, z };
  };
  // Cutaway: walls between the viewer and the room fade out.
  const wallVis = WALLS.map(({ axis, sign }) => {
    const outside = sign * eye[axis] - (axis === 0 ? room.half[0] : room.half[1]);
    return 1 - Math.min(1, Math.max(0, (outside + 0.6) / 1.4));
  });
  for (const p of room.pts) {
    const vis = p.wall >= 0 ? wallVis[p.wall] : 1;
    if (vis <= 0.02) continue;
    const q = proj([p.x, p.y, p.z]);
    if (q.z < 0.2) continue;
    const size = Math.max(1, Math.min(3.2, (2.1 * view.dist) / q.z / 1.0)) * scale;
    if (p.shot) {
      const a = (0.32 + 0.6 * p.tone) * vis;
      ctx.fillStyle = `rgba(243,241,234,${a.toFixed(3)})`;
    } else {
      const shown = Math.max(0, Math.min(1, (reveal - p.reveal) * 1.6));
      if (shown <= 0) continue;
      const tw = 0.75 + 0.25 * Math.sin(t * 1.7 + p.phase);
      const a = (0.2 + 0.62 * p.tone) * vis * shown * tw;
      ctx.fillStyle = `rgba(212,255,58,${a.toFixed(3)})`;
    }
    ctx.fillRect(q.sx - size / 2, q.sy - size / 2, size, size);
  }
  if (!frame) return;
  // The photo: frustum from the photo camera with corner brackets 0.9 m out.
  const ph = room.photo;
  const at = (d: number, sx: number, sy: number): V3 => [
    ph.eye[0] + d * (ph.f[0] + sx * ph.tanX * ph.r[0] + sy * ph.tanY * ph.u[0]),
    ph.eye[1] + d * (ph.f[1] + sx * ph.tanX * ph.r[1] + sy * ph.tanY * ph.u[1]),
    ph.eye[2] + d * (ph.f[2] + sx * ph.tanX * ph.r[2] + sy * ph.tanY * ph.u[2]),
  ];
  const signs: [number, number][] = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ];
  const apex = proj(ph.eye);
  const near = signs.map(([a, b]) => proj(at(0.9, a, b)));
  const far = signs.map(([a, b]) => proj(at(3.2, a, b)));
  if (apex.z < 0.2) return;
  ctx.lineWidth = 1 * scale;
  ctx.strokeStyle = 'rgba(243,241,234,0.22)';
  ctx.setLineDash([4 * scale, 5 * scale]);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    ctx.moveTo(near[i].sx, near[i].sy);
    ctx.lineTo(far[i].sx, far[i].sy);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(243,241,234,0.45)';
  ctx.beginPath();
  for (const c of near) {
    ctx.moveTo(apex.sx, apex.sy);
    ctx.lineTo(c.sx, c.sy);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(243,241,234,0.95)';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const c = near[i], prev = near[(i + 3) % 4], next = near[(i + 1) % 4];
    const k = 0.25;
    ctx.moveTo(c.sx + (prev.sx - c.sx) * k, c.sy + (prev.sy - c.sy) * k);
    ctx.lineTo(c.sx, c.sy);
    ctx.lineTo(c.sx + (next.sx - c.sx) * k, c.sy + (next.sy - c.sy) * k);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(243,241,234,0.95)';
  ctx.beginPath();
  ctx.arc(apex.sx, apex.sy, 3 * scale, 0, Math.PI * 2);
  ctx.fill();
}

function startHero(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const small = innerWidth < 760;
  const room = buildRoom(11, small ? 4200 : 7000);
  let w = 0, h = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.width = Math.round(canvas.clientWidth * dpr);
    h = canvas.height = Math.round(canvas.clientHeight * dpr);
  };
  resize();
  new ResizeObserver(resize).observe(canvas);
  let visible = true;
  new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true)).observe(canvas);
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = (now - t0) / 1000;
    if (visible && w && h) {
      const az = reducedMotion ? 0.55 : 0.6 + Math.sin(t * 0.16) * 0.5;
      const reveal = reducedMotion ? 9 : Math.min(9, t * 0.9 - 0.3);
      const fit = Math.max(1, (h / w) * 0.9);
      drawRoom(ctx, w, h, room, { az, el: 0.52, dist: 7.8 * fit, fov: 50 }, t, reveal, dpr);
    }
    if (!reducedMotion || t < 0.1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const thumbCache = new Map<string, string>();
/** Generated cover for scenes without a thumbnail: the same dot room, seeded by the scene id. */
function placeholderThumb(scene: { id: string }): string {
  const hit = thumbCache.get(scene.id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const seed = hashString(scene.id);
  const r = rng(seed ^ 0x9e3779b9);
  const room = buildRoom(seed, 5200);
  drawRoom(ctx, 640, 400, room, { az: 0.25 + r() * 0.8, el: 0.55, dist: 8.4, fov: 46 }, r() * 10, 9, 1.4, false);
  ctx.globalCompositeOperation = 'destination-over';
  const g = ctx.createRadialGradient(320, 220, 20, 320, 220, 380);
  g.addColorStop(0, '#1b1d17');
  g.addColorStop(1, '#0c0c0f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 640, 400);
  const url = c.toDataURL('image/jpeg', 0.85);
  thumbCache.set(scene.id, url);
  return url;
}

// ---------------------------------------------------------------------------------------------
// QR code (byte mode, error correction level L, versions 1-10) for the same-Wi-Fi link.

const QR_L: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 7, blocks: [19] },
  2: { ec: 10, blocks: [34] },
  3: { ec: 15, blocks: [55] },
  4: { ec: 20, blocks: [80] },
  5: { ec: 26, blocks: [108] },
  6: { ec: 18, blocks: [68, 68] },
  7: { ec: 20, blocks: [78, 78] },
  8: { ec: 24, blocks: [97, 97] },
  9: { ec: 30, blocks: [116, 116] },
  10: { ec: 18, blocks: [68, 68, 69, 69] },
};
const QR_ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const res = new Array<number>(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < res.length; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < res.length) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return res;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const res = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (res.shift() as number);
    res.push(0);
    divisor.forEach((coef, i) => (res[i] ^= gfMul(coef, factor)));
  }
  return res;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = QR_L[v].blocks.reduce((a, b) => a + b, 0);
    if (4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= cap * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('Text too long for a QR code');
  const { ec, blocks } = QR_L[version];
  const dataCap = blocks.reduce((a, b) => a + b, 0);

  const bits: number[] = [];
  const push = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  const div = rsDivisor(ec);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let k = 0;
  for (const len of blocks) {
    const blk = data.slice(k, k + len);
    k += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, div));
  }
  const words: number[] = [];
  const maxLen = Math.max(...blocks);
  for (let i = 0; i < maxLen; i++) for (const b of dataBlocks) if (i < b.length) words.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) words.push(b[i]);

  const size = version * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mods[y][x] = dark;
    isFn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = QR_ALIGN[version];
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask: number) => {
    const d = (1 << 3) | mask; // level L = 01
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bi < words.length * 8) {
          mods[y][x] = ((words[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1;
          bi++;
        }
      }
    }
  }
  const maskFn = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn(m, x, y)) mods[y][x] = !mods[y][x];
  };
  const penalty = (): number => {
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      const seq: number[] = [];
      for (let i = 0; i < size; i++) {
        seq.push(get(i) ? 1 : 0);
        if (i > 0) {
          if (get(i) === get(i - 1)) run++;
          else {
            if (run >= 5) p += 3 + run - 5;
            run = 1;
          }
        }
      }
      if (run >= 5) p += 3 + run - 5;
      const s = seq.join('');
      for (const pat of ['10111010000', '00001011101']) {
        let idx = s.indexOf(pat);
        while (idx >= 0) {
          p += 40;
          idx = s.indexOf(pat, idx + 1);
        }
      }
    };
    for (let y = 0; y < size; y++) line((i) => mods[y][i]);
    for (let x = 0; x < size; x++) line((i) => mods[i][x]);
    let dark = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (mods[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = mods[y][x];
          if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) p += 3;
        }
      }
    const total = size * size;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
    applyMask(m);
  }
  applyMask(best);
  drawFormat(best);
  return mods;
}

export function qrSvg(text: string): string {
  const m = qrMatrix(text);
  const n = m.length, q = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><path fill="#0b0b0d" d="${d}"/></svg>`;
}

// ---------------------------------------------------------------------------------------------
// Health strip + same-Wi-Fi panel

let health: HealthInfo | undefined;

function setHealth(h: HealthInfo | undefined) {
  health = h;
  const s = summarizeHealth(h);
  const items: [string, { ok: boolean; detail: string }][] = [
    ['gpu', s.gpu],
    ['worker', s.worker],
    ['fallbacks', s.fallbacks],
  ];
  for (const [k, v] of items) {
    const el = $(`.health-item[data-k="${k}"]`);
    if (!el) continue;
    const dot = $('.dot', el)!;
    dot.className = 'dot' + (h ? (v.ok ? ' on' : k === 'fallbacks' ? ' bad' : '') : '');
    $('.v', el)!.textContent = v.detail;
  }
  renderLan();
}

function currentLanUrl(): string | null {
  const urls = health ? lanUrls(health) : [];
  if (urls.length) return urls[0];
  if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
  return null;
}

let lastQr = '';
function renderLan() {
  const url = currentLanUrl();
  const link = $<HTMLAnchorElement>('#lan-url');
  const inline = $<HTMLAnchorElement>('#lan-inline');
  const note = $('#lan-note');
  const qr = $('#qr');
  const cap = $<HTMLAnchorElement>('#lan-capture');
  if (!link || !inline || !note || !qr) return;
  if (!url) {
    link.textContent = health ? 'No Wi-Fi address found' : 'finding this laptop…';
    link.removeAttribute('href');
    inline.textContent = health ? 'not on a network' : 'finding address';
    note.textContent = health ? 'Connect the laptop to Wi-Fi, then reload. Phones and the Quest must be on the same network.' : '';
    qr.innerHTML = '';
    return;
  }
  const pretty = url.replace(/^https?:\/\//, '');
  link.textContent = url;
  link.href = url;
  inline.textContent = pretty;
  inline.href = url;
  if (cap) cap.href = url + '/capture';
  if (url !== lastQr) {
    try {
      qr.innerHTML = qrSvg(url);
      lastQr = url;
    } catch {
      qr.innerHTML = '';
    }
  }
  note.textContent = health?.https || url.startsWith('https:')
    ? 'Scan with your phone camera or type it into the Quest browser. Accept the certificate warning once per device.'
    : 'Scan with your phone camera or type it into the Quest browser. VR mode on the Quest needs HTTPS: start the server with bun run https.';
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Gallery

const MODE_LABEL: Record<string, string> = {
  rentfree: 'Rent Free',
  thirdwheel: 'Third Wheel',
  reconstruct: 'Reconstruct',
  sample: 'Sample',
};
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  running: 'Running',
  downloading: 'Downloading',
  ready: 'Ready',
  failed: 'Failed',
};
const BACKEND_LABEL: Record<string, string> = {
  'hpg-worker': 'HiPerGator worker',
  'hpg-batch': 'HiPerGator batch',
  'hf-space': 'cloud GPU',
  local: 'this Mac',
  bundled: 'bundled',
};
const ACTIVE = new Set(['queued', 'uploading', 'running', 'downloading']);

const scenes = new Map<string, Scene>();
let filter = 'all';
let loaded = false;
let highlightId: string | null = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('new') : null;
const confirming = new Map<string, ReturnType<typeof setTimeout>>();

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;
function ago(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = (t - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

function ordered(): Scene[] {
  return [...scenes.values()].sort((a, b) => {
    const sa = a.mode === 'sample' ? 1 : 0, sb = b.mode === 'sample' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

function matches(s: Scene): boolean {
  if (filter === 'all') return true;
  return s.mode === filter;
}

/** The scene's thumbnail, else its first uploaded photo, else a generated cover. */
function thumbUrl(s: Scene): string {
  if (s.thumb) return sceneAssetUrl(s.id, s.thumb);
  const first = s.input?.files?.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (first) return sceneAssetUrl(s.id, first.includes('/') ? first : `input/${first}`);
  return placeholderThumb(s);
}

const ICON_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function metaLine(s: Scene): string {
  const clip = s.video && Number.isFinite(s.video.duration) ? `${Math.round(s.video.duration)} s${s.video.hasAudio ? ' with sound' : ''}` : '';
  return [ago(s.createdAt), clip, s.backend ? BACKEND_LABEL[s.backend] ?? s.backend : ''].filter(Boolean).join(' · ');
}

/** Stage line in product language; falls back to the status. */
function stageText(s: Scene): string {
  return productCopy(s.stage) || STATUS_LABEL[s.status] || s.status;
}

function subline(s: Scene): string {
  // Prompts are the user's own words and stay as typed; captions and stages come from the pipelines.
  const caption = s.caption ? productCopy(s.caption) : '';
  if (s.status === 'failed') return s.stage && s.stage !== 'Failed' ? `Stopped at: ${stageText(s)}` : 'Something went sideways.';
  if (ACTIVE.has(s.status)) return s.input?.prompt ? `“${s.input.prompt}”` : caption || (s.mode === 'thirdwheel' ? 'Lifting your friend into 3D' : 'Building the room');
  if (caption) return caption;
  if (s.input?.prompt) return `“${s.input.prompt}”`;
  return s.mode === 'thirdwheel' ? 'Walkable kitchen, real friend, original audio' : s.mode === 'sample' ? 'Bundled sample world' : 'Walkable world';
}

/** The failure reason, with any tool output folded into a details block. */
function errorBox(error: string | undefined): string {
  const { headline, detail } = splitErrorMessage(error || 'The job failed without saying why. Check log.txt in the scene folder.');
  return `<div class="error-box">${esc(headline)}${detail ? `<details><summary>Details</summary><pre>${esc(detail)}</pre></details>` : ''}</div>`;
}

function cardBody(s: Scene): string {
  const active = ACTIVE.has(s.status);
  const pct = typeof s.progress === 'number' ? Math.round(s.progress * 100) : null;
  const meta = metaLine(s);
  const isConfirm = confirming.has(s.id);
  return `
    <h3 class="card-title">${esc(s.name || 'Untitled')}</h3>
    <p class="card-sub">${esc(subline(s))}</p>
    ${
      active
        ? `<div class="stage-line"><b class="stage">${esc(stageText(s))}</b><span class="pct">${pct !== null ? pct + '%' : ''}</span></div>
           <div class="progress${pct === null ? ' indeterminate' : ''}"><div class="progress-fill" style="transform:scaleX(${pct !== null ? Math.max(0.02, pct / 100) : 0.3})"></div></div>`
        : ''
    }
    ${s.status === 'failed' ? errorBox(s.error) : ''}
    <div class="card-foot">
      <span class="meta" title="${esc(s.createdAt)}">${esc(meta)}</span>
      ${s.status === 'failed' ? `<button class="btn btn-xs" data-act="retry" type="button">Retry</button>` : ''}
      ${
        s.mode === 'sample'
          ? ''
          : `<button class="icon-btn del${isConfirm ? ' confirm' : ''}" data-act="delete" type="button" aria-label="Delete ${esc(s.name)}">${isConfirm ? 'Delete?' : ICON_TRASH}</button>`
      }
      <a class="btn ${s.status === 'ready' ? 'btn-primary' : ''} btn-xs" data-act="enter" href="${esc(viewUrl(s.id))}"${
        s.status === 'ready' ? '' : ' aria-disabled="true" tabindex="-1"'
      }>Enter <span class="arrow">&rarr;</span></a>
    </div>`;
}

function badges(s: Scene): string {
  const active = ACTIVE.has(s.status);
  return `<span class="badge mode-${esc(s.mode)}">${esc(MODE_LABEL[s.mode] ?? s.mode)}</span>
    <span class="badge status-${esc(s.status)}"><span class="dot${s.status === 'ready' ? ' on' : active ? ' on pulse' : s.status === 'failed' ? ' bad' : ''}"></span>${esc(STATUS_LABEL[s.status] ?? s.status)}</span>`;
}

function makeCard(s: Scene): HTMLElement {
  const el = document.createElement('article');
  el.className = 'scene-card';
  el.innerHTML = `<div class="thumb"><img alt="" decoding="async" /><div class="thumb-badges"></div></div><div class="card-body"></div>`;
  const img = el.querySelector('img')!;
  img.addEventListener('error', () => {
    // Missing or not yet written: fall back to the generated cover.
    const s2 = scenes.get(el.dataset.id ?? '') ?? s;
    const fallback = placeholderThumb(s2);
    if (img.src !== fallback) img.src = fallback;
  });
  fillCard(el, s, true);
  return el;
}

function fillCard(el: HTMLElement, s: Scene, fresh = false) {
  const prevStatus = el.dataset.status;
  el.dataset.id = s.id;
  el.dataset.status = s.status;
  el.dataset.mode = s.mode;
  const thumb = $('.thumb', el)!;
  const url = thumbUrl(s);
  if (thumb.dataset.src !== url) {
    thumb.dataset.src = url;
    thumb.querySelector('img')!.src = url;
  }
  $('.thumb-badges', el)!.innerHTML = badges(s);
  const body = $('.card-body', el)!;
  // Progress-only changes update in place so the bar animates instead of jumping.
  if (!fresh && prevStatus === s.status && ACTIVE.has(s.status) && $('.progress', body) && !confirming.has(s.id)) {
    const pct = typeof s.progress === 'number' ? Math.round(s.progress * 100) : null;
    const fill = $('.progress-fill', body)!;
    $('.progress', body)!.classList.toggle('indeterminate', pct === null);
    fill.style.transform = `scaleX(${pct !== null ? Math.max(0.02, pct / 100) : 0.3})`;
    $('.stage', body)!.textContent = stageText(s);
    $('.pct', body)!.textContent = pct !== null ? `${pct}%` : '';
    $('.card-sub', body)!.textContent = subline(s);
    $('.card-title', body)!.textContent = s.name || 'Untitled';
    return;
  }
  body.innerHTML = cardBody(s);
}

function renderFilters() {
  const bar = $('#filters');
  if (!bar) return;
  const all = [...scenes.values()];
  const count = (m: string) => all.filter((s) => s.mode === m).length;
  const opts: [string, string, number][] = [
    ['all', 'All', all.length],
    ['rentfree', 'Rent Free', count('rentfree')],
    ['thirdwheel', 'Third Wheel', count('thirdwheel')],
  ];
  if (count('reconstruct')) opts.push(['reconstruct', 'Reconstruct', count('reconstruct')]);
  if (count('sample')) opts.push(['sample', 'Samples', count('sample')]);
  bar.innerHTML = opts
    .map(([k, label, n]) => `<button class="filter" type="button" data-filter="${k}" aria-pressed="${filter === k}">${label}<span class="n">${n}</span></button>`)
    .join('');
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  renderFilters();
  const list = ordered().filter(matches);
  if (!list.length) {
    grid.innerHTML = loaded
      ? `<div class="empty"><h3>${scenes.size ? 'Nothing in this filter.' : 'Nothing here yet.'}</h3><p>${
          scenes.size ? 'Try another one, or make something new.' : 'Your first world is one photo away.'
        }</p><a class="btn btn-primary" href="/capture">Make one <span class="arrow">&rarr;</span></a></div>`
      : grid.innerHTML;
    return;
  }
  const existing = new Map<string, HTMLElement>();
  for (const el of grid.querySelectorAll<HTMLElement>('.scene-card')) if (el.dataset.id) existing.set(el.dataset.id, el);
  for (const el of grid.querySelectorAll('.skeleton, .empty')) el.remove();
  let prev: Element | null = null;
  for (const s of list) {
    let el = existing.get(s.id);
    if (el) {
      existing.delete(s.id);
      fillCard(el, s);
    } else el = makeCard(s);
    const anchor: ChildNode | null = prev ? prev.nextSibling : grid.firstChild;
    if (el !== anchor) grid.insertBefore(el, anchor);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  applyHighlight();
}

function upsert(s: Scene) {
  if (!s || typeof s.id !== 'string') return;
  const had = scenes.has(s.id);
  scenes.set(s.id, s);
  if (!had) {
    renderGrid();
    return;
  }
  const el = $(`.scene-card[data-id="${CSS.escape(s.id)}"]`);
  if (el && matches(s)) fillCard(el, s);
  else renderGrid();
}

function removeScene(id: string) {
  scenes.delete(id);
  const el = $(`.scene-card[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
      if (!scenes.size || ![...scenes.values()].some(matches)) renderGrid();
      else renderFilters();
    }, 280);
  } else renderGrid();
}

function applyHighlight() {
  if (!highlightId) return;
  const el = $(`.scene-card[data-id="${CSS.escape(highlightId)}"]`);
  if (!el) return;
  el.classList.add('is-new');
  setTimeout(() => el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' }), 120);
  highlightId = null;
  const url = new URL(location.href);
  url.searchParams.delete('new');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

async function refreshScenes() {
  const banner = $('#gallery-error');
  try {
    const list = await listScenes();
    const seen = new Set(list.map((s) => s.id));
    for (const id of [...scenes.keys()]) if (!seen.has(id)) scenes.delete(id);
    for (const s of list) scenes.set(s.id, s);
    loaded = true;
    banner?.classList.remove('show');
    renderGrid();
  } catch (err) {
    loaded = true;
    if (banner) {
      banner.textContent = `Can't load the gallery: ${err instanceof Error ? err.message : String(err)} Retrying…`;
      banner.classList.add('show');
    }
    if (!scenes.size) renderGrid();
  }
}

async function refreshHealth() {
  try {
    setHealth(await getHealth());
  } catch {
    setHealth(undefined);
    for (const el of document.querySelectorAll('.health-item[data-k] .v')) el.textContent = 'unknown';
  }
}

function onGridClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const card = target.closest<HTMLElement>('.scene-card');
  if (!card) return;
  const id = card.dataset.id!;
  const scene = scenes.get(id);
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act) {
    if (target.closest('.thumb') && scene?.status === 'ready') location.href = viewUrl(id);
    return;
  }
  if (act === 'retry') {
    e.preventDefault();
    const btn = target.closest<HTMLButtonElement>('button');
    if (btn) btn.disabled = true;
    retryScene(id)
      .then((s) => {
        if (s) upsert(s);
        toast('Retrying. Fingers crossed.');
      })
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Retry failed');
        if (btn) btn.disabled = false;
      });
  } else if (act === 'delete') {
    e.preventDefault();
    if (!confirming.has(id)) {
      confirming.set(
        id,
        setTimeout(() => {
          confirming.delete(id);
          const s = scenes.get(id);
          const el = $(`.scene-card[data-id="${CSS.escape(id)}"]`);
          if (s && el) fillCard(el, s, true);
        }, 3500),
      );
      if (scene) fillCard(card, scene, true);
      ($('.del', card) as HTMLButtonElement | null)?.focus();
      return;
    }
    clearTimeout(confirming.get(id));
    confirming.delete(id);
    deleteScene(id)
      .then(() => {
        removeScene(id);
        toast('Deleted. It never happened.');
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Delete failed'));
  } else if (act === 'enter' && scene?.status !== 'ready') {
    e.preventDefault();
  }
}

// ---------------------------------------------------------------------------------------------

function setLive(state: 'connecting' | 'open' | 'closed') {
  const dot = $('#live-dot');
  const txt = $('#live-txt');
  if (!dot || !txt) return;
  dot.className = 'dot' + (state === 'open' ? ' on pulse' : state === 'connecting' ? ' warn' : ' bad');
  txt.textContent = state === 'open' ? 'live' : state === 'connecting' ? 'connecting' : 'reconnecting';
  $('#live')?.setAttribute('title', state === 'open' ? 'Live updates on' : 'Live updates paused; polling');
}

function main() {
  const canvas = $<HTMLCanvasElement>('#hero-canvas');
  if (canvas) startHero(canvas);

  $('#grid')?.addEventListener('click', onGridClick);
  $('#filters')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter!;
    renderGrid();
  });
  $('#lan-copy')?.addEventListener('click', async () => {
    const url = currentLanUrl();
    if (!url) return toast('No network address yet');
    toast((await copyText(url)) ? 'Link copied' : url);
  });

  const events = new LiveEvents();
  let opened = false;
  events.onState((s) => {
    setLive(s);
    if (s === 'open') {
      // After a reconnect, events may have been missed.
      if (opened) void refreshScenes();
      opened = true;
    }
  });
  events.on('scene', (ev) => upsert(ev.scene));
  events.on('scene_deleted', (ev) => removeScene(ev.id));
  events.on('health', (ev) => setHealth(ev.health));
  events.start();

  void refreshScenes();
  void refreshHealth();

  // Polling fallback while the socket is down, and a slow health refresh regardless.
  setInterval(() => {
    if (events.state !== 'open') void refreshScenes();
  }, 4000);
  setInterval(() => void refreshHealth(), 20000);
  // Keep relative times fresh.
  setInterval(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.scene-card')) {
      const s = scenes.get(el.dataset.id ?? '');
      const meta = el.querySelector('.meta');
      if (s && meta) meta.textContent = metaLine(s);
    }
  }, 30000);
}

// The capture page imports qrSvg from here; only the landing page has a gallery grid.
if (typeof document !== 'undefined' && document.getElementById('grid')) main();
