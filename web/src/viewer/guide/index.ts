// The guide inside the viewer: the room talks back.
//
//   createGuide(ctx) -> Guide        build once the world is loaded; call start() when it is visible
//   guide.update(dt)                 every frame, before renderer.render (or pass ctx.onFrame)
//
// What it does:
//   - Labels: stored 3D labels for the scene (GET /api/scenes/:id/hotspots) or, once per scene, the
//     guide's hotspots for the scene's input photo / video plate projected into the room
//     (hotspots.ts), then stored back (PUT). Point (XR: right controller; desktop: click or look at
//     it with the mouse captured) and pull the trigger to ask about one.
//   - Ask: hold X or the left trigger in the headset, T on desktop (Space too in worlds without a
//     video), or the mic button. Release sends {image, audio, scene, history} to /api/guide/ask;
//     a typed box replaces the mic on desktop when there is no microphone.
//   - Narration: once per visit to a Photo world, a few seconds after it fades in.
//   - Speech plays from the WAV data URL; captions show on a panel in XR and a card on desktop.
// Every call goes through the Déjà View server's relay (/api/guide/*). When the guide is down there
// is one friendly notice and then quiet canned lines; nothing throws into the frame loop.

import * as THREE from 'three';
import type { Scene } from '../../../../shared/types.ts';
import { DesktopCaptions, XrCaptionPanel, fallbackToast, type CaptionState } from './captions.ts';
import {
  HotspotLayer,
  cameraFromThree,
  cameraFromVideo,
  cleanHotspots,
  depthMapFromNpy,
  parseInputCamera,
  parseNpy,
  parseStoredHotspots,
  placeHotspot,
  storedHotspotsBody,
  type DepthMap,
  type GuideHotspot,
  type PinholeCamera,
  type PlacedHotspot,
  type PlacementEnv,
  type Vec3,
} from './hotspots.ts';
import { SnapshotTaker, loadImageAsJpeg, type Snapshot } from './snapshot.ts';
import { MIN_RECORDING_SECONDS, SpeechPlayer, VoiceRecorder, playEarcon, speakWithDevice } from './voice.ts';

/** Seconds the headset's first-use hint stays readable before anything may replace it for good. */
const XR_HINT_MIN_S = 5;
/** When the greeting failed because the guide was down, try again after these many seconds (then give up). */
const NARRATE_RETRIES = [10, 20, 30, 45];

/** World sources that never come with input_camera.json (bundled samples, depth-lifted plate rooms). */
const NO_INPUT_CAMERA = new Set(['marble-sample', 'plate-depth']);

/** A splat raycast slower than this (ms) switches them off for the session: the voxel grid places labels then. */
const SLOW_RAYCAST_MS = 120;

export { HotspotLayer } from './hotspots.ts';
export type { PlacedHotspot, GuideHotspot } from './hotspots.ts';
export type { Snapshot } from './snapshot.ts';

// ---------------------------------------------------------------------------------------------
// The context the viewer hands over

/** What the guide needs from the viewer (web/src/viewer/app.ts builds it; see the wiring notes). */
export interface ViewerContext {
  /** The Scene being shown (shared/types.ts). */
  scene: Scene;
  /** Defaults to scene.id. */
  sceneId?: string;
  /** Prefix for /api and /data URLs; '' (default) is the page's own server. */
  baseUrl?: string;
  renderer: THREE.WebGLRenderer;
  /** The three.js scene the viewer renders. */
  three: THREE.Scene;
  /** The user camera (a child of the rig; in XR three.js keeps it at the head pose). */
  camera: THREE.PerspectiveCamera;
  /** The locomotion rig (XR controllers hang off it; they are hidden in snapshots). */
  rig: THREE.Object3D;
  /**
   * The object whose matrixWorld maps the scene's viewer frame (after WorldAsset.transform; the
   * frame of input_camera.json and VideoLayer.cameraPose) into three.js world: app.ts `flip`.
   */
  worldRoot: THREE.Object3D;
  /** The splat mesh, for raycasts (null while loading). */
  splats?: () => THREE.Object3D | null;
  /** Collision world in three.js world coordinates (voxel grid or mesh collider). */
  collision?: () => { solidAt(x: number, y: number, z: number): boolean } | null;
  /** The viewer's toast (hud.toast). Defaults to a toast in #tw-toasts. */
  toast?: (title: string, body?: string, kind?: 'info' | 'error' | 'ok', ms?: number) => void;
  /** Media to turn down while the guide speaks (the video element of a Video world). */
  media?: () => HTMLMediaElement | null;
  /** Whether the world has a playing video layer (Space then stays play/pause). Defaults to !!scene.video. */
  hasVideo?: () => boolean;
  /** True while the world is shown flipped (labels are then not stored). */
  flipped?: () => boolean;
  /** Optional per-frame hook: when given, the guide registers update() there itself. */
  onFrame?: (cb: (dt: number) => void) => () => void;
  /**
   * XR: true while another part of the viewer owns the right trigger (the wrist panel is under the pointer, a note
   * phrase picker is open). The trigger then does not ask about the label under the pointer.
   */
  pointerBusy?: () => boolean;
  /**
   * How far (metres) a label may sit from the camera that saw it, and how far labels can be pointed at. Default 6 m,
   * the contract's room-sized reach; the viewer passes more for big outdoor worlds (a street seen from 50 m away).
   */
  labelReach?: () => number;
}

export interface GuideOptions {
  /** 'photo' narrates only worlds without a video (the contract), 'always', or 'never'. */
  narrate: 'photo' | 'always' | 'never';
  /** Seconds after start() before the greeting (the reveal and intro take about 3 s). */
  narrateDelay: number;
  /** Seconds after start() before labels may pop in. */
  labelsDelay: number;
  /** Seconds after start() for the overview snapshot (labels for scenes with no input camera). */
  overviewDelay: number;
  hotspots: boolean;
  /** Store placed labels with PUT /api/scenes/:id/hotspots. */
  storeHotspots: boolean;
  /** xr-standard button indices on the talk hand that talk while held: 4 = X, 0 = trigger. */
  talkButtons: number[];
  talkHand: XRHandedness;
  /** Desktop hold-to-talk keys. 'Space' only applies to worlds without a video (there it is play/pause). */
  talkKeys: string[];
  desktopUi: boolean;
  snapshotWidth: number;
  timeouts: { narrate: number; hotspots: number; ask: number; stored: number };
  historyTurns: number;
  /** Seconds the answer stays up after the speech ends. */
  holdSeconds: number;
  fetch?: FetchLike;
}

/** fetch without the extras of `typeof fetch` (tests pass a plain function). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_GUIDE_OPTIONS: GuideOptions = {
  narrate: 'photo',
  narrateDelay: 3.2,
  labelsDelay: 2.4,
  overviewDelay: 3.0,
  hotspots: true,
  storeHotspots: true,
  talkButtons: [4, 0],
  talkHand: 'left',
  talkKeys: ['KeyT', 'Space'],
  desktopUi: true,
  // contracts 8: about 1024 x 768, so a scoreboard on a TV across the room is still readable for the guide
  snapshotWidth: 1024,
  timeouts: { narrate: 12000, hotspots: 18000, ask: 13000, stored: 4000 },
  historyTurns: 4,
  holdSeconds: 3.5,
};

// ---------------------------------------------------------------------------------------------
// The relay client

export type GuideErrorKind = 'offline' | 'timeout' | 'http' | 'aborted' | 'bad-response';

export class GuideRequestError extends Error {
  constructor(message: string, readonly kind: GuideErrorKind, readonly status = 0, readonly notConfigured = false) {
    super(message);
    this.name = 'GuideRequestError';
  }

  /**
   * The guide (or the way to it) is down, as opposed to a request we got wrong. A 404/405/501 on a
   * guide route means the server has no relay there (yet), which is the same thing to a visitor.
   */
  get unavailable(): boolean {
    if (this.kind === 'offline' || this.kind === 'timeout' || this.kind === 'bad-response') return true;
    return this.kind === 'http' && (this.status >= 500 || this.status === 404 || this.status === 405);
  }
}

export interface RequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Delays before each retry (its length is the number of retries). */
  retryDelaysMs?: number[];
  retryOn?: (e: GuideRequestError) => boolean;
}

export interface NarrateResponse {
  answer?: string;
  speech?: string | null;
  degraded?: boolean;
}
export interface AskResponse {
  question?: string;
  answer?: string;
  speech?: string | null;
  hotspot?: { label?: string; x?: number; y?: number } | null;
  degraded?: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new GuideRequestError('cancelled', 'aborted'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new GuideRequestError('cancelled', 'aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Talks to the server's guide relay and its hotspot store. Never throws anything but GuideRequestError. */
export class GuideClient {
  private fetchImpl: FetchLike;

  constructor(readonly baseUrl = '', fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  }

  url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, opts: RequestOptions): Promise<T> {
    const delays = opts.retryDelaysMs ?? [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, body, opts);
      } catch (e) {
        const err = e instanceof GuideRequestError ? e : new GuideRequestError(String(e), 'offline');
        const more = attempt < delays.length && err.kind !== 'aborted' && !err.notConfigured && (opts.retryOn ? opts.retryOn(err) : err.unavailable);
        if (!more) throw err;
        await sleep(delays[attempt], opts.signal);
      }
    }
  }

  private async once<T>(method: string, path: string, body: unknown, opts: RequestOptions): Promise<T> {
    if (opts.signal?.aborted) throw new GuideRequestError('cancelled', 'aborted');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, opts.timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path), {
          method,
          headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
          cache: 'no-store',
        });
      } catch {
        if (timedOut) throw new GuideRequestError('the guide took too long', 'timeout');
        if (opts.signal?.aborted) throw new GuideRequestError('cancelled', 'aborted');
        throw new GuideRequestError('the guide is not reachable', 'offline');
      }
      const type = res.headers.get('content-type') ?? '';
      let data: unknown = null;
      let text = '';
      try {
        text = await res.text();
      } catch {
        if (timedOut) throw new GuideRequestError('the guide took too long', 'timeout');
        if (opts.signal?.aborted) throw new GuideRequestError('cancelled', 'aborted');
        throw new GuideRequestError('the answer was cut off', 'offline', res.status);
      }
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!res.ok) {
        const msg = data && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `HTTP ${res.status}`;
        // an HTML error page (the tunnel or the Mac is down) counts as offline
        const html = data === null && /html/i.test(type + text.slice(0, 64));
        // the server has no guide at all (GUIDE_URL unset): it will not come back by itself
        const notConfigured = !!data && (data as { configured?: unknown }).configured === false;
        throw new GuideRequestError(msg, html ? 'offline' : 'http', res.status, notConfigured);
      }
      if (data === null || typeof data !== 'object') throw new GuideRequestError('the guide sent something that is not JSON', 'bad-response', res.status);
      return data as T;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  narrate(body: { image: string; scene: { id: string } }, opts: RequestOptions): Promise<NarrateResponse> {
    return this.request('POST', '/api/guide/narrate', body, opts);
  }

  hotspots(body: { image: string; scene: { id: string } }, opts: RequestOptions): Promise<{ hotspots?: unknown }> {
    return this.request('POST', '/api/guide/hotspots', body, opts);
  }

  ask(body: { image?: string; audio?: string; question?: string; scene: { id: string }; history: Array<{ q: string; a: string }> }, opts: RequestOptions): Promise<AskResponse> {
    return this.request('POST', '/api/guide/ask', body, opts);
  }

  /** Stored 3D labels; null when there are none (404) or the store cannot be reached. */
  async storedHotspots(sceneId: string, timeoutMs: number): Promise<unknown | null> {
    try {
      return await this.request('GET', `/api/scenes/${encodeURIComponent(sceneId)}/hotspots`, undefined, { timeoutMs });
    } catch {
      return null;
    }
  }

  async storeHotspots(sceneId: string, body: unknown, timeoutMs: number): Promise<boolean> {
    try {
      await this.request('PUT', `/api/scenes/${encodeURIComponent(sceneId)}/hotspots`, body, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers

/** The parts of Spark's SplatMesh that decide which splats a raycast tests (not in its public types). */
interface LodRaycastable {
  packedSplats?: { numSplats?: number; packedArray?: unknown; lodSplats?: unknown } | null;
  raycastIndices?: { numSplats: number; indices?: Uint32Array } | undefined;
  context?: { enableLod?: { value: boolean } };
}

/**
 * Runs `fn` (a raycast) against the mesh's full-resolution splats. With a level-of-detail tree (worlds over 800k
 * splats on a Quest, world.ts lodThreshold) Spark raycasts only the coarse LoD subset, which misses near surfaces or
 * hits far behind them, so labels and answer pins landed tens of metres off in the headset. The full set stays next
 * to the tree (nonLod: true in world.ts); the raycast is pointed at it for this one synchronous call, then restored.
 */
export function withFullResolution(mesh: object, fn: () => void): void {
  const m = mesh as LodRaycastable;
  const packed = m.packedSplats;
  const full = packed?.numSplats ?? 0;
  const lod = m.context?.enableLod;
  if (!packed?.lodSplats || !(full > 0) || !packed.packedArray || !lod) {
    fn();
    return;
  }
  const saved = { indices: m.raycastIndices, lod: lod.value };
  try {
    m.raycastIndices = { numSplats: full, indices: undefined };
    lod.value = false;
    fn();
  } finally {
    m.raycastIndices = saved.indices;
    lod.value = saved.lod;
  }
}

/** "Snack bowl" -> "Tell me about the snack bowl."; "Maya's controller" stays as it is. */
export function questionAbout(label: string): string {
  let l = label.trim().replace(/[.?!]+$/, '');
  if (!l) return 'What am I looking at?';
  // "Maya's controller": a name, keep it as it is
  if (/\w['\u2019]s\b/i.test(l)) return `Tell me about ${l}.`;
  // "Snack bowl" is title case from the label, not a name; "TV screen" keeps its capitals
  if (l.length > 1 && /[A-Z]/.test(l[0]) && /[a-z]/.test(l[1])) l = l[0].toLowerCase() + l.slice(1);
  const hasArticle = /^(the|a|an|this|that|these|those|my|your|his|her|their|our)\b/i.test(l);
  return `Tell me about ${hasArticle ? '' : 'the '}${l}.`;
}

/** Seconds to leave a caption up when there is no speech to time it by. */
export function readingSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(14, Math.max(3.5, 1.2 + words * 0.32));
}

export function isVideoScene(scene: Scene, hasVideo?: () => boolean): boolean {
  if (hasVideo) return hasVideo();
  const mode = scene.mode as string;
  return !!scene.video || mode === 'thirdwheel' || mode === 'video';
}

/** Image files in a scene a browser can decode (input photos may be HEIC). */
export function decodableImage(path: string | undefined | null): boolean {
  return !!path && /\.(jpe?g|png|webp|gif|avif)$/i.test(path);
}

const CANNED = {
  offline: "I can't reach the guide right now. Give it a second and ask again.",
  notSetUp: "The guide isn't set up on this server, so I can't answer out loud here.",
  noAnswer: "Hmm, I didn't catch that. Try asking again.",
  noMic: 'The microphone is off for this page.',
  tooShort: 'Hold the button while you ask.',
};

// ---------------------------------------------------------------------------------------------
// The guide

export type GuidePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface GuideDebug {
  phase: GuidePhase;
  mic: string;
  started: boolean;
  narrated: boolean;
  hotspotStatus: 'idle' | 'loading' | 'placing' | 'done' | 'none' | 'failed';
  hotspotSource: 'stored' | 'input' | 'snapshot' | 'live' | null;
  /** Labels placed for this scene (they pop in labelsDelay after start). */
  labels: Array<{ label: string; position: Vec3; source?: string }>;
  /** Labels currently in the room. */
  labelsShown: number;
  hover: string | null;
  caption: CaptionState;
  lastQuestion: string;
  lastAnswer: string;
  lastError: string;
  requests: { narrate: number; hotspots: number; ask: number; stored: number; store: number };
  offlineNotified: boolean;
  snapshot: { frameMs: number; totalMs: number; width: number; height: number; xr: boolean } | null;
  speaking: boolean;
  history: Array<{ q: string; a: string }>;
}

export interface Guide {
  /** Call when the world is visible (after the loader lifts): starts labels and the greeting timer. */
  start(): void;
  /** Every frame, before the main render. */
  update(dt: number): void;
  /** Ask a typed question (also used by the desktop box). */
  ask(question: string): Promise<void>;
  /** Ask about a placed label. */
  askAbout(hotspot: PlacedHotspot): Promise<void>;
  /** Push-to-talk from code (another button, a test). */
  startTalking(): void;
  stopTalking(): void;
  /** Play the greeting now (normally automatic). */
  narrate(): Promise<void>;
  /**
   * Call from the Enter VR click: opens the microphone early when the site already has permission,
   * so the first hold in the headset records at once. (Grant it on the page first: hold the mic
   * button once. Without permission the first hold asks.)
   */
  warmUp(): void;
  /** Show or hide the labels (host cue `labels`). */
  setLabelsVisible(on: boolean): void;
  /** Replace the labels with 3D ones (room frame metres), e.g. from a `hotspots` WebSocket message. */
  setHotspots(list: unknown): void;
  readonly hotspots: PlacedHotspot[];
  readonly debug: GuideDebug;
  dispose(): void;
}

interface Talk {
  turn: number;
  source: 'xr' | 'key' | 'mic' | 'api';
  started: Promise<boolean>;
  snapshot: Promise<Snapshot | null>;
  /** The microphone was not open yet when the button went down (a permission prompt may show). */
  firstOpen: boolean;
}

interface InputView {
  image: string;
  camera: PinholeCamera;
  depth: DepthMap | null;
}

export function createGuide(ctx: ViewerContext, options: Partial<GuideOptions> = {}): Guide {
  return new GuideImpl(ctx, { ...DEFAULT_GUIDE_OPTIONS, ...options, timeouts: { ...DEFAULT_GUIDE_OPTIONS.timeouts, ...options.timeouts } });
}

class GuideImpl implements Guide {
  readonly debug: GuideDebug;
  private sceneId: string;
  private client: GuideClient;
  private recorder = new VoiceRecorder();
  private player = new SpeechPlayer();
  private snapshots: SnapshotTaker;
  private layer: HotspotLayer;
  private panel = new XrCaptionPanel();
  private desktop: DesktopCaptions | null = null;
  private laser: THREE.Line;
  private raycaster = new THREE.Raycaster();
  private history: Array<{ q: string; a: string }> = [];
  private phase: GuidePhase = 'idle';
  private caption: CaptionState = { mode: 'hidden' };
  private captionTimer = 0;
  private turn = 0;
  private talk: Talk | null = null;
  private askAbort: AbortController | null = null;
  private lifetime = new AbortController();
  private startedAt = -1;
  private clock = 0;
  private narrated = false;
  private overview: Promise<Snapshot> | null = null;
  private lastSnapshot: Snapshot | null = null;
  private pendingLabels: PlacedHotspot[] | null = null;
  private placement: { list: GuideHotspot[]; env: PlacementEnv; i: number; out: PlacedHotspot[]; source: 'input' | 'snapshot'; slowSplats: boolean } | null = null;
  /** A hotspots request waiting to be tried again (the guide was down). */
  private hotspotRetry: { at: number; image: string; env: PlacementEnv; source: 'input' | 'snapshot'; tries: number } | null = null;
  private offlineNotified = false;
  /** The server has no guide configured: no more guide calls this visit (stored labels still show). */
  private guideOff = false;
  /** The greeting failed because the guide was down: try again later (it plays on its own when the guide is back). */
  private narrateRetry: { at: number; tries: number } | null = null;
  private xrHint: { caption: CaptionState | null; shownAt: number; done: boolean } = { caption: null, shownAt: -1, done: false };
  private presenting = false;
  private xrHintShown = false;
  /** Splat raycasts were too slow on this device (the voxel grid places labels instead). */
  private slowRaycasts = false;
  private xrTalkHeld = false;
  private xrTriggerHeld = false;
  private keyHeld: string | null = null;
  private mouse: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  private duck = { level: 1, target: 1, base: 1, el: null as HTMLMediaElement | null };
  private errorsSeen = new Set<string>();
  private unsubscribeFrame: (() => void) | null = null;
  private disposed = false;
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpD = new THREE.Vector3();

  constructor(private ctx: ViewerContext, private opts: GuideOptions) {
    this.sceneId = ctx.sceneId ?? ctx.scene.id;
    this.client = new GuideClient(ctx.baseUrl ?? '', opts.fetch);
    this.debug = {
      phase: 'idle',
      mic: this.recorder.state,
      started: false,
      narrated: false,
      hotspotStatus: 'idle',
      hotspotSource: null,
      labels: [],
      labelsShown: 0,
      hover: null,
      caption: this.caption,
      lastQuestion: '',
      lastAnswer: '',
      lastError: '',
      requests: { narrate: 0, hotspots: 0, ask: 0, stored: 0, store: 0 },
      offlineNotified: false,
      snapshot: null,
      speaking: false,
      history: this.history,
    };
    this.layer = new HotspotLayer({ actionHint: () => (this.presenting ? 'Pull the trigger to ask' : 'Click to ask') });
    ctx.three.add(this.layer.group, this.panel.mesh);
    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: 0x007aff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false }));
    this.laser.renderOrder = 975;
    this.laser.frustumCulled = false;
    this.laser.visible = false;
    ctx.three.add(this.laser);

    this.snapshots = new SnapshotTaker(ctx.renderer, ctx.three, ctx.camera, () => this.hiddenInSnapshots(), { width: opts.snapshotWidth });

    this.player.onBlocked = () => {
      if (!this.presenting && this.caption.mode !== 'hidden') this.setCaption({ ...this.caption, title: 'Tap anywhere to hear it' }, 12);
    };
    this.recorder.onAutoStop = () => this.endTalk();

    if (opts.desktopUi && typeof document !== 'undefined') {
      this.desktop = new DesktopCaptions(
        { onMicDown: () => this.onMicDown(), onMicUp: () => this.endTalk(), onTyped: (q) => void this.ask(q) },
        this.keyLabel(),
      );
      this.desktop.setNoMic(!VoiceRecorder.supported());
      // shown from start(), when the world is visible (the loader sits underneath otherwise)
      this.desktop.setVisible(false);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('keyup', this.onKeyUp, true);
      window.addEventListener('blur', this.onBlur);
      window.addEventListener('pointerdown', this.onGesture, true);
      ctx.renderer.domElement.addEventListener('pointerdown', this.onCanvasDown);
      ctx.renderer.domElement.addEventListener('pointermove', this.onCanvasMove);
      ctx.renderer.domElement.addEventListener('pointerleave', this.onCanvasLeave);
      document.fonts?.ready.then(() => {
        this.layer.invalidate();
        this.panel.invalidate();
      }).catch(() => undefined);
    }
    if (ctx.onFrame) this.unsubscribeFrame = ctx.onFrame((dt) => this.update(dt));
  }

  // ---------- public ----------

  get hotspots(): PlacedHotspot[] {
    return this.layer.hotspots;
  }

  start(): void {
    if (this.disposed || this.startedAt >= 0) return;
    this.startedAt = this.clock;
    this.debug.started = true;
    this.desktop?.setVisible(!this.presenting);
    if (this.opts.hotspots) void this.loadHotspots();
  }

  update(dt: number): void {
    if (this.disposed) return;
    try {
      this.step(Math.min(0.1, Math.max(0, dt)));
    } catch (e) {
      this.logOnce('update', e);
    }
  }

  warmUp(): void {
    // only when already allowed: a permission prompt here could get in the way of entering VR
    if (VoiceRecorder.supported()) void this.recorder.warmIfGranted().then(() => this.syncMicUi());
  }

  setLabelsVisible(on: boolean): void {
    this.layer.setVisible(on);
  }

  setHotspots(list: unknown): void {
    this.layer.reach = this.reach();
    const placed = parseStoredHotspots(list);
    this.placement = null;
    this.hotspotRetry = null;
    this.showLabels(placed, 'stored');
  }

  startTalking(): void {
    this.beginTalk('api');
  }

  stopTalking(): void {
    this.endTalk();
  }

  async narrate(): Promise<void> {
    this.narrated = true;
    this.debug.narrated = true;
    if (this.guideOff) return;
    const turn = this.turn;
    let snap: Snapshot | null = null;
    try {
      snap = await this.overviewSnapshot();
    } catch (e) {
      this.logOnce('narrate-snapshot', e);
      return;
    }
    if (this.disposed || turn !== this.turn || this.phase !== 'idle') return;
    this.debug.requests.narrate++;
    let res: NarrateResponse;
    try {
      res = await this.client.narrate(
        { image: snap.image, scene: { id: this.sceneId } },
        { timeoutMs: this.opts.timeouts.narrate, signal: this.lifetime.signal, retryDelaysMs: [1500], retryOn: (e) => e.kind === 'offline' },
      );
    } catch (e) {
      this.failed('narrate', e);
      // the guide is down, not gone: greet when it is back (a few tries in the first couple of minutes)
      const tries = this.narrateRetry?.tries ?? 0;
      if (e instanceof GuideRequestError && e.unavailable && !e.notConfigured && tries < NARRATE_RETRIES.length && !this.disposed) {
        this.narrated = false;
        this.debug.narrated = false;
        this.narrateRetry = { at: this.clock + NARRATE_RETRIES[tries]!, tries: tries + 1 };
      }
      return;
    }
    this.narrateRetry = null;
    // the person started asking meanwhile: their question wins
    if (this.disposed || turn !== this.turn || this.phase !== 'idle') return;
    const answer = typeof res.answer === 'string' ? res.answer.trim() : '';
    if (!answer) return;
    this.debug.lastAnswer = answer;
    await this.speak(turn, { answer, speech: res.speech ?? null, title: 'Welcome' });
  }

  async ask(question: string): Promise<void> {
    const q = question.trim().slice(0, 300);
    if (!q) return;
    const turn = this.newTurn();
    this.desktop?.showTyping(false);
    await this.sendAsk(turn, { question: q }, this.snapshotOrNull());
  }

  async askAbout(h: PlacedHotspot): Promise<void> {
    const turn = this.newTurn();
    playEarcon('pop');
    this.layer.pulse(h.id, 4);
    await this.sendAsk(turn, { question: questionAbout(h.label) }, this.snapshotOrNull(), h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.askAbort?.abort();
    this.unsubscribeFrame?.();
    this.recorder.dispose();
    this.player.stop();
    this.snapshots.dispose();
    this.layer.dispose();
    this.panel.dispose();
    this.laser.removeFromParent();
    this.laser.geometry.dispose();
    (this.laser.material as THREE.Material).dispose();
    this.desktop?.dispose();
    if (this.duck.el) this.duck.el.volume = this.duck.base;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('keyup', this.onKeyUp, true);
      window.removeEventListener('blur', this.onBlur);
      window.removeEventListener('pointerdown', this.onGesture, true);
      this.ctx.renderer.domElement.removeEventListener('pointerdown', this.onCanvasDown);
      this.ctx.renderer.domElement.removeEventListener('pointermove', this.onCanvasMove);
      this.ctx.renderer.domElement.removeEventListener('pointerleave', this.onCanvasLeave);
      this.ctx.renderer.domElement.style.cursor = '';
    }
  }

  // ---------- frame ----------

  private step(dt: number): void {
    this.clock += dt;
    this.snapshots.tick();
    const presenting = this.ctx.renderer.xr.isPresenting;
    if (presenting !== this.presenting) this.onPresentChange(presenting);

    if (presenting) {
      this.pollXr();
      this.stepXrHint();
    } else {
      this.laser.visible = false;
      this.pollDesktopHover();
    }

    this.stepPlacement();
    const retry = this.hotspotRetry;
    if (retry && this.clock >= retry.at) {
      this.hotspotRetry = null;
      if (!this.layer.count && !this.pendingLabels) void this.requestHotspots(retry.image, retry.env, retry.source, retry.tries);
    }

    if (this.startedAt >= 0) {
      const t = this.clock - this.startedAt;
      if (this.pendingLabels && t >= this.opts.labelsDelay) {
        this.layer.set(this.pendingLabels);
        this.pendingLabels = null;
        this.syncLabelDebug();
      }
      const retryDue = !this.narrateRetry || (this.clock >= this.narrateRetry.at && this.phase === 'idle' && !this.talk && this.caption.mode === 'hidden');
      if (!this.narrated && t >= this.opts.narrateDelay && retryDue && this.wantsNarration()) void this.narrate();
    }

    if (this.captionTimer > 0) {
      this.captionTimer -= dt;
      if (this.captionTimer <= 0 && this.phase === 'idle') this.setCaption({ mode: 'hidden' });
    }

    const level = this.recorder.level();
    this.layer.update(dt, this.ctx.camera);
    this.debug.labelsShown = this.layer.hotspots.length;
    this.panel.update(dt, this.ctx.camera, presenting, level);
    this.desktop?.update(dt, level);
    this.stepDuck(dt);
    this.debug.phase = this.phase;
    this.debug.mic = this.recorder.state;
    this.debug.speaking = this.player.playing;
  }

  private onPresentChange(on: boolean): void {
    this.presenting = on;
    this.desktop?.setVisible(!on && this.startedAt >= 0);
    this.layer.invalidate();
    this.setHover(null);
    this.xrTalkHeld = false;
    this.xrTriggerHeld = false;
    if (!on && this.talk?.source === 'xr') this.endTalk();
    // the first-use hint shows from stepXrHint() as soon as nothing else is on the panel
  }

  /**
   * The headset's first-use hint ("Hold X and ask ..."), shown once the panel is free and kept up long enough to read
   * (XR_HINT_MIN_S). A greeting that interrupts it (or that started with the Enter VR click itself) brings it back
   * when it ends; asking out loud once means it was learnt.
   */
  private stepXrHint(): void {
    const h = this.xrHint;
    if (h.done || this.startedAt < 0) return;
    if (h.caption && this.caption === h.caption) {
      if (this.clock - h.shownAt >= XR_HINT_MIN_S) h.done = true;
      return;
    }
    if (this.phase !== 'idle' || this.talk || this.caption.mode !== 'hidden') return;
    h.caption = { mode: 'hint', title: 'Your guide', answer: 'Hold X and ask about anything you can see.', question: 'Point at a label and pull the trigger to hear about it.' };
    h.shownAt = this.clock;
    this.xrHintShown = true;
    this.setCaption(h.caption, 7);
  }

  private wantsNarration(): boolean {
    if (this.opts.narrate === 'never') return false;
    if (this.opts.narrate === 'always') return true;
    return !isVideoScene(this.ctx.scene, this.ctx.hasVideo);
  }

  // ---------- XR input ----------

  private pollXr(): void {
    const xr = this.ctx.renderer.xr;
    const session = xr.getSession();
    const frame = xr.getFrame?.();
    const ref = xr.getReferenceSpace();
    if (!session) return;
    let talk = false;
    let trigger = false;
    let rayPose: Float32Array | null = null;
    let pointerSource: XRInputSource | null = null;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      if (src.handedness === this.opts.talkHand) {
        for (const i of this.opts.talkButtons) if (gp.buttons[i]?.pressed) talk = true;
      } else {
        trigger = !!gp.buttons[0]?.pressed;
        pointerSource = src;
        if (frame && ref) {
          try {
            rayPose = frame.getPose(src.targetRaySpace, ref)?.transform.matrix ?? null;
          } catch {
            rayPose = null;
          }
        }
      }
    }
    if (talk && !this.xrTalkHeld) {
      this.beginTalk('xr');
      this.haptic(session, this.opts.talkHand, 0.45, 35);
    } else if (!talk && this.xrTalkHeld && this.talk?.source === 'xr') this.endTalk();
    this.xrTalkHeld = talk;

    let hovered: PlacedHotspot | null = null;
    if (rayPose) {
      this.ctx.rig.updateMatrixWorld();
      this.tmpM.fromArray(rayPose).premultiply(this.ctx.rig.matrixWorld);
      const origin = this.tmpV.setFromMatrixPosition(this.tmpM);
      const dir = this.tmpD.set(0, 0, -1).transformDirection(this.tmpM);
      this.raycaster.set(origin, dir);
      this.raycaster.near = 0.05;
      this.raycaster.far = Math.max(15, this.reach() + 2);
      const hit = this.layer.hit(this.raycaster);
      hovered = hit?.hotspot ?? null;
      if (hit) {
        const pos = this.laser.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, origin.x, origin.y, origin.z);
        pos.setXYZ(1, hit.point.x, hit.point.y, hit.point.z);
        pos.needsUpdate = true;
        this.laser.geometry.computeBoundingSphere();
      }
      this.laser.visible = !!hit;
    } else this.laser.visible = false;
    if (hovered?.id !== this.hoverId && hovered && pointerSource) this.haptic(session, pointerSource.handedness, 0.15, 12);
    this.setHover(hovered);
    if (trigger && !this.xrTriggerHeld && hovered && !this.ctx.pointerBusy?.()) void this.askAbout(hovered);
    this.xrTriggerHeld = trigger;
  }

  private haptic(session: XRSession, hand: XRHandedness, value: number, ms: number): void {
    try {
      for (const src of session.inputSources) {
        if (src.handedness !== hand) continue;
        const gp = src.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => Promise<boolean> }> }) | null;
        const act = gp?.hapticActuators?.[0];
        if (act?.pulse) void act.pulse(value, ms).catch(() => undefined);
        else void (gp?.vibrationActuator as { playEffect?: (t: string, p: object) => Promise<unknown> } | null)?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: value, weakMagnitude: value })?.catch(() => undefined);
      }
    } catch {
      /* haptics are a nicety */
    }
  }

  // ---------- desktop input ----------

  private keyLabel(): string {
    const space = this.opts.talkKeys.includes('Space') && !isVideoScene(this.ctx.scene, this.ctx.hasVideo);
    const key = this.opts.talkKeys.find((k) => k !== 'Space');
    const name = (k: string) => k.replace(/^Key/, '').replace(/^Digit/, '');
    if (space && key) return `Hold ${name(key)} or Space`;
    if (space) return 'Hold Space';
    return key ? `Hold ${name(key)}` : 'Hold to ask';
  }

  private isTalkKey(code: string): boolean {
    if (!this.opts.talkKeys.includes(code)) return false;
    if (code === 'Space' && isVideoScene(this.ctx.scene, this.ctx.hasVideo)) return false;
    return true;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.onGesture();
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || this.startedAt < 0) return;
    if (!this.isTalkKey(e.code)) return;
    e.preventDefault();
    if (e.repeat || this.keyHeld) return;
    if (!VoiceRecorder.supported() || this.recorder.state === 'denied') {
      this.desktop?.showTyping(true);
      return;
    }
    this.keyHeld = e.code;
    this.beginTalk('key');
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.keyHeld && e.code === this.keyHeld) {
      e.preventDefault();
      this.keyHeld = null;
      this.endTalk();
    }
  };

  private onBlur = () => {
    if (this.keyHeld) {
      this.keyHeld = null;
      this.endTalk();
    }
  };

  /** Any gesture: play speech the browser blocked earlier. */
  private onGesture = () => {
    const p = this.player.unlock();
    if (p && this.phase === 'idle') {
      const turn = this.turn;
      this.phase = 'speaking';
      this.setCaption({ ...this.caption, mode: 'speaking', title: undefined }, 0);
      this.duckMedia(true);
      void p.then(() => {
        if (turn === this.turn && this.phase === 'speaking') this.finishSpeaking(this.caption.answer ?? '');
      });
    }
  };

  private onMicDown(): void {
    if (this.startedAt < 0) return;
    if (!VoiceRecorder.supported() || this.recorder.state === 'denied') {
      this.desktop?.showTyping(!this.desktop.typing);
      return;
    }
    this.beginTalk('mic');
  }

  private onCanvasMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const r = this.ctx.renderer.domElement.getBoundingClientRect();
    this.mouse = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };

  private onCanvasLeave = () => {
    this.mouse = null;
  };

  private onCanvasDown = (e: PointerEvent) => {
    if (this.presenting || e.button !== 0) return;
    const h = this.hoverFor(e.pointerType === 'mouse' ? null : e);
    if (h) void this.askAbout(h);
  };

  /** The label under the mouse, or at the centre while the mouse is captured. */
  private hoverFor(touch: PointerEvent | null): PlacedHotspot | null {
    if (!this.layer.count) return null;
    let ndc: { x: number; y: number } | null;
    if (touch) {
      const r = this.ctx.renderer.domElement.getBoundingClientRect();
      ndc = { x: ((touch.clientX - r.left) / r.width) * 2 - 1, y: -((touch.clientY - r.top) / r.height) * 2 + 1 };
    } else ndc = document.pointerLockElement ? { x: 0, y: 0 } : this.mouse;
    if (!ndc) return null;
    this.ctx.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.ctx.camera);
    this.raycaster.near = 0.05;
    this.raycaster.far = Math.max(30, this.reach() + 2);
    return this.layer.hit(this.raycaster)?.hotspot ?? null;
  }

  private pollDesktopHover(): void {
    const h = this.hoverFor(null);
    this.setHover(h);
    const cursor = h && !document.pointerLockElement ? 'pointer' : '';
    const el = this.ctx.renderer.domElement;
    if (el.style.cursor !== cursor) el.style.cursor = cursor;
  }

  private setHover(h: PlacedHotspot | null): void {
    const id = h?.id ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.layer.setHover(id);
    this.debug.hover = h?.label ?? null;
  }

  // ---------- talking ----------

  private newTurn(): number {
    this.turn++;
    this.player.stop();
    this.player.dropPending();
    this.askAbort?.abort();
    this.askAbort = null;
    this.duckMedia(false);
    return this.turn;
  }

  private beginTalk(source: Talk['source']): void {
    if (this.disposed || this.talk) return;
    if (!VoiceRecorder.supported() || this.recorder.state === 'denied') {
      this.noMic();
      return;
    }
    if (source === 'xr') this.xrHint.done = true;
    const turn = this.newTurn();
    this.phase = 'listening';
    this.setCaption({ mode: 'listening', question: 'Ask about anything you can see', answer: '' }, 0);
    playEarcon('start');
    const firstOpen = this.recorder.state !== 'ready';
    const started = this.recorder.start().then((ok) => {
      this.syncMicUi();
      return ok;
    });
    this.talk = { turn, source, started, snapshot: this.snapshotOrNull(), firstOpen };
  }

  private endTalk(): void {
    const t = this.talk;
    if (!t) return;
    this.talk = null;
    void (async () => {
      const ok = await t.started;
      if (t.turn !== this.turn) {
        // superseded; the recorder may already belong to a newer hold
        if (!this.talk) this.recorder.cancel();
        return;
      }
      if (!ok) {
        this.recorder.cancel();
        this.phase = 'idle';
        this.noMic();
        return;
      }
      const rec = await this.recorder.stop();
      playEarcon('stop');
      if (t.turn !== this.turn) return;
      if (!rec || rec.seconds < MIN_RECORDING_SECONDS) {
        this.phase = 'idle';
        const how = this.presenting ? 'Hold X, ask, then let go.' : `${this.keyLabel()}, ask, then let go.`;
        if (t.firstOpen) this.setCaption({ mode: 'hint', title: 'Microphone on', answer: 'The microphone is ready. Hold and ask away.', question: how }, 3.5);
        else this.setCaption({ mode: 'hint', title: 'Your guide', answer: CANNED.tooShort, question: how }, 3);
        return;
      }
      await this.sendAsk(t.turn, { audio: rec.dataUrl }, t.snapshot);
    })().catch((e) => this.logOnce('talk', e));
  }

  private noMic(): void {
    const state = this.recorder.state;
    this.syncMicUi();
    // the hold already showed "Listening": take it down, nothing is listening
    if (this.caption.mode === 'listening') {
      this.phase = 'idle';
      this.setCaption({ mode: 'hidden' });
    }
    if (!this.presenting && this.desktop) {
      this.desktop.showTyping(true);
      if (state === 'denied') this.notifyOnce('mic', 'Microphone blocked', 'Type your question instead, or allow the microphone for this site.');
      return;
    }
    playEarcon('error');
    this.setCaption({ mode: 'error', title: 'Microphone', answer: CANNED.noMic, question: state === 'denied' ? 'Allow the microphone for this site in the browser settings.' : 'This page needs a secure (https) address for the microphone.' }, 5);
  }

  private syncMicUi(): void {
    this.desktop?.setNoMic(!VoiceRecorder.supported() || this.recorder.state === 'denied' || this.recorder.state === 'unsupported');
    this.debug.mic = this.recorder.state;
  }

  private snapshotOrNull(): Promise<Snapshot | null> {
    return this.snapshots.request().then(
      (s) => {
        this.lastSnapshot = s;
        this.debug.snapshot = { frameMs: this.snapshots.lastFrameCostMs, totalMs: this.snapshots.lastTotalMs, width: s.width, height: s.height, xr: s.xr };
        return s;
      },
      (e) => {
        this.logOnce('snapshot', e);
        return null;
      },
    );
  }

  private async sendAsk(turn: number, payload: { audio?: string; question?: string }, snapP: Promise<Snapshot | null>, about?: PlacedHotspot): Promise<void> {
    this.phase = 'thinking';
    this.setCaption({ mode: 'thinking', question: payload.question ?? '', answer: '' }, 0);
    let snap = await snapP;
    if (turn !== this.turn || this.disposed) return;
    if (!snap) snap = await this.snapshotOrNull();
    if (turn !== this.turn || this.disposed) return;
    const ctrl = new AbortController();
    this.askAbort = ctrl;
    const onDispose = () => ctrl.abort();
    this.lifetime.signal.addEventListener('abort', onDispose, { once: true });
    this.debug.requests.ask++;
    let res: AskResponse;
    try {
      res = await this.client.ask(
        { ...(snap ? { image: snap.image } : {}), ...payload, scene: { id: this.sceneId }, history: this.history.slice(-this.opts.historyTurns) },
        { timeoutMs: this.opts.timeouts.ask, signal: ctrl.signal, retryDelaysMs: [350], retryOn: (e) => e.kind === 'offline' && e.status === 0 },
      );
    } catch (e) {
      if (turn !== this.turn || this.disposed) return;
      if (e instanceof GuideRequestError && e.kind === 'aborted') return;
      this.failed('ask', e);
      const down = !(e instanceof GuideRequestError) || e.unavailable;
      // a label still has its blurb to fall back on
      const answer = about?.blurb ? about.blurb : this.guideOff ? CANNED.notSetUp : down ? CANNED.offline : CANNED.noAnswer;
      await this.speak(turn, { question: payload.question ?? '', answer, speech: null, error: !about?.blurb });
      return;
    } finally {
      this.lifetime.signal.removeEventListener('abort', onDispose);
      if (this.askAbort === ctrl) this.askAbort = null;
    }
    if (turn !== this.turn || this.disposed) return;
    const question = (typeof res.question === 'string' && res.question.trim()) || payload.question || '';
    const answer = (typeof res.answer === 'string' && res.answer.trim()) || about?.blurb || CANNED.noAnswer;
    this.debug.lastQuestion = question;
    this.debug.lastAnswer = answer;
    this.history.push({ q: question || '(spoken question)', a: answer });
    while (this.history.length > this.opts.historyTurns) this.history.shift();
    if (res.hotspot && typeof res.hotspot.label === 'string') this.highlight(res.hotspot as { label: string; x?: number; y?: number }, snap);
    await this.speak(turn, { question, answer, speech: typeof res.speech === 'string' ? res.speech : null });
  }

  /** The answer is about one visible thing: light up its label, or pin a temporary one. */
  private highlight(h: { label: string; x?: number; y?: number }, snap: Snapshot | null): void {
    const existing = this.layer.find(h.label);
    if (existing) {
      this.layer.pulse(existing.id, 6);
      return;
    }
    const x = Number(h.x), y = Number(h.y);
    if (!snap || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const placed = placeHotspot({ label: h.label, x, y, blurb: '' }, this.snapshotEnv(snap));
    if (placed) this.layer.addTemporary({ ...placed, source: 'live' }, 8);
  }

  private async speak(turn: number, a: { question?: string; answer: string; speech: string | null; title?: string; error?: boolean }): Promise<void> {
    if (turn !== this.turn || this.disposed) return;
    this.phase = 'speaking';
    this.setCaption({ mode: a.error ? 'error' : 'speaking', question: a.question, answer: a.answer, title: a.title }, 0);
    let spoke = false;
    if (a.speech) {
      this.duckMedia(true);
      const r = await this.player.play(a.speech);
      if (turn !== this.turn || this.disposed) return;
      spoke = r === 'ended';
      if (r === 'blocked') {
        // waits for a gesture (onGesture); keep the caption up meanwhile
        this.phase = 'idle';
        this.duckMedia(false);
        this.captionTimer = 12;
        return;
      }
    }
    if (!spoke && !a.speech && !a.error && a.answer) {
      // the guide sent no audio (its speech models busy or out of quota): the device reads the answer instead
      this.duckMedia(true);
      spoke = await speakWithDevice(a.answer, readingSeconds(a.answer) * 1000 + 4000, this.lifetime.signal);
      if (turn !== this.turn || this.disposed) return;
    }
    if (!spoke) {
      // no voice: leave time to read (minus the hold that follows)
      const wait = Math.max(0, readingSeconds(a.answer) - this.opts.holdSeconds) * 1000;
      if (wait) await sleep(wait, this.lifetime.signal).catch(() => undefined);
      if (turn !== this.turn || this.disposed) return;
    }
    this.finishSpeaking(a.answer);
  }

  private finishSpeaking(answer: string): void {
    this.phase = 'idle';
    this.duckMedia(false);
    this.setCaption({ ...this.caption, mode: this.caption.mode === 'error' ? 'error' : 'answer', title: this.caption.title }, Math.max(this.opts.holdSeconds, answer ? 2 : 0));
  }

  private setCaption(c: CaptionState, holdSeconds = 0): void {
    this.caption = c;
    this.captionTimer = holdSeconds;
    this.debug.caption = c;
    this.panel.set(c);
    this.desktop?.set(c);
  }

  // ---------- media ducking ----------

  private duckMedia(on: boolean): void {
    const el = this.ctx.media?.() ?? null;
    if (on) {
      if (!el) return;
      if (this.duck.el !== el) {
        this.duck.el = el;
        this.duck.base = el.volume;
        this.duck.level = 1;
      } else if (this.duck.target === 1 && this.duck.level >= 0.999) this.duck.base = el.volume;
      this.duck.target = 0.3;
    } else this.duck.target = 1;
  }

  private stepDuck(dt: number): void {
    const el = this.duck.el;
    if (!el) return;
    const d = this.duck;
    if (Math.abs(d.level - d.target) < 0.002) {
      if (d.level === d.target) return;
      d.level = d.target;
    } else d.level += (d.target - d.level) * Math.min(1, dt * 6);
    try {
      el.volume = Math.min(1, Math.max(0, d.base * d.level));
    } catch {
      /* some media refuse volume changes */
    }
    if (d.target === 1 && d.level === 1) this.duck.el = null;
  }

  // ---------- hotspots ----------

  private hiddenInSnapshots(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [this.layer.group, this.panel.mesh, this.laser];
    for (const c of this.ctx.rig.children) if (c !== this.ctx.camera) out.push(c);
    return out;
  }

  /** One snapshot of the view a few seconds in (after the intro move), shared by the greeting and the labels. */
  private overviewSnapshot(): Promise<Snapshot> {
    if (this.overview) return this.overview;
    this.overview = (async () => {
      while (!this.disposed && (this.startedAt < 0 || this.clock - this.startedAt < this.opts.overviewDelay)) await sleep(100, this.lifetime.signal);
      const s = await this.snapshots.request();
      this.lastSnapshot = s;
      this.debug.snapshot = { frameMs: this.snapshots.lastFrameCostMs, totalMs: this.snapshots.lastTotalMs, width: s.width, height: s.height, xr: s.xr };
      return s;
    })();
    this.overview.catch(() => {
      this.overview = null;
    });
    return this.overview;
  }

  private dataUrl(file: string): string {
    return this.client.url(`/data/scenes/${encodeURIComponent(this.sceneId)}/${file.split('/').map(encodeURIComponent).join('/')}`);
  }

  private async fetchOptional(file: string, kind: 'json' | 'bytes'): Promise<unknown | ArrayBuffer | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const onDispose = () => ctrl.abort();
      this.lifetime.signal.addEventListener('abort', onDispose, { once: true });
      try {
        const res = await fetch(this.dataUrl(file), { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) return null;
        return kind === 'json' ? await res.json() : await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', onDispose);
      }
    } catch {
      return null;
    }
  }

  /** The scene's own input view: its photo or video plate, the camera it was taken with, and depth. */
  private async inputView(): Promise<InputView | null> {
    const scene = this.ctx.scene;
    // only generated and reconstructed worlds come with input_camera.json: asking the others is a 404 in the console
    const source = scene.world?.source;
    const mayHaveCamera = !source || !NO_INPUT_CAMERA.has(source);
    const camJson = mayHaveCamera ? await this.fetchOptional('input_camera.json', 'json') : null;
    let camera: PinholeCamera | null = parseInputCamera(camJson);
    const fromInput = !!camera;
    if (!camera && scene.video) camera = cameraFromVideo(scene.video);
    if (!camera) return null;
    const video = isVideoScene(scene, this.ctx.hasVideo) && !!scene.video;
    const inputs = (scene.input?.files ?? []).filter(decodableImage);
    const candidates = (video ? [scene.video?.plate, 'plate.jpg', scene.thumb] : [inputs[0], scene.thumb, 'thumb.jpg']).filter((f): f is string => decodableImage(f));
    const aspect = camera.width / camera.height;
    let image: string | null = null;
    for (const f of Array.from(new Set(candidates))) {
      try {
        const img = await loadImageAsJpeg(this.dataUrl(f), 1024, 0.85, this.lifetime.signal);
        // normalised positions only line up when the picture covers the camera's view
        if (Math.abs(img.width / img.height / aspect - 1) > 0.04) continue;
        image = img.image;
        break;
      } catch {
        /* next candidate */
      }
    }
    if (!image) return null;
    let depth: DepthMap | null = null;
    if (fromInput) {
      const buf = await this.fetchOptional('input_depth.npy', 'bytes');
      if (buf instanceof ArrayBuffer) {
        try {
          depth = depthMapFromNpy(parseNpy(buf));
        } catch (e) {
          this.logOnce('depth', e);
        }
      }
    }
    return { image, camera, depth };
  }

  private raycastSplats(origin: Vec3, dir: Vec3, far: number): number | null {
    const mesh = this.ctx.splats?.();
    if (!mesh || typeof mesh.raycast !== 'function' || this.slowRaycasts) return null;
    mesh.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...dir), 0.15, far);
    const hits: THREE.Intersection[] = [];
    const t0 = performance.now();
    withFullResolution(mesh, () => mesh.raycast(rc, hits));
    const ms = performance.now() - t0;
    // a full-resolution raycast through a big world can stall a headset frame: past this, the voxels answer instead
    if (ms > SLOW_RAYCAST_MS) {
      this.slowRaycasts = true;
      this.logOnce('slow-raycast', new Error(`a splat raycast took ${Math.round(ms)} ms; labels use the voxel grid from now on`));
    }
    let best: number | null = null;
    for (const h of hits) if (Number.isFinite(h.distance) && (best === null || h.distance < best)) best = h.distance;
    return best;
  }

  /** Label reach in metres (ctx.labelReach, at least the contract's 6 m). */
  private reach(): number {
    const r = this.ctx.labelReach?.();
    return typeof r === 'number' && Number.isFinite(r) ? Math.min(200, Math.max(6, r)) : 6;
  }

  private placementEnv(camera: PinholeCamera, frame: 'scene' | 'world', depth: DepthMap | null): PlacementEnv {
    this.layer.reach = this.reach();
    this.ctx.worldRoot.updateMatrixWorld(true);
    const world = this.ctx.collision?.() ?? null;
    return {
      camera,
      cameraFrame: frame,
      toWorld: this.ctx.worldRoot.matrixWorld.clone(),
      maxDistance: this.reach(),
      depth,
      raycastSplats: (o, d, far) => this.raycastSplats(o, d, far),
      solidAt: world ? (x, y, z) => world.solidAt(x, y, z) : null,
    };
  }

  private snapshotEnv(s: Snapshot): PlacementEnv {
    return this.placementEnv(cameraFromThree(s.camera, s.width, s.height), 'world', null);
  }

  private async loadHotspots(): Promise<void> {
    this.debug.hotspotStatus = 'loading';
    this.debug.requests.stored++;
    const stored = parseStoredHotspots(await this.client.storedHotspots(this.sceneId, this.opts.timeouts.stored));
    if (this.disposed) return;
    if (stored.length) {
      this.layer.reach = this.reach();
      this.showLabels(stored, 'stored');
      return;
    }
    let view: InputView | null = null;
    try {
      view = await this.inputView();
    } catch (e) {
      this.logOnce('input-view', e);
    }
    if (this.disposed) return;
    let image: string;
    let env: PlacementEnv;
    let source: 'input' | 'snapshot';
    if (view) {
      image = view.image;
      env = this.placementEnv(view.camera, 'scene', view.depth);
      source = 'input';
    } else {
      let snap: Snapshot;
      try {
        snap = await this.overviewSnapshot();
      } catch (e) {
        this.logOnce('overview', e);
        this.debug.hotspotStatus = 'failed';
        return;
      }
      if (this.disposed) return;
      image = snap.image;
      env = this.snapshotEnv(snap);
      source = 'snapshot';
    }
    await this.requestHotspots(image, env, source, 0);
  }

  /** Asks the guide for hotspots; when it is down, tries again later (15 s, 30 s, ... up to 6 times). */
  private async requestHotspots(image: string, env: PlacementEnv, source: 'input' | 'snapshot', tries: number): Promise<void> {
    if (this.guideOff) {
      this.debug.hotspotStatus = 'failed';
      return;
    }
    this.debug.hotspotStatus = 'loading';
    this.debug.requests.hotspots++;
    let raw: { hotspots?: unknown };
    try {
      raw = await this.client.hotspots({ image, scene: { id: this.sceneId } }, { timeoutMs: this.opts.timeouts.hotspots, signal: this.lifetime.signal, retryDelaysMs: tries ? [] : [3000, 8000] });
    } catch (e) {
      this.debug.hotspotStatus = 'failed';
      this.failed('hotspots', e);
      if (e instanceof GuideRequestError && e.unavailable && !e.notConfigured && tries < 6 && !this.disposed) this.hotspotRetry = { at: this.clock + 15 * (tries + 1), image, env, source, tries: tries + 1 };
      return;
    }
    if (this.disposed || this.layer.count) return;
    const list = cleanHotspots(raw);
    if (!list.length) {
      this.debug.hotspotStatus = 'none';
      return;
    }
    this.debug.hotspotStatus = 'placing';
    this.placement = { list, env, i: 0, out: [], source, slowSplats: false };
  }

  /** One hotspot per frame, so splat raycasts never pile up in one frame. */
  private stepPlacement(): void {
    const p = this.placement;
    if (!p) return;
    if (p.i < p.list.length) {
      const h = p.list[p.i++];
      const t0 = performance.now();
      const env = p.slowSplats ? { ...p.env, raycastSplats: null } : p.env;
      const placed = placeHotspot(h, env);
      if (performance.now() - t0 > 60) p.slowSplats = true;
      if (placed) p.out.push(placed);
      return;
    }
    this.placement = null;
    if (!p.out.length) {
      this.debug.hotspotStatus = 'none';
      return;
    }
    this.showLabels(p.out, p.source);
    if (this.opts.storeHotspots && !this.ctx.flipped?.()) {
      this.debug.requests.store++;
      void this.client.storeHotspots(this.sceneId, storedHotspotsBody(p.out), this.opts.timeouts.stored);
    }
  }

  private showLabels(list: PlacedHotspot[], source: GuideDebug['hotspotSource']): void {
    this.debug.hotspotSource = source;
    this.debug.hotspotStatus = list.length ? 'done' : 'none';
    const t = this.startedAt >= 0 ? this.clock - this.startedAt : -1;
    if (t >= this.opts.labelsDelay) {
      this.layer.set(list);
      this.pendingLabels = null;
    } else this.pendingLabels = list;
    this.syncLabelDebug(list);
  }

  private syncLabelDebug(list = this.layer.hotspots): void {
    this.debug.labels = list.map((h) => ({ label: h.label, position: h.position, source: h.source }));
  }

  // ---------- failures ----------

  private failed(what: string, e: unknown): void {
    const err = e instanceof GuideRequestError ? e : new GuideRequestError(String(e), 'offline');
    this.debug.lastError = `${what}: ${err.message}`;
    if (err.kind === 'aborted') return;
    if (err.notConfigured) {
      // nothing will come back on its own: stop asking, and say so once
      this.guideOff = true;
      this.hotspotRetry = null;
      this.narrateRetry = null;
      if (!this.offlineNotified) {
        this.offlineNotified = true;
        this.debug.offlineNotified = true;
        this.notify('The guide is off', 'Labels and voice answers are not set up on this server.');
      }
    } else if (err.unavailable) {
      if (!this.offlineNotified) {
        this.offlineNotified = true;
        this.debug.offlineNotified = true;
        this.notify('The guide is taking a break', 'Labels and answers come back on their own when it reconnects.');
      }
    } else this.logOnce(what, err);
  }

  private notifyOnce(key: string, title: string, body: string): void {
    if (this.errorsSeen.has(`notify:${key}`)) return;
    this.errorsSeen.add(`notify:${key}`);
    this.notify(title, body);
  }

  private notify(title: string, body: string): void {
    if (this.presenting) {
      if (this.phase === 'idle') this.setCaption({ mode: 'error', title: 'Guide', answer: title, question: body }, 5);
      return;
    }
    try {
      (this.ctx.toast ?? fallbackToast)(title, body, 'info', 6000);
    } catch {
      /* the toast is a nicety */
    }
  }

  private logOnce(key: string, e: unknown): void {
    if (this.errorsSeen.has(key)) return;
    this.errorsSeen.add(key);
    console.warn(`[guide] ${key}:`, e instanceof Error ? e.message : e);
  }
}
