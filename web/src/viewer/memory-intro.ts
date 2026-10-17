// "The photo becomes the world": the moment you enter a memory.
//
// You first see the picture that made the world (one-photo worlds: the input photo; reconstructed worlds: the input
// view nearest the spawn; video memories: the clip's first frame) floating in a dark space, where its camera took it
// and at its field of view. After a beat it comes toward you: its camera centre travels to the spot where the photo
// was taken while every pixel lifts along its own ray to the depth of the world behind it. Each pixel dissolves as the
// world's reveal front (SplatFx), growing out from that camera position, reaches the place it landed, until the room
// is all around you and the photo is gone. Leaving plays it backwards: the world shrinks back into the card.
//
// Comfort: the head and the rig never move; only the card and the reveal do. Any button or key skips it, ?intro=0
// turns it off, and prefers-reduced-motion swaps the motion for a short crossfade. A scene without a usable picture
// or camera gets no memory intro (the viewer keeps its plain reveal).
// The pure parts (camera choice, relief, timeline) live in memory-plan.ts.

import * as THREE from 'three';
import type { Scene, VideoLayer } from '../../../shared/types.ts';
import { mixRgb, type Bounds, type SkyPalette } from './analysis.ts';
import type { SkyDome, SplatFx } from './effects.ts';
import {
  buildRelief,
  ENTER,
  ENTER_REDUCED,
  enterMoment,
  fitIntrinsics,
  imageCandidates,
  inputImage,
  isPinhole,
  LEAVE,
  LEAVE_REDUCED,
  leaveMoment,
  occupancySampler,
  rankCameras,
  reliefGrid,
  wrapAngle,
  yawPitch,
  type CameraRecord,
  type Moment,
  type Occupancy,
  type PinholeCamera,
  type Relief,
  type Shape,
  type Stand,
  type V3,
} from './memory-plan.ts';

/** The picture a world was made from, with the camera that took it (world frame). */
export interface MemorySource {
  kind: 'photo' | 'view' | 'frame';
  /** What it is (file or camera name), for the debug readout. */
  label: string;
  image: HTMLImageElement | HTMLCanvasElement;
  camera: PinholeCamera;
  /** z-depth in metres at an image pixel (x right, y down) when the source carries its own depth (video frames). */
  depthAt?: (px: number, py: number) => number;
  /** True at an image pixel that shows one of the video's people (video frames). */
  personAt?: (px: number, py: number) => boolean;
  /** Distance from the camera to the video's subject (metres), when known. */
  subject?: number;
}

export interface FindContext {
  scene: Scene;
  /** Scene folder URL, ending in '/'. */
  base: string;
  /** Viewer frame (scene.json) -> world frame (floor at 0). */
  toWorld: (p: V3) => V3;
  spawn: Stand;
  eyeY: number;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!(img.naturalWidth > 8 && img.naturalHeight > 8)) return reject(new Error(`empty image ${url}`));
      // decoded off the main thread now, not on the frame the photo first appears
      img.decode().catch(() => undefined).then(() => resolve(img));
    };
    img.onerror = () => reject(new Error(`no image at ${url}`));
    img.src = url;
  });
}

/** The first frame of a video as a canvas (the element is released straight after). */
async function firstFrame(url: string, timeoutMs = 8000): Promise<HTMLCanvasElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the first frame took too long')), timeoutMs);
      v.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
      v.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the video did not load')); }, { once: true });
      v.src = url;
    });
    if (!(v.videoWidth > 0 && v.videoHeight > 0)) throw new Error('the video has no picture');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d', { willReadFrequently: true })!.drawImage(v, 0, 0);
    return c;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

async function fromVideo(layer: VideoLayer, ctx: FindContext): Promise<MemorySource | null> {
  if (layer.layout !== 'tw-pack-v1' || layer.depth?.encoding !== 'inverse') return null;
  const pose = layer.cameraPose;
  const cam0: Partial<PinholeCamera> = { position: ctx.toWorld(pose.position), quaternion: pose.quaternion, width: layer.width, height: layer.height, ...layer.intrinsics };
  if (!isPinhole(cam0)) return null;
  const packed = await firstFrame(ctx.base + encodePath(layer.file));
  const W = packed.width;
  const rgbRows = Math.round(packed.height / 1.5);
  const rgb = document.createElement('canvas');
  rgb.width = W;
  rgb.height = rgbRows;
  rgb.getContext('2d')!.drawImage(packed, 0, 0, W, rgbRows, 0, 0, W, rgbRows);
  // tw-pack-v1: below the picture, depth on the left half and the people mask on the right half
  const half = Math.floor(W / 2), dh = packed.height - rgbRows;
  const px = packed.getContext('2d', { willReadFrequently: true })!.getImageData(0, rgbRows, W, dh).data;
  const { near, far } = layer.depth;
  const decode = (v: number) => 1 / (1 / far + v * (1 / near - 1 / far));
  const cam = fitIntrinsics(cam0, W, rgbRows);
  const cell = (x: number, y: number) => {
    const u = Math.min(half - 1, Math.max(0, Math.floor((x / cam.width) * half)));
    const v = Math.min(dh - 1, Math.max(0, Math.floor((y / cam.height) * dh)));
    return v * W + u;
  };
  const depthAt = (x: number, y: number) => decode(px[cell(x, y) * 4] / 255);
  const personAt = (x: number, y: number) => px[(cell(x, y) + half) * 4] > 127;
  // where the people stand: median depth under the mask
  const people: number[] = [];
  for (let v = 0; v < dh; v += 3) {
    for (let u = 0; u < half; u += 3) {
      if (px[(v * W + half + u) * 4] > 127) people.push(decode(px[(v * W + u) * 4] / 255));
    }
  }
  people.sort((a, b) => a - b);
  const subject = people.length > 20 ? people[people.length >> 1] : Math.sqrt(near * far);
  return { kind: 'frame', label: `${layer.file} @ 0:00`, image: rgb, camera: cam, depthAt, personAt, subject };
}

async function fromInputCamera(ctx: FindContext): Promise<MemorySource | null> {
  const file = inputImage(ctx.scene);
  if (!file) return null;
  const ic = (await fetchJson(ctx.base + 'input_camera.json')) as Partial<PinholeCamera> | null;
  if (!ic || !Array.isArray(ic.position)) return null;
  const cam0: Partial<PinholeCamera> = { ...ic, position: ctx.toWorld(ic.position as V3) };
  if (!isPinhole(cam0)) return null;
  const img = await loadImage(ctx.base + encodePath(file));
  return { kind: 'photo', label: file, image: img, camera: fitIntrinsics(cam0, img.naturalWidth, img.naturalHeight) };
}

async function fromCameras(ctx: FindContext): Promise<MemorySource | null> {
  const doc = (await fetchJson(ctx.base + 'cameras.json')) as { cameras?: CameraRecord[] } | null;
  const cams = Array.isArray(doc?.cameras) ? doc.cameras : [];
  for (const cam of rankCameras(cams, ctx.spawn, ctx.eyeY, ctx.toWorld).slice(0, 2)) {
    for (const rel of imageCandidates(ctx.scene, cam)) {
      try {
        const img = await loadImage(ctx.base + encodePath(rel));
        const pinhole: PinholeCamera = { position: ctx.toWorld(cam.position), quaternion: cam.quaternion, ...cam.intrinsics };
        return { kind: 'view', label: rel, image: img, camera: fitIntrinsics(pinhole, img.naturalWidth, img.naturalHeight) };
      } catch {
        /* next place, then the next view */
      }
    }
  }
  return null;
}

/**
 * Finds the picture this world was made from: the video's first frame, the one input photo (with its camera from
 * input_camera.json), or the reconstructed input view nearest the spawn (cameras.json). Null when there is none.
 */
export async function findMemorySource(ctx: FindContext): Promise<MemorySource | null> {
  const { scene } = ctx;
  if (scene.video) return fromVideo(scene.video, ctx);
  const source = scene.world?.source;
  if (source === 'flashworld') return fromInputCamera(ctx);
  if (source === 'other' || source === 'anysplat') return fromCameras(ctx);
  return null;
}

/**
 * The relief for a source: rays marched through the world's occupancy grid, so every pixel lands on the world itself
 * and the picture matches it from any eye (a video's own depth can disagree with its splat world by metres). A video's
 * people keep the video's depth (the video layer draws them there) where it is in front of the world, as does a frame
 * whose rays mostly miss the grid.
 */
export function reliefFor(src: MemorySource, world: Occupancy & { size?: number }, bounds: Bounds): Relief {
  const cam = src.camera;
  const { cols, rows } = reliefGrid(cam, 56);
  let reach = 0;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    reach = Math.max(reach, Math.hypot(x - cam.position[0], y - cam.position[1], z - cam.position[2]));
  }
  reach = Math.min(80, Math.max(4, reach));
  const occupied = occupancySampler(world, cam, Math.max(0.03, (world.size ?? 0.1) * 0.5), reach);
  const own = src.depthAt;
  if (!own) return buildRelief(cam, cols, rows, occupied, reach * 0.75);
  const person = src.personAt;
  const mixed = buildRelief(cam, cols, rows, (tx, ty, px, py) => {
    const w = occupied(tx, ty, px, py);
    if (!person?.(px, py)) return w;
    // someone the video places behind the world's own surface on this ray would tear the card open: the surface wins
    const v = own(px, py);
    return Number.isFinite(w) && w < v ? w : v;
  }, reach * 0.75);
  return mixed.coverage >= 0.4 ? mixed : buildRelief(cam, cols, rows, (_tx, _ty, px, py) => own(px, py), reach * 0.75);
}

// ---------------------------------------------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute vec2 aTan;
attribute float aDepth;
attribute float aFade;
uniform float uCard;
uniform float uLift;
uniform float uPush;
uniform float uParallax;
uniform float uMid;
varying vec2 vUv;
varying float vDist;
void main() {
  // Each pixel lifts from the flat card (uCard) to the depth of the world behind it, uPush further out while the card
  // travels. Kept on its own ray from a centre uPush ahead, seen from where the photo was taken (the eye), a relief
  // that deep tears open at the edges of near things; so the picture grows as one, at the pace of its median-depth
  // pixel, keeping only uParallax of each pixel's own parallax: enough to come alive, not enough to tear. At the end
  // (push 0) every pixel lies on the world, exactly on its ray.
  float z = mix(uCard, aDepth, uLift);
  float zo = z + uPush;
  float zr = mix(uCard, uMid, uLift);
  float k = mix(zr / (zr + uPush), z / zo, uParallax);
  vec3 p = vec3(aTan * k * zo, -zo);
  vUv = uv;
  vDist = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uAlpha;
uniform float uFront;
uniform float uBand;
uniform float uCorner;
uniform float uFeather;
uniform float uAspect;
varying vec2 vUv;
varying float vDist;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  // the print: rounded corners, a crisp edge that softens into the world as it lifts
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float sd = sdRound(p, vec2(0.5 * uAspect, 0.5), uCorner * 0.028);
  float aa = max(fwidth(sd), 1e-5);
  float frame = clamp(-sd / max(uFeather * 0.07, aa * 1.25), 0.0, 1.0);
  // each pixel dissolves once the world's reveal front has passed the place it lands (never before:
  // the world must be there behind it); grain fixed to the picture breaks the line up into fine dust
  float n = 0.6 * vnoise(p * 7.0) + 0.4 * vnoise(p * 61.0);
  float d = vDist * (1.0 + n * 0.22);
  float gone = smoothstep(d, d + uBand, uFront);
  float a = uAlpha * frame * (1.0 - gone);
  if (a < 0.002) discard;
  gl_FragColor = vec4(texture2D(uMap, vUv).rgb, a);
  #include <colorspace_fragment>
}`;

const DARK_SKY: SkyPalette = { top: [0.02, 0.02, 0.024], horizon: [0.034, 0.034, 0.039], bottom: [0.012, 0.012, 0.014] };
const mixSky = (a: SkyPalette, b: SkyPalette, t: number): SkyPalette => ({ top: mixRgb(a.top, b.top, t), horizon: mixRgb(a.horizon, b.horizon, t), bottom: mixRgb(a.bottom, b.bottom, t) });

const STYLE_ID = 'dv-memory-style';
/** What steps aside on a screen while the memory plays: the page chrome, toasts, the guide's and the live layer's DOM. */
const CHROME = ['#tw-hud .tw-top', '#tw-hud .tw-status', '#tw-hud .tw-hint', '#tw-hud .tw-coach', '#tw-hud .tw-transport', '#tw-hud .tw-help', '#tw-hud .tw-stick', '#tw-toasts', '.dvg-root', '.dvs-root'];
const STYLE = `
${CHROME.map((c) => `body.dv-memory ${c}`).join(', ')} {
  opacity: 0 !important; pointer-events: none !important; transition: opacity 0.35s ease !important;
}
${CHROME.map((c) => `body.dv-memory-out ${c}`).join(', ')} {
  transition: opacity 0.7s ease !important;
}`;

export interface MemoryHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** The user camera: on a screen the desktop camera, in a headset its world matrix is the head. */
  camera: THREE.Camera;
  fx: SplatFx;
  sky: SkyDome;
  /** The world's own sky (analysis palette). */
  palette(): SkyPalette;
  /** World bounds (for the reveal radius). */
  bounds(): Bounds;
  /** Video layer opacity, when there is one. */
  setVideoAlpha?(a: number): void;
  /**
   * Objects kept hidden while the memory plays (the floor pool under a camera-only room, presence ghosts, notes):
   * asked every frame, since the live layer starts after the intro does.
   */
  hide?(): (THREE.Object3D | null | undefined)[];
  /** The page body, whose chrome steps aside while the memory plays on a screen (null: leave it alone). */
  page?: HTMLElement | null;
}

export type MemoryPhase = 'idle' | 'wait' | 'enter' | 'shown' | 'leave' | 'left';

const Y = new THREE.Vector3(0, 1, 0);

export class MemoryIntro {
  phase: MemoryPhase = 'idle';
  readonly reduced: boolean;
  private readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly texture: THREE.Texture;
  private readonly u: Record<string, THREE.IUniform>;
  private readonly shape: Shape;
  private readonly origin = new THREE.Vector3();
  private aligned = true;
  private anchored = false;
  private t = 0;
  private speed = 1;
  private waitLeft = 0;
  private holdAt: number | null = null;
  private lastFront = -1;
  private lastBand = -1;
  private savedGlow: number | null = null;
  private hidden: { obj: THREE.Object3D; was: boolean }[] = [];
  private resolve: (() => void) | null = null;
  private prevButtons = new Map<string, boolean>();
  private listening = false;
  private outTimer = 0;
  private skipped = false;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly host: MemoryHost, readonly source: MemorySource, readonly relief: Relief) {
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cam = source.camera;
    // the card starts 1.8 m away: 1.3 m from its own camera centre, which itself sits 0.5 m ahead of where the
    // photo was taken and travels back to it (reduced motion: nothing travels; the picture sits at the world's depth)
    this.shape = {
      travel: this.reduced ? 0 : 0.5,
      card: this.reduced ? 1.8 : 1.3,
      near: relief.near,
      far: relief.far,
      max: this.revealReach(cam.position),
      subject: source.subject ?? 0,
    };

    this.texture = source.image instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source.image) : new THREE.Texture(source.image);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = Math.min(8, host.renderer.capabilities.getMaxAnisotropy());
    this.texture.needsUpdate = true;

    this.u = {
      uMap: { value: this.texture },
      uAlpha: { value: 0 },
      uFront: { value: 0 },
      uBand: { value: 0.5 },
      uCorner: { value: 1 },
      uFeather: { value: 0 },
      uAspect: { value: cam.width / cam.height },
      uLift: { value: 0 },
      uCard: { value: this.shape.card },
      uPush: { value: this.shape.travel },
      uParallax: { value: 0.25 },
      uMid: { value: relief.mid },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(buildCardGeometry(relief), material);
    this.mesh.name = 'memory-card';
    this.mesh.frustumCulled = false;
    // after the splats and the video layer, before the head veil: the card is the nearest thing on its rays
    this.mesh.renderOrder = 150;
    this.group.name = 'memory';
    this.group.visible = false;
    this.group.add(this.mesh);
    host.scene.add(this.group);
    this.warm();
  }

  /**
   * Uploads the photo and compiles the card's shader now, while the loader is up: done lazily, they cost about
   * a tenth of a second on the very frame the photo first fades in.
   */
  private warm(): void {
    try {
      this.host.renderer.initTexture(this.texture);
      this.host.renderer.compile(this.mesh, this.host.camera, this.host.scene);
    } catch (e) {
      console.warn('memory card warm-up skipped', e);
    }
  }

  /** The intro is changing what is on screen (the app holds its own fades and frame-time tuning meanwhile). */
  get active(): boolean {
    return this.phase === 'wait' || this.phase === 'enter' || this.phase === 'leave';
  }

  /** The world can shrink back into the picture (it is shown, or still growing). */
  get canLeave(): boolean {
    return this.phase !== 'idle' && this.phase !== 'left';
  }

  /**
   * On a screen, before enter(): places the card for a viewer whose eye is at `eye` (where the photo was taken when
   * that is close, else straight ahead of the eye) and returns the yaw and pitch that look at it.
   */
  frameFor(eye: THREE.Vector3): { yaw: number; pitch: number } {
    const camYaw = yawPitch(this.source.camera.quaternion).yaw;
    this.placeAnchor(eye, camYaw);
    const cam = this.source.camera;
    const z = this.shape.card;
    const local = new THREE.Vector3(((cam.width / 2 - cam.cx) / cam.fx) * z, (-(cam.height / 2 - cam.cy) / cam.fy) * z, -z - this.shape.travel);
    const c = this.group.localToWorld(local).sub(eye);
    return { yaw: Math.atan2(-c.x, -c.z), pitch: Math.atan2(c.y, Math.hypot(c.x, c.z)) };
  }

  /**
   * Plays the entry. `delay` keeps the world dark for a moment first (the page loader fading, a headset session
   * starting). In a headset (`xr`) the card is placed from the head pose when the delay ends. Resolves when the world
   * is complete (or the intro was skipped or cancelled).
   */
  enter(opts: { delay?: number; xr?: boolean } = {}): Promise<void> {
    this.settle();
    if (opts.xr) this.anchored = false;
    this.phase = 'wait';
    this.waitLeft = Math.max(0, opts.delay ?? 0);
    this.t = -(this.reduced ? ENTER_REDUCED.preroll : ENTER.preroll);
    this.speed = 1;
    this.skipped = false;
    this.begin();
    this.apply(this.momentAt('enter', this.t));
    this.group.visible = false;
    return new Promise((r) => (this.resolve = r));
  }

  /** Plays the exit: the world shrinks back into the card in front of you. Resolves on the card in the dark. */
  leave(): Promise<void> {
    if (this.phase === 'left' || this.phase === 'idle') return Promise.resolve();
    this.settle();
    this.placeFromHead();
    this.phase = 'leave';
    this.t = 0;
    this.speed = 1;
    this.skipped = false;
    this.begin();
    this.apply(this.momentAt('leave', 0));
    return new Promise((r) => (this.resolve = r));
  }

  /** Hurries to the end (any button or key). */
  skip(): void {
    if (this.holdAt !== null || this.skipped) return;
    if (this.phase === 'wait') {
      this.waitLeft = 0;
      this.startTimeline();
    }
    if (this.phase === 'enter' || this.phase === 'leave') {
      const end = this.endOf(this.phase);
      this.skipped = true;
      this.speed = Math.max(1, (end - this.t) / (this.phase === 'enter' ? 0.35 : 0.25));
    }
  }

  /** Shows the world at once, without the card (flip, errors, a headset session ending mid-way). */
  cancel(): void {
    if (this.phase === 'idle') return;
    this.holdAt = null;
    this.finish('shown');
  }

  /**
   * Test hook: freezes the intro at `t` seconds of `phase` (entering or leaving), or lets it run on (null).
   * The card is anchored from the current head or screen pose the first time.
   */
  hold(t: number | null, phase: 'enter' | 'leave' = 'enter'): void {
    if (t === null) {
      this.holdAt = null;
      return;
    }
    if (this.phase !== phase) {
      this.settle();
      if (!this.anchored || phase === 'leave') this.placeFromHead();
      this.phase = phase;
      this.begin();
    }
    this.group.visible = true;
    this.holdAt = t;
    this.t = t;
  }

  update(dt: number): void {
    if (!this.active) return;
    if (this.phase === 'wait') {
      if (this.pressed()) this.skip();
      if (this.phase === 'wait') {
        this.waitLeft -= dt;
        if (this.waitLeft > 0) return;
        this.startTimeline();
      }
    }
    if (this.holdAt !== null) this.t = this.holdAt;
    else {
      if (this.pressed()) this.skip();
      this.t += dt * this.speed;
    }
    const phase = this.phase as 'enter' | 'leave';
    this.apply(this.momentAt(phase, Math.min(this.t, this.endOf(phase))));
    if (this.holdAt === null && this.t >= this.endOf(phase)) this.finish(phase === 'enter' ? 'shown' : 'left');
  }

  debug(): Record<string, unknown> {
    const r = this.relief;
    return {
      phase: this.phase,
      t: Math.round(this.t * 1000) / 1000,
      kind: this.source.kind,
      label: this.source.label,
      aligned: this.aligned,
      reduced: this.reduced,
      grid: [r.cols, r.rows],
      near: round2(r.near),
      mid: round2(r.mid),
      far: round2(r.far),
      reach: round2(this.shape.max),
      coverage: round2(r.coverage),
      subject: round2(this.shape.subject),
      fov: round2((2 * Math.atan(this.source.camera.height / 2 / this.source.camera.fy) * 180) / Math.PI),
    };
  }

  dispose(): void {
    this.stopListening();
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }

  // ----------------------------------------------------------------------------------------------------------

  /** Reveal radius from `p` that covers the whole world. */
  private revealReach(p: ArrayLike<number>): number {
    const b = this.host.bounds();
    let r = 0;
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      r = Math.max(r, Math.hypot(x - p[0], y - p[1], z - p[2]));
    }
    return r + 2;
  }

  private endOf(phase: 'enter' | 'leave'): number {
    if (phase === 'enter') return this.reduced ? ENTER_REDUCED.end : ENTER.end;
    return this.reduced ? LEAVE_REDUCED.end : LEAVE.end;
  }

  private momentAt(phase: 'enter' | 'leave', t: number): Moment {
    return phase === 'enter' ? enterMoment(t, this.shape, this.reduced) : leaveMoment(t, this.shape, this.reduced);
  }

  /** Where the eye is and which way it looks (head in a headset, the camera on a screen). */
  private eyePose(): { eye: THREE.Vector3; yaw: number } {
    const cam = this.host.camera;
    cam.updateWorldMatrix(true, false);
    const eye = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const f = this.tmp.set(0, 0, -1).transformDirection(cam.matrixWorld);
    return { eye, yaw: Math.atan2(-f.x, -f.z) };
  }

  private placeFromHead(): void {
    const { eye, yaw } = this.eyePose();
    this.placeAnchor(eye, yaw);
  }

  /**
   * Exactly where the photo was taken when the eye is near that spot and facing about the same way (then the relief
   * lands on the world itself); otherwise straight ahead of the eye, turned to the way it faces.
   */
  private placeAnchor(eye: THREE.Vector3, yaw: number): void {
    const cam = this.source.camera;
    const p = new THREE.Vector3(...cam.position);
    const q = new THREE.Quaternion(...cam.quaternion).normalize();
    const turn = wrapAngle(yaw - yawPitch(cam.quaternion).yaw);
    const close = Math.hypot(eye.x - p.x, eye.z - p.z) < 0.75 && Math.abs(eye.y - p.y) < 0.9;
    this.aligned = close && Math.abs(turn) < THREE.MathUtils.degToRad(50);
    if (this.aligned) {
      this.group.position.copy(p);
      this.group.quaternion.copy(q);
    } else {
      this.group.position.copy(eye);
      this.group.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(Y, turn).multiply(q));
    }
    this.group.updateMatrixWorld(true);
    this.origin.copy(this.group.position);
    // the front grows from (and shrinks to) the card: from the eye, when the card is not where the photo was taken
    this.shape.max = this.revealReach([this.origin.x, this.origin.y, this.origin.z]);
    this.anchored = true;
  }

  private startTimeline(): void {
    if (!this.anchored) this.placeFromHead();
    this.phase = 'enter';
    this.group.visible = true;
  }

  /** Takes over the reveal, the sky and the chrome. */
  private begin(): void {
    const fx = this.host.fx;
    if (this.savedGlow === null) this.savedGlow = fx.glow.value;
    fx.glow.value = 0;
    this.lastFront = this.lastBand = -1;
    this.hideOthers();
    this.prevButtons.clear();
    this.primeButtons();
    this.listen();
    this.chrome(true);
  }

  /** Ends whatever was playing without resolving into a new state (a new enter/leave takes over). */
  private settle(): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
    this.holdAt = null;
  }

  private finish(to: 'shown' | 'left'): void {
    const fx = this.host.fx;
    if (to === 'shown') {
      this.group.visible = false;
      fx.setReveal(1e5, this.origin);
      this.host.sky.setPalette(this.host.palette());
      this.host.setVideoAlpha?.(1);
      for (const h of this.hidden) h.obj.visible = h.was;
      this.hidden = [];
    } else {
      this.apply(this.momentAt('leave', this.endOf('leave')));
    }
    if (this.savedGlow !== null) fx.glow.value = this.savedGlow;
    this.savedGlow = null;
    fx.touch();
    this.phase = to;
    this.stopListening();
    this.chrome(false);
    const r = this.resolve;
    this.resolve = null;
    r?.();
  }

  /** Keeps what is not part of the picture out of the dark (restored by finish). */
  private hideOthers(): void {
    for (const obj of this.host.hide?.() ?? []) {
      if (!obj) continue;
      if (!this.hidden.some((h) => h.obj === obj)) this.hidden.push({ obj, was: obj.visible });
      obj.visible = false;
    }
  }

  private apply(m: Moment): void {
    this.hideOthers();
    const u = this.u;
    u.uAlpha.value = m.alpha;
    u.uPush.value = m.push;
    u.uLift.value = m.lift;
    u.uFront.value = m.front;
    u.uBand.value = m.band;
    u.uCorner.value = m.corner;
    u.uFeather.value = m.feather;
    this.group.visible = this.phase !== 'wait' && m.alpha > 0.002;
    if (Math.abs(m.front - this.lastFront) > 1e-4 || Math.abs(m.band - this.lastBand) > 1e-4) {
      this.lastFront = m.front;
      this.lastBand = m.band;
      this.host.fx.setReveal(m.front, this.origin, m.band);
    }
    this.host.sky.setPalette(mixSky(DARK_SKY, this.host.palette(), m.sky));
    this.host.setVideoAlpha?.(m.video);
  }

  /** The page chrome steps aside on a screen while the memory plays. */
  private chrome(on: boolean): void {
    const hud = this.host.page;
    if (!hud || typeof document === 'undefined') return;
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = STYLE;
      document.head.append(s);
    }
    clearTimeout(this.outTimer);
    if (on) {
      hud.classList.remove('dv-memory-out');
      hud.classList.add('dv-memory');
    } else if (hud.classList.contains('dv-memory')) {
      hud.classList.remove('dv-memory');
      hud.classList.add('dv-memory-out');
      this.outTimer = window.setTimeout(() => hud.classList.remove('dv-memory-out'), 900);
    }
  }

  // ---- skipping: any key, click or touch on a screen; any controller button or a stick push in a headset ----

  private onInput = (e: Event) => {
    if (e instanceof KeyboardEvent && (e.repeat || e.metaKey || e.ctrlKey)) return;
    this.skip();
  };

  private listen(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('keydown', this.onInput);
    window.addEventListener('pointerdown', this.onInput);
    window.addEventListener('wheel', this.onInput, { passive: true });
    window.addEventListener('touchstart', this.onInput, { passive: true });
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.onInput);
    window.removeEventListener('pointerdown', this.onInput);
    window.removeEventListener('wheel', this.onInput);
    window.removeEventListener('touchstart', this.onInput);
  }

  /** Buttons already held when the intro starts (the trigger that pressed Enter VR) must be let go first. */
  private primeButtons(): void {
    const session = this.host.renderer.xr.getSession?.();
    if (!session) return;
    for (const src of session.inputSources) {
      src.gamepad?.buttons.forEach((b, i) => this.prevButtons.set(`${src.handedness}:${i}`, b.pressed));
    }
  }

  private pressed(): boolean {
    if (!this.host.renderer.xr.isPresenting) return false;
    const session = this.host.renderer.xr.getSession();
    if (!session) return false;
    let any = false;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      gp.buttons.forEach((b, i) => {
        const key = `${src.handedness}:${i}`;
        const was = this.prevButtons.get(key) ?? b.pressed;
        if (b.pressed && !was) any = true;
        this.prevButtons.set(key, b.pressed);
      });
      for (const a of gp.axes) if (Math.abs(a) > 0.6) any = true;
    }
    return any;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The card: one vertex per relief grid point, triangles ordered far to near so the relief overlaps itself right. */
function buildCardGeometry(r: Relief): THREE.BufferGeometry {
  const W = r.cols + 1, H = r.rows + 1, n = W * H;
  const g = new THREE.BufferGeometry();
  const uv = new Float32Array(n * 2);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      uv[k * 2] = i / r.cols;
      uv[k * 2 + 1] = 1 - j / r.rows;
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aTan', new THREE.BufferAttribute(r.tan, 2));
  g.setAttribute('aDepth', new THREE.BufferAttribute(r.depth, 1));
  g.setAttribute('aFade', new THREE.BufferAttribute(r.fade, 1));
  const tris: { a: number; b: number; c: number; d: number }[] = [];
  for (let j = 0; j < r.rows; j++) {
    for (let i = 0; i < r.cols; i++) {
      const k = j * W + i;
      const k1 = k + 1, k2 = k + W, k3 = k + W + 1;
      tris.push({ a: k, b: k2, c: k1, d: Math.max(r.depth[k], r.depth[k2], r.depth[k1]) });
      tris.push({ a: k1, b: k2, c: k3, d: Math.max(r.depth[k1], r.depth[k2], r.depth[k3]) });
    }
  }
  tris.sort((x, y) => y.d - x.d);
  const index = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => index.set([t.a, t.b, t.c], i * 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}
