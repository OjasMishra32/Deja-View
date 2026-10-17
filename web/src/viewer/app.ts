// Viewer boot: reads ?scene=<id>, fetches the Scene, builds renderer + Spark + world + physics +
// controls + HUD + XR, and the Third Wheel video layer when the scene has one.

import * as THREE from 'three';
import { SparkRenderer, isMobile, isOculus, type SplatMesh } from '@sparkjsdev/spark';
import type { Scene, VideoLayer } from '../../../shared/types.ts';
import { distanceOutside, expandBounds, type Bounds, type RGB } from './analysis.ts';
import { loadMeshCollider, type MeshCollider } from './collider.ts';
import { makeVoxelView } from './debug.ts';
import { DesktopControls, type DesktopAction } from './desktop.ts';
import { easeOutCubic, HeadVeil, IntroMove, SkyDome, SplatFx, type CameraPose } from './effects.ts';
import { formatTime, Hud } from './hud.ts';
import { DEFAULT_BODY, DEFAULT_GROUND, EMPTY_WORLD, type GroundOptions } from './physics.ts';
import { Player } from './player.ts';
import { analyseWorld, applyTransform, loadSplatMesh, splatCount, type WorldAnalysis } from './world.ts';
import type { CollisionWorld } from './voxels.ts';
import { XrSystem } from './xr.ts';

/** Contract of web/src/viewer/thirdwheel.ts (docs/ARCHITECTURE.md). */
interface VideoLayerHandle {
  object: THREE.Object3D;
  video: HTMLVideoElement;
  ready: Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number;
  update(dt: number, camera: THREE.Camera): void;
  setOpacity(o: number): void;
  dispose(): void;
}
type VideoModule = { createVideoLayer(layer: VideoLayer, baseUrl: string, renderer: THREE.WebGLRenderer): VideoLayerHandle };

const params = new URLSearchParams(location.search);
const hud = new Hud();
const DARK: RGB = [0.02, 0.02, 0.025];
/** Gaussian cutoff in standard deviations: Spark's default, and a lighter one for headsets/phones. */
const FULL_STD_DEV = Math.sqrt(8);
const LIGHT_STD_DEV = Math.sqrt(6);

interface ViewerDebug {
  ready: boolean;
  stage: string;
  error: string | null;
  stats: Record<string, number>;
  info: Record<string, unknown>;
  [k: string]: unknown;
}
const debug: ViewerDebug = { ready: false, stage: 'boot', error: null, stats: {}, info: {} };
(window as unknown as { __viewer: ViewerDebug }).__viewer = debug;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function fetchScene(id: string): Promise<Scene> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (res.status === 404) throw new Error(`There is no scene called “${id}”.`);
  if (!res.ok) throw new Error(`The server answered ${res.status} for this scene.`);
  return (await res.json()) as Scene;
}

class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly rig = new THREE.Group();
  readonly content = new THREE.Group();
  readonly flip = new THREE.Group();
  readonly spark: SparkRenderer;
  readonly sky = new SkyDome();
  readonly veil = new HeadVeil();
  readonly fx = new SplatFx();
  readonly player = new Player();
  readonly controls: DesktopControls;
  readonly xr: XrSystem;
  mesh: SplatMesh | null = null;
  analysis: WorldAnalysis | null = null;
  collider: MeshCollider | null = null;
  video: VideoLayerHandle | null = null;
  videoReady = false;
  videoStarted = false;
  flipped = false;
  private ground: GroundOptions = { ...DEFAULT_GROUND };
  private intro: IntroMove | null = null;
  private introPose: CameraPose = { position: new THREE.Vector3(), yaw: 0, pitch: 0 };
  private revealT = -1;
  private revealMax = 12;
  private loadFade = 1;
  private resetFade: { t: number; done: boolean } | null = null;
  private voxelView: THREE.Object3D | null = null;
  private horizon: RGB = [0.24, 0.25, 0.29];
  private last = performance.now();
  private frameTimes: number[] = [];
  /** Main-thread time spent in our frame callback, render submission included. */
  private cpuTimes: number[] = [];
  private perfOn = params.has('debug');
  private perfTimer = 0;
  private uiTimer = 0;
  private started = performance.now();
  private dpr = 1;
  private dprCap = 1;
  private dprAdaptive = true;
  private dprTimer = 0;

  constructor(readonly data: Scene) {
    const mobile = isMobile();
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    const pinned = Number(params.get('dpr'));
    this.dprCap = Math.min(window.devicePixelRatio || 1, pinned || (mobile ? 1.5 : 2));
    this.dprAdaptive = !pinned;
    this.dpr = this.dprCap;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x0c0c0e, 1);
    document.getElementById('tw-stage')!.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(mobile ? 72 : 68, window.innerWidth / window.innerHeight, 0.03, 900);
    this.rig.name = 'rig';
    this.rig.add(this.camera);
    this.camera.add(this.veil.mesh);
    this.veil.setFadeColor(DARK);

    this.spark = new SparkRenderer({
      renderer: this.renderer,
      // Quest 3S keeps a steady frame rate up to roughly a million splats
      lodSplatCount: isOculus() ? 1_000_000 : undefined,
      maxStdDev: isOculus() || mobile ? LIGHT_STD_DEV : FULL_STD_DEV,
    });
    this.scene.add(this.sky.mesh, this.spark, this.rig, this.content);
    this.content.add(this.flip);

    this.controls = new DesktopControls(this.renderer.domElement, hud);
    this.controls.enabled = false;
    this.controls.onAction = (a) => this.onAction(a);
    // Space and M act on the video themselves; any other first gesture starts it
    this.controls.onFirstGesture = (source) => {
      if (source !== 'Space' && source !== 'KeyM') this.startVideoFromGesture();
    };

    const fb = Number(params.get('fb')) || 0.7;
    this.xr = new XrSystem(
      {
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        rig: this.rig,
        world: () => this.world,
        body: DEFAULT_BODY,
        ground: () => this.ground,
        walkBounds: () => this.analysis?.walkBounds ?? null,
        spawn: () => this.analysis?.spawn ?? { x: 0, y: 0, z: 0, yaw: 0 },
        startPose: () => ({ x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z, yaw: this.player.yaw }),
        sceneName: () => this.data.name,
        video: () => ({
          has: !!this.video && this.videoReady,
          playing: !!this.video?.playing,
          time: this.video && this.videoReady ? `${formatTime(this.video.currentTime)} / ${formatTime(this.video.duration)}` : '',
        }),
        playToggle: () => this.togglePlay(),
        restartVideo: () => {
          if (!this.video) return;
          this.video.seek(0);
          void this.playVideo();
        },
        onEnter: () => {
          this.intro = null;
          this.spark.maxStdDev = LIGHT_STD_DEV;
          this.controls.releaseLock();
          void this.playVideo();
        },
        onExit: (p) => {
          this.spark.maxStdDev = isOculus() || isMobile() ? LIGHT_STD_DEV : FULL_STD_DEV;
          this.player.place(p.x, p.y, p.z, p.yaw, 0);
          this.syncRig();
        },
      },
      { framebufferScale: Math.min(1, Math.max(0.3, fb)), foveation: 1 },
    );

    window.addEventListener('resize', () => this.resize());
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      hud.toast('Graphics context lost', 'The GPU reset. Reload the page to continue.', 'error', 0);
    });
    try {
      this.flipped = localStorage.getItem(`tw.flip.${data.id}`) === '1';
    } catch {
      this.flipped = false;
    }
  }

  get world(): CollisionWorld {
    return this.collider ?? this.analysis?.grid ?? EMPTY_WORLD;
  }

  private resize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  async start(): Promise<void> {
    const t0 = performance.now();
    const asset = this.data.world!;
    const base = `/data/scenes/${encodeURIComponent(this.data.id)}/`;
    const lodParam = params.get('lod');
    hud.setProgress('Downloading world', 0);
    debug.stage = 'download';
    const mesh = await loadSplatMesh(base + asset.file, {
      lod: lodParam === '1' ? true : lodParam === '0' ? false : undefined,
      onProgress: (p) => {
        debug.stage = p.stage;
        hud.setProgress(p.stage, p.fraction);
      },
    });
    debug.stats.downloadMs = performance.now() - t0;
    this.mesh = mesh;
    applyTransform(mesh, asset.transform);
    mesh.visible = false;
    this.flip.add(mesh);
    this.fx.attach(mesh);
    this.fx.setReveal(0.01);
    debug.info.splats = splatCount(mesh);
    debug.info.lod = !!mesh.packedSplats?.lodSplats;

    await this.analyse();
    debug.stats.analysisMs = performance.now() - t0 - debug.stats.downloadMs;

    if (asset.collider) {
      hud.setProgress('Loading the collider mesh', null);
      await this.loadCollider();
    }

    hud.setProgress('Ready', 1);
    hud.setScene(this.data.name, this.data.mode, this.data.caption);
    hud.handlers = {
      onEnterVr: () => this.enterVr(),
      onPlayToggle: () => this.togglePlay(),
      onSeek: (f) => this.video?.seek(f * (this.video.duration || 0)),
      onMute: () => this.toggleMute(),
    };

    if (this.data.video) await this.setupVideo(this.data.video, base);

    // first frames render behind the loader so sorting is done when it lifts
    mesh.visible = true;
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
    await nextFrame();
    await nextFrame();
    await nextFrame();
    debug.stats.loadMs = performance.now() - this.started;
    hud.finishLoading();
    this.beginIntro();
    this.controls.enabled = true;
    debug.ready = true;
    debug.stage = 'ready';

    const xrOk = await this.xr.probe();
    hud.showVr(xrOk);
    if (hud.isTouch) hud.setCoach(true);
    else hud.setHint(true);
    if (!hud.helpSeen() && !hud.isTouch) {
      hud.toggleHelp(true);
      setTimeout(() => {
        if (hud.helpVisible) hud.toggleHelp(false);
      }, 9000);
    }
    if (this.analysis && this.analysis.floorEstimated && this.analysis.floorConfidence < 0.15) {
      hud.toast('Floor is a guess', 'This world has no clear floor. Press F to fly, or U if it looks upside down.', 'info', 7000);
    }
    if (this.flipped) hud.toast('Flipped view', 'This world is shown upside down from its file (U to undo).', 'info', 5000);
  }

  /** Loads the GLB collider in the current frame (scene transform, flip and floor shift). */
  private async loadCollider(): Promise<void> {
    const file = this.data.world?.collider;
    if (!file || !this.mesh) return;
    this.collider = null;
    try {
      this.content.updateMatrixWorld(true);
      const toWorld = new THREE.Matrix4().multiplyMatrices(this.content.matrixWorld, this.flip.matrix).multiply(this.mesh.matrix);
      this.collider = await loadMeshCollider(`/data/scenes/${encodeURIComponent(this.data.id)}/${file}`, toWorld);
    } catch (e) {
      hud.toast('Collider mesh not loaded', `${errorMessage(e)}. Walking uses the splat collider instead.`, 'error');
    }
  }

  /** (Re)runs the analysis for the current flip state and applies it. */
  private async analyse(): Promise<void> {
    const mesh = this.mesh!;
    this.flip.rotation.set(this.flipped ? Math.PI : 0, 0, 0);
    this.flip.updateMatrix();
    mesh.updateMatrix();
    const toContent = new THREE.Matrix4().multiplyMatrices(this.flip.matrix, mesh.matrix);
    const a = await analyseWorld(mesh, toContent, {
      asset: this.data.world!,
      video: this.data.video,
      flipped: this.flipped,
      yieldFrame: nextFrame,
      onStage: (s) => {
        debug.stage = s;
        hud.setProgress(s, null);
      },
    });
    this.analysis = a;
    this.content.position.set(0, -a.floorY, 0);
    this.content.updateMatrixWorld(true);
    this.ground = { ...DEFAULT_GROUND, floorY: 0 };

    this.sky.setPalette(a.palette);
    this.horizon = a.palette.horizon;
    const fwd = new THREE.Vector3(-Math.sin(a.spawn.yaw), 0, -Math.cos(a.spawn.yaw));
    this.sky.setGlowDirection(fwd);
    this.fx.setBounds(a.fadeBounds, 2.2);
    const b = a.bounds;
    const corners = [b.min[0], b.max[0]].flatMap((x) => [b.min[2], b.max[2]].map((z) => Math.hypot(x - a.spawn.x, z - a.spawn.z)));
    this.revealMax = Math.max(...corners) + 3;
    this.player.place(a.spawn.x, a.spawn.y, a.spawn.z, a.spawn.yaw, 0);
    this.syncRig();
    if (this.voxelView) {
      this.scene.remove(this.voxelView);
      this.voxelView = makeVoxelView(a.grid);
      this.scene.add(this.voxelView);
    }
    debug.info.floorY = a.floorY;
    debug.info.floorEstimated = a.floorEstimated;
    debug.info.floorConfidence = a.floorConfidence;
    debug.info.bounds = a.bounds;
    debug.info.spawn = a.spawn;
    debug.info.voxels = a.grid.stats();
    debug.info.timings = a.timings;
    debug.info.palette = a.palette;
  }

  private async setupVideo(layer: VideoLayer, base: string): Promise<void> {
    try {
      const mod = (await import('./thirdwheel.ts')) as unknown as VideoModule;
      if (typeof mod.createVideoLayer !== 'function') throw new Error('createVideoLayer is missing');
      const handle = mod.createVideoLayer(layer, base, this.renderer);
      this.video = handle;
      this.flip.add(handle.object);
      hud.showTransport(true, layer.hasAudio);
      hud.setPlaying(false, true);
      hud.setTime(0, layer.duration);
      hud.setMuted(handle.video.muted);
      handle.ready
        .then(() => {
          this.videoReady = true;
          hud.setTime(handle.currentTime, handle.duration || layer.duration);
        })
        .catch((e) => {
          hud.toast('Video layer failed', errorMessage(e), 'error');
          hud.showTransport(false);
        });
      debug.info.video = true;
    } catch (e) {
      this.video = null;
      hud.toast('Third Wheel layer unavailable', `${errorMessage(e)}. The room still works.`, 'error');
    }
  }

  private async playVideo(): Promise<void> {
    if (!this.video) return;
    try {
      await this.video.play();
      this.videoStarted = true;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'NotAllowedError') hud.toast('Tap play to start', 'The browser wants a tap before it plays sound.', 'info');
      else hud.toast('Video did not start', errorMessage(e), 'error');
    }
  }

  private startVideoFromGesture(): void {
    if (this.video && !this.videoStarted) void this.playVideo();
  }

  private togglePlay(): void {
    const v = this.video;
    if (!v) return;
    if (v.playing) v.pause();
    else void this.playVideo();
  }

  private toggleMute(): void {
    const v = this.video;
    if (!v) return;
    v.video.muted = !v.video.muted;
    hud.setMuted(v.video.muted);
  }

  private async enterVr(): Promise<void> {
    try {
      await this.xr.enter();
    } catch (e) {
      hud.toast('Could not enter VR', errorMessage(e), 'error');
    }
  }

  private onAction(a: DesktopAction): void {
    if (!debug.ready) return;
    switch (a) {
      case 'play': this.togglePlay(); break;
      case 'reset': this.resetToSpawn(); break;
      case 'fly': {
        this.intro = null;
        this.player.setFly(!this.player.fly);
        hud.setFly(this.player.fly);
        break;
      }
      case 'mute': this.toggleMute(); break;
      case 'help': hud.toggleHelp(); break;
      case 'flip': void this.toggleFlip(); break;
      case 'voxels': this.toggleVoxels(); break;
      case 'perf': this.perfOn = !this.perfOn; if (!this.perfOn) hud.setPerf(null); break;
    }
  }

  private resetToSpawn(): void {
    this.intro = null;
    this.resetFade = { t: 0, done: false };
  }

  private async toggleFlip(): Promise<void> {
    this.flipped = !this.flipped;
    try {
      if (this.flipped) localStorage.setItem(`tw.flip.${this.data.id}`, '1');
      else localStorage.removeItem(`tw.flip.${this.data.id}`);
    } catch {
      /* not persisted */
    }
    this.loadFade = 1;
    await this.analyse();
    await this.loadCollider();
    this.beginIntro();
    hud.toast(this.flipped ? 'World flipped' : 'Flip undone', 'Saved for this scene on this device. Press U to switch back.', 'ok');
  }

  private toggleVoxels(): void {
    if (this.voxelView) {
      this.scene.remove(this.voxelView);
      this.voxelView = null;
      return;
    }
    if (!this.analysis) return;
    this.voxelView = makeVoxelView(this.analysis.grid);
    this.scene.add(this.voxelView);
    const s = this.analysis.grid.stats();
    hud.toast('Voxel collider', `${s.occupied.toLocaleString()} cells at ${(this.analysis.grid.size * 100).toFixed(0)} cm (V to hide)`, 'info');
  }

  /** Short dolly into the spawn pose and the reveal front growing out from it. */
  private beginIntro(): void {
    const a = this.analysis!;
    this.revealT = 0;
    this.loadFade = 1;
    if (this.renderer.xr.isPresenting || params.get('intro') === '0') {
      this.intro = null;
      return;
    }
    const eye = new THREE.Vector3(a.spawn.x, a.spawn.y + this.player.eyeHeight, a.spawn.z);
    const back = new THREE.Vector3(Math.sin(a.spawn.yaw), 0, Math.cos(a.spawn.yaw));
    // pull back only through free space
    let d = 0;
    for (let s = 0.1; s <= 1.3; s += 0.1) {
      const p = eye.clone().addScaledVector(back, s);
      if (a.grid.solidAt(p.x, p.y, p.z) || a.grid.solidAt(p.x, p.y + 0.4, p.z) || a.grid.solidAt(p.x, p.y - 0.5, p.z)) break;
      d = Math.max(0, s - 0.3);
    }
    const from: CameraPose = { position: eye.clone().addScaledVector(back, d).add(new THREE.Vector3(0, 0.45, 0)), yaw: a.spawn.yaw + 0.32, pitch: -0.22 };
    const to: CameraPose = { position: eye, yaw: a.spawn.yaw, pitch: 0 };
    this.intro = new IntroMove(from, to, 3.0);
    this.intro.step(0, this.introPose);
  }

  private syncRig(): void {
    if (this.renderer.xr.isPresenting) return;
    const p = this.player;
    this.rig.position.set(p.pos.x, p.eyeY, p.pos.z);
    this.rig.rotation.set(0, p.yaw, 0);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(p.pitch, 0, 0);
  }

  private frame(_t: number, _frame?: XRFrame): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    const presenting = this.renderer.xr.isPresenting;

    if (presenting) {
      this.xr.update(dt);
    } else if (debug.ready) {
      const look = this.controls.consumeLook();
      const input = this.controls.read();
      if (this.intro) {
        const skip = Math.abs(look.x) + Math.abs(look.y) > 0.002 || input.forward !== 0 || input.right !== 0 || input.up !== 0;
        if (skip) {
          // hand over smoothly from wherever the intro is
          this.player.yaw = this.introPose.yaw;
          this.player.pitch = this.introPose.pitch;
          this.intro = null;
        } else if (!this.intro.step(dt, this.introPose)) this.intro = null;
      }
      if (!this.intro) {
        this.player.look(look.x, look.y);
        const fly = this.player.fly;
        const wb = this.analysis ? (fly ? expandBounds(this.analysis.walkBounds, [2.5, 0, 2.5]) : this.analysis.walkBounds) : null;
        this.player.update(dt, input, { world: this.world, ground: this.ground, walkBounds: wb, margin: fly ? 1.5 : 0.5 });
        this.syncRig();
      } else {
        this.rig.position.copy(this.introPose.position);
        this.rig.rotation.set(0, this.introPose.yaw, 0);
        this.camera.position.set(0, 0, 0);
        this.camera.rotation.set(this.introPose.pitch, 0, 0);
      }
    }

    this.updateEffects(dt, presenting);

    if (this.video) {
      // the user camera: in XR three keeps its world matrix at rig x head pose, while the XR
      // array camera's own world matrix leaves out the rig
      try {
        this.video.update(dt, this.camera);
      } catch (e) {
        console.error(e);
      }
      this.uiTimer -= dt;
      if (this.uiTimer <= 0) {
        this.uiTimer = 0.25;
        hud.setPlaying(this.video.playing, !this.videoStarted);
        if (this.videoReady) hud.setTime(this.video.currentTime, this.video.duration);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.cpuTimes.push(performance.now() - now);
    if (this.cpuTimes.length > 120) this.cpuTimes.shift();

    if (!presenting && debug.ready) this.adaptResolution(dt);

    this.perfTimer -= dt;
    if (this.perfTimer <= 0) {
      this.perfTimer = 0.5;
      const ft = this.frameTimes.slice().sort((a, b) => a - b);
      const avg = ft.reduce((s, v) => s + v, 0) / Math.max(1, ft.length);
      debug.stats.frameMs = avg;
      debug.stats.fps = 1000 / Math.max(1e-3, avg);
      debug.stats.p95Ms = ft[Math.floor(ft.length * 0.95)] ?? avg;
      debug.stats.cpuMs = this.cpuTimes.reduce((s, v) => s + v, 0) / Math.max(1, this.cpuTimes.length);
      debug.player = { ...this.player.pos, yaw: this.player.yaw, pitch: this.player.pitch, fly: this.player.fly, eyeY: this.player.eyeY };
      debug.xr = { presenting, ...this.xr.debug };
      if (this.perfOn) {
        const n = (debug.info.splats as number) ?? 0;
        hud.setPerf(`${debug.stats.fps.toFixed(0)} fps · ${avg.toFixed(1)} ms · ${(n / 1e6).toFixed(2)}M`);
      }
    }
  }

  /**
   * Splats are fill-rate bound: when frames run long for a couple of seconds, render fewer pixels
   * (soft splats hide it well); give them back only when there is clear headroom.
   */
  private adaptResolution(dt: number): void {
    if (!this.dprAdaptive || this.revealT >= 0 || this.frameTimes.length < 60) return;
    this.dprTimer += dt;
    if (this.dprTimer < 2) return;
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const min = Math.min(this.dprCap, 0.8);
    let next = this.dpr;
    if (median > 24 && this.dpr > min) next = Math.max(min, this.dpr - 0.25);
    else if (median < 12 && this.dpr < this.dprCap) next = Math.min(this.dprCap, this.dpr + 0.25);
    if (next !== this.dpr) {
      this.dpr = next;
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.frameTimes.length = 0;
    }
    this.dprTimer = 0;
    debug.stats.dpr = this.dpr;
  }

  private updateEffects(dt: number, presenting: boolean): void {
    const a = this.analysis;
    // reveal front
    if (this.revealT >= 0) {
      this.revealT += dt;
      const dur = 2.6;
      const e = easeOutCubic(Math.min(1, this.revealT / dur));
      if (this.revealT >= dur) {
        this.revealT = -1;
        this.fx.setReveal(1e5);
      } else if (a) {
        this.fx.setReveal(0.4 + e * this.revealMax, new THREE.Vector3(a.spawn.x, a.spawn.y + 1.2, a.spawn.z));
      }
    }
    // load fade from dark
    this.loadFade = Math.max(0, this.loadFade - dt / 1.1);
    // reset-to-spawn fade
    let resetFade = 0;
    if (this.resetFade) {
      const r = this.resetFade;
      r.t += dt;
      if (r.t < 0.18) resetFade = r.t / 0.18;
      else {
        if (!r.done && a) {
          r.done = true;
          if (presenting) this.xr.resetToSpawn();
          else {
            this.player.place(a.spawn.x, a.spawn.y, a.spawn.z, a.spawn.yaw, 0);
            this.syncRig();
          }
        }
        resetFade = Math.max(0, 1 - (r.t - 0.18) / 0.3);
        if (r.t > 0.5) this.resetFade = null;
      }
    }
    // leaving the world: fade toward the horizon colour
    let outside = 0;
    if (a) {
      const p = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
      const d = distanceOutside(expandBounds(a.bounds, 0.4) as Bounds, p.x, p.y, p.z);
      outside = THREE.MathUtils.smoothstep(d, 0.2, 3.0) * 0.92;
    }
    const dark = Math.max(this.loadFade, resetFade, presenting ? this.xr.fadeLevel : 0);
    if (outside > dark) {
      this.veil.setFadeColor(this.horizon);
      this.veil.fade = outside;
    } else {
      this.veil.setFadeColor(DARK);
      this.veil.fade = dark;
    }
    this.veil.vignette = presenting ? this.xr.vignetteLevel : 0;
    this.veil.sync();
  }
}

async function boot(): Promise<void> {
  if (params.get('xremu') === '1') {
    try {
      await installEmulatorFirst();
    } catch (e) {
      hud.toast('XR emulator failed to load', errorMessage(e), 'error');
    }
  }
  const id = params.get('scene');
  if (!id) {
    hud.setLoaderTitle('Pick a world');
    hud.loaderError('No scene selected', 'This page needs ?scene=<id>.', { href: '/', label: 'Open the gallery' });
    debug.error = 'no scene';
    return;
  }
  hud.setProgress('Fetching scene', null);
  let scene: Scene;
  try {
    scene = await fetchScene(id);
    hud.setLoaderTitle(scene.name, scene.mode);
    // still generating: show its progress and wait
    while (scene.status !== 'ready') {
      if (scene.status === 'failed') {
        hud.loaderError('Generation failed', scene.error || 'The job stopped without saying why.', { href: '/', label: 'Back to the gallery' });
        debug.error = 'failed';
        return;
      }
      hud.setProgress(scene.stage || 'Generating the world', scene.progress ?? null, 'This page opens the world as soon as it is ready.');
      await new Promise((r) => setTimeout(r, 2000));
      scene = await fetchScene(id);
    }
  } catch (e) {
    hud.setLoaderTitle('Lost in the hallway');
    hud.loaderError('Could not load the scene', errorMessage(e), { href: '/', label: 'Back to the gallery' });
    debug.error = errorMessage(e);
    return;
  }
  if (!scene.world) {
    hud.loaderError('No world in this scene', 'The scene is ready but has no splat world attached.', { href: '/', label: 'Back to the gallery' });
    debug.error = 'no world';
    return;
  }
  hud.setLoaderTitle(scene.name, scene.mode);
  let viewer: Viewer | null = null;
  try {
    viewer = new Viewer(scene);
    (window as unknown as { __viewerApp: Viewer }).__viewerApp = viewer;
    await viewer.start();
  } catch (e) {
    console.error(e);
    const msg = errorMessage(e);
    debug.error = msg;
    const gl = /webgl|context/i.test(msg);
    hud.loaderError(gl ? 'This browser cannot draw the world' : 'The world did not open', msg, { href: '/', label: 'Back to the gallery' });
  }
}

async function installEmulatorFirst(): Promise<void> {
  const { installXrEmulator } = await import('./emu.ts');
  await installXrEmulator();
}

void boot();
