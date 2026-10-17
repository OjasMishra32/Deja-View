// The landing page's headset when the Quest 3S model file (quest-model.ts) cannot load: a Meta Quest 3S
// built in code, matched to photos of the real one.
//
// A white visor whose front is a wide superellipse, gently domed and wrapped round the face, with a
// thin dark seam behind its rounded front edge. Two clusters of three round black sensors sit low on
// the front, one on each side, a single sensor on the outside and two stacked on the inside. Behind
// the visor: the dark fabric facial interface with its nose cut-out and two lenses; light grey ribbed
// side arms running back from near the front; the rear loop and the top strap. The power button, a
// status light and the USB-C port are on the wearer's left, the headphone jack on the right, and the
// action button, the volume rocker and the vents underneath.
//
// Units are centimetres / 10 (the visor is 1.915 wide, 0.98 tall, as the real one's 191.5 mm); the
// front faces +Z, the wearer looks down +Z, so the wearer's left is +X.

import * as THREE from 'three';

export interface Headset {
  group: THREE.Group;
  /** Lens centres in the group's frame (wearer's left, wearer's right), on the face side, at the lens surface. */
  lenses: [THREE.Vector3, THREE.Vector3];
  lensRadius: number;
  /** Fades the strap and side arms (0..1): they would hide the lenses once the face side turns to you. */
  setStrap(opacity: number): void;
  dispose(): void;
}

// ---- the visor's measurements
/** Half width and half height of the front outline. */
const A = 0.9575;
const B = 0.49;
/** Superellipse exponent of the outline: flat top and bottom, full round sides. */
const N = 3.4;
/** Front and back of the white shell (before the wrap). */
const ZF = 0.31;
const ZB = -0.2;
/** The rounded front edge: how far in it starts (sides and top, bottom) and how deep it runs. */
const R_SIDE = 0.2;
const R_BOTTOM = 0.15;
const R_DEPTH = 0.2;
/**
 * The seam behind the rounded front edge: how far inside the body's outline the front cover stops,
 * how deep the groove runs in under it, and how wide the dark line it makes looks from the front.
 */
const SEAM_IN = 0.02;
const SEAM_DEEP = 0.014;
const SEAM_W = 0.01;
/** How far the front recedes at the sides and at the top and bottom (the visor wraps round the face). */
const WRAP_X = 0.16;
const WRAP_Y = 0.05;
const wrap = (x: number, y: number) => WRAP_X * (x / A) ** 2 + WRAP_Y * (y / B) ** 2;

type Pt = { x: number; y: number };

/** A point of the superellipse |x/a|^n + |y/b|^n = 1 at angle parameter t; `b2` is the lower half's height. */
function se(a: number, b: number, n: number, t: number, b2 = b): Pt {
  const c = Math.cos(t), s = Math.sin(t);
  return { x: a * Math.sign(c) * Math.abs(c) ** (2 / n), y: (s < 0 ? b2 : b) * Math.sign(s) * Math.abs(s) ** (2 / n) };
}

/** `count` parameters spread evenly by arc length round the superellipse (dense samples, then resampled). */
function evenParams(a: number, b: number, n: number, count: number): number[] {
  const dense = 2048;
  const lens = [0];
  let prev = se(a, b, n, 0);
  for (let i = 1; i <= dense; i++) {
    const p = se(a, b, n, (i / dense) * Math.PI * 2);
    lens.push(lens[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const total = lens[dense];
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const want = (k / count) * total;
    while (lens[j + 1] < want) j++;
    const f = (want - lens[j]) / (lens[j + 1] - lens[j] || 1);
    out.push(((j + f) / dense) * Math.PI * 2);
  }
  return out;
}

interface Row {
  /** The point of this row at outline parameter index u. */
  at(u: number): THREE.Vector3;
  color: THREE.Color;
}

/** A closed surface swept round an outline: rows of points, each row a loop, stitched in order. */
function sweep(rows: Row[], count: number, deform?: (v: THREE.Vector3, row: number) => void): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  rows.forEach((row, r) => {
    for (let u = 0; u < count; u++) {
      const v = row.at(u);
      deform?.(v, r);
      pos.push(v.x, v.y, v.z);
      col.push(row.color.r, row.color.g, row.color.b);
    }
  });
  for (let r = 0; r < rows.length - 1; r++) {
    for (let u = 0; u < count; u++) {
      const a = r * count + u, b = (r + 1) * count + u, c = (r + 1) * count + ((u + 1) % count), d = r * count + ((u + 1) % count);
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A flat band along a path (a strap): a stadium cross-section `width` by `thick`, its width along
 * `ups` (one per path point). UVs are in model units, along and across, for the ribbed texture.
 */
function ribbon(path: THREE.Vector3[], ups: THREE.Vector3[], width: number, thick: number, segs = 64, sides = 20): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const len = curve.getLength();
  const T = new THREE.Vector3(), W = new THREE.Vector3(), Nn = new THREE.Vector3(), P = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    curve.getPointAt(s, P);
    curve.getTangentAt(s, T);
    // the band's width direction: the given ups, blended along the path, made square to it
    const f = s * (ups.length - 1), k = Math.min(ups.length - 2, Math.floor(f));
    W.copy(ups[k]).lerp(ups[k + 1], f - k);
    W.addScaledVector(T, -W.dot(T)).normalize();
    Nn.crossVectors(T, W);
    for (let j = 0; j < sides; j++) {
      const phi = (j / sides) * Math.PI * 2, c = Math.cos(phi), sn = Math.sin(phi);
      const cx = (width / 2) * Math.sign(c) * Math.abs(c) ** (1 / 3), cy = (thick / 2) * Math.sign(sn) * Math.abs(sn) ** (1 / 3);
      pos.push(P.x + W.x * cx + Nn.x * cy, P.y + W.y * cx + Nn.y * cy, P.z + W.z * cx + Nn.z * cy);
      uv.push(s * len, cx);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j, b = (i + 1) * sides + j, c = (i + 1) * sides + ((j + 1) % sides), d = i * sides + ((j + 1) % sides);
      idx.push(a, d, c, a, c, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A canvas texture for bump maps: the straps' diagonal ribs, or the fabric's fine grain. */
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

/** A Fresnel lens: faint concentric rings over dark glass. */
function fresnelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const bg = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  bg.addColorStop(0, '#2a2e36');
  bg.addColorStop(1, '#14161b');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 256);
  for (let r = 8; r < 128; r += 5) {
    g.strokeStyle = `rgba(210,220,235,${0.05 + 0.12 * (r / 128)})`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(128, 128, r, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildHeadset(): Headset {
  const group = new THREE.Group();
  group.name = 'quest-3s';
  // the meshes sit in `model`; the group turns about a point a little behind the visor
  const model = new THREE.Group();
  model.position.z = 0.35;
  group.add(model);
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g);
  const mat = <T extends THREE.Material>(m: T) => (mats.push(m), m);
  const tex = <T extends THREE.Texture>(t: T) => (texs.push(t), t);
  const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], at?: THREE.Vector3, q?: THREE.Quaternion) => {
    const mesh = new THREE.Mesh(keep(g), m);
    if (at) mesh.position.copy(at);
    if (q) mesh.quaternion.copy(q);
    model.add(mesh);
    return mesh;
  };

  // ---- materials: white plastic with a light clear coat, glossy black sensors, dark fabric, light grey straps
  const shellMat = mat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.22 }));
  // the seam is a shadowed gap, so matte and without the shell's clear coat (which would catch the
  // light at a glancing angle and turn it into a pale hairline)
  const seamMat = mat(new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.9, metalness: 0 }));
  const sensorMat = mat(new THREE.MeshPhysicalMaterial({ color: 0x060607, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }));
  const camRingMat = mat(new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.28, metalness: 0.85 }));
  const camGlassMat = mat(new THREE.MeshPhysicalMaterial({ color: 0x141a24, roughness: 0.03, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.02 }));
  const holeMat = mat(new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.7, metalness: 0 }));
  const grain = tex(bumpTexture('grain'));
  grain.repeat.set(9, 9);
  const fabricMat = mat(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.96, metalness: 0, bumpMap: grain, bumpScale: 0.6 }));
  const ribs = tex(bumpTexture('ribs'));
  ribs.repeat.set(3.6, 3.6);
  const strapMat = mat(new THREE.MeshStandardMaterial({ color: 0xdcdcd8, roughness: 0.82, metalness: 0, bumpMap: ribs, bumpScale: 1.2, transparent: true }));
  const clipMat = mat(new THREE.MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.4, clearcoat: 0.3, transparent: true }));
  const buttonMat = mat(new THREE.MeshPhysicalMaterial({ color: 0xececea, roughness: 0.38, clearcoat: 0.3 }));
  const housingMat = mat(new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide }));
  // the lenses only faintly mirror the room: up close they fill the screen, and a sharp reflection of
  // the room's lights would show round the film as it opens
  const fresnelMat = mat(new THREE.MeshPhysicalMaterial({ map: tex(fresnelTexture()), roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15, envMapIntensity: 0.25 }));

  const white = new THREE.Color(0xeeeeec);
  const seam = new THREE.Color(0x1d1d1f);
  const backGrey = new THREE.Color(0x8e8e93);
  const fabric = new THREE.Color(0x3a3b3e);
  const plate = new THREE.Color(0x2b2c2f);

  // ---- the white visor
  const U = 192;
  const ts = evenParams(A, B, N, U);
  const outline = (inset: number, insetBottom = inset) => ts.map((t) => se(A - inset, B - inset, N, t, B - insetBottom));
  const O = outline(0);
  const E = outline(R_SIDE, R_BOTTOM);
  const G = outline(0.006);
  // the front cover stops a little inside the body's outline, so the seam shows from the front too
  const C = outline(SEAM_IN);
  const K = outline(SEAM_IN + SEAM_DEEP);
  const S = outline(SEAM_IN - SEAM_W);
  const rows: Row[] = [];
  // the front face, centre outwards (rings closer together towards the edge)
  for (let i = 0; i <= 10; i++) {
    const k = Math.sin((i / 10) * (Math.PI / 2));
    rows.push({ at: (u) => new THREE.Vector3(E[u].x * k, E[u].y * k, ZF), color: white });
  }
  // the rounded front edge, out to the front cover's outline
  for (let j = 1; j <= 12; j++) {
    const th = (j / 12) * (Math.PI / 2), s = Math.sin(th), z = ZF - R_DEPTH * (1 - Math.cos(th));
    rows.push({ at: (u) => new THREE.Vector3(E[u].x + (C[u].x - E[u].x) * s, E[u].y + (C[u].y - E[u].y) * s, z), color: white });
  }
  // the seam: a groove tucked under the cover's edge, then the body's shoulder rising out of it (dark
  // where it shows as a line, in front and from the side), then a white chamfer out to the body
  const z0 = ZF - R_DEPTH;
  const seamFrom = rows.length - 1;
  rows.push({ at: (u) => new THREE.Vector3(C[u].x, C[u].y, z0 - 0.002), color: seam });
  rows.push({ at: (u) => new THREE.Vector3(K[u].x, K[u].y, z0 - 0.005), color: seam });
  rows.push({ at: (u) => new THREE.Vector3(K[u].x, K[u].y, z0 - 0.012), color: seam });
  rows.push({ at: (u) => new THREE.Vector3(S[u].x, S[u].y, z0 - 0.015), color: seam });
  const seamTo = rows.length - 1;
  rows.push({ at: (u) => new THREE.Vector3(O[u].x, O[u].y, z0 - 0.024), color: white });
  // the sides, top and bottom, back to the facial interface, and a closed back
  rows.push({ at: (u) => new THREE.Vector3(O[u].x, O[u].y, ZB + 0.02), color: white });
  rows.push({ at: (u) => new THREE.Vector3(G[u].x, G[u].y, ZB), color: white });
  for (const k of [0.97, 0.7, 0.35, 0]) rows.push({ at: (u) => new THREE.Vector3(O[u].x * k, O[u].y * k, ZB), color: backGrey });
  const shellGeo = sweep(rows, U, (v) => (v.z -= wrap(v.x, v.y)));
  // each band between two rows is U quads (6 indices each): the seam's bands take the seam material
  const band = U * 6;
  shellGeo.addGroup(0, seamFrom * band, 0);
  shellGeo.addGroup(seamFrom * band, (seamTo - seamFrom) * band, 1);
  shellGeo.addGroup(seamTo * band, shellGeo.getIndex()!.count - seamTo * band, 0);
  const shell = add(shellGeo, [shellMat, seamMat]);

  // things on the shell's surface: found by casting a ray at it, then turned to its normal
  const caster = new THREE.Raycaster();
  const onShell = (origin: THREE.Vector3, dir: THREE.Vector3) => {
    caster.set(origin, dir.clone().normalize());
    const hit = caster.intersectObject(shell, false)[0];
    if (!hit) return null;
    const n = hit.face!.normal.clone();
    return { point: hit.point.clone().sub(model.position), normal: n, q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n) };
  };
  model.updateMatrixWorld(true);
  const fromFront = (x: number, y: number) => onShell(new THREE.Vector3(x, y, 5).add(model.position), new THREE.Vector3(0, 0, -1));

  // ---- the sensors: two clusters low on the front, a glossy dome outside and two cameras stacked inside
  const dome = (r: number) => {
    const g = new THREE.LatheGeometry(
      [[1, -0.15], [1, 0], [0.97, 0.07], [0.88, 0.13], [0.7, 0.16], [0.4, 0.172], [0, 0.175]].map(([x, y]) => new THREE.Vector2(x * r, y * r)),
      48,
    );
    g.rotateX(Math.PI / 2);
    return g;
  };
  const SENSOR_R = 0.066;
  for (const side of [-1, 1]) {
    // positions from the front photo, mirrored for the two sides
    const spots: [number, number, 'dome' | 'camera' | 'tracker'][] = [
      [side * 0.524, -0.232, 'dome'],
      [side * 0.386, -0.168, 'camera'],
      [side * 0.386, -0.312, 'tracker'],
    ];
    for (const [x, y, kind] of spots) {
      const s = fromFront(x, y);
      if (!s) continue;
      add(dome(SENSOR_R), sensorMat, s.point, s.q);
      const top = s.point.clone().addScaledVector(s.normal, SENSOR_R * 0.18);
      if (kind === 'camera') {
        add(new THREE.RingGeometry(0.03, 0.045, 48), camRingMat, top, s.q);
        add(new THREE.CircleGeometry(0.03, 48), camGlassMat, top.clone().addScaledVector(s.normal, 0.0015), s.q);
      } else if (kind === 'tracker') {
        add(new THREE.RingGeometry(0.011, 0.019, 32), camRingMat, top, s.q);
        add(new THREE.CircleGeometry(0.011, 32), camGlassMat, top.clone().addScaledVector(s.normal, 0.0015), s.q);
      }
    }
  }
  // a small light sensor above the left cluster, as seen from the front
  const dot = fromFront(-0.508, -0.118);
  if (dot) add(new THREE.CircleGeometry(0.011, 24), holeMat, dot.point.addScaledVector(dot.normal, 0.002), dot.q);

  // ---- ports and buttons: power, status light and USB-C on the wearer's left, the headphone jack on the right
  const fromSide = (side: number, z: number, y: number) => onShell(new THREE.Vector3(side * 5, y, z).add(model.position), new THREE.Vector3(-side, 0, 0));
  const power = fromSide(1, ZF - 0.2, -0.06);
  if (power) {
    const btn = new THREE.CylinderGeometry(0.036, 0.04, 0.02, 32);
    btn.rotateX(Math.PI / 2);
    add(btn, buttonMat, power.point.addScaledVector(power.normal, 0.004), power.q);
  }
  const led = fromSide(1, ZF - 0.19, 0.07);
  if (led) add(new THREE.CircleGeometry(0.008, 16), holeMat, led.point.addScaledVector(led.normal, 0.002), led.q);
  const usb = fromSide(1, ZF - 0.3, -0.3);
  if (usb) {
    const port = new THREE.Shape();
    port.absarc(-0.03, 0, 0.012, Math.PI / 2, (Math.PI * 3) / 2, false);
    port.absarc(0.03, 0, 0.012, -Math.PI / 2, Math.PI / 2, false);
    const g = new THREE.ShapeGeometry(port, 12);
    // the port's long side runs along the headset
    add(g, holeMat, usb.point.addScaledVector(usb.normal, 0.002), usb.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)));
  }
  const jack = fromSide(-1, ZF - 0.34, -0.31);
  if (jack) add(new THREE.CircleGeometry(0.022, 24), holeMat, jack.point.addScaledVector(jack.normal, 0.002), jack.q);

  // ---- underneath: the action button (left), the volume rocker (right) and a row of vents
  const fromBelow = (x: number, z: number) => onShell(new THREE.Vector3(x, -5, z).add(model.position), new THREE.Vector3(0, 1, 0));
  const pill = (len: number) => {
    const s = new THREE.Shape();
    s.absarc(-len / 2, 0, 0.024, Math.PI / 2, (Math.PI * 3) / 2, false);
    s.absarc(len / 2, 0, 0.024, -Math.PI / 2, Math.PI / 2, false);
    return new THREE.ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3, curveSegments: 16 });
  };
  const action = fromBelow(0.5, -0.02);
  if (action) add(pill(0.07), buttonMat, action.point, action.q);
  const volume = fromBelow(-0.5, -0.02);
  if (volume) add(pill(0.16), buttonMat, volume.point, volume.q);
  for (let i = -6; i <= 6; i++) {
    const v = fromBelow(i * 0.045, -0.16);
    if (!v) continue;
    const slot = new THREE.PlaneGeometry(0.014, 0.12);
    add(slot, holeMat, v.point.addScaledVector(v.normal, 0.002), v.q);
  }

  // ---- the facial interface: dark fabric, a little taller than the visor, hollow round the eyes
  const L = 0.86;
  const zAttach = ZB + 0.04;
  const zBack = ZB - L;
  const zPlate = ZB - 0.2;
  const a2 = A - 0.035, b2 = B + 0.01, rb = 0.07;
  const ts2 = evenParams(a2, b2, 3.2, U);
  const ring = (da: number, db: number) => ts2.map((t) => se(a2 - da, b2 - db, 3.2, t));
  const O2 = ring(0, 0), Bk = ring(rb, rb), I2 = ring(0.17, 0.15), P2 = ring(0.17 + 0.03, 0.15 + 0.03);
  const frows: Row[] = [];
  frows.push({ at: (u) => new THREE.Vector3(O2[u].x, O2[u].y, zAttach), color: fabric });
  frows.push({ at: (u) => new THREE.Vector3(O2[u].x, O2[u].y, zBack + rb), color: fabric });
  for (let j = 1; j <= 6; j++) {
    const th = (j / 6) * (Math.PI / 2), c = Math.cos(th);
    frows.push({ at: (u) => new THREE.Vector3(Bk[u].x + (O2[u].x - Bk[u].x) * c, Bk[u].y + (O2[u].y - Bk[u].y) * c, zBack + rb - rb * Math.sin(th)), color: fabric });
  }
  for (const k of [0.33, 0.66]) frows.push({ at: (u) => new THREE.Vector3(Bk[u].x + (I2[u].x - Bk[u].x) * k, Bk[u].y + (I2[u].y - Bk[u].y) * k, zBack), color: fabric });
  frows.push({ at: (u) => new THREE.Vector3(I2[u].x, I2[u].y, zBack + 0.03), color: fabric });
  frows.push({ at: (u) => new THREE.Vector3(I2[u].x, I2[u].y, zPlate - 0.03), color: fabric });
  frows.push({ at: (u) => new THREE.Vector3(P2[u].x, P2[u].y, zPlate), color: plate });
  for (const k of [0.6, 0.25, 0]) frows.push({ at: (u) => new THREE.Vector3(P2[u].x * k, P2[u].y * k, zPlate), color: plate });
  const plateRow = frows.length - 4;
  const iface = sweep(frows, U, (v, r) => {
    if (r >= plateRow) return;
    // how far back this point is: the attached edge stays put, the face side curves and opens for the nose
    const f = THREE.MathUtils.clamp((zAttach - v.z - 0.15) / (L - 0.15), 0, 1);
    v.z += f * 0.14 * (1 - (v.x / a2) ** 2);
    const nose = Math.exp(-((v.x / 0.17) ** 2)) * THREE.MathUtils.clamp((-v.y - 0.08) / (b2 - 0.08), 0, 1) ** 0.8;
    // the nose cut-out stops well short of the lens plate
    v.z = Math.min(v.z + f * 0.24 * nose, zPlate - 0.015);
    v.y *= 1 + 0.06 * f;
    v.y += 0.03 * f;
  });
  add(iface, fabricMat);

  // the lenses: dark Fresnel glass in black housings, on the plate inside
  const housing = new THREE.LatheGeometry(
    [[0.215, 0], [0.215, 0.045], [0.2, 0.05], [0.19, 0.04]].map(([x, y]) => new THREE.Vector2(x, y)),
    64,
  );
  housing.rotateX(-Math.PI / 2);
  const lensQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  /** The glass: round, filling the housing's inner lip. */
  const LENS_R = 0.19;
  // wearer's left (+X) first; in the group's frame (the model sits at model.position)
  const lenses: [THREE.Vector3, THREE.Vector3] = [1, -1].map((side) => new THREE.Vector3(side * 0.34, 0.01, zPlate - 0.035).add(model.position)) as [THREE.Vector3, THREE.Vector3];
  // a material's own envMapIntensity only counts when it has its own envMap (otherwise the scene's
  // environmentIntensity is used), so the lenses take the scene's environment as theirs when drawn
  const ownEnv = (_r: THREE.WebGLRenderer, scene: THREE.Scene) => {
    if (fresnelMat.envMap === scene.environment) return;
    fresnelMat.envMap = scene.environment;
    fresnelMat.needsUpdate = true;
  };
  for (const side of [-1, 1]) {
    const at = new THREE.Vector3(side * 0.34, 0.01, zPlate - 0.002);
    add(housing.clone(), housingMat, at);
    add(new THREE.CircleGeometry(LENS_R, 64), fresnelMat, at.clone().setZ(zPlate - 0.035), lensQ).onBeforeRender = ownEnv;
  }
  housing.dispose();

  // ---- the side arms: light grey ribbed bands from near the front of the visor, back to the strap
  const armShape = new THREE.Shape();
  const armLen = 2.05, hf = 0.42, hb = 0.34, rBack = 0.08;
  armShape.moveTo(hf / 2, -hf / 2);
  armShape.lineTo(armLen - rBack, -hb / 2);
  armShape.quadraticCurveTo(armLen, -hb / 2, armLen, -hb / 2 + rBack);
  armShape.lineTo(armLen, hb / 2 - rBack);
  armShape.quadraticCurveTo(armLen, hb / 2, armLen - rBack, hb / 2);
  armShape.lineTo(hf / 2, hf / 2);
  armShape.absarc(hf / 2, 0, hf / 2, Math.PI / 2, (Math.PI * 3) / 2, false);
  const armThick = 0.07;
  const armGeo = keep(new THREE.ExtrudeGeometry(armShape, { depth: armThick, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.018, bevelSegments: 4, curveSegments: 32 }));
  // shape x runs back along -Z, shape y is up, the extrusion is outwards along X
  armGeo.rotateY(Math.PI / 2);
  const clipGeo = keep(pill(0.06));
  const armEnds: THREE.Vector3[] = [];
  const strapParts: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    const m = new THREE.Mesh(armGeo, strapMat);
    // the +X arm extrudes outwards as built; the -X one is mirrored
    if (side < 0) m.scale.x = -1;
    m.position.x = side * 0.018;
    arm.add(m);
    // the strap clip near the arm's front end
    const clip = new THREE.Mesh(clipGeo, clipMat);
    clip.position.set(side * (armThick + 0.034), 0, -0.17);
    clip.rotation.y = side * (Math.PI / 2);
    clip.scale.set(1, 0.9, 0.5);
    arm.add(clip);
    arm.position.set(side * (A + 0.02), -0.02, ZF - 0.3);
    // splayed a little, and rising slightly towards the back
    arm.rotation.set(-0.04, side * 0.07, 0);
    model.add(arm);
    strapParts.push(arm);
    arm.updateMatrix();
    armEnds.push(new THREE.Vector3(side * (armThick / 2 + 0.018), 0, -(armLen - 0.05)).applyMatrix4(arm.matrix));
  }

  // ---- the rear loop round the back of the head, and the top strap over it
  const [leftEnd, rightEnd] = armEnds;
  const up = new THREE.Vector3(0, 1, 0);
  const loop = [
    leftEnd.clone().add(new THREE.Vector3(0, 0, 0.25)),
    leftEnd,
    new THREE.Vector3(leftEnd.x * 0.97, leftEnd.y - 0.04, leftEnd.z - 0.4),
    new THREE.Vector3(leftEnd.x * 0.68, -0.14, leftEnd.z - 0.82),
    new THREE.Vector3(0, -0.22, leftEnd.z - 1.0),
    new THREE.Vector3(rightEnd.x * 0.68, -0.14, rightEnd.z - 0.82),
    new THREE.Vector3(rightEnd.x * 0.97, rightEnd.y - 0.04, rightEnd.z - 0.4),
    rightEnd,
    rightEnd.clone().add(new THREE.Vector3(0, 0, 0.25)),
  ];
  const tilt = new THREE.Vector3(0, 1, -0.35).normalize();
  strapParts.push(add(ribbon(loop, [up, up, up, tilt, tilt, tilt, up, up, up], 0.34, 0.05, 96), strapMat));
  const back = loop[4];
  const top = [
    new THREE.Vector3(0, B + 0.02, ZB - 0.18),
    new THREE.Vector3(0, B + 0.16, ZB - 0.62),
    new THREE.Vector3(0, B + 0.26, ZB - 1.3),
    new THREE.Vector3(0, B + 0.16, back.z + 0.62),
    new THREE.Vector3(0, back.y + 0.36, back.z + 0.08),
    back.clone().add(new THREE.Vector3(0, 0.1, 0.01)),
  ];
  const across = new THREE.Vector3(1, 0, 0);
  strapParts.push(add(ribbon(top, [across, across, across, across, across, across], 0.3, 0.045, 72), strapMat));

  return {
    group,
    lenses,
    // the opening the film fills: the glass and the housing's lip round it, which stands proud of the
    // glass (so it looks a little larger, in the glass's plane, from close up). The circle drawn over
    // it, a little inside this, then still covers all of the glass, even seen slightly off its axis.
    lensRadius: LENS_R * 1.08,
    setStrap(opacity: number) {
      for (const m of [strapMat, clipMat]) {
        m.opacity = opacity;
        m.depthWrite = opacity > 0.99;
      }
      for (const o of strapParts) o.visible = opacity > 0.01;
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
    },
  };
}

/** A soft round shadow to sit under the headset. */
export function contactShadow(size = 3.2): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.26)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.09)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}
