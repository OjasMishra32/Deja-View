// Reality check across three worlds. Real data: each world's seen/imagined split (reality.json), made by projecting
// every splat into the cameras that filmed it and testing it against their depth. One card, one world at a time, seen
// from its own camera: the world whole, then what no camera saw turns blue, while the camera drifts into it.
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { BLUE, ease, el, json, lerp, seg, stage, story, type Shot } from '../lib';

const WORLDS = [
  { id: 'chess-match', name: 'Giant chess match', from: 'a phone video', turn: -22, back: 0.4 },
  { id: 'courts-foosball', name: 'Foosball at the Game Lawn', from: 'a phone video', turn: 24, back: 0.4 },
  { id: 'kitchen-cooking', name: 'Seb cooking', from: 'a phone video', turn: 26, back: 0.4 },
];
const SEG = 3.6, T0 = 0.6, DUR = T0 + SEG * WORLDS.length + 0.4;
const CW = 1040, CH = 585, CX = 240, CY = 120;
let S: ReturnType<typeof stage>;
let spark: SparkRenderer;
let words: ReturnType<typeof story>;
const ui: Record<string, HTMLElement> = {};
const rows: HTMLElement[] = [];
const W: { seen: SplatMesh; imagined: SplatMesh; pos: THREE.Vector3; q: THREE.Quaternion; fov: number; frac: number }[] = [];
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const tintTo = new THREE.Color(BLUE);

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    S.renderer.toneMapping = THREE.NoToneMapping;
    S.renderer.setSize(CW, CH);
    S.camera.aspect = CW / CH;
    Object.assign(S.renderer.domElement.style, { position: 'absolute', left: `${CX}px`, top: `${CY}px`, borderRadius: '22px' });
    (document.getElementById('shade') as HTMLElement).style.display = 'none';
    spark = new SparkRenderer({ renderer: S.renderer, maxStdDev: Math.sqrt(8) });
    S.scene.add(spark);
    for (const w of WORLDS) {
      const base = `/data/scenes/${w.id}`;
      const sc = await json(`${base}/scene.json`);
      const r = await json(`${base}/reality.json`);
      const tf = sc.world.transform;
      const load = async (f: string) => {
        const m = new SplatMesh({ url: `${base}/${f}` });
        await m.initialized;
        m.position.fromArray(tf.position);
        m.quaternion.fromArray(tf.quaternion);
        m.scale.setScalar(tf.scale);
        m.visible = false;
        S.scene.add(m);
        return m;
      };
      const c = r.camera;
      W.push({
        seen: await load(r.seen.file),
        imagined: await load(r.imagined.file),
        pos: new THREE.Vector3().fromArray(c.position),
        q: new THREE.Quaternion().fromArray(c.quaternion),
        fov: Math.min(62, Math.max(48, (2 * Math.atan(c.height / 2 / c.fx) * 180) / Math.PI + 10)),
        frac: r.seenFraction,
      });
    }

    // the panel: each world's split, seen in white and imagined in blue
    const P = el('', 1330, 120, '');
    P.style.cssText += 'width:420px;height:585px;border-radius:24px;background:rgba(29,29,31,.72);backdrop-filter:blur(18px)';
    P.innerHTML = '<div class="callout" style="position:absolute;left:32px;top:28px">Seen by a camera</div>';
    WORLDS.forEach((w, i) => {
      const r = document.createElement('div');
      r.style.cssText = `position:absolute;left:32px;top:${104 + i * 128}px;width:356px`;
      r.innerHTML = `<div style="font-size:24px;font-weight:600;color:#f5f5f7;letter-spacing:-0.01em">${w.name}</div>
        <div class="axis" style="margin-top:4px">From ${w.from}</div>
        <div style="position:relative;margin-top:14px;height:10px;border-radius:5px;background:rgba(41,151,255,.9);overflow:hidden">
          <div class="seen" style="position:absolute;left:0;top:0;bottom:0;width:0;background:#f5f5f7"></div></div>
        <div class="value pct" style="position:absolute;right:0;top:0;font-size:24px"></div>`;
      P.appendChild(r);
      rows.push(r);
    });
    P.insertAdjacentHTML('beforeend', `<div style="position:absolute;left:32px;right:32px;bottom:30px;display:flex;align-items:center;justify-content:space-between">
      <span class="axis">Provenance for every splat</span>
      <img src="/film/assets/logos/vobile.png" style="height:30px"></div>`);
    ui.panel = P;
    ui.badge = el('', CX + 28, CY + 24, '');
    ui.badge.style.cssText += 'padding:10px 18px;border-radius:999px;background:rgba(0,0,0,.55);backdrop-filter:blur(12px);font-size:22px;color:#f5f5f7;letter-spacing:-0.01em';
    words = story('Reality check', 'What was really there.',
      'Every splat is projected into each camera that filmed the room and checked against its depth. If no camera saw it, the model imagined it, and one button turns it blue.');
  },

  async frame(t) {
    const i = Math.min(WORLDS.length - 1, Math.max(0, Math.floor((t - T0) / SEG)));
    const u = t - T0 - i * SEG; // time inside this world
    const w = WORLDS[i], d = W[i];
    W.forEach((x, j) => (x.seen.visible = x.imagined.visible = j === i));

    // camera: the world's own camera, drifting round into what it never saw
    const k = ease.sine(seg(u, 0, SEG));
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(w.turn * k));
    S.camera.quaternion.copy(turn).multiply(d.q);
    S.camera.position.copy(d.pos).add(new THREE.Vector3(0, 0, 1).applyQuaternion(S.camera.quaternion).multiplyScalar(w.back * k));
    S.camera.fov = d.fov;
    S.camera.updateProjectionMatrix();
    S.camera.updateMatrixWorld();

    // the reality check: on at 0.9 s into each world
    const tint = ease.inOut(seg(u, 0.9, 1.5));
    d.imagined.recolor = new THREE.Color(1, 1, 1).lerp(tintTo, tint * 0.7);
    ui.badge.innerHTML = tint > 0.5 ? 'Reality check <span style="color:#2997ff">on</span>' : 'Reality check off';
    ui.badge.style.opacity = String(ease.site(seg(t, T0, T0 + 0.4)));

    // a soft dip to black between worlds
    const dip = Math.min(seg(u, 0, 0.25), 1 - seg(u, SEG - 0.25, SEG));
    S.renderer.domElement.style.opacity = String(i === WORLDS.length - 1 ? Math.min(1, seg(u, 0, 0.25)) : dip);

    // panel rows: the active one bright, its bar filling to the seen fraction
    ui.panel.style.opacity = String(ease.site(seg(t, 0.3, 0.9)));
    rows.forEach((r, j) => {
      const on = j < i ? 1 : j === i ? ease.site(seg(u, 1.0, 2.0)) : 0;
      r.style.opacity = String(j === i ? 1 : j < i ? 0.45 : 0.3);
      (r.querySelector('.seen') as HTMLElement).style.width = `${W[j].frac * 100 * on}%`;
      (r.querySelector('.pct') as HTMLElement).textContent = on > 0 ? `${Math.round(W[j].frac * 100 * on)}%` : '';
    });
    words.show(t, 0.5);

    for (let n = 0; n < 40; n++) {
      S.renderer.render(S.scene, S.camera);
      await raf();
      if (!(spark as any).sorting && !(spark as any).sortDirty) break;
    }
    S.renderer.render(S.scene, S.camera);
  },
};

export default shot;
