// Shot 35: Roblox from our splats. Real data: the Game Lawn's splats, the voxel grid our voxelizer uses (1.4 studs),
// and the 5,817 merged parts it wrote to roblox-map.json (3.57 studs per metre, same axes as the splats).
//   0.0–1.8  the splats as points
//   1.8–3.6  every point snaps to its voxel; the voxels appear
//   3.6–5.8  a sweep merges the voxels into the real parts
//   5.8–8.0  the camera drops into the block world
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { ease, el, fmt, json, lerp, orbit, reveal, seg, stage, type Shot } from '../lib';

const DUR = 8;
let S: ReturnType<typeof stage>;
let pts: THREE.Points;
let from: Float32Array;
let to: Float32Array;
let vox: THREE.InstancedMesh;
let parts: THREE.InstancedMesh;
let voxX: Float32Array;
let partX: Float32Array;
let nVox = 0;
let nParts = 0;
let total = 0;
let spm = 3.57;
let xMin = 0, xMax = 0;
const centre = new THREE.Vector3();
const ui: Record<string, HTMLElement> = {};
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const s3 = new THREE.Vector3();

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    const map = await json('/data/scenes/the-courts/roblox-map.json');
    spm = map.studsPerMeter;
    const vsz = map.voxel / spm; // metres

    // Splats (read only, not drawn by Spark)
    const mesh = new SplatMesh({ url: '/data/scenes/the-courts/world-filled.spz' });
    await mesh.initialized;
    total = mesh.packedSplats.numSplats;
    const P: number[] = [], C: number[] = [];
    let i = 0;
    mesh.forEachSplat((_i, c, _s, _q, o, k) => {
      if (o < 0.15 || (i++ % 2) !== 0) return;
      P.push(c.x, c.y, c.z);
      C.push(k.r, k.g, k.b);
    });
    const n = P.length / 3;
    from = new Float32Array(P);
    to = new Float32Array(n * 3);
    const cells = new Map<string, { x: number; y: number; z: number; r: number; g: number; b: number; n: number }>();
    for (let k = 0; k < n; k++) {
      const gx = Math.floor(from[k * 3] / vsz), gy = Math.floor(from[k * 3 + 1] / vsz), gz = Math.floor(from[k * 3 + 2] / vsz);
      to[k * 3] = (gx + 0.5) * vsz; to[k * 3 + 1] = (gy + 0.5) * vsz; to[k * 3 + 2] = (gz + 0.5) * vsz;
      const key = `${gx},${gy},${gz}`;
      const c = cells.get(key) ?? { x: to[k * 3], y: to[k * 3 + 1], z: to[k * 3 + 2], r: 0, g: 0, b: 0, n: 0 };
      c.r += C[k * 3]; c.g += C[k * 3 + 1]; c.b += C[k * 3 + 2]; c.n++;
      cells.set(key, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(from.slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
    pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.075, vertexColors: true, transparent: true, sizeAttenuation: true }));
    S.scene.add(pts);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    const kept = [...cells.values()].filter((c) => c.n >= 2);
    nVox = kept.length;
    vox = new THREE.InstancedMesh(box, mat, nVox);
    voxX = new Float32Array(nVox);
    const col = new THREE.Color();
    kept.forEach((c, k) => {
      m4.compose(v.set(c.x, c.y, c.z), q, s3.setScalar(vsz * 0.94));
      vox.setMatrixAt(k, m4);
      vox.setColorAt(k, col.setRGB(c.r / c.n, c.g / c.n, c.b / c.n));
      voxX[k] = c.x;
    });
    S.scene.add(vox);

    nParts = map.parts.length;
    parts = new THREE.InstancedMesh(box, mat.clone(), nParts);
    partX = new Float32Array(nParts);
    map.parts.forEach((p: number[], k: number) => {
      m4.compose(v.set(p[0] / spm, p[1] / spm, p[2] / spm), q, s3.set(p[3] / spm, p[4] / spm, p[5] / spm));
      parts.setMatrixAt(k, m4);
      parts.setColorAt(k, col.setRGB(p[6] / 255, p[7] / 255, p[8] / 255, THREE.SRGBColorSpace));
      partX[k] = p[0] / spm;
    });
    S.scene.add(parts);
    xMin = Math.min(...voxX);
    xMax = Math.max(...voxX);

    const b = map.bounds;
    centre.set((b.min[0] + b.max[0]) / 2 / spm, 1.2, (b.min[2] + b.max[2]) / 2 / spm);
    S.scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-8, 14, 6);
    S.scene.add(sun);

    ui.label = el('label', 120, 104, 'Roblox from our splats');
    ui.sub = el('note', 120, 144, "Roblox can't draw splats, so we turn them into blocks");
    ui.n = el('big', 120, 800, '');
    ui.u = el('unit', 124, 916, '');
    ui.note = el('note', 120, 966, '');
    ui.spm = el('chip', 1390, 104, `${spm} studs per metre · life-size`);
  },

  frame(t) {
    const snap = ease.inOut(seg(t, 1.8, 3.0));
    const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let k = 0; k < arr.length; k++) arr[k] = lerp(from[k], to[k], snap);
    pos.needsUpdate = true;
    const showVox = seg(t, 2.8, 3.6);
    (pts.material as THREE.PointsMaterial).opacity = 1 - showVox;
    pts.visible = showVox < 1;

    // Sweep: voxels behind the sweep plane become parts
    const sweep = lerp(xMin - 1, xMax + 1, ease.inOut(seg(t, 3.7, 5.6)));
    vox.visible = showVox > 0;
    let shown = 0;
    for (let k = 0; k < nVox; k++) {
      vox.getMatrixAt(k, m4);
      m4.decompose(v, q, s3);
      const on = voxX[k] > sweep ? showVox : 0;
      s3.setScalar((map_vsz() * 0.94) * on + 1e-6);
      m4.compose(v, q, s3);
      vox.setMatrixAt(k, m4);
    }
    vox.instanceMatrix.needsUpdate = true;
    for (let k = 0; k < nParts; k++) if (partX[k] <= sweep) shown++;
    parts.visible = t > 3.7;
    parts.count = nParts;
    (parts.material as THREE.MeshStandardMaterial).transparent = false;
    // reveal parts behind the sweep by hiding the rest
    for (let k = 0; k < nParts; k++) {
      parts.getMatrixAt(k, m4);
      m4.decompose(v, q, s3);
      if (!partScale[k]) partScale[k] = s3.clone();
      s3.copy(partScale[k]).multiplyScalar(partX[k] <= sweep ? 1 : 1e-6);
      m4.compose(v, q, s3);
      parts.setMatrixAt(k, m4);
    }
    parts.instanceMatrix.needsUpdate = true;

    // Camera: wide orbit, then down into the block world
    const drop = ease.inOut(seg(t, 5.8, 8));
    orbit(S.camera, centre, 30, lerp(-30, 25, ease.sine(seg(t, 0, 5.8))), 38);
    if (drop > 0) {
      const endPos = new THREE.Vector3(0.2, 1.7, 2.6).lerp(new THREE.Vector3(0.3, 1.65, 1.4), drop);
      S.camera.position.lerp(endPos, drop);
      S.camera.lookAt(centre.clone().lerp(new THREE.Vector3(1.0, 0.9, -6.4), drop));
    }

    // Type
    reveal(ui.label, t, 0.1, 0.6);
    reveal(ui.sub, t, 0.25, 0.8);
    reveal(ui.spm, t, 0.6, 1.1);
    reveal(ui.n, t, 0.3, 0.8);
    reveal(ui.u, t, 0.4, 0.9);
    reveal(ui.note, t, 2.0, 2.5);
    if (t < 3.6) {
      ui.n.textContent = t < 1.8 ? fmt(total) : '1.4 studs';
      ui.u.textContent = t < 1.8 ? 'splats' : 'one voxel, about 39 cm';
      ui.note.textContent = 'every splat snaps to its voxel, coloured by the splats inside it';
    } else {
      ui.n.textContent = fmt(nParts * ease.out(seg(t, 3.7, 5.6)));
      ui.u.textContent = 'Roblox parts, merged from the voxels';
      ui.note.textContent = 'neighbouring voxels of the same colour merge into one box: along x, then z, then y';
    }

    S.renderer.render(S.scene, S.camera);
  },
};

const partScale: THREE.Vector3[] = [];
let vszCache = 0;
function map_vsz() {
  if (!vszCache) {
    vox.getMatrixAt(0, m4);
    m4.decompose(v, q, s3);
    vszCache = s3.x / 0.94;
  }
  return vszCache;
}

export default shot;
