// Shot 32a: structure from motion on the Game Lawn, from the real solve.
// 163 photos and clip frames fly to the exact spots they were taken from, faint sight-lines link cameras to points
// they see, and the 57,048 triangulated points appear in their real colours, strongest tracks first.
import * as THREE from 'three';
import { ease, json, lerp, loadTexture, orbit, pointsMaterial, rng, seg, stage, story, type Shot, BLUE, INK, GREY_3 } from '../lib';

const DUR = 7.5;
const FRAME_COLOUR: Record<string, string> = { photo: INK, walk: GREY_3, play: GREY_3 };

let S: ReturnType<typeof stage>;
let pointsMat: THREE.ShaderMaterial;
const cams: { group: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; delay: number; mats: THREE.Material[] }[] = [];
let threads: THREE.LineSegments;
const threadData: { a: THREE.Vector3; b: THREE.Vector3; delay: number }[] = [];
const target = new THREE.Vector3();
let words: ReturnType<typeof story>;

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    // keep the picture in the upper part of the frame, above the story text
    S.camera.setViewOffset(1920, 1080, 0, 250, 1920, 1080);
    const data = await json('/film/assets/kit/courts.json');
    const buf = await (await fetch('/film/assets/kit/points.bin')).arrayBuffer();
    const n: number = data.points;
    const xyz = new Float32Array(buf, 0, n * 3);
    const rgb = new Uint8Array(buf, n * 12, n * 3);
    const track = new Uint8Array(buf, n * 15, n);
    for (const c of data.cameras) target.add(new THREE.Vector3(...c.centre));
    target.divideScalar(data.cameras.length).add(new THREE.Vector3(0, 0.6, 0));

    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => track[b] - track[a]);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const rev = new Float32Array(n);
    order.forEach((k, i) => {
      const far = Math.hypot(xyz[k * 3] - target.x, xyz[k * 3 + 1] - target.y, xyz[k * 3 + 2] - target.z) > 15;
      rev[i] = far ? 9 : i / n;
      pos.set(xyz.subarray(k * 3, k * 3 + 3), i * 3);
      for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.pow(rgb[k * 3 + c] / 255, 0.85);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('reveal', new THREE.BufferAttribute(rev, 1));
    pointsMat = pointsMaterial(1.1);
    S.scene.add(new THREE.Points(g, pointsMat));

    const rand = rng(7);
    const groups = ['photo', 'walk', 'play'];
    const sorted = [...data.cameras].sort((a: any, b: any) => groups.indexOf(a.group) - groups.indexOf(b.group));
    const textures = await Promise.all(sorted.map((c: any) => loadTexture(`/film/assets/kit/${c.thumb}`)));
    sorted.forEach((c: any, i: number) => {
      const centre = new THREE.Vector3(...c.centre);
      const corners = c.corners.map((p: number[]) => new THREE.Vector3(...p).sub(centre));
      const group = new THREE.Group();
      const plane = new THREE.BufferGeometry();
      plane.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corners.flatMap((v: THREE.Vector3) => v.toArray())), 3));
      plane.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
      plane.setIndex([0, 1, 2, 0, 2, 3]);
      const photoMat = new THREE.MeshBasicMaterial({ map: textures[i], transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
      group.add(new THREE.Mesh(plane, photoMat));
      const o = new THREE.Vector3();
      const lines = [o, corners[0], o, corners[1], o, corners[2], o, corners[3], corners[0], corners[1], corners[1], corners[2], corners[2], corners[3], corners[3], corners[0]];
      const lineMat = new THREE.LineBasicMaterial({ color: FRAME_COLOUR[c.group], transparent: true, opacity: 0 });
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lines), lineMat));
      const fwd = new THREE.Vector3(...c.forward);
      const from = centre.clone().addScaledVector(fwd, -26 - rand() * 14).add(new THREE.Vector3(0, 6 + rand() * 6, 0));
      cams.push({ group, from, to: centre, delay: 0.3 + 2.3 * (i / sorted.length) + rand() * 0.12, mats: [photoMat, lineMat] });
      S.scene.add(group);
    });

    const sample = sorted.filter((_: any, i: number) => i % 5 === 0);
    const cosMax = Math.cos((26 * Math.PI) / 180);
    const p = new THREE.Vector3();
    const d = new THREE.Vector3();
    sample.forEach((c: any, ci: number) => {
      const centre = new THREE.Vector3(...c.centre);
      const fwd = new THREE.Vector3(...c.forward);
      let taken = 0;
      for (let k = (ci * 97) % 211; k < n && taken < 22; k += 211) {
        p.set(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 2]);
        d.copy(p).sub(centre);
        if (d.length() < 16 && d.normalize().dot(fwd) > cosMax) {
          threadData.push({ a: centre, b: p.clone(), delay: 2.6 + 1.4 * (ci / sample.length) + (taken % 5) * 0.04 });
          taken++;
        }
      }
    });
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(threadData.length * 6), 3));
    threads = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    S.scene.add(threads);

    words = story('Cameras', 'Every photo, placed where it was taken.',
      `<b>163</b> photos and video frames, located from the pictures alone. <b>57,048</b> points triangulated between them, to within a pixel.`);
  },

  frame(t) {
    orbit(S.camera, target, lerp(21, 15.5, ease.site(seg(t, 0, DUR))), lerp(28, 62, ease.sine(seg(t, 0, DUR))), lerp(30, 22, ease.site(seg(t, 0, DUR))));

    for (const c of cams) {
      const k = ease.expo(seg(t, c.delay, c.delay + 1.0));
      c.group.position.lerpVectors(c.from, c.to, k);
      (c.mats[0] as THREE.MeshBasicMaterial).opacity = 0.95 * k * (1 - 0.5 * seg(t, 4.8, 6.2));
      (c.mats[1] as THREE.LineBasicMaterial).opacity = 0.7 * k;
    }

    const pos = threads.geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    threadData.forEach((th, i) => {
      const k = ease.out(seg(t, th.delay, th.delay + 0.45));
      v.lerpVectors(th.a, th.b, k);
      pos.setXYZ(i * 2, th.a.x, th.a.y, th.a.z);
      pos.setXYZ(i * 2 + 1, v.x, v.y, v.z);
    });
    pos.needsUpdate = true;
    (threads.material as THREE.LineBasicMaterial).opacity = 0.22 * (1 - seg(t, 5.0, 6.0));
    pointsMat.uniforms.uReveal.value = ease.out(seg(t, 2.7, 5.0)) * 1.06;

    words.show(t, 0.6);
    S.renderer.render(S.scene, S.camera);
  },
};

export default shot;
