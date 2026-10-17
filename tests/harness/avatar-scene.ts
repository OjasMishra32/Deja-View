// Harness page (tests/harness/avatar-scene.html): the-courts world loaded the way the viewer loads it (world.ts
// loadSplatMesh + applyTransform, a SparkRenderer in the scene) with the people from IMG_7373
// (web/src/viewer/avatars.ts) on a media clock, found the way the Video memory courts-foosball will find them: in
// its place's folder (video.avatars = {scene: 'the-courts', poses: 'IMG_7373-poses.json'}).
//
//   ?t=<s>                      media time to start at (default 0)
//   &paused=1                   frozen at t: walk around the pose
//   &cam=x,y,z,yaw[,pitch]      eye in the viewer frame (m), yaw and pitch in degrees (yaw 0 looks down -Z)
//   &cam=rec                    the recording camera at t, with the clip's field of view
//   &cam=orbit,yaw[,dist,height] looking at the people's centre from `dist` m (default 2.4) at `height` (1.6)
//   &video=<url>|none           follow a real media element instead of the fake clock (default: the clip when the
//                               place serves it as input/IMG_7373.mp4 or .mov, else the fake clock)
//   &blend=0                    full opacity near the recording camera too (default: the viewer's crossfade)
//   &world=0                    people only, over a grid
//   &place=<id>                 the folder with the people and the world (default the-courts)
//   &poses=<file>               recording camera track in that folder (default IMG_7373-poses.json)
//   &shot=1                     no readout (screenshots)
//   &pip=0                      the clip's own frame not drawn in the corner (still decoded: footage() reads it)
// Keys: Space play / pause, , and . one frame back / on, WASD or arrows walk, Q / E down / up, drag to look.
// window.__avatarScene {ready, error, set({t, paused, cam, offset}), info(), probe(), scan(times), footage(), bench(n),
// frames(n)} drives it from tests/harness/avatar-scene-shots.ts. probe() measures each person's skinned mesh at the
// current pose (feet on the floor, height, hands, facing, stretched or stray vertices, inside a box such as a table);
// scan(times) does that at each media time (fake clock); footage() is the clip's frame on screen and `offset` moves
// the people's clock against it (the sync check); bench(n, people) times renders of the view with and without them.

import * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';
import type { Scene } from '../../shared/types.ts';
import { clamp, parseCameraTrack, trackPositionAt, trackQuaternionAt, type CameraSample } from '../../web/src/viewer/avatar-clock.ts';
import { createAvatars, type AvatarsHandle, type MediaClock } from '../../web/src/viewer/avatars.ts';
import { applyTransform, loadSplatMesh, splatCount } from '../../web/src/viewer/world.ts';

const params = new URLSearchParams(location.search);
const PLACE = params.get('place') || 'the-courts';
const BASE = `/data/scenes/${encodeURIComponent(PLACE)}/`;
const POSES = params.get('poses') || 'IMG_7373-poses.json';
const hudEl = document.getElementById('hud')!;
if (params.get('shot') === '1') document.body.classList.add('shot');

/** The clock the people follow: the fake one, or a real media element. */
interface Clock extends MediaClock {
  readonly duration: number;
  readonly paused: boolean;
  play(): void;
  pause(): void;
  seek(t: number): Promise<void>;
  tick(dt: number): void;
}

/** IMG_7373's timeline without its media: advances with the frame, loops like the viewer's video element. */
class FakeClock implements Clock {
  currentTime = 0;
  paused = true;
  constructor(readonly duration: number) {}
  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  async seek(t: number): Promise<void> {
    this.currentTime = clamp(t, 0, Math.max(0, this.duration - 1e-3));
  }
  tick(dt: number): void {
    if (this.paused) return;
    this.currentTime += dt;
    if (this.currentTime >= this.duration) this.currentTime %= this.duration;
  }
}

class MediaElementClock implements Clock {
  constructor(readonly el: HTMLVideoElement) {}
  get currentTime(): number {
    return this.el.currentTime;
  }
  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  get paused(): boolean {
    return this.el.paused;
  }
  play(): void {
    void this.el.play().catch((e) => console.warn('play refused', e));
  }
  pause(): void {
    this.el.pause();
  }
  seek(t: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      this.el.addEventListener('seeked', done, { once: true });
      this.el.currentTime = clamp(t, 0, Math.max(0, this.duration - 1e-3));
      setTimeout(done, 3000);
    });
  }
  tick(): void {}
}

type CamSpec =
  | { kind: 'rec' }
  | { kind: 'orbit'; yaw: number; dist: number; height: number }
  | { kind: 'fixed'; x: number; y: number; z: number; yaw: number; pitch: number };

function parseCam(s: string | null | undefined): CamSpec | null {
  if (!s) return null;
  if (s === 'rec') return { kind: 'rec' };
  const parts = s.split(',');
  if (parts[0] === 'orbit') {
    const [yaw = 0, dist = 2.4, height = 1.6] = parts.slice(1).map(Number);
    return { kind: 'orbit', yaw, dist, height };
  }
  const n = parts.map(Number);
  if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  return { kind: 'fixed', x: n[0], y: n[1], z: n[2], yaw: n[3], pitch: n[4] ?? 0 };
}

interface SetArgs {
  t?: number;
  paused?: boolean;
  cam?: string;
  blend?: boolean;
  /** Seconds added to the media time the people see (sync checks: the clip's frame stays at t). */
  offset?: number;
}

/** One person's skinned mesh at the current pose, in the viewer frame (m). */
interface ProbePerson {
  id: string;
  /** Lowest and highest skinned vertex (y): the soles and the top of the head. */
  minY: number;
  maxY: number;
  /** Lowest vertex skinned mostly to each foot chain (lower leg and below). */
  footY: { L: number; R: number };
  pelvis: number[];
  wrist: { L: number[]; R: number[] };
  head: number[];
  /** Body forward (from the hips) vs the direction to the other person, horizontal, degrees. */
  facingDeg: number | null;
  /** Farthest vertex from the pelvis; the most stretched edge (skinned / bind length) and the most lengthened (m). */
  maxFromPelvis: number;
  maxStretch: number;
  maxGrow: number;
  /** Vertices that are not finite. */
  bad: number;
  /** With a box: vertices inside it, and the deepest one (m from its nearest side). */
  inBox?: number;
  boxDepth?: number;
}

/** An upright box (e.g. a table's cabinet) in the viewer frame: centre and long axis on the floor, half sizes, y span. */
interface ProbeBox {
  centre: [number, number];
  axis: [number, number];
  half: [number, number];
  y: [number, number];
}

const api = {
  ready: false,
  error: null as string | null,
  set: async (_a: SetArgs): Promise<unknown> => null,
  info: (): unknown => null,
  probe: (_box?: ProbeBox): ProbePerson[] => [],
  scan: async (_times: number[], _box?: ProbeBox): Promise<Array<{ t: number; people: ProbePerson[] }>> => [],
  /** The media element's current frame as a PNG data URL (null on the fake clock). */
  footage: (): string | null => null,
  /** Milliseconds per render of the current view (GPU included: the batch ends in a pixel read), people shown or not. */
  bench: (_n: number, _people: boolean): number => 0,
  /**
   * Sync check at the current (paused) media time, from the current view (the recording camera): the people rendered
   * at each offset (s) against the clip's frame on screen. Error = mean difference of the two pictures, each
   * normalised over the pixels the people cover at any offset; the right clock has the smallest.
   */
  sync: (_offsets: number[]): Array<{ offset: number; err: number }> | null => null,
  frames: async (_n: number): Promise<void> => {},
};
(window as unknown as { __avatarScene: typeof api }).__avatarScene = api;

async function json(url: string): Promise<any> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function main(): Promise<void> {
  const t0 = performance.now();
  let loadMs = 0;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0c0c0e, 1);
  document.getElementById('stage')!.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 900);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  // the viewer's frame: content shifted so the floor is y = 0, the world and the video layer's parent under `flip`
  const content = new THREE.Group();
  const flip = new THREE.Group();
  content.add(flip);
  scene.add(content);

  const place = (await json(`${BASE}scene.json`)) as Scene;
  const posesDoc = await json(BASE + POSES).catch(() => null);
  const track: CameraSample[] | null = parseCameraTrack(posesDoc);
  const intr = posesDoc?.intrinsics as { width: number; height: number; fy: number } | undefined;
  const recFov = intr ? (2 * Math.atan(intr.height / 2 / intr.fy) * 180) / Math.PI : 63;
  const clipDuration = Number(posesDoc?.video?.duration) || 12.3867;

  let splats = 0;
  if (params.get('world') !== '0' && place.world) {
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    const mesh = await loadSplatMesh(BASE + place.world.file, {
      onProgress: (p) => (hudEl.textContent = `${p.stage}${p.fraction != null ? ` ${Math.round(p.fraction * 100)}%` : ''}`),
    });
    applyTransform(mesh, place.world.transform);
    content.position.y = -(place.world.floorY ?? 0);
    flip.add(mesh);
    splats = splatCount(mesh);
  } else {
    scene.add(new THREE.GridHelper(12, 24, 0x666670, 0x34343a));
  }

  // the clock: a real media element when asked for or served with the place (and playable), else IMG_7373's timeline
  let clock: Clock = new FakeClock(clipDuration);
  let videoUrl = params.get('video');
  if (!videoUrl) {
    for (const f of ['input/IMG_7373.mp4', 'input/IMG_7373.mov']) {
      const r = await fetch(BASE + f, { method: 'HEAD' }).catch(() => null);
      if (r?.ok) {
        videoUrl = BASE + f;
        break;
      }
    }
  }
  if (videoUrl === 'none') videoUrl = null;
  if (videoUrl) {
    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = videoUrl;
    el.style.cssText = `position:fixed;right:8px;bottom:8px;width:240px;opacity:${params.get('pip') === '0' ? 0 : 0.9};z-index:2`;
    document.body.append(el);
    const ok = await new Promise<boolean>((r) => {
      el.addEventListener('loadeddata', () => r(true), { once: true });
      el.addEventListener('error', () => r(false), { once: true });
      setTimeout(() => r(false), 15000);
    });
    if (ok) clock = new MediaElementClock(el);
    else {
      console.warn(`[harness] ${videoUrl} did not load; using the fake clock`);
      el.remove();
    }
  }

  // the Video memory as it will be stored: its people (and the camera track) in the place's folder
  const memory = { id: 'courts-foosball', video: { avatars: { scene: PLACE, poses: track ? POSES : undefined } } };
  // (offset: the people a little ahead of or behind the clip, for the sync check)
  let offset = 0;
  const peopleClock: MediaClock = {
    get currentTime() {
      return clock.currentTime + offset;
    },
  };
  const avatars: AvatarsHandle = createAvatars({ scene: memory, video: peopleClock, parent: flip, renderer });
  await avatars.ready;

  let cam: CamSpec = parseCam(params.get('cam')) ?? { kind: 'orbit', yaw: 30, dist: 2.6, height: 1.6 };
  let blendOn = params.get('blend') !== '0';
  await clock.seek(Number(params.get('t')) || 0);
  if (params.get('paused') !== '1') clock.play();

  // ---- camera ---------------------------------------------------------------------------------
  const centre = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const quat = { x: 0, y: 0, z: 0, w: 1 };
  /** Root bone (pelvis) of each person in world space. */
  function pelvises(): Array<{ id: string; p: THREE.Vector3 }> {
    const out: Array<{ id: string; p: THREE.Vector3 }> = [];
    for (const root of avatars.object.children) {
      root.traverse((o) => {
        const s = o as THREE.SkinnedMesh;
        if (s.isSkinnedMesh && s.skeleton.bones[0]) out.push({ id: root.name.replace(/^avatar-/, ''), p: s.skeleton.bones[0].getWorldPosition(new THREE.Vector3()) });
      });
    }
    return out;
  }
  function peopleCentre(out: THREE.Vector3): THREE.Vector3 {
    const ps = pelvises();
    out.set(0, 0.9, -1.9);
    if (!ps.length) return out;
    out.set(0, 0, 0);
    for (const q of ps) out.add(q.p);
    return out.multiplyScalar(1 / ps.length);
  }
  const look = { yaw: 0, pitch: 0 };
  function placeCamera(): void {
    if (cam.kind === 'rec' && track) {
      trackPositionAt(track, clock.currentTime, camera.position);
      trackQuaternionAt(track, clock.currentTime, quat);
      camera.quaternion.set(quat.x, quat.y, quat.z, quat.w);
      camera.position.applyMatrix4(flip.matrixWorld);
      if (camera.fov !== recFov) {
        camera.fov = recFov;
        camera.updateProjectionMatrix();
      }
      return;
    }
    if (camera.fov !== 70) {
      camera.fov = 70;
      camera.updateProjectionMatrix();
    }
    if (cam.kind === 'orbit') {
      peopleCentre(centre);
      const a = THREE.MathUtils.degToRad(cam.yaw);
      camera.position.set(centre.x + cam.dist * Math.sin(a), cam.height, centre.z + cam.dist * Math.cos(a));
      camera.rotation.set(Math.atan2(centre.y - cam.height, cam.dist), a, 0);
      return;
    }
    if (cam.kind === 'fixed') {
      camera.position.set(cam.x, cam.y, cam.z);
      camera.rotation.set(THREE.MathUtils.degToRad(cam.pitch), THREE.MathUtils.degToRad(cam.yaw), 0);
    }
  }
  /** Hands the current view to the walk controls. */
  function toFixed(): void {
    look.yaw = camera.rotation.y;
    look.pitch = camera.rotation.x;
    cam = { kind: 'fixed', x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: THREE.MathUtils.radToDeg(look.yaw), pitch: THREE.MathUtils.radToDeg(look.pitch) };
  }

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      if (clock.paused) clock.play();
      else clock.pause();
      e.preventDefault();
      return;
    }
    if (e.code === 'Comma' || e.code === 'Period') {
      clock.pause();
      void clock.seek(clock.currentTime + (e.code === 'Comma' ? -1 : 1) / 30);
      return;
    }
    if (cam.kind !== 'fixed') toFixed();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  let drag: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (cam.kind !== 'fixed') toFixed();
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (drag = null));
  window.addEventListener('pointermove', (e) => {
    if (!drag || cam.kind !== 'fixed') return;
    cam.yaw -= (e.clientX - drag.x) * 0.25;
    cam.pitch = clamp(cam.pitch - (e.clientY - drag.y) * 0.25, -85, 85);
    drag = { x: e.clientX, y: e.clientY };
  });
  function walk(dt: number): void {
    if (cam.kind !== 'fixed' || !keys.size) return;
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const u = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    const a = THREE.MathUtils.degToRad(cam.yaw);
    const s = 1.4 * dt;
    cam.x += (-Math.sin(a) * f + Math.cos(a) * r) * s;
    cam.z += (-Math.cos(a) * f - Math.sin(a) * r) * s;
    cam.y += u * s;
  }

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // ---- frame ----------------------------------------------------------------------------------
  let last = performance.now();
  let frameCount = 0;
  let hudTimer = 0;
  const frameTimes: number[] = [];
  const waiters: Array<{ until: number; resolve: () => void }> = [];
  let recDistance = Infinity;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameTimes.push(dt);
    if (frameTimes.length > 60) frameTimes.shift();
    clock.tick(dt);
    walk(dt);
    content.updateMatrixWorld(true);
    placeCamera();
    camera.updateMatrixWorld();
    const rec = avatars.recordingCamera(tmp);
    recDistance = rec ? camera.position.distanceTo(rec) : Infinity;
    avatars.setBlend(blendOn ? recDistance : Infinity);
    avatars.update(dt);
    renderer.render(scene, camera);
    frameCount++;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frameCount >= waiters[i].until) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.2;
      const d = avatars.debug();
      const fps = frameTimes.length / Math.max(1e-3, frameTimes.reduce((s, v) => s + v, 0));
      hudEl.textContent =
        `t ${clock.currentTime.toFixed(3)} s ${clock.paused ? 'paused' : 'playing'} · ${fps.toFixed(0)} fps · ${cam.kind}\n` +
        `recording camera ${Number.isFinite(recDistance) ? recDistance.toFixed(2) + ' m' : 'n/a'} · blend ${d.blend.toFixed(2)} · coverage ${d.coverage.toFixed(2)}\n` +
        d.people.map((p) => `${p.id}  anim ${p.time.toFixed(3)} s  alpha ${p.alpha.toFixed(2)}`).join('\n') +
        `\nspace play/pause · , . frame · WASD QE walk · drag look`;
    }
  });

  // ---- geometry probe -------------------------------------------------------------------------
  interface MeshCache {
    /** Vertex pairs of every triangle edge, and their bind-pose lengths. */
    edges: Uint32Array;
    bindLen: Float32Array;
    /** 1 = left foot chain, 2 = right (lower shin, foot and toes carry most of the vertex's weight). */
    foot: Uint8Array;
    local: Float32Array;
  }
  const meshCache = new Map<THREE.SkinnedMesh, MeshCache>();
  function cacheFor(mesh: THREE.SkinnedMesh): MeshCache {
    const hit = meshCache.get(mesh);
    if (hit) return hit;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const tris = (index ? index.count : pos.count) / 3;
    const edges = new Uint32Array(tris * 6);
    const bindLen = new Float32Array(tris * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let f = 0; f < tris; f++) {
      for (let e = 0; e < 3; e++) {
        const i = index ? index.getX(f * 3 + e) : f * 3 + e;
        const j = index ? index.getX(f * 3 + ((e + 1) % 3)) : f * 3 + ((e + 1) % 3);
        edges[(f * 3 + e) * 2] = i;
        edges[(f * 3 + e) * 2 + 1] = j;
        bindLen[f * 3 + e] = a.fromBufferAttribute(pos, i).distanceTo(b.fromBufferAttribute(pos, j));
      }
    }
    // (GLTFLoader drops the '.' from node names: foot.L is footL)
    const side = mesh.skeleton.bones.map((bone) => (/^(lowerleg02|foot|toe)/.test(bone.name) ? (/\.?L$/.test(bone.name) ? 1 : /\.?R$/.test(bone.name) ? 2 : 0) : 0));
    const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
    const foot = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      let wl = 0, wr = 0;
      for (let k = 0; k < 4; k++) {
        const s = side[si.getComponent(i, k)];
        if (s === 1) wl += sw.getComponent(i, k);
        else if (s === 2) wr += sw.getComponent(i, k);
      }
      foot[i] = wl > 0.5 ? 1 : wr > 0.5 ? 2 : 0;
    }
    const c = { edges, bindLen, foot, local: new Float32Array(pos.count * 3) };
    meshCache.set(mesh, c);
    return c;
  }
  const r4 = (v: number) => +v.toFixed(4);
  function probePeople(box?: ProbeBox): ProbePerson[] {
    const ax = box ? Math.hypot(box.axis[0], box.axis[1]) || 1 : 1;
    const ux = box ? box.axis[0] / ax : 1, uz = box ? box.axis[1] / ax : 0;
    content.updateMatrixWorld(true);
    const bodies = avatars.object.children.map((root) => {
      let mesh: THREE.SkinnedMesh | null = null;
      root.traverse((o) => {
        if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
      });
      const bone = (name: string) =>
        (mesh as THREE.SkinnedMesh | null)?.skeleton.bones.find((x) => x.name === name || x.name === name.replace(/\./g, ''))?.getWorldPosition(new THREE.Vector3()) ?? null;
      return { id: root.name.replace(/^avatar-/, ''), mesh: mesh as THREE.SkinnedMesh | null, bone, pelvis: bone('root') };
    });
    const v = new THREE.Vector3();
    return bodies.flatMap((body, n) => {
      const mesh = body.mesh;
      if (!mesh || !body.pelvis) return [];
      const c = cacheFor(mesh);
      const count = mesh.geometry.getAttribute('position').count;
      let minY = Infinity, maxY = -Infinity, footL = Infinity, footR = Infinity, far = 0, bad = 0, inBox = 0, boxDepth = 0;
      for (let i = 0; i < count; i++) {
        mesh.getVertexPosition(i, v);
        c.local[i * 3] = v.x;
        c.local[i * 3 + 1] = v.y;
        c.local[i * 3 + 2] = v.z;
        v.applyMatrix4(mesh.matrixWorld);
        if (!Number.isFinite(v.x + v.y + v.z)) {
          bad++;
          continue;
        }
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
        if (c.foot[i] === 1 && v.y < footL) footL = v.y;
        if (c.foot[i] === 2 && v.y < footR) footR = v.y;
        far = Math.max(far, v.distanceTo(body.pelvis));
        if (box && v.y >= box.y[0] && v.y <= box.y[1]) {
          const dx = v.x - box.centre[0], dz = v.z - box.centre[1];
          const depth = Math.min(box.half[0] - Math.abs(dx * ux + dz * uz), box.half[1] - Math.abs(-dx * uz + dz * ux));
          if (depth > 0) {
            inBox++;
            boxDepth = Math.max(boxDepth, depth);
          }
        }
      }
      let stretch = 0, grow = 0;
      for (let e = 0; e < c.bindLen.length; e++) {
        const i = c.edges[e * 2] * 3, j = c.edges[e * 2 + 1] * 3;
        const len = Math.hypot(c.local[i] - c.local[j], c.local[i + 1] - c.local[j + 1], c.local[i + 2] - c.local[j + 2]);
        if (c.bindLen[e] > 1e-4) stretch = Math.max(stretch, len / c.bindLen[e]);
        grow = Math.max(grow, len - c.bindLen[e]);
      }
      // facing: forward from the hips (left hip minus right hip, crossed with up) against the way to the other person
      let facingDeg: number | null = null;
      // (the hip joints: pelvis.L and pelvis.R both start at the root)
      const L = body.bone('upperleg01.L'), R = body.bone('upperleg01.R');
      const other = bodies[n === 0 ? 1 : 0]?.pelvis;
      if (L && R && other && bodies.length > 1) {
        const fx = -(L.z - R.z), fz = L.x - R.x;
        const ox = other.x - body.pelvis.x, oz = other.z - body.pelvis.z;
        const cos = (fx * ox + fz * oz) / (Math.hypot(fx, fz) * Math.hypot(ox, oz) || 1);
        facingDeg = r4((Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
      }
      const arr = (p: THREE.Vector3 | null) => (p ? p.toArray().map(r4) : []);
      return [
        {
          id: body.id,
          minY: r4(minY),
          maxY: r4(maxY),
          footY: { L: r4(footL), R: r4(footR) },
          pelvis: arr(body.pelvis),
          wrist: { L: arr(body.bone('wrist.L')), R: arr(body.bone('wrist.R')) },
          head: arr(body.bone('head')),
          facingDeg,
          maxFromPelvis: r4(far),
          maxStretch: r4(stretch),
          maxGrow: r4(grow),
          bad,
          ...(box ? { inBox, boxDepth: r4(boxDepth) } : {}),
        },
      ];
    });
  }

  api.probe = probePeople;
  api.scan = async (times: number[], box?: ProbeBox) => {
    const out: Array<{ t: number; people: ProbePerson[] }> = [];
    clock.pause();
    for (const t of times) {
      await clock.seek(t);
      // (posed whatever the crossfade: only shown people are posed)
      avatars.setBlend(Infinity);
      avatars.update(0);
      out.push({ t: clock.currentTime, people: probePeople(box) });
    }
    return out;
  };
  api.frames = (n: number) => new Promise<void>((resolve) => waiters.push({ until: frameCount + Math.max(1, n), resolve }));
  // (for poking at from the console)
  (window as unknown as { __avatarParts: unknown }).__avatarParts = { THREE, avatars, renderer, scene, camera };
  api.bench = (n: number, people: boolean) => {
    const was = avatars.object.visible;
    avatars.object.visible = people;
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = (performance.now() - t0) / Math.max(1, n);
    avatars.object.visible = was;
    return ms;
  };
  api.sync = (offsets: number[]) => {
    if (!(clock instanceof MediaElementClock) || !clock.el.videoWidth) return null;
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    const shot = (source: CanvasImageSource): Uint8ClampedArray => {
      g.drawImage(source, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    };
    const frame = shot(clock.el);
    const was = offset;
    const draw = (people: boolean, o: number) => {
      offset = o;
      avatars.setBlend(Infinity);
      avatars.update(0);
      avatars.object.visible = people;
      renderer.render(scene, camera);
      // (read in the same task: the drawing buffer is still there)
      return shot(renderer.domElement);
    };
    const empty = draw(false, 0);
    const renders = offsets.map((o) => draw(true, o));
    avatars.object.visible = true;
    offset = was;
    const n = w * h;
    const region = new Uint8Array(n);
    for (const r of renders) {
      for (let i = 0; i < n; i++) {
        const k = i * 4;
        if (Math.max(Math.abs(r[k] - empty[k]), Math.abs(r[k + 1] - empty[k + 1]), Math.abs(r[k + 2] - empty[k + 2])) > 10) region[i] = 1;
      }
    }
    // per channel mean and spread over the region (the clip and the render differ in exposure and white balance)
    const stats = (img: Uint8ClampedArray) => {
      const m = [0, 0, 0], q = [0, 0, 0];
      let c = 0;
      for (let i = 0; i < n; i++) {
        if (!region[i]) continue;
        c++;
        for (let ch = 0; ch < 3; ch++) {
          const v = img[i * 4 + ch];
          m[ch] += v;
          q[ch] += v * v;
        }
      }
      return m.map((s, ch) => {
        const mean = s / Math.max(1, c);
        return [mean, Math.sqrt(Math.max(1e-6, q[ch] / Math.max(1, c) - mean * mean))];
      });
    };
    const fs = stats(frame);
    return renders.map((r, j) => {
      const rs = stats(r);
      let e = 0, c = 0;
      for (let i = 0; i < n; i++) {
        if (!region[i]) continue;
        c++;
        for (let ch = 0; ch < 3; ch++) e += Math.abs((r[i * 4 + ch] - rs[ch][0]) / rs[ch][1] - (frame[i * 4 + ch] - fs[ch][0]) / fs[ch][1]);
      }
      return { offset: offsets[j], err: +(e / Math.max(1, c * 3)).toFixed(5) };
    });
  };
  const grab = document.createElement('canvas');
  api.footage = () => {
    if (!(clock instanceof MediaElementClock) || !clock.el.videoWidth) return null;
    grab.width = clock.el.videoWidth;
    grab.height = clock.el.videoHeight;
    grab.getContext('2d')!.drawImage(clock.el, 0, 0);
    return grab.toDataURL('image/png');
  };
  api.info = () => {
    const d = avatars.debug();
    const info = renderer.info.render;
    return {
      media: clock.currentTime,
      paused: clock.paused,
      clock: clock instanceof FakeClock ? 'fake' : 'media',
      duration: clock.duration,
      cam: { kind: cam.kind, position: camera.position.toArray(), fov: camera.fov },
      recDistance: Number.isFinite(recDistance) ? recDistance : null,
      blend: d.blend,
      coverage: d.coverage,
      visible: d.visible,
      people: d.people.map((p) => ({ ...p, pelvis: pelvises().find((q) => q.id === p.id)?.p.toArray().map((v) => +v.toFixed(4)) ?? null })),
      failed: d.failed,
      credits: avatars.credits.length,
      count: avatars.count,
      splats,
      loadMs: Math.round(loadMs),
      frame: { calls: info.calls, triangles: info.triangles },
    };
  };
  api.set = async (a: SetArgs) => {
    if (a.cam) cam = parseCam(a.cam) ?? cam;
    if (a.blend !== undefined) blendOn = a.blend;
    if (a.offset !== undefined) offset = a.offset;
    if (a.paused === true) clock.pause();
    if (a.t !== undefined) await clock.seek(a.t);
    if (a.paused === false) clock.play();
    await api.frames(2);
    return api.info();
  };
  loadMs = performance.now() - t0;
  await api.frames(3);
  api.ready = true;
}

main().catch((e) => {
  console.error(e);
  api.error = String((e as Error)?.stack ?? e);
  api.ready = true;
  hudEl.textContent = `error: ${api.error}`;
});
