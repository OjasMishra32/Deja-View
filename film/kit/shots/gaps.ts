// Shot 33: filling the gaps. Real data: the Game Lawn before the fill (world.spz) and after it (world-filled.spz),
// rendered from the same camera with a slider between them, and the gap finder's own measurement of what is missing at
// each viewing angle (2,304 views from 72 standing spots).
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ease, el, json, lerp, seg, stage, story, type Shot, BLUE, INK } from '../lib';

const DUR = 8;
const SCENE = '/data/scenes/the-courts';
let S: ReturnType<typeof stage>;
let spark: SparkRenderer;
let before: SplatMesh, after: SplatMesh;
let gaps: any;
let words: ReturnType<typeof story>;
const ui: Record<string, HTMLElement> = {};
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const EYE = new THREE.Vector3(4.5, 1.6, -2.1); // the gap finder's own spot (+4.5, -2.1), yaw 135

async function draw(mesh: SplatMesh, other: SplatMesh, x0: number, x1: number) {
  mesh.visible = true;
  other.visible = false;
  S.renderer.setScissor(x0, 0, x1 - x0, 1080);
  for (let k = 0; k < 40; k++) {
    S.renderer.render(S.scene, S.camera);
    await raf();
    if (!(spark as any).sorting && !(spark as any).sortDirty) break;
  }
  S.renderer.render(S.scene, S.camera);
}

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    S.renderer.toneMapping = THREE.NoToneMapping;
    S.renderer.autoClear = false;
    S.camera.fov = 50;
    S.camera.setViewOffset(1920, 1080, 0, 120, 1920, 1080);
    S.camera.updateProjectionMatrix();
    spark = new SparkRenderer({ renderer: S.renderer, maxStdDev: Math.sqrt(8) });
    S.scene.add(spark);
    const load = async (f: string) => {
      const m = new SplatMesh({ url: `${SCENE}/${f}` });
      await m.initialized;
      S.scene.add(m);
      return m;
    };
    before = await load('world.spz');
    after = await load('world-filled.spz');
    gaps = await json('/film/assets/genfill/gaps2/gaps.json');

    ui.line = el('', 0, 0, '');
    ui.line.style.cssText += 'top:0;height:1080px;width:2px;background:#fff;box-shadow:0 0 12px rgba(0,0,0,.4)';
    ui.knob = el('', 0, 0, '‹›');
    ui.knob.style.cssText += 'top:400px;width:52px;height:52px;margin-left:-26px;border-radius:50%;background:#fff;color:#1d1d1f;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;letter-spacing:4px;box-shadow:0 4px 18px rgba(0,0,0,.35)';
    ui.lB = el('axis', 260, 60, 'Before');
    ui.lA = el('axis', 0, 60, 'After');

    // Missing, by how far up you look: the gap finder's own numbers
    const by = gaps.summary.byPitch as Record<string, { hole: number }>;
    const rows = Object.entries(by).map(([p, v]) => [Number(p), v.hole] as const).sort((a, b) => a[0] - b[0]);
    const chart = el('', 1340, 120, '');
    chart.style.cssText += 'width:420px;height:470px;border-radius:24px;background:rgba(29,29,31,.72);backdrop-filter:blur(18px)';
    const max = 0.2;
    chart.innerHTML = `<div class="callout" style="position:absolute;left:32px;top:28px">Missing, by how far up you look</div>` +
      rows.map(([p, h], i) => `
        <div class="bar" data-h="${h}" style="position:absolute;bottom:92px;left:${48 + i * 92}px;width:56px;height:0;border-radius:10px 10px 4px 4px;background:${BLUE}"></div>
        <div class="value" data-v="${h}" style="position:absolute;left:${36 + i * 92}px;width:80px;text-align:center;font-size:24px"></div>
        <div class="axis" style="position:absolute;bottom:52px;left:${36 + i * 92}px;width:80px;text-align:center">${p > 0 ? '+' : ''}${p}°</div>`).join('') +
      `<div class="axis" style="position:absolute;left:32px;bottom:20px">${gaps.views.length.toLocaleString('en-US')} views from ${gaps.spots.length} standing spots</div>`;
    ui.chart = chart;
    (ui.chart as any)._max = max;

    words = story('Filling the gaps', 'Look up, and the photos run out.',
      `We render ${gaps.views.length.toLocaleString('en-US')} views from every spot a person can stand and measure what is missing. <img src="/film/assets/logos/gemini-sparkle.svg" style="height:24px;vertical-align:-4px;margin:0 6px 0 2px">Gemini works with our other models to describe it, paint it, and lift it back into 3D.`);
  },

  async frame(t) {
    // stand under the palms and tilt up into the crowns
    const tilt = ease.site(seg(t, 0, 3.2));
    S.camera.position.copy(EYE);
    S.camera.rotation.order = 'YXZ';
    S.camera.rotation.set(THREE.MathUtils.degToRad(lerp(4, 40, tilt)), THREE.MathUtils.degToRad(135 + 6 * seg(t, 0, DUR)), 0);
    S.camera.updateMatrixWorld();

    // the slider: everything left of it is the world before the fill
    const w = t < 3.3 ? 1 : 1 - 0.62 * ease.site(seg(t, 3.3, 6.3)) + 0.04 * Math.sin(seg(t, 6.3, 8) * Math.PI);
    const xw = Math.round(1920 * w);
    S.renderer.setScissorTest(true);
    S.renderer.clear();
    await draw(before, after, 0, xw);
    if (xw < 1920) await draw(after, before, xw, 1920);
    S.renderer.setScissorTest(false);
    const show = t >= 3.3 ? 1 : 0;
    ui.line.style.left = ui.knob.style.left = `${xw}px`;
    ui.line.style.opacity = ui.knob.style.opacity = String(show * ease.site(seg(t, 3.3, 3.6)));
    ui.lB.style.opacity = String(ease.site(seg(t, 3.3, 3.7)));
    ui.lA.style.left = `${Math.min(xw + 20, 1860)}px`;
    ui.lA.style.opacity = String(ease.site(seg(t, 3.9, 4.3)));

    // the chart grows
    const g = ease.site(seg(t, 1.0, 2.6));
    ui.chart.style.opacity = String(ease.site(seg(t, 0.6, 1.2)));
    ui.chart.querySelectorAll<HTMLElement>('.bar').forEach((b) => (b.style.height = `${(Number(b.dataset.h) / 0.2) * 250 * g}px`));
    ui.chart.querySelectorAll<HTMLElement>('.value').forEach((v) => {
      const h = Number(v.dataset.v);
      v.textContent = `${(h * 100 * g).toFixed(1)}%`;
      v.style.bottom = `${92 + (h / 0.2) * 250 * g + 10}px`;
    });
    words.show(t, 0.5);
  },
};

export default shot;
