// Viewer boot: reads ?scene=<id>, fetches the Scene, builds renderer + Spark + world + physics +
// controls + HUD + XR, and the video layer when the scene has one. Once the world is visible, the live
// layer starts on one /ws connection: social (presence ghosts, sticky notes, tag moments, reality check)
// and the guide (labels, hold-to-ask, narration). ?follow=1 obeys host cues and opens new worlds.

import * as THREE from 'three';
import { SparkRenderer, isMobile, isOculus, type SplatMesh } from '@sparkjsdev/spark';
import type { Scene, VideoLayer } from '../../../shared/types.ts';
import { distanceOutside, expandBounds, mixRgb, type Bounds, type RGB } from './analysis.ts';
import { cameraEyeHeight, isCameraOnlyRoom, videoFrustum, type Frustum } from './camroom.ts';
import { loadMeshCollider, type MeshCollider } from './collider.ts';
import { makeVoxelView } from './debug.ts';
import { DesktopControls, type DesktopAction } from './desktop.ts';
import { easeOutCubic, GroundGlow, HeadVeil, IntroMove, SkyDome, SplatFx, type CameraPose } from './effects.ts';
import { formatTime, Hud } from './hud.ts';
import { DEFAULT_BODY, DEFAULT_GROUND, EMPTY_WORLD, type GroundOptions } from './physics.ts';
import { FrameGovernor, XR_LEVELS } from './perf.ts';
import { Player } from './player.ts';
import { createGuide, type Guide, type GuideOptions } from './guide/index.ts';
import { findMemorySource, MemoryIntro, reliefFor } from './memory-intro.ts';
import { createSocial, type Cue, type SocialHandle } from './social/index.ts';
import { SocialSocket } from './social/presence-client.ts';
import { analyseWorld, applyTransform, loadSplatMesh, repairHiddenSplats, splatCount, type WorldAnalysis } from './world.ts';
import type { CollisionWorld } from './voxels.ts';
import { XrSystem } from './xr.ts';

/** Contract of web/src/viewer/thirdwheel.ts, the video layer (docs/ARCHITECTURE.md). */
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
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** Same labels at the same spots (within 1 cm): a `hotspots` echo of what this viewer just stored. */
function sameLabels(a: ReadonlyArray<{ label: string; position: readonly number[] }>, raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== a.length) return false;
  const key = (l: string) => l.trim().toLowerCase();
  const mine = new Map(a.map((h) => [key(h.label), h.position]));
  return raw.every((h) => {
    const p = h && typeof h === 'object' ? mine.get(key(String((h as { label?: unknown }).label ?? ''))) : undefined;
    const r = h as { x?: unknown; y?: unknown; z?: unknown };
    return !!p && [r.x, r.y, r.z].every((v, i) => typeof v === 'number' && Math.abs(v - p[i]!) < 0.01);
  });
}

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
  readonly floorGlow = new GroundGlow();
  /**
   * The video camera's view when the room was lifted from that one camera (no generated room
   * around it). Such a room is shown from the camera's height, walking stays near the camera, and
   * what the camera never saw fades into the sky.
   */
  readonly cameraRoom: Frustum | null;
  readonly player = new Player();
  readonly controls: DesktopControls;
  readonly xr: XrSystem;
  mesh: SplatMesh | null = null;
  /** Presence ghosts, sticky notes, tag moments and the reality check (web/src/viewer/social). */
  social: SocialHandle | null = null;
  /** Labels, hold-to-ask and narration (web/src/viewer/guide). */
  guide: Guide | null = null;
  /** The viewer's one /ws connection; social and the guide listen on it. */
  live: SocialSocket | null = null;
  /** "The photo becomes the world": the entry and exit around the picture this world was made from (memory-intro.ts). */
  memory: MemoryIntro | null = null;
  private realityBusy = false;
  private liveUiTimer = 0;
  private leaving = false;
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
  /** Steps splat cost down in the headset when frames drop (see perf.ts). */
  private readonly xrGovernor = new FrameGovernor({ levels: XR_LEVELS.length });

  constructor(readonly data: Scene) {
    const mobile = isMobile();
    this.cameraRoom = isCameraOnlyRoom(data) && data.video ? videoFrustum(data.video) : null;
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
      // level-of-detail budget: Spark's own per-platform default (500-750k splats in a headset)
      maxStdDev: isOculus() || mobile ? LIGHT_STD_DEV : FULL_STD_DEV,
    });
    this.scene.add(this.sky.mesh, this.floorGlow.mesh, this.spark, this.rig, this.content);
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
        walkMargin: () => (this.activeCameraRoom ? 0.35 : 0.6),
        eyeLevel: () => (this.activeCameraRoom ? this.player.eyeHeight : null),
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
          this.xrGovernor.reset();
          this.applyXrLevel(this.xrGovernor.level);
          this.controls.releaseLock();
          // in the headset the memory plays from the photo (the video starts once you stand in the world)
          if (this.memory && !this.flipped && params.get('intro') !== '0') {
            this.revealT = -1;
            void this.memory.enter({ delay: 0.3, xr: true }).then(() => {
              if (this.renderer.xr.isPresenting) void this.playVideo();
            });
          } else void this.playVideo();
        },
        onExit: (p) => {
          this.spark.maxStdDev = isOculus() || isMobile() ? LIGHT_STD_DEV : FULL_STD_DEV;
          this.spark.lodSplatScale = 1;
          this.spark.maxPixelRadius = 512;
          this.player.place(p.x, p.y, p.z, p.yaw, 0);
          this.syncRig();
          // left through the photo (or mid-way): the world grows back on the screen, once three.js has let go
          // of the session (this runs inside its end event)
          const m = this.memory;
          if (m && !this.leaving && (m.phase === 'left' || m.active)) setTimeout(() => void this.beginIntro(0.15), 0);
        },
      },
      { framebufferScale: Math.min(1, Math.max(0.3, fb)), foveation: 1 },
    );
    // the wrist panel's Exit VR shrinks the world back into the photo first
    const exitXr = this.xr.exit.bind(this.xr);
    this.xr.exit = () => {
      const m = this.memory;
      if (!m || !m.canLeave || !this.renderer.xr.isPresenting || params.get('intro') === '0') return exitXr();
      void m.leave().then(exitXr);
    };

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

  /** The camera-only room handling applies (not while the world is shown flipped). */
  get activeCameraRoom(): Frustum | null {
    return this.flipped ? null : this.cameraRoom;
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
    if (this.cameraRoom) {
      // what the camera never saw behind objects takes the colours of the surface behind them
      try {
        mesh.updateMatrix();
        debug.info.hiddenRepaired = repairHiddenSplats(mesh, mesh.matrix, this.cameraRoom);
      } catch (e) {
        console.warn('hidden splat repair skipped', e);
      }
    }

    await this.analyse();
    debug.stats.analysisMs = performance.now() - t0 - debug.stats.downloadMs;
    const memoryReady = this.prepareMemory(base);

    if (asset.collider) {
      hud.setProgress('Loading the collider mesh', null);
      await this.loadCollider();
    }

    hud.setProgress('Ready', 1);
    hud.setScene(this.data.name, this.data.mode, this.data.caption);
    hud.handlers = {
      // the guide opens the microphone early (only when the site already has permission)
      onEnterVr: () => {
        this.guide?.warmUp();
        void this.enterVr();
      },
      onPlayToggle: () => this.togglePlay(),
      onSeek: (f) => this.video?.seek(f * (this.video.duration || 0)),
      onMute: () => this.toggleMute(),
    };

    if (this.data.video) await this.setupVideo(this.data.video, base);
    await memoryReady;

    // first frames render behind the loader so sorting is done when it lifts
    mesh.visible = true;
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
    await nextFrame();
    await nextFrame();
    await nextFrame();
    debug.stats.loadMs = performance.now() - this.started;
    hud.finishLoading();
    // the memory waits for the loader to fade before the photo appears
    const introDone = this.beginIntro(0.5);
    this.hookBackLink();
    this.controls.enabled = true;
    debug.ready = true;
    debug.stage = 'ready';
    this.startLive();

    const xrOk = await this.xr.probe();
    hud.showVr(xrOk);
    if (hud.isTouch) hud.setCoach(true);
    else hud.setHint(true);
    await introDone;
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

  /**
   * Finds the picture this world was made from and builds the memory card (memory-intro.ts). Never holds the world
   * back for long: without a picture, a camera or in time, the world opens with the plain reveal.
   */
  private async prepareMemory(base: string): Promise<void> {
    const a = this.analysis;
    if (!a || this.flipped || params.get('intro') === '0') return;
    const t0 = performance.now();
    const floor = a.floorY;
    const work = (async () => {
      const src = await findMemorySource({
        scene: this.data,
        base,
        toWorld: (p) => [p[0], p[1] - floor, p[2]],
        spawn: a.spawn,
        eyeY: this.player.eyeHeight,
      });
      if (!src) return null;
      const relief = reliefFor(src, a.grid, a.bounds);
      return new MemoryIntro(
        {
          renderer: this.renderer,
          scene: this.scene,
          camera: this.camera,
          fx: this.fx,
          sky: this.sky,
          palette: () => this.analysis?.palette ?? a.palette,
          bounds: () => this.analysis?.bounds ?? a.bounds,
          setVideoAlpha: (o) => this.video?.setOpacity(o),
          hide: () => [
            this.floorGlow.mesh.visible ? this.floorGlow.mesh : null,
            this.social?.ghosts.group,
            this.social?.notes.group,
            this.scene.getObjectByName('guide-captions'),
            this.scene.getObjectByName('guide-hotspots'),
          ],
          page: document.body,
        },
        src,
        relief,
      );
    })().catch((e) => {
      console.warn('memory intro skipped:', e);
      return null;
    });
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
    this.memory = await Promise.race([work, timeout]);
    if (!this.memory) void work.then((late) => late?.dispose());
    debug.stats.memoryMs = performance.now() - t0;
    Object.defineProperty(debug, 'memory', { get: () => this.memory?.debug() ?? null, enumerable: true, configurable: true });
  }

  /** The back arrow shrinks the world back into the photo before it goes. */
  private hookBackLink(): void {
    const back = document.querySelector<HTMLAnchorElement>('.tw-back');
    back?.addEventListener('click', (e) => {
      const m = this.memory;
      if (!m || !m.canLeave || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (this.leaving) {
        location.assign(back.href);
        return;
      }
      this.leaving = true;
      void m.leave().then(() => {
        this.disposeLive();
        location.assign(back.href);
      });
    });
    // back from the next page with this one kept in memory: the world grows again
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || this.memory?.phase !== 'left') return;
      this.leaving = false;
      void this.beginIntro(0.1);
    });
  }

  /**
   * The live layer, once the world is visible. Each part starts on its own: one that fails (or a server without
   * the live routes) never stops the world from opening.
   */
  private startLive(): void {
    const id = this.data.id;
    const follow = params.get('follow') === '1';
    try {
      this.live = SCENE_ID.test(id) ? new SocialSocket(SocialSocket.urlFor(''), id) : null;
    } catch (e) {
      console.error('live socket not created', e);
      this.live = null;
    }
    try {
      this.social = createSocial(
        {
          sceneId: id,
          renderer: this.renderer,
          scene: this.scene,
          camera: this.camera,
          rig: this.rig,
          worldRoot: this.flip,
          splatMesh: () => this.mesh,
          splatFx: this.fx,
          toast: (t, b, k, ms) => hud.toast(t, b, k, ms),
          eyeHeight: () => this.player.eyeHeight,
          xrHeightOffset: () => this.xr.debug.heightOffset,
          collision: () => this.world,
          loadSplat: (url) => loadSplatMesh(url),
          // the server splits Photo and Video worlds for the reality check (server/reality.ts); samples never
          realityExpected: (this.data.mode as string) !== 'sample',
          prepareRealityMesh: this.cameraRoom
            ? (m) => {
                m.updateMatrix();
                repairHiddenSplats(m, m.matrix, this.cameraRoom!);
              }
            : undefined,
          releasePointerLock: () => this.controls.releaseLock(),
        },
        // headset buttons: right grip = note, left Y = reality (xr.ts owns A, B, the right trigger on the wrist
        // panel and both sticks; the guide owns X and the left trigger)
        { cues: follow, socket: this.live ?? true, onCue: (cue) => this.onCue(cue, follow) },
      );
    } catch (e) {
      console.error('social layer did not start', e);
      this.social = null;
    }
    // ?narrate=never|always|photo, ?narrateDelay=, ?labelsDelay= (seconds): a quiet rehearsal, the test benches
    const guideOpts: Partial<GuideOptions> = {};
    const narrate = params.get('narrate');
    if (narrate === 'photo' || narrate === 'always' || narrate === 'never') guideOpts.narrate = narrate;
    for (const k of ['narrateDelay', 'labelsDelay'] as const) {
      const v = Number(params.get(k));
      if (params.has(k) && Number.isFinite(v) && v >= 0) guideOpts[k] = v;
    }
    try {
      this.guide = createGuide({
        scene: this.data,
        sceneId: id,
        baseUrl: '',
        renderer: this.renderer,
        three: this.scene,
        camera: this.camera,
        rig: this.rig,
        worldRoot: this.flip,
        splats: () => this.mesh,
        collision: () => this.world,
        toast: (t, b, k, ms) => hud.toast(t, b, k, ms),
        media: () => this.video?.video ?? null,
        hasVideo: () => !!this.video,
        flipped: () => this.flipped,
        // the right trigger presses wrist-panel buttons and picks note phrases before it asks about a label
        pointerBusy: () => this.xr.panelHovered || (this.social?.debug.composer ?? 'idle') !== 'idle',
        // rooms keep the 6 m reach; a big outdoor world lets labels sit as far away as half its size
        labelReach: () => {
          const b = this.analysis?.bounds;
          return b ? Math.min(60, Math.max(6, 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]))) : 6;
        },
      }, guideOpts);
      this.guide.start();
    } catch (e) {
      console.error('guide did not start', e);
      this.guide = null;
    }
    if (this.live) {
      this.live.on('hotspots', (m) => {
        // the echo of labels this viewer just placed and stored would only pop them in again
        if (this.guide && !sameLabels(this.guide.hotspots, m.hotspots)) this.guide.setHotspots(m.hotspots);
      });
      if (follow) this.live.on('scene', (m) => this.onSceneEvent(m.scene as Scene | undefined));
      this.live.start();
    }
    hud.showLive(!!this.social?.reality, !!this.social);
    hud.handlers.onReality = () => void this.toggleReality();
    hud.handlers.onNote = () => this.social?.startNote();
    Object.defineProperty(debug, 'social', { get: () => this.social?.debug ?? null, enumerable: true, configurable: true });
    Object.defineProperty(debug, 'guide', { get: () => this.guide?.debug ?? null, enumerable: true, configurable: true });
    Object.defineProperty(debug, 'socket', { get: () => !!this.live?.connected, enumerable: true, configurable: true });
    window.addEventListener('pagehide', () => this.disposeLive(), { once: true });
  }

  /** Host cues from /ws (contracts 11). Social has already acted on `reality` when following. */
  private onCue(cue: Cue, follow: boolean): void {
    if (!follow) return;
    if (cue.action === 'labels') this.guide?.setLabelsVisible(cue.on !== false);
    else if (cue.action === 'load' && typeof cue.sceneId === 'string' && cue.sceneId !== this.data.id) this.openWorld(cue.sceneId, 'Opening the next world');
  }

  /** Follow mode: a world that finishes building while this page is open (the live finale) opens here. */
  private onSceneEvent(scene: Scene | undefined): void {
    if (!scene || typeof scene.id !== 'string' || scene.id === this.data.id) return;
    if (scene.status === 'ready' && scene.world) this.openWorld(scene.id, `${scene.name || 'A new world'} is ready`);
  }

  /**
   * Swaps to another world by reloading the page on it (the headset leaves VR first; press Enter VR again when it
   * appears, about 5 s). The live layer is torn down before the page goes.
   */
  private openWorld(id: string, title: string): void {
    if (this.leaving || !SCENE_ID.test(id)) return;
    this.leaving = true;
    const q = new URLSearchParams(location.search);
    q.set('scene', id);
    const url = `${location.pathname}?${q}`;
    const presenting = this.renderer.xr.isPresenting;
    const body = presenting ? 'Opening it now. Press Enter VR again when it appears.' : 'Opening it now.';
    if (this.social) this.social.notify(title, body, 'ok');
    else hud.toast(title, body, 'ok');
    // the world shrinks back into its photo while the note is read
    const shrink = this.memory?.leave() ?? Promise.resolve();
    const read = new Promise((r) => setTimeout(r, presenting ? 1800 : 900));
    void Promise.all([shrink, read]).then(async () => {
      try {
        await this.renderer.xr.getSession()?.end();
      } catch {
        /* already ended */
      }
      this.disposeLive();
      location.assign(url);
    });
  }

  private async toggleReality(): Promise<void> {
    const s = this.social;
    if (!s || this.realityBusy) return;
    this.realityBusy = true;
    hud.setReality(s.realityOn, true);
    try {
      await s.toggleRealityCheck();
    } catch (e) {
      console.error('reality check', e);
    } finally {
      this.realityBusy = false;
      hud.setReality(s.realityOn);
    }
  }

  private disposeLive(): void {
    try {
      this.guide?.dispose();
      this.social?.dispose();
      this.live?.close();
    } catch (e) {
      console.warn('live layer teardown', e);
    }
    this.guide = null;
    this.social = null;
    this.live = null;
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
      cameraRoom: this.activeCameraRoom,
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
    const room = this.activeCameraRoom;
    // a single-view room only lines up with the footage from about the camera's own height
    this.player.eyeHeight = room ? cameraEyeHeight(room, a.floorY) : 1.6;
    this.applyCameraRoom(a);

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
    debug.info.eyeHeight = this.player.eyeHeight;
    debug.info.walkBounds = a.walkBounds;
    debug.info.floorY = a.floorY;
    debug.info.floorEstimated = a.floorEstimated;
    debug.info.floorConfidence = a.floorConfidence;
    debug.info.bounds = a.bounds;
    debug.info.spawn = a.spawn;
    debug.info.voxels = a.grid.stats();
    debug.info.timings = a.timings;
    debug.info.palette = a.palette;
  }

  /**
   * Camera-only rooms: fade what the camera never saw (the guessed box around the room) into the
   * sky and lay a soft floor under the walk area; everything else turns this off.
   */
  private applyCameraRoom(a: WorldAnalysis): void {
    const room = this.activeCameraRoom;
    if (!room) {
      this.fx.setViewCone(null);
      this.floorGlow.hide();
      return;
    }
    const m = new THREE.Matrix4().multiplyMatrices(this.content.matrixWorld, this.flip.matrix);
    const v = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
    this.fx.setViewCone({
      position: v(room.position).applyMatrix4(m),
      right: v(room.right).transformDirection(m),
      up: v(room.up).transformDirection(m),
      forward: v(room.forward).transformDirection(m),
      tans: [room.tanLeft, room.tanRight, room.tanDown, room.tanUp],
      soft: 0.3,
      inset: 0.05,
    });
    const wb = a.walkBounds;
    const cx = (wb.min[0] + wb.max[0]) / 2, cz = (wb.min[2] + wb.max[2]) / 2;
    const reach = Math.max(2.6, Math.min(4.5, a.nearContent + 1.6));
    this.floorGlow.set(cx, 0, cz, reach, mixRgb(a.palette.horizon, a.palette.bottom, 0.4));
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
          hud.toast('The video did not load', errorMessage(e), 'error');
          hud.showTransport(false);
        });
      debug.info.video = true;
    } catch (e) {
      this.video = null;
      hud.toast('The video could not be shown', 'The room still works without it. Reload the page to try again.', 'error');
      console.error(e);
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

  /**
   * The memory (the photo becomes the world) when this world has its picture; otherwise a short dolly into the spawn
   * pose and the reveal front growing out from it. Resolves when the world is complete.
   */
  private beginIntro(delay = 0): Promise<void> {
    const a = this.analysis!;
    this.revealT = 0;
    this.loadFade = 1;
    const m = this.memory;
    if (m && !this.flipped && params.get('intro') !== '0' && !this.renderer.xr.isPresenting) {
      // the camera stays put: it only turns once to face the photo, which then does the moving
      this.revealT = -1;
      this.loadFade = 0;
      this.intro = null;
      const aim = m.frameFor(new THREE.Vector3(this.player.pos.x, this.player.eyeY, this.player.pos.z));
      this.player.yaw = aim.yaw;
      this.player.pitch = aim.pitch;
      this.syncRig();
      return m.enter({ delay });
    }
    m?.cancel();
    if (this.renderer.xr.isPresenting || params.get('intro') === '0') {
      this.intro = null;
      return Promise.resolve();
    }
    const eye = new THREE.Vector3(a.spawn.x, a.spawn.y + this.player.eyeHeight, a.spawn.z);
    const back = new THREE.Vector3(Math.sin(a.spawn.yaw), 0, Math.cos(a.spawn.yaw));
    if (this.activeCameraRoom) {
      // a single-view room: a short push in along the camera's own line of sight
      const from: CameraPose = { position: eye.clone().addScaledVector(back, 0.55).add(new THREE.Vector3(0, 0.04, 0)), yaw: a.spawn.yaw + 0.1, pitch: -0.03 };
      this.intro = new IntroMove(from, { position: eye, yaw: a.spawn.yaw, pitch: 0 }, 2.6);
      this.intro.step(0, this.introPose);
      return Promise.resolve();
    }
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
    return Promise.resolve();
  }

  private syncRig(): void {
    if (this.renderer.xr.isPresenting) return;
    const p = this.player;
    this.rig.position.set(p.pos.x, p.eyeY, p.pos.z);
    this.rig.rotation.set(0, p.yaw, 0);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(p.pitch, 0, 0);
  }

  /** Applies one of the headset's splat cost levels. */
  private applyXrLevel(level: number): void {
    const l = XR_LEVELS[Math.max(0, Math.min(XR_LEVELS.length - 1, level))];
    this.spark.maxStdDev = l.maxStdDev;
    this.spark.lodSplatScale = l.lodSplatScale;
    this.spark.maxPixelRadius = l.maxPixelRadius;
    debug.info.xrPerf = level;
  }

  /** Headset only: watch for dropped frames and step the splat cost down (or back up). */
  private governXr(intervalMs: number): void {
    // the load reveal and teleport fades regenerate or hide splats: not representative frames
    if (this.revealT >= 0 || this.xr.fadeLevel > 0 || this.memory?.active) return;
    const rate = (this.renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null)?.frameRate;
    const budget = 1000 / (rate && rate > 20 ? rate : 72);
    const changed = this.xrGovernor.push(intervalMs, budget);
    if (changed !== null) this.applyXrLevel(changed);
  }

  private frame(_t: number, _frame?: XRFrame): void {
    const now = performance.now();
    const interval = now - this.last;
    const dt = Math.min(0.1, interval / 1000);
    this.last = now;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    const presenting = this.renderer.xr.isPresenting;

    if (presenting) {
      this.governXr(interval);
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
        const room = !!this.activeCameraRoom;
        const flyGrow = room ? 0.5 : 2.5;
        const wb = this.analysis ? (fly ? expandBounds(this.analysis.walkBounds, [flyGrow, 0, flyGrow]) : this.analysis.walkBounds) : null;
        this.player.update(dt, input, { world: this.world, ground: this.ground, walkBounds: wb, margin: fly ? (room ? 0.4 : 1.5) : room ? 0.3 : 0.5 });
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

    // the live layer reads this frame's head pose and XR input, and draws before the render
    if (this.social) {
      try {
        this.social.update(dt);
      } catch (e) {
        console.error(e);
      }
    }
    if (this.guide) {
      try {
        this.guide.update(dt);
      } catch (e) {
        console.error(e);
      }
    }
    // after the live layer: the memory keeps its panels out of the dark while the photo plays
    this.memory?.update(dt);
    this.liveUiTimer -= dt;
    if (this.liveUiTimer <= 0 && this.social) {
      this.liveUiTimer = 0.25;
      hud.setReality(this.social.realityOn, this.realityBusy);
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
    if (!this.dprAdaptive || this.revealT >= 0 || this.memory?.active || this.frameTimes.length < 60) return;
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
