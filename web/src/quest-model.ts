// The landing page's headset from a real model: "Quest 3S with controllers" by OG_MATTER (CC BY 4.0),
// given new materials to match photos of the real one, in the same frame as the code-built headset
// (headset.ts) so the hero can swap one for the other.
//
// The file holds the headset, both Touch Plus controllers and a few modelling leftovers (two spheres,
// a UV-checker disc, some small parts far from the headset). Only the headset is kept. Its parts:
//   QuestHeadset_2    every dark part: the facial interface, the lens housings, the sensors, ports,
//                     buttons, and some trim on the arms and the rear band
//   QuestHeadset.001  the white front cover
//   QuestHeadset.002  the white shell round the sides, and the arm hinges behind it
//   QuestHeadset.003  the black seam round the front cover
//   QuestHeadset.004  the edge trim of the arms and rear band
//   QuestHeadset.005  the side arms and the rear band
//   QuestHeadset.006  the top strap
//   QuestHeadset.007  the two lenses
//   QuestHeadset.008  the fit button on the left arm
// The dark parts and the shell are split into their connected pieces, and each piece is sorted by
// where it sits. A part whose name is missing is placed by its colour and position instead.
//
// Units: the visor is 1.915 wide (1 unit = 100 mm); the front faces +Z, the lenses -Z, +Y is up and
// the wearer's left is +X. The origin is at the visor's centre, halfway between the front cover and
// the back of the facial interface.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Headset } from './headset.ts';

const VISOR_W = 1.915;

/** What each named headset node is, by its number (QuestHeadset_2 has none). */
type NodeRole = 'body' | 'front' | 'shell' | 'seam' | 'trim' | 'strap' | 'topStrap' | 'lens' | 'fit';
const ROLE_BY_NUMBER: Record<string, NodeRole> = {
  '': 'body', '001': 'front', '002': 'shell', '003': 'seam', '004': 'trim', '005': 'strap', '006': 'topStrap', '007': 'lens', '008': 'fit',
};
/** Headset node names as exported ("QuestHeadset.001_15") or as GLTFLoader keeps them ("QuestHeadset001_15"). */
const HEADSET_NODE = /^questheadset\.?(\d{3})?(?:_\d+)?$/i;
/** Things in the file that are not the headset. */
const NOT_HEADSET = /icosphere|checker|uv_?grid|touch_?plus|controller|battery|^asset/i;

/** The final look of each piece. The strap kinds fade with setStrap. */
type Kind = 'white' | 'seam' | 'sensor' | 'camRing' | 'button' | 'fabric' | 'housing' | 'lens' | 'detail' | 'strap' | 'trim' | 'hinge' | 'fit' | 'strapDetail';
const STRAP_KINDS: Kind[] = ['strap', 'trim', 'hinge', 'fit', 'strapDetail'];
/** How many times the pieces the camera flies past are subdivided (each level: four times the triangles). */
const SMOOTH_LEVELS = 2;

interface Part {
  role: NodeRole;
  /** In the file's scene frame. */
  geo: THREE.BufferGeometry;
}

/**
 * A Fresnel lens as in the photos: clear glass over the dark housing, read through its rings. Fine
 * silvery grooves, denser and brighter towards the rim, a few with a faint rainbow tint low down.
 */
function fresnelTexture(): THREE.CanvasTexture {
  const S = 1024, h = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const bg = g.createRadialGradient(h, h, S * 0.02, h, h, h);
  bg.addColorStop(0, '#585b61');
  bg.addColorStop(0.55, '#63666c');
  bg.addColorStop(1, '#73767c');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  // the grooves: a light edge and a dark edge each, closer together towards the rim
  for (let k = 1, r = 0; r < h; k++) {
    r = h * Math.sqrt(k / 46);
    const f = r / h;
    g.lineWidth = 2.2;
    g.strokeStyle = `rgba(236,238,242,${0.14 + 0.3 * f})`;
    g.beginPath();
    g.arc(h, h, r, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1.6;
    g.strokeStyle = `rgba(24,26,30,${0.1 + 0.14 * f})`;
    g.beginPath();
    g.arc(h, h, r + 3, 0, Math.PI * 2);
    g.stroke();
  }
  // the rainbow the grooves split light into, low on the lens
  g.globalCompositeOperation = 'screen';
  for (const [a0, a1, col, dr] of [[0.55, 0.95, '90,140,255', 0], [0.62, 0.86, '255,170,90', 1.5]] as const) {
    for (let k = 20; k < 46; k += 3) {
      const r = h * Math.sqrt(k / 46);
      g.lineWidth = 2;
      g.strokeStyle = `rgba(${col},0.16)`;
      g.beginPath();
      g.arc(h, h, r + dr, Math.PI * a0, Math.PI * a1);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A canvas texture for bump maps: the straps' diagonal ribs, or the fabric's fine grain (as in headset.ts). */
function bumpTexture(kind: 'ribs' | 'grain'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 128, 128);
  if (kind === 'ribs') {
    g.strokeStyle = '#d8d8d8';
    g.lineWidth = 7;
    g.filter = 'blur(1.5px)';
    for (let k = -128; k <= 256; k += 16) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k - 128, 128);
      g.stroke();
    }
  } else {
    const img = g.getImageData(0, 0, 128, 128);
    let seed = 11;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647;
      const v = 96 + (seed % 64);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The triangles of a geometry in connected pieces (triangles sharing a corner, matched by position). */
function connectedPieces(g: THREE.BufferGeometry): number[][] {
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const n = pos.count;
  const triCount = (index ? index.count : n) / 3;
  const corner = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const weld = weldMap(pos);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const join = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (let t = 0; t < triCount; t++) {
    const a = weld[corner(t, 0)];
    join(a, weld[corner(t, 1)]);
    join(a, weld[corner(t, 2)]);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(weld[corner(t, 0)]);
    let list = groups.get(r);
    if (!list) groups.set(r, (list = []));
    list.push(t);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** A new, compact geometry of some of a geometry's triangles (position, normal and uv). */
function subset(g: THREE.BufferGeometry, tris: number[]): THREE.BufferGeometry {
  const index = g.getIndex();
  const names = ['position', 'normal', 'uv'].filter((k) => g.getAttribute(k));
  const remap = new Map<number, number>();
  const order: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k;
      let m = remap.get(v);
      if (m === undefined) {
        remap.set(v, (m = order.length));
        order.push(v);
      }
      idx.push(m);
    }
  }
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const src = g.getAttribute(name);
    const size = src.itemSize;
    const arr = new Float32Array(order.length * size);
    order.forEach((v, i) => {
      for (let c = 0; c < size; c++) arr[i * size + c] = src.getComponent(v, c);
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.setIndex(idx);
  return out;
}

/** Each vertex's first vertex at the same position (positions matched to 1e-4). */
function weldMap(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Int32Array {
  const weld = new Int32Array(pos.count);
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let w = seen.get(key);
    if (w === undefined) seen.set(key, (w = i));
    weld[i] = w;
  }
  return weld;
}

/**
 * Splits every triangle in four, `levels` times, placing each new vertex on the smooth surface the
 * vertex normals describe (Phong tessellation), so curved outlines stop showing their facets. Copies of
 * a vertex (UV or normal seams) move together, so nothing cracks open; normals and UVs are interpolated.
 */
function smoothSubdivide(geo: THREE.BufferGeometry, levels: number): THREE.BufferGeometry {
  const ALPHA = 0.6;
  let g = geo;
  for (let level = 0; level < levels; level++) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const index = g.getIndex()!;
    const n = pos.count;
    const weld = weldMap(pos);
    // one normal per position, averaged over its copies, for placing the new vertices
    const wn = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const w = weld[i] * 3;
      wn[w] += nrm.getX(i);
      wn[w + 1] += nrm.getY(i);
      wn[w + 2] += nrm.getZ(i);
    }
    for (let i = 0; i < n; i++) {
      if (weld[i] !== i) continue;
      const l = Math.hypot(wn[i * 3], wn[i * 3 + 1], wn[i * 3 + 2]) || 1;
      wn[i * 3] /= l;
      wn[i * 3 + 1] /= l;
      wn[i * 3 + 2] /= l;
    }
    const P: number[] = [], N: number[] = [], U: number[] = [];
    for (let i = 0; i < n; i++) {
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      N.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      if (uv) U.push(uv.getX(i), uv.getY(i));
    }
    const placed = new Map<number, [number, number, number]>();
    /** The new vertex on an edge, by its welded ends, so every copy lands on the same point. */
    const place = (a: number, b: number): [number, number, number] => {
      let wa = weld[a], wb = weld[b];
      if (wa > wb) [wa, wb] = [wb, wa];
      const key = wa * n + wb;
      const hit = placed.get(key);
      if (hit) return hit;
      const m = [0, 1, 2].map((k) => (P[wa * 3 + k] + P[wb * 3 + k]) / 2);
      const out: [number, number, number] = [0, 0, 0];
      for (const w of [wa, wb]) {
        const d = (m[0] - P[w * 3]) * wn[w * 3] + (m[1] - P[w * 3 + 1]) * wn[w * 3 + 1] + (m[2] - P[w * 3 + 2]) * wn[w * 3 + 2];
        for (let k = 0; k < 3; k++) out[k] += (m[k] - d * wn[w * 3 + k]) / 2;
      }
      for (let k = 0; k < 3; k++) out[k] = (1 - ALPHA) * m[k] + ALPHA * out[k];
      placed.set(key, out);
      return out;
    };
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * n + b : b * n + a;
      let v = mids.get(key);
      if (v !== undefined) return v;
      v = P.length / 3;
      P.push(...place(a, b));
      const nx = N[a * 3] + N[b * 3], ny = N[a * 3 + 1] + N[b * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      N.push(nx / l, ny / l, nz / l);
      if (uv) U.push((U[a * 2] + U[b * 2]) / 2, (U[a * 2 + 1] + U[b * 2 + 1]) / 2);
      mids.set(key, v);
      return v;
    };
    const idx: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    out.setIndex(idx);
    if (g !== geo) g.dispose();
    g = out;
  }
  return g;
}

/** The open edges of a mesh, chained into loops of (welded) vertex indices. */
function boundaryLoops(g: THREE.BufferGeometry): number[][] {
  const pos = g.getAttribute('position');
  const index = g.getIndex()!;
  const n = pos.count;
  const weld = weldMap(pos);
  const uses = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < index.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const e = key(weld[index.getX(t + k)], weld[index.getX(t + ((k + 1) % 3))]);
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  const next = new Map<number, number[]>();
  for (let t = 0; t < index.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = weld[index.getX(t + k)], b = weld[index.getX(t + ((k + 1) % 3))];
      if (uses.get(key(a, b)) !== 1) continue;
      let list = next.get(a);
      if (!list) next.set(a, (list = []));
      list.push(b);
    }
  }
  const done = new Set<number>();
  const loops: number[][] = [];
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: number[] = [];
    for (let v: number | undefined = start; v !== undefined && !done.has(v); ) {
      done.add(v);
      loop.push(v);
      const options: number[] = next.get(v) ?? [];
      v = options.find((x) => !done.has(x));
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Closes a hole with a flat disc (a fan round its middle), facing away from `inside`. The model's
 * shell has a socket on each side where the arm's hinge plugs in; with the strap gone it would be an
 * open hole into the headset.
 */
function capLoop(g: THREE.BufferGeometry, loop: number[], inside: THREE.Vector3): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const pts = loop.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  const mid = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
  // the loop's plane (Newell), facing out
  const normal = new THREE.Vector3();
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    normal.x += (p.y - q.y) * (p.z + q.z);
    normal.y += (p.z - q.z) * (p.x + q.x);
    normal.z += (p.x - q.x) * (p.y + q.y);
  });
  normal.normalize();
  if (normal.dot(mid.clone().sub(inside)) < 0) normal.negate();
  const P: number[] = [...mid.toArray()];
  for (const p of pts) P.push(p.x, p.y, p.z);
  const N: number[] = [];
  for (let i = 0; i <= pts.length; i++) N.push(normal.x, normal.y, normal.z);
  const idx: number[] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = i + 1, b = ((i + 1) % pts.length) + 1;
    e1.subVectors(pts[i], mid);
    e2.subVectors(pts[b - 1], mid);
    if (e1.cross(e2).dot(normal) >= 0) idx.push(0, a, b);
    else idx.push(0, b, a);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setIndex(idx);
  return out;
}

/** The box and the vertex centroid of some triangles. */
function measure(g: THREE.BufferGeometry, tris: number[]) {
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const box = new THREE.Box3();
  const centroid = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, index ? index.getX(t * 3 + k) : t * 3 + k);
      box.expandByPoint(v);
      centroid.add(v);
    }
  }
  centroid.divideScalar(Math.max(1, tris.length * 3));
  return { box, centroid };
}

/** Bounds of some geometries' vertices after a matrix. */
function boundsOf(geos: THREE.BufferGeometry[], m: THREE.Matrix4): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const g of geos) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
  }
  return box;
}

/** All vertex positions of some geometries, flattened (for nearest-point tests). */
function pointsOf(geos: THREE.BufferGeometry[]): Float32Array {
  const total = geos.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++, o += 3) {
      out[o] = pos.getX(i);
      out[o + 1] = pos.getY(i);
      out[o + 2] = pos.getZ(i);
    }
  }
  return out;
}

/** The corner positions of some triangles, flattened. */
function pointsOfTris(g: THREE.BufferGeometry, tris: number[]): Float32Array {
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const out = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) {
    for (let k = 0; k < 3; k++, o += 3) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k;
      out[o] = pos.getX(v);
      out[o + 1] = pos.getY(v);
      out[o + 2] = pos.getZ(v);
    }
  }
  return out;
}

function nearest(points: Float32Array, p: THREE.Vector3): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - p.x, dy = points[i + 1] - p.y, dz = points[i + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const luminance = (m: THREE.Material | THREE.Material[]): number => {
  const c = (Array.isArray(m) ? m[0] : m) as THREE.MeshStandardMaterial;
  return c?.color ? 0.2126 * c.color.r + 0.7152 * c.color.g + 0.0722 * c.color.b : 1;
};

export async function loadQuestHeadset(url = '/public/models/quest-3s.min.glb'): Promise<Headset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // ---- the headset's meshes, by node name; everything else in the file is dropped
  const parts: Part[] = [];
  const unnamed: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !triangles(mesh)) return;
    let role: NodeRole | undefined;
    for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) {
      if (NOT_HEADSET.test(p.name)) return;
      const m = HEADSET_NODE.exec(p.name);
      if (m && !role) role = ROLE_BY_NUMBER[m[1] ?? ''];
      if (m && !role) role = luminance(mesh.material) > 0.5 ? 'shell' : 'body';
    }
    // a glowing helper (the checker disc glows at 2.31)
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat?.emissive && mat.emissive.getHex() !== 0 && (mat.emissiveIntensity ?? 1) > 1) return;
    if (role) parts.push({ role, geo: bake(mesh) });
    else unnamed.push({ mesh, box: new THREE.Box3().setFromObject(mesh) });
  });
  // meshes without a headset name: keep those touching the headset (or, with no names at all, the
  // biggest mesh and whatever touches it), as white or dark parts by their colour
  if (unnamed.length) {
    unnamed.sort((a, b) => triangles(b.mesh) - triangles(a.mesh));
    const cluster = parts.length ? boundsOf(parts.map((p) => p.geo), new THREE.Matrix4()) : unnamed[0].box.clone();
    const kept = new Set(parts.length ? [] : [unnamed[0]]);
    for (let grew = true; grew; ) {
      grew = false;
      const pad = cluster.getSize(new THREE.Vector3()).multiplyScalar(0.02);
      const reach = cluster.clone().expandByVector(pad);
      for (const u of unnamed) {
        if (kept.has(u) || !reach.intersectsBox(u.box)) continue;
        kept.add(u);
        cluster.union(u.box);
        grew = true;
      }
    }
    for (const u of kept) parts.push({ role: luminance(u.mesh.material) > 0.5 ? 'shell' : 'body', geo: bake(u.mesh) });
  }
  // the file's own geometry and materials are no longer needed
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
  if (!parts.length) throw new Error('quest-3s: no headset in the model');

  const of = (...roles: NodeRole[]) => parts.filter((p) => roles.includes(p.role)).map((p) => p.geo);

  // ---- sort every piece into its final kind
  const pieces: { kind: Kind; geo: THREE.BufferGeometry }[] = [];
  const temp: THREE.BufferGeometry[] = [];
  const put = (kind: Kind, geo: THREE.BufferGeometry) => pieces.push({ kind, geo });

  // the shell: its biggest piece wraps the visor; pieces reaching back along the arms are the hinges
  const shellMain: THREE.BufferGeometry[] = [];
  for (const g of of('shell')) {
    const split = connectedPieces(g);
    const main = measure(g, split[0]).box;
    const depth = main.max.z - main.min.z;
    const hinge: number[] = [], rest: number[] = [];
    for (const tris of split) {
      const b = tris === split[0] ? main : measure(g, tris).box;
      (b.min.z < main.min.z - 0.25 * depth ? hinge : rest).push(...tris);
    }
    const r = subset(g, rest);
    shellMain.push(r);
    put('white', r);
    if (hinge.length) put('hinge', subset(g, hinge));
    // the sockets the hinges plug into: wide holes on the sides (not the front and back edges, nor the
    // ports and buttons), closed in white so the side reads as solid once the strap has faded
    const w = main.max.x - main.min.x;
    const inside = main.getCenter(new THREE.Vector3());
    const rp = r.getAttribute('position');
    const v = new THREE.Vector3();
    for (const loop of boundaryLoops(r)) {
      const box = new THREE.Box3();
      for (const i of loop) box.expandByPoint(v.fromBufferAttribute(rp, i));
      const e = box.getSize(new THREE.Vector3()).toArray().sort((a, b) => a - b);
      const side = Math.abs(box.getCenter(v).x - inside.x) > 0.35 * w;
      if (side && e[1] > 0.08 * w && e[2] < 0.25 * w) put('white', capLoop(r, loop, inside));
    }
    temp.push(g);
  }
  for (const g of of('front')) put('white', g);
  for (const g of of('seam')) put('seam', g);
  for (const g of of('strap', 'topStrap')) put('strap', g);
  for (const g of of('trim')) put('trim', g);
  for (const g of of('fit')) put('fit', g);

  // the lenses: one piece each, smoothed (the camera flies right up to one), with planar UVs for the
  // Fresnel rings
  const lensPieces: { geo: THREE.BufferGeometry; box: THREE.Box3; centroid: THREE.Vector3 }[] = [];
  for (const g of of('lens')) {
    for (const tris of connectedPieces(g)) {
      const geo = smoothSubdivide(subset(g, tris), SMOOTH_LEVELS);
      const { box, centroid } = measure(g, tris);
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2 || 1;
      const pos = geo.getAttribute('position');
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = 0.5 + (pos.getX(i) - c.x) / (2 * r);
        uv[i * 2 + 1] = 0.5 + (pos.getY(i) - c.y) / (2 * r);
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      lensPieces.push({ geo, box, centroid });
      put('lens', geo);
    }
    temp.push(g);
  }

  // the dark parts: the two big pieces are the facial interface (the one reaching furthest back) and
  // the lens housings; small pieces on the front are sensors, pieces nearer the strap than the visor
  // are strap trim, and the rest are ports, buttons and vents
  const frontGeos = of('front');
  const frontBox = frontGeos.length ? boundsOf(frontGeos, new THREE.Matrix4()) : null;
  const visorBox0 = boundsOf([...shellMain, ...frontGeos], new THREE.Matrix4());
  const visorW0 = visorBox0.isEmpty() ? Infinity : visorBox0.max.x - visorBox0.min.x;
  const strapPts = pointsOf([...of('strap', 'topStrap', 'trim', 'fit'), ...pieces.filter((p) => p.kind === 'hinge').map((p) => p.geo)]);
  const fabric: THREE.BufferGeometry[] = [];
  for (const g of of('body')) {
    const split = connectedPieces(g).map((tris) => ({ tris, ...measure(g, tris) }));
    const total = split.reduce((n, s) => n + s.tris.length, 0);
    const big = split.filter((s) => s.tris.length >= 0.1 * total);
    const face = big.reduce((a, b) => (b.box.min.z < a.box.min.z ? b : a), big[0]);
    const corePts = pointsOf([...shellMain, ...frontGeos, ...of('seam')]);
    const bigPts = big.map((s) => pointsOfTris(g, s.tris));
    const sorted: Record<'fabric' | 'housing' | 'sensor' | 'camRing' | 'button' | 'detail' | 'strapDetail', number[]> = {
      fabric: [], housing: [], sensor: [], camRing: [], button: [], detail: [], strapDetail: [],
    };
    const onFront = (s: (typeof split)[number]) => !!frontBox && s.centroid.z > frontBox.min.z && s.centroid.x > frontBox.min.x && s.centroid.x < frontBox.max.x;
    // the biggest sensor pieces are the satin rings round the upper cameras
    const ringTris = Math.max(0, ...split.filter((s) => !big.includes(s) && onFront(s)).map((s) => s.tris.length));
    for (const s of split) {
      if (s === face) sorted.fabric.push(...s.tris);
      else if (big.includes(s)) sorted.housing.push(...s.tris);
      else if (onFront(s)) (s.tris.length >= 0.9 * ringTris ? sorted.camRing : sorted.sensor).push(...s.tris);
      else {
        const toStrap = strapPts.length ? nearest(strapPts, s.centroid) : Infinity;
        const toCore = Math.min(corePts.length ? nearest(corePts, s.centroid) : Infinity, ...bigPts.map((p) => nearest(p, s.centroid)));
        if (toStrap < toCore) {
          sorted.strapDetail.push(...s.tris);
          continue;
        }
        // flat discs and pills (the power button, the buttons underneath) are white; deeper holes stay dark
        const e = s.box.getSize(new THREE.Vector3()).toArray().sort((a, b) => a - b);
        const flat = e[0] < 0.3 * e[2] && e[2] > 0.025 * visorW0 && e[2] < 0.18 * visorW0;
        (flat ? sorted.button : sorted.detail).push(...s.tris);
      }
    }
    for (const [kind, tris] of Object.entries(sorted) as [Kind, number[]][]) {
      if (!tris.length) continue;
      const geo = subset(g, tris);
      if (kind === 'fabric') fabric.push(geo);
      put(kind, geo);
    }
    temp.push(g);
  }
  for (const g of temp) g.dispose();
  if (!pieces.length) throw new Error('quest-3s: nothing left to show');

  // ---- square it up: the lenses sit level side to side, so their centroids give the model's yaw
  let yaw = 0;
  if (lensPieces.length === 2) {
    const [a, b] = lensPieces.map((l) => l.centroid).sort((p, q) => q.x - p.x);
    const dx = a.x - b.x, dz = a.z - b.z;
    if (Math.abs(dx) > 1e-6 && Math.abs(dz / dx) < 0.2) yaw = Math.atan(dz / dx);
  }
  const rot = new THREE.Matrix4().makeRotationY(yaw);
  const nonStrap = pieces.filter((p) => !STRAP_KINDS.includes(p.kind)).map((p) => p.geo);
  const visorGeos = [...shellMain, ...frontGeos].length ? [...shellMain, ...frontGeos] : nonStrap.length ? nonStrap : pieces.map((p) => p.geo);
  const visor = boundsOf(visorGeos, rot);
  const back = boundsOf(fabric.length ? fabric : nonStrap.length ? nonStrap : visorGeos, rot);
  const width = visor.max.x - visor.min.x;
  const scale = VISOR_W / width;
  const centre = new THREE.Vector3((visor.min.x + visor.max.x) / 2, (visor.min.y + visor.max.y) / 2, (visor.max.z + Math.min(back.min.z, visor.min.z)) / 2);

  // ---- the facial interface and the lens housings fill the screen as the camera flies in: smoothed
  for (const p of pieces) {
    if (p.kind !== 'fabric' && p.kind !== 'housing') continue;
    const smooth = smoothSubdivide(p.geo, SMOOTH_LEVELS);
    p.geo.dispose();
    p.geo = smooth;
  }

  // ---- materials, tuned to the photos under the hero's studio light
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const mat = <T extends THREE.Material>(m: T) => (mats.push(m), m);
  const side = THREE.DoubleSide;
  const lensTex = fresnelTexture();
  const grain = bumpTexture('grain');
  const ribs = bumpTexture('ribs');
  // the file's UVs: about 0.57 m of fabric and 0.28 m of strap per unit; ribs about 3.5 mm apart
  grain.repeat.set(50, 50);
  ribs.repeat.set(10, 10);
  texs.push(lensTex, grain, ribs);
  const looks: Record<Kind, THREE.Material> = {
    white: mat(new THREE.MeshPhysicalMaterial({ color: 0xeeeeec, roughness: 0.48, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.22, side })),
    seam: mat(new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.45, metalness: 0, side })),
    sensor: mat(new THREE.MeshPhysicalMaterial({ color: 0x060607, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, side })),
    camRing: mat(new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.28, metalness: 0.85, side })),
    button: mat(new THREE.MeshPhysicalMaterial({ color: 0xececea, roughness: 0.38, metalness: 0, clearcoat: 0.3, side })),
    fabric: mat(new THREE.MeshStandardMaterial({ color: 0x4a4b4f, roughness: 0.95, metalness: 0, bumpMap: grain, bumpScale: 0.6, side })),
    housing: mat(new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.6, metalness: 0, side })),
    // glass: the rings show, the studio's light panels only as a soft sheen (at full strength they read
    // as a white rectangle, and as a white blob once the lens fills the screen)
    lens: mat(new THREE.MeshPhysicalMaterial({ map: lensTex, roughness: 0.25, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 0.2, specularIntensity: 0.6, side })),
    detail: mat(new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.7, metalness: 0, side })),
    strap: mat(new THREE.MeshStandardMaterial({ color: 0xdcdcd8, roughness: 0.82, metalness: 0, bumpMap: ribs, bumpScale: 1.2, side })),
    trim: mat(new THREE.MeshStandardMaterial({ color: 0xd2d2ce, roughness: 0.7, metalness: 0, side })),
    hinge: mat(new THREE.MeshPhysicalMaterial({ color: 0xececea, roughness: 0.45, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.25, side })),
    fit: mat(new THREE.MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.4, metalness: 0, clearcoat: 0.3, side })),
    strapDetail: mat(new THREE.MeshStandardMaterial({ color: 0x2b2c2f, roughness: 0.7, metalness: 0, side })),
  };
  // three.js ignores a material's envMapIntensity when the reflections come from scene.environment, so
  // the lens takes the scene's environment as its own map the first time it is drawn
  const lensMat = looks.lens as THREE.MeshPhysicalMaterial;
  lensMat.onBeforeRender = (_r, scene) => {
    const env = scene.environment;
    if (env && lensMat.envMap !== env && env instanceof THREE.Texture) {
      lensMat.envMap = env;
      lensMat.needsUpdate = true;
    }
  };

  // ---- the group: clean outside, the model normalised inside
  const group = new THREE.Group();
  group.name = 'quest-3s';
  const model = new THREE.Group();
  model.name = 'quest-3s-model';
  model.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  model.scale.setScalar(scale);
  model.position.copy(centre).multiplyScalar(-scale);
  group.add(model);
  const geos: THREE.BufferGeometry[] = [];
  const strapMeshes: THREE.Mesh[] = [];
  // while the strap fades, a depth-only copy of it is drawn first, so only its nearest surface blends
  // over the visor (not every layer of strap, trim and hinge stacked behind it)
  const strapDepthMat = mat(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  const strapDepth: THREE.Mesh[] = [];
  for (const p of pieces) {
    const mesh = new THREE.Mesh(p.geo, looks[p.kind]);
    mesh.name = p.kind;
    model.add(mesh);
    geos.push(p.geo);
    if (STRAP_KINDS.includes(p.kind)) {
      strapMeshes.push(mesh);
      mesh.renderOrder = 2;
      const depth = new THREE.Mesh(p.geo, strapDepthMat);
      depth.name = 'strapDepth';
      depth.renderOrder = 1;
      depth.visible = false;
      model.add(depth);
      strapDepth.push(depth);
    }
  }
  model.updateMatrix();

  // ---- the lenses in the group's frame: the centre of each, on its face-side surface
  const toGroup = model.matrix;
  let lenses: [THREE.Vector3, THREE.Vector3];
  let lensRadius: number;
  if (lensPieces.length === 2) {
    const found = lensPieces.map((l) => {
      const box = boundsOf([l.geo], toGroup);
      const c = box.getCenter(new THREE.Vector3());
      const r = (box.max.x - box.min.x + (box.max.y - box.min.y)) / 4;
      const pos = l.geo.getAttribute('position');
      const v = new THREE.Vector3();
      let z = Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toGroup);
        if (Math.hypot(v.x - c.x, v.y - c.y) < 0.3 * r) z = Math.min(z, v.z);
      }
      return { c: c.setZ(Number.isFinite(z) ? z : box.min.z), r };
    });
    found.sort((a, b) => b.c.x - a.c.x);
    lenses = [found[0].c, found[1].c];
    lensRadius = (found[0].r + found[1].r) / 2;
  } else {
    // no lens part: where they sit in this model, as fractions of the visor
    const v = boundsOf(visorGeos, toGroup);
    const w = v.max.x - v.min.x;
    const y = (v.min.y + v.max.y) / 2 - 0.027 * w;
    const z = v.max.z - 0.38 * w;
    lenses = [new THREE.Vector3(0.2 * w, y, z), new THREE.Vector3(-0.2 * w, y, z)];
    lensRadius = 0.14 * w;
  }

  const strapMats = [...new Set(strapMeshes.map((m) => m.material as THREE.Material))];
  const headset = {
    group,
    lenses,
    lensRadius,
    setStrap(opacity: number) {
      const o = THREE.MathUtils.clamp(opacity, 0, 1);
      const see = o < 0.99;
      for (const m of strapMats) {
        if (m.transparent !== see) {
          m.transparent = see;
          m.needsUpdate = true;
        }
        m.opacity = see ? o : 1;
        m.depthWrite = !see;
      }
      for (const mesh of strapMeshes) mesh.visible = o > 0.01;
      for (const mesh of strapDepth) mesh.visible = see && o > 0.01;
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
    },
  };
  return headset;
}

function triangles(mesh: THREE.Mesh): number {
  const g = mesh.geometry;
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

/** A mesh's geometry in the file's scene frame (indexed). */
function bake(mesh: THREE.Mesh): THREE.BufferGeometry {
  const g = mesh.geometry.clone();
  if (!g.getIndex()) g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, i) => i));
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  g.applyMatrix4(mesh.matrixWorld);
  if (mesh.matrixWorld.determinant() < 0) {
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}
