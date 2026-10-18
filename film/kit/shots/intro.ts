// Shots 1–4, the intro (20 s, no tech): inside the memory, then logged out of it.
//   0.0–6.6   the Quest POV of Shivin's dad's memory, warm, a slow push
//   6.6–9.7   the log-out: a cyan scan line, the frame de-rezzes into shards that peel off toward us while two headset
//             lenses light up and close on the last of the memory; then a warp backward out of the lenses (radial
//             streaks, chromatic aberration) and a flash
//   9.7–16.4  the real headset coming off, slowed to 0.7x, cooler and quieter
//   16.4–20   his face holds; "Déjà View" appears
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ease, el, lerp, seg, type Shot } from '../lib';

const DUR = 20;
const T_POV = 6.6, T_OFF = 9.7;
const GW = 16, GH = 9;
const NX = 120, NY = 68; // shards
const LENS = [new THREE.Vector2(-3.05, 0.25), new THREE.Vector2(3.05, 0.25)];
const R0 = 10.5, R_A = 6.9, R_B = 8.9;
const CYAN = new THREE.Color(0.35, 0.85, 1.0);

let renderer: THREE.WebGLRenderer;
let composer: EffectComposer;
let post: ShaderPass;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let screen: THREE.Mesh;
let screenMat: THREE.ShaderMaterial;
let shards: THREE.Mesh;
let shardMat: THREE.ShaderMaterial;
const rings: THREE.Mesh[] = [];
const group = new THREE.Group();
let pov: HTMLVideoElement, off: HTMLVideoElement;
let povTex: THREE.Texture, offTex: THREE.Texture;
let title: HTMLElement, flash: HTMLElement, scan: HTMLElement;

const lensR = (t: number) => R0 * (1 - ease.inOut(seg(t, R_A, R_B)));

function video(src: string) {
  const v = document.createElement('video');
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  return new Promise<HTMLVideoElement>((res, rej) => {
    v.onloadeddata = () => res(v);
    v.onerror = rej;
  });
}
async function seek(v: HTMLVideoElement, t: number) {
  t = Math.min(Math.max(t, 0), v.duration - 0.02);
  if (Math.abs(v.currentTime - t) < 1e-3) return;
  await new Promise((r) => {
    v.onseeked = () => r(null);
    v.currentTime = t;
  });
}

const POST = {
  uniforms: { tDiffuse: { value: null }, uBlur: { value: 0 }, uCA: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uBlur; uniform float uCA; uniform vec2 uCenter; varying vec2 vUv;
    void main() {
      vec2 dir = vUv - uCenter;
      vec3 acc = vec3(0.0); float w = 0.0;
      for (int i = 0; i < 28; i++) {
        float f = float(i) / 27.0;
        float s = 1.0 - uBlur * f;
        float wt = 1.0 - 0.7 * f;
        acc.r += texture2D(tDiffuse, uCenter + dir * s * (1.0 + uCA)).r * wt;
        acc.g += texture2D(tDiffuse, uCenter + dir * s).g * wt;
        acc.b += texture2D(tDiffuse, uCenter + dir * s * (1.0 - uCA)).b * wt;
        w += wt;
      }
      gl_FragColor = vec4(acc / w, 1.0);
    }`,
};

const shot: Shot = {
  duration: DUR,
  async setup() {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(1920, 1080);
    renderer.setClearColor(0x000000, 1);
    document.getElementById('gl')!.appendChild(renderer.domElement);
    (document.getElementById('shade') as HTMLElement).style.display = 'none';
    scene = new THREE.Scene();
    const fov = 30;
    camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 400);
    camera.position.set(0, 0, GH / 2 / Math.tan((fov * Math.PI) / 360));
    scene.add(group);
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    post = new ShaderPass(POST);
    composer.addPass(post);
    composer.addPass(new OutputPass());

    [pov, off] = await Promise.all([video('/film/assets/intro/pov.mp4'), video('/film/assets/intro/off.mp4')]);
    povTex = new THREE.VideoTexture(pov);
    offTex = new THREE.VideoTexture(off);
    for (const tx of [povTex, offTex]) tx.colorSpace = THREE.SRGBColorSpace;

    screenMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: povTex }, uZoom: { value: 1 }, uTop: { value: 1 }, uFade: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D uTex; uniform float uZoom; uniform float uTop; uniform float uFade; varying vec2 vUv;
        void main(){
          float k = 1.0 / uZoom;
          vec2 uv = vec2(0.5 + (vUv.x - 0.5) * k, mix(0.5 + (vUv.y - 0.5) * k, 1.0 - (1.0 - vUv.y) * k, uTop));
          vec3 c = texture2D(uTex, uv).rgb;
          float vig = smoothstep(1.25, 0.35, length((vUv - 0.5) * vec2(1.6, 1.0)));
          gl_FragColor = vec4(c * mix(0.78, 1.0, vig) * uFade, 1.0);
        }`,
    });
    screen = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), screenMat);
    scene.add(screen);

    // The frozen last frame of the memory, cropped exactly as the screen shows it at its end (zoom 1.2, from the top)
    await seek(pov, pov.duration);
    const cv = document.createElement('canvas');
    cv.width = 1920;
    cv.height = 1080;
    const zEnd = 1.2;
    const sw = pov.videoWidth / zEnd, sh = pov.videoHeight / zEnd;
    cv.getContext('2d')!.drawImage(pov, (pov.videoWidth - sw) / 2, 0, sw, sh, 0, 0, 1920, 1080);
    const frameTex = new THREE.CanvasTexture(cv);
    frameTex.colorSpace = THREE.SRGBColorSpace;

    // Shards: one instanced quad per cell, each showing its own piece of the frame
    const n = NX * NY;
    const tw = GW / NX, th = GH / NY;
    const cell = new Float32Array(n * 2), seedA = new Float32Array(n * 4), det = new Float32Array(n);
    const samples: number[] = [];
    for (let s = 0; s <= 1000; s++) samples.push(lensR(R_A + ((R_B - R_A) * s) / 1000));
    let rs = 777;
    const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        cell.set([i, j], k * 2);
        seedA.set([rnd(), rnd(), rnd(), rnd()], k * 4);
        const x = ((i + 0.5) / NX - 0.5) * GW, y = (0.5 - (j + 0.5) / NY) * GH;
        const d = Math.min(...LENS.map((c) => Math.hypot(x - c.x, y - c.y))) + (rnd() - 0.5) * 0.5;
        let s = 0;
        while (s < 1000 && samples[s] > d) s++;
        det[k] = R_A + ((R_B - R_A) * s) / 1000;
      }
    }
    const base = new THREE.PlaneGeometry(tw, th);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    geo.instanceCount = n;
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 2));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedA, 4));
    geo.setAttribute('aDetach', new THREE.InstancedBufferAttribute(det, 1));
    shardMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTex: { value: frameTex }, uTime: { value: 0 }, uCyan: { value: CYAN }, uGrid: { value: new THREE.Vector2(NX, NY) },
        uSize: { value: new THREE.Vector2(GW, GH) } },
      vertexShader: /* glsl */ `
        attribute vec2 aCell; attribute vec4 aSeed; attribute float aDetach;
        uniform float uTime; uniform vec2 uGrid; uniform vec2 uSize;
        varying vec2 vUv; varying vec2 vLocal; varying float vAge; varying float vFront; varying float vSeed; varying float vDust;
        mat3 rot(vec3 a, float g) { a = normalize(a); float s = sin(g), c = cos(g), o = 1.0 - c;
          return mat3(o*a.x*a.x+c, o*a.x*a.y+a.z*s, o*a.z*a.x-a.y*s, o*a.x*a.y-a.z*s, o*a.y*a.y+c, o*a.y*a.z+a.x*s,
                      o*a.z*a.x+a.y*s, o*a.y*a.z-a.x*s, o*a.z*a.z+c); }
        void main() {
          vec2 centre = ((aCell + 0.5) / uGrid - 0.5) * uSize * vec2(1.0, -1.0);
          float age = max(uTime - aDetach, 0.0);
          vec3 p = position;
          p = rot(vec3(aSeed.x - 0.5, aSeed.y - 0.5, 0.35), age * (2.0 + 4.0 * aSeed.z)) * p;
          p *= 1.0 - 0.35 * smoothstep(0.0, 1.4, age);
          float dust = step(aSeed.x, 0.85);            // most shards flash and dissolve where they are
          float m = mix(1.0, 0.12, dust);
          vec2 out2 = normalize(centre + vec2(0.001)) * (0.8 + aSeed.w);
          vec3 c = vec3(centre, 0.0) + m * vec3(out2 * age * (1.0 + 0.8 * age), age * age * (1.6 + 1.6 * aSeed.y) + age * 0.9);
          vDust = dust;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(c + p, 1.0);
          vUv = vec2((aCell.x + uv.x) / uGrid.x, 1.0 - (aCell.y + 1.0 - uv.y) / uGrid.y);
          vLocal = uv;
          vAge = age;
          vFront = uTime - aDetach;
          vSeed = aSeed.w;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform vec3 uCyan;
        varying vec2 vUv; varying vec2 vLocal; varying float vAge; varying float vFront; varying float vSeed; varying float vDust;
        void main() {
          vec3 c = texture2D(uTex, vUv).rgb;
          float edge = smoothstep(0.36, 0.5, max(abs(vLocal.x - 0.5), abs(vLocal.y - 0.5)));
          float lifted = smoothstep(0.0, 0.25, vAge);
          float front = exp(-pow((vFront + 0.06) / 0.045, 2.0));   // the de-rez wave just before a shard lets go
          c = mix(c, c * 0.6 + uCyan * 0.35, lifted * 0.5);
          c += uCyan * (edge * lifted * 0.8 * (1.0 - vDust * 0.5) + front * 0.35);
          float a = mix(1.0 - smoothstep(0.8 + vSeed * 0.5, 1.6 + vSeed * 0.6, vAge), 1.0 - smoothstep(0.08, 0.4 + vSeed * 0.2, vAge), vDust);
          gl_FragColor = vec4(c, a);
        }`,
    });
    shards = new THREE.Mesh(geo, shardMat);
    shards.frustumCulled = false;
    shards.visible = false;
    group.add(shards);

    // The headset's two lenses, glowing cyan as they close
    for (const c of LENS) {
      for (const [w, o] of [[0.012, 0.9], [0.06, 0.25]] as const) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(1 - w, 1, 160), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
        ring.position.set(c.x, c.y, 0.02);
        ring.userData.o = o;
        rings.push(ring);
        group.add(ring);
      }
    }

    scan = el('', 0, 0, '');
    scan.style.cssText += 'top:0;bottom:0;width:3px;background:#5ad8ff;box-shadow:0 0 24px 6px rgba(90,216,255,.7);opacity:0';
    flash = el('', 0, 0, '');
    flash.style.cssText += 'inset:0;background:#e9f6ff;opacity:0';
    title = el('', 0, 0, 'Déjà View');
    title.style.cssText += 'left:0;right:0;top:880px;text-align:center;font-size:64px;font-weight:600;letter-spacing:-0.02em;color:#f5f5f7;opacity:0';
  },

  async frame(t) {
    let blur = 0, ca = 0;
    group.position.set(0, 0, 0);
    if (t < T_POV) {
      await seek(pov, t);
      povTex.needsUpdate = true;
      screenMat.uniforms.uTex.value = povTex;
      screenMat.uniforms.uZoom.value = lerp(1.15, 1.2, ease.site(seg(t, 0, T_POV)));
      screenMat.uniforms.uTop.value = 1;
      screenMat.uniforms.uFade.value = ease.site(seg(t, 0, 0.8));
      screen.visible = true;
      shards.visible = false;
      rings.forEach((r) => (r.visible = false));
      flash.style.opacity = '0';
    } else if (t < T_OFF) {
      screen.visible = false;
      shards.visible = true;
      shardMat.uniforms.uTime.value = t;
      // the scan line crosses the frozen frame first
      const sk = seg(t, 6.6, 6.95);
      scan.style.left = `${sk * 1920}px`;
      scan.style.opacity = String(sk > 0 && sk < 1 ? 1 : 0);
      // drift back while the lenses close, then warp out of them
      const warp = Math.pow(seg(t, 8.55, 9.6), 2.2);
      group.position.z = -lerp(0, 2, ease.site(seg(t, 6.9, 8.6))) - warp * 70;
      blur = 0.42 * Math.sin(Math.PI * seg(t, 8.5, 9.65));
      ca = 0.006 * seg(t, 6.6, 7.0) + 0.03 * Math.sin(Math.PI * seg(t, 8.5, 9.65));
      const r = lensR(t);
      rings.forEach((ring) => {
        ring.visible = true;
        ring.scale.setScalar(Math.max(r, 0.9));
        (ring.material as THREE.MeshBasicMaterial).opacity = ring.userData.o * seg(t, 7.0, 7.5) * (1 - seg(t, 9.3, 9.6));
      });
      flash.style.opacity = String(0.9 * Math.max(0, 1 - Math.abs(t - 9.62) / 0.12));
    } else {
      shards.visible = false;
      rings.forEach((r) => (r.visible = false));
      scan.style.opacity = '0';
      screen.visible = true;
      const local = t - T_OFF;
      await seek(off, local);
      offTex.needsUpdate = true;
      screenMat.uniforms.uTex.value = offTex;
      const hold = seg(t, T_OFF + off.duration, DUR);
      screenMat.uniforms.uZoom.value = lerp(1.0, 1.06, ease.site(hold));
      screenMat.uniforms.uTop.value = 0;
      screenMat.uniforms.uFade.value = 1;
      flash.style.opacity = String(0.85 * (1 - ease.site(seg(local, 0, 0.55))));
      ca = 0.02 * (1 - seg(local, 0, 0.5));
    }
    post.uniforms.uBlur.value = blur;
    post.uniforms.uCA.value = ca;
    const k = ease.site(seg(t, 18.0, 19.1));
    title.style.opacity = String(k);
    title.style.transform = `translateY(${(1 - k) * 16}px)`;
    composer.render();
  },
};

export default shot;
