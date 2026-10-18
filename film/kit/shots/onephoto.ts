// Shot 31: one photo becomes a whole place. All real: the old listing photo, the caption Gemini wrote for it (the
// text prompt the world model got), the world it made, and our measured split of what the photo saw (26%) and what
// was imagined (74%).
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ease, el, fmt, json, lerp, reveal, seg, stage, type Shot, LIME, INK } from '../lib';

const DUR = 9.5;
const SCENE = '/data/scenes/old-house-kitchen';

let S: ReturnType<typeof stage>;
let spark: SparkRenderer;
let seen: SplatMesh;
let imagined: SplatMesh;
let caption = '';
let reality: any;
const camPos = new THREE.Vector3();
const camQ = new THREE.Quaternion();
const ui: Record<string, HTMLElement> = {};
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const lime = new THREE.Color(LIME);

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    S.renderer.toneMapping = THREE.NoToneMapping;
    spark = new SparkRenderer({ renderer: S.renderer, maxStdDev: Math.sqrt(8) });
    S.scene.add(spark);
    const scene = await json(`${SCENE}/scene.json`);
    const req = await json(`${SCENE}/request.json`);
    reality = await json(`${SCENE}/reality.json`);
    const cam = await json(`${SCENE}/input_camera.json`);
    caption = req.text_prompt;
    const tf = scene.world.transform;
    const load = async (file: string) => {
      const m = new SplatMesh({ url: `${SCENE}/${file}` });
      await m.initialized;
      m.position.fromArray(tf.position);
      m.quaternion.fromArray(tf.quaternion);
      m.scale.setScalar(tf.scale);
      S.scene.add(m);
      return m;
    };
    seen = await load(reality.seen.file);
    imagined = await load(reality.imagined.file);
    camPos.fromArray(cam.position);
    camQ.fromArray(cam.quaternion);
    S.camera.fov = (2 * Math.atan(cam.height / 2 / cam.fy) * 180) / Math.PI;
    S.camera.updateProjectionMatrix();

    ui.label = el('label', 120, 104, 'One photo → a whole place');
    ui.sub = el('note', 120, 144, 'An old real-estate listing photo of a kitchen in Pennsylvania');
    ui.photo = el('', 120, 230, '');
    ui.photo.style.cssText += 'width:880px;height:660px;border-radius:18px;background:url(/data/inputs/old-house-kitchen/01.jpg) center/cover;box-shadow:0 30px 80px rgba(0,0,0,.6)';
    ui.capL = el('label', 1080, 236, 'Gemini describes it');
    ui.cap = el('', 1080, 284, '');
    ui.cap.style.cssText += 'width:700px;white-space:normal;font-size:32px;line-height:1.38;font-weight:500;color:#F5F5F7';
    ui.ring = el('', 1500, 150, '');
    ui.ringN = el('big', 120, 800, '');
    ui.ringU = el('unit', 124, 916, '');
    ui.model = el('note', 120, 966, 'The rest: a video diffusion model generated the views nobody filmed, decoded straight into splats');
    ui.gpu = el('', 1250, 830, `<div class="chip" style="position:static;display:inline-block;margin-right:12px">HiPerGator · RTX PRO 6000 Blackwell</div><div class="chip" style="position:static;display:inline-block">Vultr · cloud GPU</div>` +
      `<div class="unit" style="position:static;margin-top:16px">about 10 s from photo to world on a warm GPU</div>`);
  },

  async frame(t) {
    // Caption types out, then the photo grows into the world
    const typed = Math.floor(caption.length * seg(t, 0.9, 3.0));
    ui.cap.textContent = caption.slice(0, typed);
    reveal(ui.label, t, 0.1, 0.6);
    reveal(ui.sub, t, 0.25, 0.8);
    reveal(ui.capL, t, 0.7, 1.1);
    ui.cap.style.opacity = String(1 - seg(t, 3.3, 3.7));
    ui.capL.style.opacity = String(Number(ui.capL.style.opacity) * (1 - seg(t, 3.3, 3.7)));
    const grow = ease.inOut(seg(t, 3.1, 3.9));
    ui.photo.style.left = `${lerp(120, 0, grow)}px`;
    ui.photo.style.top = `${lerp(230, 0, grow)}px`;
    ui.photo.style.width = `${lerp(880, 1920, grow)}px`;
    ui.photo.style.height = `${lerp(660, 1080, grow)}px`;
    ui.photo.style.borderRadius = `${lerp(18, 0, grow)}px`;
    ui.photo.style.opacity = String(ease.out(seg(t, 0, 0.5)) * (1 - seg(t, 3.7, 4.2)));
    ui.sub.style.opacity = String(Number(ui.sub.style.opacity) * (1 - seg(t, 3.3, 3.6)));

    (document.getElementById('gl') as HTMLElement).style.opacity = String(seg(t, 3.45, 3.95));
    // Camera: starts in the photo's own view, then turns round into what the photo never showed
    const turn = ease.inOut(seg(t, 4.2, 8.6));
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (turn * 200 * Math.PI) / 180);
    S.camera.quaternion.copy(yaw).multiply(camQ);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(S.camera.quaternion).multiplyScalar(0.55 * turn);
    S.camera.position.copy(camPos).add(back);
    S.camera.updateMatrixWorld();

    // The imagined part turns lime
    const tint = ease.inOut(seg(t, 4.4, 5.2));
    imagined.recolor = new THREE.Color(1, 1, 1).lerp(lime, tint * 0.62);

    // The split, as a ring
    const k = ease.out(seg(t, 5.0, 6.2));
    const frac = reality.seenFraction;
    const r = 120, c = 2 * Math.PI * r;
    ui.ring.innerHTML = `<svg width="320" height="320" viewBox="-160 -160 320 320" style="overflow:visible">
      <circle r="${r}" fill="none" stroke="rgba(245,245,247,.12)" stroke-width="26"/>
      <circle r="${r}" fill="none" stroke="${LIME}" stroke-width="26" stroke-dasharray="${c * (1 - frac) * k} ${c}" transform="rotate(${-90 + 360 * frac})"/>
      <circle r="${r}" fill="none" stroke="${INK}" stroke-width="26" stroke-dasharray="${c * frac * k} ${c}" transform="rotate(-90)"/>
      <text y="-6" text-anchor="middle" fill="${LIME}" font-size="56" font-weight="600" font-family="-apple-system,system-ui">${Math.round((1 - frac) * 100 * k)}%</text>
      <text y="36" text-anchor="middle" fill="rgba(245,245,247,.6)" font-size="22" font-family="-apple-system,system-ui">imagined</text></svg>`;
    ui.ring.style.opacity = String(k);
    ui.ringN.innerHTML = `${fmt(reality.seen.count * k)}<span class="unit" style="position:static;margin:0 18px">seen</span>${fmt(reality.imagined.count * k)}<span class="unit" style="position:static;margin-left:18px">imagined</span>`;
    ui.ringU.textContent = 'splats in this world: only 26% of it was in the photo';
    reveal(ui.ringN, t, 5.0, 5.5);
    reveal(ui.ringU, t, 5.2, 5.7);
    reveal(ui.model, t, 5.8, 6.4);
    reveal(ui.gpu, t, 7.0, 7.6);

    for (let n = 0; n < 40; n++) {
      S.renderer.render(S.scene, S.camera);
      await raf();
      if (!(spark as any).sorting && !(spark as any).sortDirty) break;
    }
    S.renderer.render(S.scene, S.camera);
  },
};

export default shot;
