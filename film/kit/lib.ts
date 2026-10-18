// Shared pieces for the film shots: one look, deterministic time, and a three.js stage.
// A shot is a module whose default export is a Shot. The renderer calls frame(t) for every frame, so nothing may
// depend on wall-clock time: every animation is a pure function of t.
import * as THREE from 'three';

export const W = 1920;
export const H = 1080;
export const LIME = '#C6FF3D';
export const INK = '#F5F5F7';
export const SKY = '#64D2FF';
export const BG = '#060607';

export interface Shot {
  duration: number;
  setup(): Promise<void>;
  frame(t: number): void | Promise<void>;
}

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** 0 before a, 1 after b, linear between. */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
export const ease = {
  out: (x: number) => 1 - Math.pow(1 - x, 3),
  inOut: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  expo: (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  sine: (x: number) => -(Math.cos(Math.PI * x) - 1) / 2,
};
export const fmt = (n: number, digits = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A deterministic random stream, so every render of a shot is identical. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const overlay = () => document.getElementById('overlay')!;

/** An absolutely placed overlay element. */
export function el(cls: string, x: number, y: number, html = '', parent: HTMLElement = overlay()) {
  const e = document.createElement('div');
  e.className = cls;
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

/** Fade and lift an element in over [a, b]. */
export function reveal(e: HTMLElement, t: number, a: number, b: number, lift = 16) {
  const k = ease.out(seg(t, a, b));
  e.style.opacity = String(k);
  e.style.transform = `translateY(${(1 - k) * lift}px)`;
}

export function fadeOut(e: HTMLElement, t: number, a: number, b: number) {
  e.style.opacity = String(Number(e.style.opacity || 1) * (1 - seg(t, a, b)));
}

export function stage() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.setClearColor(BG, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('gl')!.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 800);
  return { renderer, scene, camera };
}

/** Put the camera on a sphere round `target`: azimuth and elevation in degrees. */
export function orbit(camera: THREE.PerspectiveCamera, target: THREE.Vector3, dist: number, azDeg: number, elDeg: number) {
  const az = (azDeg * Math.PI) / 180;
  const elv = (elDeg * Math.PI) / 180;
  camera.position.set(
    target.x + dist * Math.cos(elv) * Math.sin(az),
    target.y + dist * Math.sin(elv),
    target.z + dist * Math.cos(elv) * Math.cos(az),
  );
  camera.lookAt(target);
}

export async function json<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) =>
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      resolve(tex);
    }, undefined, reject),
  );
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Round, soft points that fade in by a per-point reveal value as uReveal passes it. */
export function pointsMaterial(size: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uReveal: { value: 0 }, uSize: { value: size }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute float reveal;
      uniform float uReveal; uniform float uSize;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = clamp((uReveal - reveal) * 18.0, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(uSize * (0.6 + 0.4 * vAlpha) * (220.0 / -mv.z), 5.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFade; varying vec3 vColor; varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d) * 4.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(vColor, vAlpha * uFade * (1.0 - r * r));
      }`,
  });
}
