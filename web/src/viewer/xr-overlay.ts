// The headset's own interface over the world: the wrist menu, the Video memory transport and the
// arrival card, with one pointer shared between them (the right ray with its trigger, or a pinch)
// and short haptic ticks on hover and select. xr.ts feeds it the head, the hands and the trigger every
// frame; it reaches the viewer (scene, video layer, guide, photo intro) through XrViewerLinks.

import * as THREE from 'three';
import type { Scene } from '../../../shared/types.ts';
import { listScenes, sceneAssetUrl } from '../api.ts';
import { worldModeName } from './hud.ts';
import { ArrivalCard } from './xr-arrival.ts';
import { palmFacing, palmWants, WristHint, WristMenu, type AskPhase, type MenuWorld } from './xr-menu.ts';
import type { GlassPanel, PanelHit, PanelItem } from './xr-panel.ts';
import { shortCaption } from './xr-text.ts';
import { VideoTransport, type TransportVideo } from './xr-transport.ts';

export interface XrVideoLink extends TransportVideo {
  setOpacity(o: number): void;
}

export interface XrGuideLink {
  setLabelsVisible(on: boolean): void;
  startTalking(): void;
  stopTalking(): void;
  readonly debug: { readonly phase: string };
}

/** What the headset interface reads from the viewer (app.ts's Viewer has all of it). */
export interface XrViewerLinks {
  readonly data: Pick<Scene, 'id' | 'name' | 'mode' | 'caption' | 'video'>;
  readonly video: XrVideoLink | null;
  /** The video layer has loaded (when the viewer says so; else OverlayHost.videoReady() asks). */
  readonly videoReady?: boolean;
  readonly guide: XrGuideLink | null;
  readonly memory?: { readonly active: boolean; readonly canLeave?: boolean } | null;
  /** Shows or hides the people of a Video memory; without it, People fades the video layer. */
  setPeopleVisible?(on: boolean): void;
}

export interface OverlayHost {
  links(): XrViewerLinks | null;
  sceneName(): string;
  /** The video layer has loaded and can be played. */
  videoReady(): boolean;
  playToggle(): void;
  recenter(): void;
  exit(): void;
  openWorld(id: string): void;
}

export interface OverlayFrame {
  /** Eyes in world space, heading (rotation about +Y) and gaze direction. */
  head: THREE.Vector3;
  yaw: number;
  gaze: THREE.Vector3;
  /** The pointing hand's target-ray space, or null. */
  ray: THREE.Object3D | null;
  raySource: XRInputSource | null;
  /** Trigger or pinch held on the pointing hand. */
  trigger: boolean;
  leftGrip: THREE.Object3D | null;
  /** The menu button went down this frame (the left stick click). */
  menuButton: boolean;
  /** Teleport aiming or a fade: the pointer is not for panels now. */
  busy: boolean;
}

type HapticSource = { gamepad?: Gamepad | null } | null;

/** One short pulse on a controller (Quest: hapticActuators[0].pulse). Never throws. */
export function pulse(src: HapticSource, value: number, ms: number): void {
  try {
    const gp = src?.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, d: number) => Promise<boolean> }> }) | null | undefined;
    const act = gp?.hapticActuators?.[0];
    if (act?.pulse) void act.pulse(value, ms).catch(() => undefined);
  } catch {
    /* haptics are a nicety */
  }
}

function askPhase(phase: string): AskPhase {
  return phase === 'listening' || phase === 'thinking' || phase === 'speaking' ? phase : 'idle';
}

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const HINT_KEY = 'dv.xr.menuSeen';

function menuSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export class XrOverlay {
  readonly group = new THREE.Group();
  readonly menu = new WristMenu();
  readonly transport = new VideoTransport();
  readonly arrival = new ArrivalCard();
  readonly hint = new WristHint();
  /** The pointer is on a panel (its trigger belongs to the panel, not to labels or notes). */
  hovering = false;
  /** Pointer length for the ray (metres) and whether it rests on a button. */
  pointerLength = 1.2;
  onItem = false;
  readonly debug = { menu: false, pinned: false, palm: 0, hover: null as string | null, transport: false, arrival: false, hint: false, worlds: 0 };

  private presenting = false;
  private pinned = false;
  private palmOpen = false;
  private palmTimer = 0;
  /** Closed from its own button while the palm is still up: stays shut until the palm turns down. */
  private palmLatch = false;
  private prevTrigger = false;
  private dragging = false;
  private labelsOn = true;
  private peopleOn = true;
  private askOwned = false;
  private opening: string | null = null;
  private worldsState: 'idle' | 'loading' | 'done' = 'idle';
  private worldsRetryAt = 0;
  private arrivalArmed = false;
  private arrivalWait = 0;
  /** Seconds left for the palm-up hint (it starts once the arrival card is gone). */
  private hintLeft = 0;
  private hintArmed = false;
  private hintDone = menuSeen();
  private lastData: unknown = null;
  private clock = 0;
  private gripPos = new THREE.Vector3();
  private palm = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private menuHit: PanelHit = { item: null, x: 0, y: 0, distance: 0 };
  private barHit: PanelHit = { item: null, x: 0, y: 0, distance: 0 };

  constructor(private host: OverlayHost) {
    this.group.name = 'xr-overlay';
    this.group.add(this.menu.panel.group, this.transport.group, this.arrival.group, this.hint.group);
  }

  /** A headset session started: the card waits for the world to be shown, the worlds list loads. */
  enter(): void {
    this.presenting = true;
    this.arrivalArmed = true;
    this.arrivalWait = 0;
    this.hintArmed = !this.hintDone;
    this.opening = null;
    this.menu.setOpening(null);
    if (this.worldsState !== 'done') void this.loadWorlds();
  }

  /** The session ended: everything closes at once. */
  end(): void {
    this.presenting = false;
    this.pinned = false;
    this.palmOpen = false;
    this.dragging = false;
    this.hovering = false;
    this.arrivalArmed = false;
    this.stopAsk();
    this.transport.endDrag();
    this.menu.panel.setHover(null);
    this.transport.panel.setHover(null);
    this.menu.update(1, false, null, this.tmp, 0);
    this.transport.update(1, false, false, this.tmp, 0, this.tmp);
    this.arrival.cancel();
    this.hintLeft = 0;
    this.hint.update(1, false, null, this.tmp);
  }

  update(dt: number, f: OverlayFrame): void {
    if (!this.presenting) return;
    this.clock += dt;
    const links = this.host.links();
    this.sync(links);

    // ---- wrist menu: palm up, or pinned with the left stick ----
    let grip: THREE.Vector3 | null = null;
    let wants = false;
    if (f.leftGrip && f.leftGrip.visible) {
      f.leftGrip.updateWorldMatrix(true, false);
      grip = this.gripPos.setFromMatrixPosition(f.leftGrip.matrixWorld);
      // +X of the left grip space is the palm side
      this.palm.setFromMatrixColumn(f.leftGrip.matrixWorld, 0).normalize();
      const score = palmFacing(this.palm, grip, f.head, this.tmp);
      const dist = this.tmp.copy(grip).sub(f.head).length();
      const gazeCos = dist > 1e-4 ? this.tmp.dot(f.gaze) / dist : 0;
      wants = palmWants(this.palmOpen, score, dist, gazeCos);
      this.debug.palm = score;
    }
    // hold it open while it is being pointed at (the left hand drifts as the right one aims)
    if (!wants && this.palmOpen && this.menu.panel.hoveredId) wants = true;
    if (wants !== this.palmOpen) {
      this.palmTimer += dt;
      if (this.palmTimer > (wants ? 0.12 : 0.3)) {
        this.palmOpen = wants;
        this.palmTimer = 0;
      }
    } else this.palmTimer = 0;
    if (!this.palmOpen) this.palmLatch = false;
    if (f.menuButton) {
      if (this.menuOpen) this.closeMenu();
      else this.pinned = true;
    }
    const open = !!grip && (this.pinned || (this.palmOpen && !this.palmLatch) || this.opening !== null);
    if (!open && this.menu.shown) this.onMenuClosed();
    if (open && !this.menu.shown && this.worldsState === 'idle' && this.clock > this.worldsRetryAt) void this.loadWorlds();
    this.menu.setPinned(this.pinned);
    this.menu.update(dt, open, grip, f.head, f.yaw);

    // ---- transport ----
    const video = links?.video ?? null;
    this.transport.bind(video);
    const ready = typeof links?.videoReady === 'boolean' ? links.videoReady : !!video && this.host.videoReady();
    const allowed = !!video && ready && !this.menu.shown && !links?.memory?.active;

    // ---- pointer ----
    const pressed = f.trigger && !this.prevTrigger;
    const released = !f.trigger && this.prevTrigger;
    this.prevTrigger = f.trigger;
    let panel: GlassPanel | null = null;
    let hit: PanelHit | null = null;
    if (f.ray && !f.busy) {
      f.ray.updateWorldMatrix(true, false);
      this.origin.setFromMatrixPosition(f.ray.matrixWorld);
      this.dir.set(0, 0, -1).transformDirection(f.ray.matrixWorld);
      if (this.dragging) {
        if (this.transport.dragHit(this.origin, this.dir, this.barHit)) this.transport.drag(this.barHit.x, this.clock * 1000);
        panel = this.transport.panel;
        hit = this.barHit;
      } else {
        const m = this.menu.hit(this.origin, this.dir, this.menuHit);
        const b = this.transport.hit(this.origin, this.dir, this.barHit);
        if (m && (!b || this.menuHit.distance <= this.barHit.distance)) {
          panel = this.menu.panel;
          hit = this.menuHit;
        } else if (b) {
          panel = this.transport.panel;
          hit = this.barHit;
        }
      }
    }
    if (this.dragging && (released || !f.ray)) {
      this.dragging = false;
      this.transport.endDrag();
    }
    const item = this.dragging ? null : hit?.item ?? null;
    this.hover(this.menu.panel, panel === this.menu.panel ? item : null, f.raySource);
    this.hover(this.transport.panel, panel === this.transport.panel ? (this.dragging ? this.transport.panel.items[1] : item) : null, f.raySource);
    this.hovering = !!hit;
    this.onItem = !!item || this.dragging;
    this.pointerLength = hit ? hit.distance : 1.2;
    if (pressed && item && hit && panel) this.activate(panel, item, hit, f.raySource, links);

    this.transport.update(dt, allowed, panel === this.transport.panel, f.head, f.yaw, f.gaze);

    // ---- arrival card ----
    if (this.arrivalArmed && !f.busy) {
      this.arrivalWait += dt;
      const waiting = !!links?.memory?.active && this.arrivalWait < 15;
      if (!waiting && this.arrivalWait > 0.6) {
        this.arrivalArmed = false;
        const title = links?.data.name || this.host.sceneName();
        const mode = worldModeName(links?.data.mode, !!links?.data.video);
        this.arrival.show(title, mode, shortCaption(title, links?.data.caption) || (mode === 'Video' ? 'A Video memory' : 'A Photo world'), f.head, f.yaw);
        this.transport.wake(5);
      }
    }
    this.arrival.update(dt);

    // ---- the palm-up hint, until the menu has been opened once ----
    if (this.menu.shown && !this.hintDone) {
      this.hintDone = true;
      this.hintLeft = 0;
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        /* shown again next time */
      }
    }
    if (this.hintArmed && !this.hintDone && !this.arrivalArmed && !this.arrival.active) {
      this.hintArmed = false;
      this.hintLeft = 10;
    }
    this.hintLeft = Math.max(0, this.hintLeft - dt);
    this.hint.update(dt, this.hintLeft > 0 && !this.menu.shown && !f.busy, grip, f.head);

    this.debug.menu = this.menu.shown;
    this.debug.pinned = this.pinned;
    this.debug.hover = item?.id ?? (this.dragging ? 'track' : null);
    this.debug.transport = this.transport.shown;
    this.debug.arrival = this.arrival.active;
    this.debug.hint = this.hint.group.visible;
  }

  get menuOpen(): boolean {
    return this.menu.shown;
  }

  /** Opens the menu as if the left stick were clicked (tests and other buttons). */
  openMenu(): void {
    this.pinned = true;
  }

  closeMenu(): void {
    this.pinned = false;
    if (this.palmOpen) this.palmLatch = true;
  }

  dispose(): void {
    this.stopAsk();
    this.menu.dispose();
    this.transport.dispose();
    this.arrival.dispose();
    this.hint.dispose();
    this.group.removeFromParent();
  }

  // ---------- internals ----------

  /** Scene identity, toggles and the guide's state into the menu (each only redraws on a change). */
  private sync(links: XrViewerLinks | null): void {
    const data = links?.data ?? null;
    if (data !== this.lastData) {
      this.lastData = data;
      const title = data?.name || this.host.sceneName();
      this.menu.setScene(title, worldModeName(data?.mode, !!data?.video), shortCaption(title, data?.caption));
    }
    this.menu.setToggles(links?.guide ? this.labelsOn : null, links?.video ? this.peopleOn : null);
    const phase = links?.guide ? askPhase(links.guide.debug.phase) : null;
    this.menu.setAsk(phase);
    // the guide moved on (it heard the question, or gave up): nothing left for the menu to send
    if (this.askOwned && phase !== 'listening' && phase !== 'idle') this.askOwned = false;
  }

  private hover(panel: GlassPanel, item: PanelItem | null, src: XRInputSource | null): void {
    if (panel.setHover(item) && item) pulse(src, 0.22, 12);
  }

  private activate(panel: GlassPanel, item: PanelItem, hit: PanelHit, src: XRInputSource | null, links: XrViewerLinks | null): void {
    panel.press();
    pulse(src, 0.5, 20);
    const id = item.id;
    if (panel === this.transport.panel) {
      if (id === 'play') {
        this.host.playToggle();
        this.transport.wake();
      } else if (id === 'track') {
        this.dragging = true;
        this.transport.beginDrag(hit.x);
      } else if (id.startsWith('speed:')) this.transport.setRate(Number(id.slice(6)) || 1);
      return;
    }
    if (id.startsWith('world:')) {
      const target = id.slice(6);
      if (!SCENE_ID.test(target) || this.opening) return;
      this.opening = target;
      this.menu.setOpening(target);
      this.host.openWorld(target);
    } else if (id === 'recenter') {
      this.host.recenter();
      this.closeMenu();
    } else if (id === 'labels' && links?.guide) {
      this.labelsOn = !this.labelsOn;
      links.guide.setLabelsVisible(this.labelsOn);
    } else if (id === 'people' && links?.video) {
      this.peopleOn = !this.peopleOn;
      if (links.setPeopleVisible) links.setPeopleVisible(this.peopleOn);
      else links.video.setOpacity(this.peopleOn ? 1 : 0);
    } else if (id === 'ask' && links?.guide) {
      if (askPhase(links.guide.debug.phase) === 'listening') this.stopAsk();
      else {
        links.guide.startTalking();
        this.askOwned = true;
      }
    } else if (id === 'exit') {
      this.closeMenu();
      this.host.exit();
    }
  }

  private onMenuClosed(): void {
    // a question started from the menu is sent when the menu goes away
    this.stopAsk();
    this.menu.panel.setHover(null);
  }

  private stopAsk(): void {
    if (!this.askOwned) return;
    this.askOwned = false;
    try {
      const g = this.host.links()?.guide;
      if (g && askPhase(g.debug.phase) === 'listening') g.stopTalking();
    } catch {
      /* the guide may be gone */
    }
  }

  private async loadWorlds(): Promise<void> {
    if (this.worldsState === 'loading') return;
    this.worldsState = 'loading';
    try {
      const all = await listScenes();
      const current = this.host.links()?.data.id ?? new URLSearchParams(location.search).get('scene');
      const ready = all.filter((s) => s.status === 'ready' && !!s.world && SCENE_ID.test(s.id));
      // where you are first, then the newest
      ready.sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
      const list: MenuWorld[] = ready.slice(0, 6).map((s) => ({
        id: s.id,
        name: s.name || s.id,
        thumb: s.thumb ? sceneAssetUrl(s.id, s.thumb) : null,
        current: s.id === current,
      }));
      this.menu.setWorlds(list);
      this.debug.worlds = list.length;
      this.worldsState = 'done';
    } catch {
      // the menu works without the list; try again on a later open
      this.menu.setWorlds([]);
      this.worldsState = 'idle';
      this.worldsRetryAt = this.clock + 15;
    }
  }
}
