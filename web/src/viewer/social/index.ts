// The social layer inside the viewer (desktop and Quest 3S WebXR): live presence and ghosts,
// sticky notes, tag moments and the reality check. One entry point:
//
//   const social = createSocial(ctx, opts);   // after the world is loaded
//   social.update(dt);                         // every frame, before renderer.render
//   await social.setRealityCheck(true);        // host cue or a button
//   social.dispose();
//
// Nothing here can stop the render loop: every part runs inside its own try/catch, every
// request has a timeout, and a teammate service being down only shows one polite toast.

import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import { GhostLayer, ensureSocialStyles } from './ghosts.ts';
import { NoteComposer, NotesClient, NotesLayer, SocialSounds, parseNote, parseNotes, type Note, type SolidQuery, type XrPointer } from './notes.ts';
import { ClockSync, PresenceClient, SocialSocket, localNow, questId, validSceneId, webId, type LocalPose, type V3 } from './presence-client.ts';
import { RealityCheck, RealityLegend, type SplatFxLike } from './reality.ts';
import { TagHud } from './tag.ts';

export type ToastKind = 'info' | 'error' | 'ok';

export interface HeadPose {
  /** Feet on the floor (room frame). */
  feet: V3;
  /** Eye position (room frame). */
  head: V3;
  /** Radians about +Y, 0 = facing -Z. */
  yaw: number;
}

/**
 * What the social layer needs from the viewer. In web/src/viewer/app.ts every field maps to
 * something the Viewer already has (see the wiring notes in the report / createSocial docs).
 */
export interface ViewerContext {
  /** Scene id from ?scene= (must match the server's scene id rule). */
  sceneId: string;
  /** '' (default) = same origin as the page. */
  baseUrl?: string;
  renderer: THREE.WebGLRenderer;
  /** The three.js scene. Its world frame is the room frame (floor at y = 0, metres). */
  scene: THREE.Scene;
  /** The user camera (child of the rig; in XR three keeps its world matrix at rig x head pose). */
  camera: THREE.PerspectiveCamera;
  /** The locomotion rig (XR controllers are its children). */
  rig: THREE.Object3D;
  /** Parent of the splat mesh (Viewer.flip); the reality parts are added beside the mesh. */
  worldRoot: THREE.Object3D;
  /** The loaded world mesh. */
  splatMesh: () => SplatMesh | null;
  /** The viewer's SplatFx (effects.ts): the reality parts reuse its soft world edge. */
  splatFx?: SplatFxLike | null;
  /** DOM toast (Hud.toast). Defaults to the viewer's #tw-toasts markup. */
  toast?: (title: string, body?: string, kind?: ToastKind, ms?: number) => void;
  /** Our pose; defaults to the camera's world matrix plus eyeHeight / xrHeightOffset. */
  getHeadPose?: () => HeadPose | null;
  /** Desktop eye height above the feet (Player.eyeHeight). Default 1.6. */
  eyeHeight?: () => number;
  /** XR: rig.position.y = feet + this (XrSystem.debug.heightOffset). Default 0. */
  xrHeightOffset?: () => number;
  /** Solid-geometry query in the room frame (Viewer.world: the voxel grid or mesh collider). */
  collision?: () => SolidQuery | null;
  /** Same per-splat fixes the world mesh got (camera rooms: repairHiddenSplats). */
  prepareRealityMesh?: (mesh: SplatMesh) => void;
  /** Splat loader for the reality parts (defaults to a plain SplatMesh). */
  loadSplat?: (url: string) => Promise<SplatMesh>;
  /** False for a world that cannot have reality parts (a bundled sample): the reality check never looks for them. */
  realityExpected?: boolean;
  /** Default: renderer.xr.isPresenting. */
  isPresenting?: () => boolean;
  /** Desktop: release pointer lock before a dialog opens. Default document.exitPointerLock(). */
  releasePointerLock?: () => void;
}

export interface Cue {
  action: string;
  on?: boolean;
  sceneId?: string;
  at?: unknown;
  [k: string]: unknown;
}

export interface XrBinding {
  hand: 'left' | 'right';
  /** xr-standard gamepad button index (0 trigger, 1 grip, 3 stick press, 4 A/X, 5 B/Y). */
  button: number;
}

export interface SocialOptions {
  /** Shown above your ghost elsewhere and signed under your notes. Default ?name=, else "Judge" in VR / "Visitor". */
  name?: string;
  /** Browser viewer id (default a stable web-xxxxxxxx). */
  webId?: string;
  /** Headset id (quest-1 on the demo headset: ?follow=1 or ?quest=1; quest-<n> with ?quest=n; else a guest id). */
  questId?: string;
  presence?: boolean;
  notes?: boolean;
  tag?: boolean;
  reality?: boolean;
  /** Desktop keys: N leaves a note, C toggles the reality check. Default true. */
  keys?: boolean;
  /** Obey {type:'cue', action:'reality'} from /ws. Default: the page has ?follow=1. */
  cues?: boolean;
  /** Every cue from /ws (load, labels, reality...) for the app to act on. */
  onCue?: (cue: Cue) => void;
  /** Headset buttons; null disables one. Defaults: note = right grip, reality = left Y. */
  xrButtons?: { note?: XrBinding | null; reality?: XrBinding | null };
  /** Fetch the reality parts in the background so the cue is instant. Default true. */
  preloadReality?: boolean;
  /**
   * The /ws socket. Default true (the layer opens its own). Pass the viewer's SocialSocket to share one connection:
   * the layer then only listens on it and never starts or closes it.
   */
  socket?: boolean | SocialSocket;
}

export interface SocialHandle {
  update(dt: number): void;
  dispose(): void;
  setRealityCheck(on: boolean): Promise<boolean>;
  toggleRealityCheck(): Promise<boolean>;
  readonly realityOn: boolean;
  /** Desktop: opens the note dialog for the spot in front of you. */
  startNote(): void;
  /** Posts a note (at a room-frame point, default in front of you). */
  postNote(text: string, at?: V3): Promise<boolean>;
  /** Shows a toast (DOM, and in the headset while presenting). */
  notify(title: string, body?: string, kind?: ToastKind): void;
  /** Feeds a /ws message by hand (tests, the host page). */
  handleMessage(msg: { type: string; [k: string]: unknown }): void;
  readonly ghosts: GhostLayer;
  readonly notes: NotesLayer;
  readonly tag: TagHud | null;
  readonly reality: RealityCheck | null;
  readonly debug: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------

function defaultToast(): (title: string, body?: string, kind?: ToastKind, ms?: number) => void {
  return (title, body = '', kind = 'info', ms = kind === 'error' ? 9000 : 4500) => {
    const host = document.getElementById('tw-toasts');
    if (!host) {
      console.info(`[social] ${title}${body ? `: ${body}` : ''}`);
      return;
    }
    const el = document.createElement('div');
    el.className = `tw-toast is-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const bar = document.createElement('div');
    bar.className = 'tw-toast__bar';
    const text = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'tw-toast__title';
    t.textContent = title;
    text.append(t);
    if (body) {
      const b = document.createElement('div');
      b.className = 'tw-toast__body';
      b.textContent = body;
      text.append(b);
    }
    el.append(bar, text);
    host.append(el);
    while (host.children.length > 4) host.firstElementChild?.remove();
    const remove = () => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    };
    if (ms > 0) setTimeout(remove, ms);
  };
}

/** Our pose from the camera's world matrix (valid after the previous render). */
const tmpHead = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();

export function poseFromCamera(camera: THREE.Camera, rig: THREE.Object3D, presenting: boolean, eyeHeight: number, xrOffset: number, lastYaw = 0): HeadPose {
  const m = camera.matrixWorld;
  const head = tmpHead.setFromMatrixPosition(m);
  const fwd = tmpFwd.set(0, 0, -1).transformDirection(m);
  const flat = Math.hypot(fwd.x, fwd.z);
  const yaw = flat > 0.12 ? Math.atan2(-fwd.x, -fwd.z) : lastYaw;
  const feetY = presenting ? rig.position.y - xrOffset : head.y - eyeHeight;
  return { feet: [head.x, feetY, head.z], head: [head.x, head.y, head.z], yaw };
}

interface Slot {
  ray: THREE.Object3D;
  grip: THREE.Object3D;
  source: XRInputSource | null;
  prev: boolean[];
  cur: boolean[];
}

/** XR controllers as the social layer sees them: handedness, rays, grips and button edges. */
class XrInputs {
  readonly slots: Slot[] = [];
  private off: Array<() => void> = [];

  constructor(renderer: THREE.WebGLRenderer) {
    for (let i = 0; i < 2; i++) {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const slot: Slot = { ray, grip, source: null, prev: [], cur: [] };
      const on = (e: { data?: XRInputSource }) => (slot.source = e.data ?? null);
      const offEv = () => (slot.source = null);
      ray.addEventListener('connected' as never, on as never);
      ray.addEventListener('disconnected' as never, offEv as never);
      this.off.push(() => {
        ray.removeEventListener('connected' as never, on as never);
        ray.removeEventListener('disconnected' as never, offEv as never);
      });
      this.slots.push(slot);
    }
  }

  poll(session: XRSession | null): void {
    const list = session ? Array.from(session.inputSources) : [];
    this.slots.forEach((s, i) => {
      // created mid-session: the 'connected' events already fired, so match by order
      if (!s.source && list[i]) s.source = list[i];
      if (s.source && session && !list.includes(s.source)) s.source = null;
      s.prev = s.cur;
      s.cur = s.source?.gamepad ? s.source.gamepad.buttons.map((b) => b.pressed) : [];
    });
  }

  slot(hand: 'left' | 'right'): Slot | null {
    return this.slots.find((s) => s.source?.handedness === hand && s.source.gamepad) ?? null;
  }

  pointer(hand: 'left' | 'right'): XrPointer | null {
    const s = this.slot(hand);
    if (!s) return null;
    return {
      ray: s.ray,
      pressed: (b) => !!s.cur[b] && !s.prev[b],
      released: (b) => !s.cur[b] && !!s.prev[b],
      held: (b) => !!s.cur[b],
    };
  }

  /** Grip positions, left then right (one missing: both are the other). */
  hands(): [V3, V3] | null {
    const get = (h: 'left' | 'right'): V3 | null => {
      const s = this.slots.find((x) => x.source?.handedness === h);
      if (!s || !s.grip.visible) return null;
      const p = new THREE.Vector3().setFromMatrixPosition(s.grip.matrixWorld);
      return Number.isFinite(p.x + p.y + p.z) && p.lengthSq() > 0 ? [p.x, p.y, p.z] : null;
    };
    const l = get('left'), r = get('right');
    if (!l && !r) return null;
    return [l ?? r!, r ?? l!];
  }

  dispose(): void {
    for (const f of this.off) f();
  }
}

const params = () => (typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams());

function storedName(): string | null {
  try {
    return localStorage.getItem('dv.name');
  } catch {
    return null;
  }
}

/**
 * Builds the social layer for a loaded world. Safe to call when the server has no presence or
 * notes routes yet: those parts stay quiet until the routes answer.
 */
export function createSocial(ctx: ViewerContext, opts: SocialOptions = {}): SocialHandle {
  ensureSocialStyles();
  const q = params();
  const baseUrl = ctx.baseUrl ?? '';
  const sceneId = ctx.sceneId;
  const presenting = ctx.isPresenting ?? (() => ctx.renderer.xr.isPresenting);
  const toastDom = ctx.toast ?? defaultToast();
  const clock = new ClockSync();
  const ownIds = new Set<string>();
  const myWebId = opts.webId ?? (q.get('pid') && /^web-[0-9a-f]{8}$/.test(q.get('pid')!) ? q.get('pid')! : webId());
  const myQuestId = opts.questId ?? questId(q);
  const nameFor = (vr: boolean) => (opts.name ?? q.get('name') ?? storedName() ?? (vr ? 'Judge' : 'Visitor')).trim().slice(0, 40) || 'Visitor';
  const myVrIds: ReadonlySet<string> = new Set([myQuestId]);
  const myWebIds: ReadonlySet<string> = new Set([myWebId]);
  const obeyCues = opts.cues ?? q.get('follow') === '1';
  const enabled = { presence: opts.presence !== false, notes: opts.notes !== false, tag: opts.tag !== false, reality: opts.reality !== false };
  const okScene = validSceneId(sceneId);
  if (!okScene) console.warn(`[social] scene id ${JSON.stringify(sceneId)} does not match the server rule; live features stay off`);

  const root = document.createElement('div');
  root.className = 'dvs-root';
  document.body.append(root);

  const sounds = new SocialSounds();
  const xr = new XrInputs(ctx.renderer);
  const ghosts = new GhostLayer(clock);
  ctx.scene.add(ghosts.group);
  const notesLayer = new NotesLayer();
  ctx.scene.add(notesLayer.group);

  const errorsLogged = new Set<string>();
  const guard = (part: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!errorsLogged.has(part)) {
        errorsLogged.add(part);
        console.error(`[social] ${part} failed (continuing without it this frame)`, e);
      }
    }
  };

  // ---- pose ----
  let lastYaw = 0;
  let pose: HeadPose = { feet: [0, 0, 0], head: [0, 1.6, 0], yaw: 0 };
  const headVec = new THREE.Vector3(0, 1.6, 0);
  const readPose = () => {
    const p = ctx.getHeadPose?.() ?? poseFromCamera(ctx.camera, ctx.rig, presenting(), ctx.eyeHeight?.() ?? 1.6, ctx.xrHeightOffset?.() ?? 0, lastYaw);
    if (p && Number.isFinite(p.head[0] + p.head[1] + p.head[2] + p.yaw)) {
      pose = p;
      lastYaw = p.yaw;
      headVec.set(p.head[0], p.head[1], p.head[2]);
    }
  };

  // ---- toasts (DOM + headset), rate limited per title ----
  let tag: TagHud | null = null;
  const lastToast = new Map<string, number>();
  const notify = (title: string, body = '', kind: ToastKind = 'info') => {
    const now = localNow();
    const key = `${title}|${body}`;
    if ((lastToast.get(key) ?? -1e9) > now - 4) return;
    lastToast.set(key, now);
    try {
      toastDom(title, body, kind);
    } catch {
      /* the DOM toast is best effort */
    }
    if (presenting()) tag?.toast.show(title, body, kind);
  };

  // ---- presence ----
  let presenceOnline: boolean | null = null;
  const presence = new PresenceClient({
    baseUrl,
    sceneId,
    clock,
    ownIds,
    getKind: () => (presenting() ? 'vr' : 'web'),
    getId: () => (presenting() ? myQuestId : myWebId),
    getName: () => nameFor(presenting()),
    getPose: (): LocalPose | null => {
      const vr = presenting();
      return { x: pose.feet[0], y: Math.max(-0.5, pose.feet[1]), z: pose.feet[2], yaw: pose.yaw, head: vr ? pose.head : null, hands: vr ? xr.hands() : null };
    },
    onSnapshot: (snap, at) => guard('ghosts', () => ghosts.applySnapshot(snap, at, localNow())),
    onStatus: (online, why) => {
      if (presenceOnline === true && !online) notify('Live presence paused', why && why.length < 90 ? why : 'Other people will reappear when the connection is back.', 'info');
      else if (presenceOnline === false && online) notify('Live presence is back', '', 'ok');
      presenceOnline = online;
    },
  });

  // ---- notes ----
  let tempIds = 0;
  const notesClient = new NotesClient({
    baseUrl,
    sceneId,
    socketUp: () => !!socket?.connected,
    onList: (list, initial) => guard('notes', () => notesLayer.sync(list, initial)),
  });
  notesLayer.onArrive = (n, at) => {
    const dx = at.x - headVec.x, dz = at.z - headVec.z;
    const rel = Math.atan2(Math.sin(Math.atan2(-dx, -dz) - pose.yaw), Math.cos(Math.atan2(-dx, -dz) - pose.yaw));
    sounds.pop(THREE.MathUtils.clamp(-Math.sin(rel), -1, 1) * 0.75);
    notify(`${n.author} left a note`, n.text.length > 60 ? `${n.text.slice(0, 58)}…` : n.text, 'ok');
  };
  const postNote = async (text: string, at?: V3): Promise<boolean> => {
    let p = at;
    if (!p) {
      const ahead = new THREE.Vector3(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw)).multiplyScalar(1.2).add(headVec);
      p = [ahead.x, THREE.MathUtils.clamp(ahead.y - 0.15, 0.45, 2.4), ahead.z];
    }
    const author = nameFor(presenting());
    const temp: Note = { id: `pending-${++tempIds}`, author, text, x: p[0], y: p[1], z: p[2], createdAt: new Date().toISOString() };
    notesLayer.add(temp, { pending: true });
    const res = await notesClient.post(author, text, p);
    if (res.ok) {
      notesLayer.confirm(temp.id, res.note);
      sounds.pop();
      if (presenting()) tag?.toast.show('Note pinned', `“${res.note.text}”`, 'ok', 2.2);
      return true;
    }
    notesLayer.delete(temp.id);
    notify('Note not saved', res.error, 'error');
    return false;
  };
  const composer = new NoteComposer({
    scene: ctx.scene,
    camera: ctx.camera,
    world: () => ctx.collision?.() ?? null,
    head: () => headVec.clone(),
    author: () => nameFor(presenting()),
    post: (text, at) => postNote(text, at),
    notify,
    releasePointer: ctx.releasePointerLock ?? (() => document.exitPointerLock?.()),
  });

  // ---- tag ----
  if (enabled.tag) {
    tag = new TagHud(
      {
        scene: ctx.scene,
        camera: ctx.camera,
        presenting,
        session: () => ctx.renderer.xr.getSession(),
        serverNow: () => clock.serverNow(),
        nameOf: (id) => {
          if (id === (presenting() ? myQuestId : myWebId) || (ownIds.has(id) && !ghosts.nameOf(id))) return nameFor(presenting());
          return ghosts.nameOf(id) ?? (id.startsWith('rbx-') ? 'Roblox player' : id.startsWith('quest') ? 'Headset' : 'Visitor');
        },
        whereIs: (id) => {
          if (ownIds.has(id)) return { position: new THREE.Vector3(pose.feet[0], pose.feet[1], pose.feet[2]), head: headVec.clone() };
          const g = ghosts.info(id);
          return g ? { position: g.position, head: g.head } : null;
        },
        // only the id we are using now: a desktop viewer is not "it" because a headset once used quest-1 here
        myIds: () => (presenting() ? myVrIds : myWebIds),
        head: () => ({ position: headVec, yaw: pose.yaw }),
        sounds,
      },
      root,
    );
  }

  // ---- reality ----
  let reality: RealityCheck | null = null;
  let legend: RealityLegend | null = null;
  if (enabled.reality) {
    reality = new RealityCheck({
      sceneId,
      baseUrl,
      expected: ctx.realityExpected,
      mesh: ctx.splatMesh,
      fx: ctx.splatFx ?? null,
      load: ctx.loadSplat,
      prepare: ctx.prepareRealityMesh,
      notify,
      head: () => headVec.clone(),
    });
    legend = new RealityLegend(root);
    reality.onChange = (on, report) => {
      legend?.set(on && !presenting(), report);
      if (on && presenting() && report) tag?.toast.show('Reality check on', `Violet = imagined · ${Math.round((1 - report.seenFraction) * 100)}% of this world`, 'ok', 3.5);
    };
  }
  let preloadTimer: ReturnType<typeof setTimeout> | null = null;
  if (reality && opts.preloadReality !== false && okScene) {
    preloadTimer = setTimeout(() => {
      preloadTimer = null;
      void reality!.probe().then((ok) => (ok ? reality!.preload() : false));
    }, 3500);
  }
  const setRealityCheck = async (on: boolean): Promise<boolean> => {
    if (!reality) return false;
    try {
      return await reality.set(on);
    } catch (e) {
      console.error('[social] reality check', e);
      return false;
    }
  };

  // ---- socket ----
  let socket: SocialSocket | null = null;
  const shared = opts.socket instanceof SocialSocket ? opts.socket : null;
  const socketOffs: Array<() => void> = [];
  const handleMessage = (m: { type: string; [k: string]: unknown }) => {
    switch (m.type) {
      case 'note': {
        const n = parseNote(m.note);
        if (n && enabled.notes) guard('notes', () => notesLayer.add(n));
        break;
      }
      case 'notes': {
        const list = parseNotes(m.notes);
        if (list && enabled.notes) guard('notes', () => notesLayer.sync(list, false));
        break;
      }
      case 'note_deleted':
        if (typeof m.id === 'string') notesLayer.delete(m.id);
        break;
      case 'roblox':
        if (tag) guard('tag', () => tag!.handle(m));
        break;
      case 'presence':
        if (enabled.presence) presence.ingest(m);
        break;
      case 'cue': {
        const cue = m as unknown as Cue;
        if (typeof cue.sceneId === 'string' && cue.sceneId !== sceneId && cue.action !== 'load') break;
        if (obeyCues && cue.action === 'reality') void setRealityCheck(cue.on !== false);
        try {
          opts.onCue?.(cue);
        } catch (e) {
          console.warn('[social] onCue', e);
        }
        break;
      }
    }
  };
  if (opts.socket !== false && okScene) {
    socket = shared ?? new SocialSocket(SocialSocket.urlFor(baseUrl), sceneId);
    for (const t of ['note', 'notes', 'note_deleted', 'roblox', 'presence']) socketOffs.push(socket.on(t, handleMessage));
    // cues carry the target scene in sceneId (a load cue names another scene): the socket passes them unfiltered
    socketOffs.push(socket.on('cue', handleMessage));
    socketOffs.push(
      socket.onConnection((up) => {
        if (up && enabled.notes) void notesClient.poll();
      }),
    );
    if (!shared) socket.start();
  }

  // ---- keys (desktop) ----
  const onKey = (e: KeyboardEvent) => {
    if (opts.keys === false || presenting() || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'KeyN' && enabled.notes) {
      e.preventDefault();
      composer.openDesktop();
    } else if (e.code === 'KeyC' && reality) {
      e.preventDefault();
      void reality.toggle();
    }
  };
  window.addEventListener('keydown', onKey);
  const onSessionStart = () => {
    sounds.unlock();
    legend?.set(false, reality?.report ?? null);
  };
  const onSessionEnd = () => {
    composer.cancel();
    legend?.set(!!reality?.on, reality?.report ?? null);
  };
  ctx.renderer.xr.addEventListener('sessionstart', onSessionStart);
  ctx.renderer.xr.addEventListener('sessionend', onSessionEnd);

  const noteBind = opts.xrButtons?.note === undefined ? ({ hand: 'right', button: 1 } as XrBinding) : opts.xrButtons.note;
  const realityBind = opts.xrButtons?.reality === undefined ? ({ hand: 'left', button: 5 } as XrBinding) : opts.xrButtons.reality;
  if (noteBind) composer.aimButton = noteBind.button;

  const debug: Record<string, unknown> = {};
  let disposed = false;

  const handle: SocialHandle = {
    update(dt: number) {
      if (disposed) return;
      const d = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
      const now = localNow();
      const vr = presenting();
      guard('input', () => xr.poll(vr ? ctx.renderer.xr.getSession() : null));
      guard('pose', readPose);
      if (okScene && enabled.presence) guard('presence', () => presence.tick(d, now));
      if (okScene && enabled.notes) guard('notes-net', () => notesClient.tick(d));
      guard('ghosts', () => ghosts.update(d, headVec, now));
      guard('notes', () => notesLayer.update(d, headVec));
      guard('composer', () => {
        if (!enabled.notes) return;
        if (vr) composer.updateXr(d, noteBind ? xr.pointer(noteBind.hand) : null);
        else composer.updateDesktop(d);
      });
      if (vr && realityBind && reality) {
        const p = xr.pointer(realityBind.hand);
        if (p?.pressed(realityBind.button)) void reality.toggle();
      }
      if (tag) guard('tag', () => tag!.update(d));
      if (reality) guard('reality', () => reality!.update(d));
      debug.people = ghosts.count;
      debug.notes = notesLayer.count;
      debug.presence = presence.stats;
      debug.socket = !!socket?.connected;
      debug.reality = reality ? { available: reality.available, phase: reality.phase } : null;
      debug.round = tag ? { active: tag.game.active, remaining: tag.game.remaining(clock.serverNow()) } : null;
      debug.composer = composer.state;
      debug.id = vr ? myQuestId : myWebId;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (preloadTimer) clearTimeout(preloadTimer);
      presence.stop();
      notesClient.stopped = true;
      for (const off of socketOffs) off();
      if (!shared) socket?.close();
      window.removeEventListener('keydown', onKey);
      ctx.renderer.xr.removeEventListener('sessionstart', onSessionStart);
      ctx.renderer.xr.removeEventListener('sessionend', onSessionEnd);
      xr.dispose();
      composer.dispose();
      ghosts.dispose();
      notesLayer.dispose();
      tag?.dispose();
      reality?.dispose();
      legend?.dispose();
      sounds.dispose();
      root.remove();
    },
    setRealityCheck,
    toggleRealityCheck: () => (reality ? reality.toggle() : Promise.resolve(false)),
    get realityOn() {
      return !!reality?.on;
    },
    startNote: () => {
      if (!presenting()) composer.openDesktop();
    },
    postNote,
    notify,
    handleMessage,
    ghosts,
    notes: notesLayer,
    tag,
    reality,
    debug,
  };
  (window as unknown as { __social?: SocialHandle }).__social = handle;
  return handle;
}

export type { Note } from './notes.ts';
export type { Person, PresenceSnapshot, V3 } from './presence-client.ts';
export type { SplatFxLike, RealityReport } from './reality.ts';
