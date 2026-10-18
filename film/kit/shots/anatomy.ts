// Shot 30: what a world is made of. Every number and shape here is the live Game Lawn file (world-filled.spz).
//   A  0.0–2.4 s  the real place; we push into a palm crown
//   B  2.4–3.8 s  the crown comes apart into its splats, drawn as the ellipsoids they are (2σ), in their colours
//   C  3.8–6.6 s  one real splat isolated: centre, axes (R and S), σ shells, opacity falloff
//   D  6.6–9.2 s  one pixel's ray composites through the splats it hits, front to back, until the light runs out
//   E  9.2–10 s   back to the real place, wide, with the splat count
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ease, el, fmt, lerp, seg, stage, story, type Shot, LIME, INK } from '../lib';

const DUR = 10;
const CROP = 2.4; // metres round the crown that come apart
type Sp = { c: THREE.Vector3; s: THREE.Vector3; q: THREE.Quaternion; o: number; col: THREE.Color };

let S: ReturnType<typeof stage>;
let spark: SparkRenderer;
let world: SplatMesh;
let total = 0;
const crown = new THREE.Vector3();
const toCam = new THREE.Vector3();
const side = new THREE.Vector3();
let near: Sp[] = [];
let inst: THREE.InstancedMesh;
let hero: Sp;
let heroGroup: THREE.Group;
let shells: THREE.Mesh[] = [];
let hits: { i: number; t: number; alpha: number; T: number }[] = [];
const rayFrom = new THREE.Vector3();
const rayDir = new THREE.Vector3();
let ray: THREE.Line;
let rayCam: THREE.LineSegments;
const ui: Record<string, HTMLElement> = {};
let svg: SVGSVGElement;
let words: ReturnType<typeof story>;
const m4 = new THREE.Matrix4();
const v3 = new THREE.Vector3();
const sc = new THREE.Vector3();
const col = new THREE.Color();
const BG = new THREE.Color('#060607');

const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    S.camera.setViewOffset(1920, 1080, 0, 170, 1920, 1080); // the picture sits above the story text
    S.renderer.toneMapping = THREE.NoToneMapping;
    spark = new SparkRenderer({ renderer: S.renderer, maxStdDev: Math.sqrt(8) });
    S.scene.add(spark);
    world = new SplatMesh({ url: '/data/scenes/the-courts/world-filled.spz' });
    await world.initialized;
    S.scene.add(world);
    total = world.packedSplats.numSplats;

    // Palm crowns: high, opaque, green splats
    const cand: THREE.Vector3[] = [];
    world.forEachSplat((_i, c, _s, _q, o, k) => {
      if (c.y > 3.2 && c.y < 9 && o > 0.45 && k.g > k.r * 1.04 && k.g > k.b * 1.02) cand.push(c.clone());
    });
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    crown.set(med(cand.map((p) => p.x)), med(cand.map((p) => p.y)), med(cand.map((p) => p.z)));
    // snap to the densest cluster near the median
    let best = 0;
    for (const p of cand.filter((_, i) => i % 7 === 0)) {
      const n = cand.reduce((acc, q) => acc + (q.distanceToSquared(p) < 1.2 ? 1 : 0), 0);
      if (n > best) { best = n; crown.copy(p); }
    }
    toCam.set(0, 1.6, 0).sub(crown).setY(0).normalize();
    side.crossVectors(toCam, new THREE.Vector3(0, 1, 0)).normalize();

    world.forEachSplat((_i, c, s, q, o, k) => {
      if (o > 0.12 && c.distanceTo(crown) < CROP) near.push({ c: c.clone(), s: s.clone(), q: q.clone(), o, col: k.clone() });
    });
    if (near.length > 60000) near = near.filter((_, i) => i % Math.ceil(near.length / 60000) === 0);

    inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.05 }), near.length);
    near.forEach((p, i) => inst.setColorAt(i, p.col));
    S.scene.add(inst);
    S.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.copy(crown).add(new THREE.Vector3(3, 6, 4));
    S.scene.add(sun);

    // The hero: a large, opaque, elongated splat near the crown's centre
    let score = -1;
    for (const p of near) {
      const mx = Math.max(p.s.x, p.s.y, p.s.z), mn = Math.min(p.s.x, p.s.y, p.s.z);
      const mid = p.s.x + p.s.y + p.s.z - mx - mn;
      const sc2 = p.o > 0.5 && mx > 0.02 && mx < 0.15 ? p.o * (mid / mx) * (mn / mx + 0.15) / (1 + 0.5 * p.c.distanceTo(crown)) : -1;
      if (sc2 > score) { score = sc2; hero = p; }
    }
    if (!hero) {
      // nothing round enough: take the most opaque mid-sized splat near the centre
      let b = -1;
      for (const p of near) {
        const mx = Math.max(p.s.x, p.s.y, p.s.z);
        const v = mx < 0.15 ? p.o * mx / (1 + p.c.distanceTo(crown)) : -1;
        if (v > b) { b = v; hero = p; }
      }
    }
    console.log(`crown ${crown.toArray().map((x) => x.toFixed(2))}, ${near.length} splats in the crop, hero scales ${hero.s.toArray().map((x) => x.toFixed(3))}, ${hits.length} ray hits`);
    heroGroup = new THREE.Group();
    heroGroup.position.copy(hero.c);
    heroGroup.quaternion.copy(hero.q);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshStandardMaterial({ color: hero.col, roughness: 0.25, emissive: hero.col, emissiveIntensity: 0.25 }));
    core.scale.copy(hero.s);
    heroGroup.add(core);
    for (const [k, o] of [[2, 0.22], [3, 0.1]] as const) {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshBasicMaterial({ color: hero.col, transparent: true, opacity: o, depthWrite: false }));
      shell.scale.copy(hero.s).multiplyScalar(k);
      shell.userData.o = o;
      shells.push(shell);
      heroGroup.add(shell);
    }
    const ax: THREE.Vector3[] = [];
    (['x', 'y', 'z'] as const).forEach((a) => {
      const e = new THREE.Vector3();
      e[a] = hero.s[a] * 3.2;
      ax.push(e.clone().negate(), e);
    });
    heroGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ax), new THREE.LineBasicMaterial({ color: LIME })));
    heroGroup.visible = false;
    S.scene.add(heroGroup);

    // A pixel's ray: from a small camera off to one side, through the crown
    rayFrom.copy(crown).addScaledVector(side, 3.4).addScaledVector(toCam, 0.6).add(new THREE.Vector3(0, 0.25, 0));
    rayDir.copy(crown).sub(rayFrom).normalize();
    const R = new THREE.Matrix3();
    near.forEach((p, i) => {
      R.setFromMatrix4(m4.makeRotationFromQuaternion(p.q)).transpose();
      const o = v3.copy(rayFrom).sub(p.c).applyMatrix3(R).divide(p.s);
      const d = sc.copy(rayDir).applyMatrix3(R).divide(p.s);
      const t = -o.dot(d) / d.dot(d);
      if (t <= 0) return;
      const m2 = o.addScaledVector(d, t).lengthSq();
      if (m2 < 6.25) hits.push({ i, t, alpha: Math.min(0.99, p.o * Math.exp(-0.5 * m2)), T: 1 });
    });
    hits.sort((a, b) => a.t - b.t);
    let T = 1;
    const kept: typeof hits = [];
    for (const h of hits) {
      if (h.alpha < 0.02) continue;
      h.T = T;
      kept.push(h);
      T *= 1 - h.alpha;
      if (T < 0.01 || kept.length >= 16) break;
    }
    hits = kept;
    const far = hits.length ? hits[hits.length - 1].t + 0.6 : 4;
    const tube = new THREE.CylinderGeometry(0.012, 0.012, far, 12).translate(0, far / 2, 0).rotateX(Math.PI / 2);
    ray = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: LIME, transparent: true })) as unknown as THREE.Line;
    ray.position.copy(rayFrom);
    ray.lookAt(rayFrom.clone().add(rayDir));
    ray.visible = false;
    S.scene.add(ray);
    const f = 0.18;
    const look = new THREE.Matrix4().lookAt(rayFrom, crown, new THREE.Vector3(0, 1, 0));
    const corners = [[-1, -0.6], [1, -0.6], [1, 0.6], [-1, 0.6]].map(([x, y]) => new THREE.Vector3(x * f, y * f, -f * 1.6).applyMatrix4(look).add(rayFrom));
    rayCam = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      rayFrom, corners[0], rayFrom, corners[1], rayFrom, corners[2], rayFrom, corners[3],
      corners[0], corners[1], corners[1], corners[2], corners[2], corners[3], corners[3], corners[0]]), new THREE.LineBasicMaterial({ color: LIME, transparent: true }));
    rayCam.visible = false;
    S.scene.add(rayCam);

    // Type
    ui.mu = el('callout', 0, 0, 'μ <span>position</span>');
    ui.sigma = el('callout', 0, 0, 'Σ = R S Sᵀ Rᵀ <span>shape and rotation</span>');
    ui.alpha = el('callout', 0, 0, 'α <span>opacity, falling off as a Gaussian</span>');
    ui.colour = el('callout', 0, 0, 'c(d) <span>colour by viewing direction</span>');
    ui.panel = el('', 1150, 110, '');
    ui.panel.style.cssText += 'width:620px;height:560px;border-radius:24px;background:rgba(29,29,31,.72);backdrop-filter:blur(18px)';
    ui.eq = el('callout', 1190, 146, 'C = Σ<sub>i</sub> c<sub>i</sub> α<sub>i</sub> T<sub>i</sub>, &nbsp; T<sub>i</sub> = Π<sub>j&lt;i</sub>(1 − α<sub>j</sub>)');
    ui.eqSub = el('axis', 1190, 196, 'One pixel: the splats on its ray, front to back');
    ui.bar = el('', 1190, 262, '');
    ui.bar.style.cssText += 'width:24px;height:260px;border:1.5px solid rgba(245,245,247,.3);border-radius:6px;overflow:hidden';
    ui.barFill = document.createElement('div');
    ui.barFill.style.cssText = `position:absolute;left:0;right:0;bottom:0;background:${LIME}`;
    ui.bar.appendChild(ui.barFill);
    ui.barL = el('axis', 1236, 262, 'Light remaining, T');
    ui.barN = el('value', 1236, 292, '100%');
    ui.barN.style.fontSize = '72px';
    ui.swatch = el('', 1236, 420, '');
    ui.swatch.style.cssText += 'width:120px;height:120px;border-radius:14px;border:1.5px solid rgba(245,245,247,.3)';
    ui.swatchL = el('axis', 1360, 456, 'The pixel, so far');
    ui.hitsN = el('axis', 1236, 560, '');
    words = story('Splats', 'Made of soft 3D brushstrokes.', `Each one is a 3D Gaussian: a position, a shape, an opacity and a colour that changes with the angle. A pixel blends them front to back until the light runs out. This lawn is <b>${fmt(total)}</b> of them.`);
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '1920');
    svg.setAttribute('height', '1080');
    svg.style.cssText = 'position:absolute;left:0;top:0';
    document.getElementById('overlay')!.appendChild(svg);
  },

  async frame(t) {
    const cam = S.camera;
    // Camera path
    const pA0 = crown.clone().addScaledVector(toCam, 9).setY(1.7);
    const pA1 = crown.clone().addScaledVector(toCam, 3.1).add(new THREE.Vector3(0, -0.4, 0));
    const pB = crown.clone().addScaledVector(toCam, 3.4).addScaledVector(side, -0.6).add(new THREE.Vector3(0, -0.2, 0));
    const hs = Math.max(hero.s.x, hero.s.y, hero.s.z);
    const orbitC = (a: number) => hero.c.clone().addScaledVector(toCam.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a), hs * 11).add(new THREE.Vector3(0, hs * 2.5, 0));
    const pD = crown.clone().addScaledVector(toCam, 4.4).addScaledVector(side, -1.6).add(new THREE.Vector3(0, 0.7, 0));
    const pE = crown.clone().addScaledVector(toCam, 15).addScaledVector(side, -1.6).setY(2.2);
    let pos: THREE.Vector3, look: THREE.Vector3;
    if (t < 2.4) { pos = pA0.clone().lerp(pA1, ease.inOut(seg(t, 0, 2.4))); look = crown.clone(); }
    else if (t < 3.8) { pos = pA1.clone().lerp(pB, ease.inOut(seg(t, 2.4, 3.8))); look = crown.clone(); }
    else if (t < 6.6) {
      const k = ease.inOut(seg(t, 3.8, 4.8));
      pos = pB.clone().lerp(orbitC(0.9 * seg(t, 3.8, 6.6)), k);
      look = crown.clone().lerp(hero.c, k);
    } else if (t < 9.2) {
      const k = ease.inOut(seg(t, 6.6, 7.4));
      pos = orbitC(0.9).lerp(pD, k);
      look = hero.c.clone().lerp(crown, k);
    } else {
      pos = new THREE.Vector3(0.2, 1.65, 2.4).lerp(new THREE.Vector3(0.35, 1.6, 1.2), ease.inOut(seg(t, 9.2, 10)));
      look = new THREE.Vector3(1.0, 0.9, -6.4);
    }
    cam.position.copy(pos);
    cam.lookAt(look);
    cam.fov = 38;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Phases
    const apart = ease.out(seg(t, 2.4, 3.6));
    const isolate = ease.inOut(seg(t, 3.9, 4.6)) * (1 - ease.inOut(seg(t, 6.4, 6.9)));
    const back = t >= 9.2 ? 1 : 0;
    (document.getElementById('gl') as HTMLElement).style.opacity = String(1 - Math.min(seg(t, 8.95, 9.2), 1 - seg(t, 9.2, 9.6)));
    world.opacity = Math.max(1 - apart, back);
    world.visible = world.opacity > 0.01;
    inst.visible = apart > 0.01 && back < 0.99;
    heroGroup.visible = isolate > 0.01;
    shells.forEach((s) => ((s.material as THREE.MeshBasicMaterial).opacity = s.userData.o * isolate));

    const rayK = seg(t, 6.9, 7.3);
    const litUpTo = (hits.length) * seg(t, 7.3, 8.9);
    ray.visible = rayCam.visible = rayK > 0 && back < 0.5;
    (ray.material as THREE.MeshBasicMaterial).opacity = rayK;
    (rayCam.material as THREE.LineBasicMaterial).opacity = rayK;
    const hitSet = new Map(hits.map((h, n) => [h.i, n]));

    const grow = lerp(0.35, 1, apart);
    near.forEach((p, i) => {
      const spread = 1 + 0.18 * apart;
      v3.copy(p.c).sub(crown).multiplyScalar(spread).add(crown);
      const isHit = hitSet.has(i);
      const lit = isHit && hitSet.get(i)! < litUpTo;
      const hide = 1 - isolate;
      const rayShrink = t > 6.9 ? (lit ? 1.3 : isHit ? 1 : 0.45) : 1;
      sc.copy(p.s).multiplyScalar(2 * grow * hide * rayShrink + 1e-6);
      m4.compose(v3, p.q, sc);
      inst.setMatrixAt(i, m4);
      let k = 1 - 0.94 * isolate;
      if (t > 6.9) {
        const n = hitSet.get(i);
        k = n === undefined ? 0.1 : n < litUpTo ? 1.7 : 0.35;
      }
      col.copy(p.col).lerp(BG, 1 - Math.min(k, 1)).multiplyScalar(k > 1 ? k : 1);
      inst.setColorAt(i, col);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor!.needsUpdate = true;

    // Compositing readouts
    const n = Math.floor(litUpTo);
    let T = 1;
    const acc = new THREE.Color(0, 0, 0);
    for (let j = 0; j < Math.min(n, hits.length); j++) {
      const h = hits[j];
      acc.r += near[h.i].col.r * h.alpha * T;
      acc.g += near[h.i].col.g * h.alpha * T;
      acc.b += near[h.i].col.b * h.alpha * T;
      T *= 1 - h.alpha;
    }
    ui.barFill.style.height = `${(T * 100).toFixed(1)}%`;
    ui.barN.textContent = `${Math.round(T * 100)}%`;
    ui.swatch.style.background = `rgb(${Math.min(255, acc.r * 255)},${Math.min(255, acc.g * 255)},${Math.min(255, acc.b * 255)})`;
    ui.hitsN.textContent = n >= hits.length ? `${hits.length} splats, then the light is used up` : `${n} of the splats this ray hits`;
    const dPanel = ease.out(seg(t, 6.9, 7.4)) * (1 - seg(t, 9.1, 9.4));
    for (const k of ['panel', 'eq', 'eqSub', 'bar', 'barL', 'barN', 'swatch', 'swatchL', 'hitsN']) ui[k].style.opacity = String(dPanel);

    // Labels on the hero splat
    const proj = (p: THREE.Vector3) => {
      const q = p.clone().project(cam);
      return { x: (q.x * 0.5 + 0.5) * 1920, y: (-q.y * 0.5 + 0.5) * 1080 };
    };
    const axis = (a: 'x' | 'y' | 'z', k: number) => { const e = new THREE.Vector3(); e[a] = hero.s[a] * k; return e.applyQuaternion(hero.q).add(hero.c); };
    const longest = (['x', 'y', 'z'] as const).reduce((a, b) => (hero.s[a] > hero.s[b] ? a : b));
    const anchors = [
      [ui.mu, proj(hero.c), 180, -170, 4.2],
      [ui.sigma, proj(axis(longest, 3.2)), 40, -40, 4.6],
      [ui.alpha, proj(axis(longest === 'x' ? 'y' : 'x', 2)), 220, 90, 5.0],
      [ui.colour, proj(axis(longest === 'z' ? 'y' : 'z', -2)), -220, 170, 5.4],
    ] as const;
    let lines = '';
    for (const [e, a, dx, dy, at] of anchors) {
      const k = ease.out(seg(t, at, at + 0.4)) * (1 - seg(t, 6.3, 6.6));
      const x = a.x + dx, y = a.y + dy;
      e.style.left = `${Math.min(1860 - e.offsetWidth, Math.max(60, x + (dx < 0 ? -e.offsetWidth : 0)))}px`;
      e.style.top = `${y - 26}px`;
      e.style.opacity = String(k);
      if (k > 0) lines += `<line x1="${a.x}" y1="${a.y}" x2="${x}" y2="${y}" stroke="#86868b" stroke-width="1.5" opacity="${k}"/><circle cx="${a.x}" cy="${a.y}" r="4" fill="${INK}" opacity="${k}"/>`;
    }
    svg.innerHTML = lines;

    words.show(t, 0.4);

    // Render, and let Spark finish sorting for this view before the frame is taken
    for (let k = 0; k < 40; k++) {
      S.renderer.render(S.scene, cam);
      if (!world.visible) break;
      await raf();
      if (!(spark as any).sorting && !(spark as any).sortDirty) break;
    }
    S.renderer.render(S.scene, cam);
  },
};

export default shot;
