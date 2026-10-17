// Tag moments (contracts 6.4): Roblox's server is the referee and sends `tag` and `round`
// events; the Déjà View server stamps them with `t` and pushes {type:'roblox', event} on /ws.
// The headset shows a "Tagged" notification with a haptic pulse and a burst at the target, a
// "You're it" notification on round start, a round timer and scoreboard, and a winner card.
//
// Also the in-headset toasts (DOM toasts are invisible in a headset).

import * as THREE from 'three';
import { ACCENT, ACCENT_HEX, CanvasPlane, FONT, GLASS, INK, INK_2, ORDER, RED, damp, drawAppIcon, redrawWhenFontsLoad, roundRect, softShadow } from './ghosts.ts';
import { toSeconds } from './presence-client.ts';

export const DEFAULT_ROUND_SECONDS = 90;

export type TagEvent =
  | { type: 'tag'; by: string; target: string; t: number | null; targetName?: string; scores?: Record<string, number> | null; livesLeft?: number }
  | { type: 'round'; state: 'start' | 'end'; t: number | null; scores: Record<string, number> | null; duration: number | null; it: string | null; winner: string | null };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseScores(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (finite(n)) out[k] = n;
  return out;
}

/** Durations are seconds; a value over 1000 is taken as milliseconds. */
export function parseDuration(v: unknown): number | null {
  if (!finite(v) || v <= 0) return null;
  const s = v > 1000 ? v / 1000 : v;
  return Math.min(3600, s);
}

/** The event inside a {type:'roblox', event} message (or a bare event). */
export function parseTagEvent(raw: unknown): TagEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const e = (m.type === 'roblox' && m.event && typeof m.event === 'object' ? m.event : m) as Record<string, unknown>;
  const t = toSeconds(e.t);
  if (e.type === 'tag') {
    const by = typeof e.by === 'string' ? e.by : '';
    const target = typeof e.target === 'string' ? e.target : '';
    if (!target) return null;
    const ev: TagEvent = { type: 'tag', by, target, t, targetName: typeof e.targetName === 'string' ? e.targetName : undefined };
    const scores = parseScores(e.scores);
    if (scores && Object.keys(scores).length) ev.scores = scores;
    if (finite(e.livesLeft)) ev.livesLeft = e.livesLeft;
    return ev;
  }
  if (e.type === 'round' && (e.state === 'start' || e.state === 'end')) {
    return {
      type: 'round',
      state: e.state,
      t,
      scores: parseScores(e.scores),
      duration: parseDuration(e.duration),
      it: typeof e.it === 'string' ? e.it : null,
      winner: typeof e.winner === 'string' ? e.winner : null,
    };
  }
  return null;
}

export interface ScoreRow {
  id: string;
  name: string;
  score: number;
  me: boolean;
}

export type TagEffect =
  | { kind: 'tagged'; by: string; target: string; mine: boolean; me: boolean }
  | { kind: 'start'; it: string | null; youAreIt: boolean; duration: number }
  | { kind: 'end'; winner: string | null; rows: ScoreRow[] };

/** Round state from the event stream. Times are server seconds. */
export class TagGame {
  active = false;
  startedAt: number | null = null;
  duration = DEFAULT_ROUND_SECONDS;
  endedAt: number | null = null;
  scores: Record<string, number> = {};
  it: string | null = null;
  winner: string | null = null;
  tags = new Map<string, number>();
  private lastTag = new Map<string, number>();

  constructor(private myIds: () => ReadonlySet<string>) {}

  private isMe(id: string | null): boolean {
    return !!id && this.myIds().has(id);
  }

  /** Applies one event at server time `now`; returns what the HUD should show, or null. */
  apply(e: TagEvent, now: number): TagEffect | null {
    const t = e.t ?? now;
    if (e.type === 'tag') {
      // the referee may retry a send: one flash per target per second
      const key = `${e.by}>${e.target}`;
      const prev = this.lastTag.get(key);
      if (prev !== undefined && Math.abs(t - prev) < 1) return null;
      this.lastTag.set(key, t);
      if (e.by) this.tags.set(e.by, (this.tags.get(e.by) ?? 0) + 1);
      if (e.scores) {
        this.scores = { ...this.scores, ...e.scores };
      } else {
        // the referee sends scores only at the round's start and end: count the tag here so the scoreboard moves at
        // once (the tagger's tags up by one; the target down to the lives it has left, or one fewer)
        if (e.by) this.scores = { ...this.scores, [e.by]: (this.scores[e.by] ?? 0) + 1 };
        if (e.livesLeft !== undefined) this.scores = { ...this.scores, [e.target]: Math.max(0, e.livesLeft) };
        else if (this.scores[e.target] !== undefined) this.scores = { ...this.scores, [e.target]: Math.max(0, this.scores[e.target]! - 1) };
      }
      return { kind: 'tagged', by: e.by, target: e.target, mine: this.isMe(e.by), me: this.isMe(e.target) };
    }
    if (e.state === 'start') {
      this.active = true;
      this.startedAt = t;
      this.endedAt = null;
      this.winner = null;
      this.duration = e.duration ?? DEFAULT_ROUND_SECONDS;
      this.scores = e.scores ?? {};
      this.tags.clear();
      // the VR player is "it" unless the event says otherwise
      const it = e.it ?? [...this.myIds()].find((id) => id.startsWith('quest')) ?? null;
      this.it = it;
      return { kind: 'start', it, youAreIt: e.it ? this.isMe(e.it) : !!it && this.isMe(it), duration: this.duration };
    }
    this.active = false;
    this.endedAt = t;
    if (e.scores) this.scores = e.scores;
    this.winner = e.winner ?? topScorer(this.scores);
    return { kind: 'end', winner: this.winner, rows: [] };
  }

  /** Scores from an event other than start/end (some referees send them with every tag). */
  updateScores(s: Record<string, number> | null): void {
    if (s) this.scores = { ...this.scores, ...s };
  }

  /** Seconds left in the round, or null when no round is running. Ends a round whose end event never came. */
  remaining(now: number): number | null {
    if (!this.active || this.startedAt === null) return null;
    const left = this.startedAt + this.duration - now;
    if (left < -10) {
      this.active = false;
      this.endedAt = this.startedAt + this.duration;
      return null;
    }
    return Math.max(0, left);
  }

  rows(nameOf: (id: string) => string): ScoreRow[] {
    const ids = new Set([...Object.keys(this.scores)]);
    return [...ids]
      .map((id) => ({ id, name: nameOf(id), score: this.scores[id] ?? 0, me: this.isMe(id) }))
      .sort((a, b) => b.score - a.score || (a.me ? -1 : b.me ? 1 : a.name.localeCompare(b.name)));
  }
}

/** Highest score, or null on a tie or with no scores. */
export function topScorer(scores: Record<string, number>): string | null {
  let best: string | null = null, bestN = -Infinity, tie = false;
  for (const [id, n] of Object.entries(scores)) {
    if (n > bestN) {
      best = id;
      bestN = n;
      tie = false;
    } else if (n === bestN) tie = true;
  }
  return tie ? null : best;
}

export function formatClock(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// haptics

/** One pulse on every connected controller (Quest: hapticActuators.pulse). Never throws. */
export function pulseControllers(session: XRSession | null, intensity: number, ms: number): void {
  if (!session) return;
  try {
    for (const src of session.inputSources) {
      const gp = src.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, d: number) => Promise<boolean> }> }) | undefined;
      const act = gp?.hapticActuators?.[0];
      if (act?.pulse) void act.pulse(intensity, ms).catch(() => undefined);
      else {
        const v = (gp as unknown as { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } })?.vibrationActuator;
        void v?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity * 0.6 })?.catch(() => undefined);
      }
    }
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------------------------
// headset visuals

/**
 * Keeps a camera child exactly on the head pose of the frame being drawn. In XR, three applies
 * the new head pose to the camera after it updated the scene's matrices, so camera children would
 * trail by a frame and swim when the head turns; recomputing here (per eye, before the
 * model-view matrix is formed) removes the lag.
 */
export function headLock(obj: THREE.Object3D, camera: THREE.Camera): void {
  obj.onBeforeRender = () => {
    obj.matrixWorld.multiplyMatrices(camera.matrixWorld, obj.matrix);
  };
}

/** A head-locked banner: big word, optional pill underneath, slam-in animation. */
class HeadBanner {
  readonly plane = new CanvasPlane(1024, 420, 1.15, 0.472, { order: ORDER.hud + 2 });
  private t = -1;
  private dur = 1.7;

  constructor() {
    this.plane.mesh.position.set(0, 0.04, -1.25);
    this.plane.opacity = 0;
    this.plane.mesh.name = 'tag-banner';
  }

  show(word: string, sub: string | null, accent = ACCENT, dur = 1.7): void {
    const draw = () =>
      this.plane.draw((g, W, H) => {
        // a notification card: app icon, title, message, "now"
        const x = 24, y = 60, w = W - 48, h = H - 120;
        roundRect(g, x, y, w, h, 64);
        const reset = softShadow(g, 30, 8, 0.28);
        g.fillStyle = GLASS;
        g.fill();
        reset();
        drawAppIcon(g, x + 40, y + (h - 120) / 2, 120);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'right';
        g.fillStyle = '#8e8e93';
        g.font = `400 38px ${FONT}`;
        g.fillText('now', x + w - 44, y + 74);
        g.textAlign = 'left';
        const tx = x + 196, maxW = w - 196 - 140;
        let size = 66;
        g.font = `600 ${size}px ${FONT}`;
        while (g.measureText(word).width > maxW && size > 40) {
          size -= 4;
          g.font = `600 ${size}px ${FONT}`;
        }
        g.fillStyle = accent === RED ? RED : INK;
        g.fillText(word, tx, sub ? y + h / 2 - 8 : y + h / 2 + 22);
        if (sub) {
          g.font = `400 50px ${FONT}`;
          g.fillStyle = INK;
          let line = sub;
          while (g.measureText(line).width > w - 196 - 50 && line.length > 4) line = line.slice(0, -2);
          if (line !== sub) line = line.replace(/\s+$/, '') + '…';
          g.fillText(line, tx, y + h / 2 + 62);
        }
      });
    draw();
    this.redraw = draw;
    this.t = 0;
    this.dur = dur;
  }

  redraw: () => void = () => undefined;

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    const p = this.t / this.dur;
    if (p >= 1) {
      this.t = -1;
      this.plane.opacity = 0;
      return;
    }
    // drops in from slightly above, settles, fades at the end
    const inT = Math.min(1, this.t / 0.32);
    this.plane.mesh.position.y = 0.04 + 0.06 * (1 - easeOut(inT));
    this.plane.mesh.scale.setScalar(0.97 + 0.03 * easeOut(inT));
    this.plane.opacity = easeOut(inT) * (p > 0.82 ? 1 - (p - 0.82) / 0.18 : 1);
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The small round panel: timer and scoreboard, floating up and to the left of where you look. */
class RoundPanel {
  readonly plane = new CanvasPlane(720, 330, 0.4, 0.183, { order: ORDER.hud });
  private anchor = new THREE.Vector3();
  private anchorYaw = 0;
  private placed = false;
  private key = '';
  private fade = 0;

  constructor() {
    this.plane.opacity = 0;
    this.plane.mesh.name = 'tag-round';
  }

  draw(time: string, urgent: boolean, rows: ScoreRow[], title: string): void {
    const key = `${time}|${urgent}|${title}|${rows.map((r) => `${r.name}:${r.score}:${r.me}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.plane.draw((g, W, H) => {
      roundRect(g, 4, 4, W - 8, H - 8, 34);
      g.fillStyle = GLASS;
      g.fill();
      // clock block
      roundRect(g, 18, 18, 230, H - 36, 24);
      g.fillStyle = urgent ? RED : ACCENT;
      g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.font = `600 28px ${FONT}`;
      g.fillText(title, 133, 70);
      g.font = `600 88px ${FONT}`;
      g.fillText(time, 133, 190);
      g.textAlign = 'left';
      // scores
      const list = rows.slice(0, 4);
      if (!list.length) {
        g.fillStyle = INK_2;
        g.font = `400 30px ${FONT}`;
        g.fillText('Tag them with your hands', 276, H / 2 + 10);
      }
      list.forEach((r, i) => {
        const y = 62 + i * 66;
        if (r.me) {
          roundRect(g, 266, y - 42, W - 286, 58, 14);
          g.fillStyle = 'rgba(0,122,255,0.1)';
          g.fill();
        }
        g.fillStyle = r.me ? ACCENT : INK;
        g.font = `500 34px ${FONT}`;
        let name = r.me ? `${r.name} (you)` : r.name;
        while (g.measureText(name).width > W - 420 && name.length > 3) name = name.slice(0, -2);
        g.fillText(name, 284, y);
        g.textAlign = 'right';
        g.font = `600 40px ${FONT}`;
        g.fillText(String(r.score), W - 36, y + 2);
        g.textAlign = 'left';
      });
    });
  }

  /** Lazy-follow: stays put until you turn away, then glides back into view. */
  update(dt: number, show: boolean, head: THREE.Vector3, headYaw: number): void {
    this.fade += ((show ? 1 : 0) - this.fade) * damp(show ? 8 : 5, dt);
    this.plane.opacity = this.fade < 0.01 && !show ? 0 : this.fade;
    if (!this.plane.mesh.visible) {
      this.placed = false;
      return;
    }
    const off = Math.atan2(Math.sin(headYaw - this.anchorYaw), Math.cos(headYaw - this.anchorYaw));
    if (!this.placed || Math.abs(off) > 0.6) {
      this.anchorYaw = headYaw;
    }
    const yaw = this.anchorYaw + 0.32;
    const want = new THREE.Vector3(head.x - Math.sin(yaw) * 1.25, head.y + 0.3, head.z - Math.cos(yaw) * 1.25);
    if (!this.placed) this.anchor.copy(want);
    else this.anchor.lerp(want, damp(3.5, dt));
    this.placed = true;
    const m = this.plane.mesh;
    m.position.copy(this.anchor);
    m.lookAt(head);
  }
}

/** Small head-locked toast for the headset. */
export class XrToast {
  readonly plane = new CanvasPlane(900, 200, 0.56, 0.124, { order: ORDER.hud + 1 });
  private t = -1;
  private hold = 3;

  constructor() {
    this.plane.mesh.position.set(0, -0.3, -1.1);
    this.plane.mesh.rotation.x = 0.22;
    this.plane.opacity = 0;
    this.plane.mesh.name = 'xr-toast';
  }

  show(title: string, body = '', kind: 'info' | 'error' | 'ok' = 'info', seconds = 3.2): void {
    const accent = kind === 'error' ? RED : INK;
    const draw = () =>
      this.plane.draw((g, W, H) => {
        roundRect(g, 4, 4, W - 8, H - 8, 40);
        g.fillStyle = GLASS;
        g.fill();
        const icon = Math.min(76, H - 56);
        drawAppIcon(g, 30, (H - icon) / 2, icon);
        const tx = 30 + icon + 24, maxW = W - tx - 34;
        g.fillStyle = accent;
        g.font = `600 42px ${FONT}`;
        let tt = title;
        while (g.measureText(tt).width > maxW && tt.length > 4) tt = tt.slice(0, -2);
        g.fillText(tt, tx, body ? 88 : 116);
        if (body) {
          g.fillStyle = INK_2;
          g.font = `400 32px ${FONT}`;
          let bb = body;
          while (g.measureText(bb).width > maxW && bb.length > 4) bb = bb.slice(0, -2);
          if (bb !== body) bb = bb.replace(/\s+$/, '') + '…';
          g.fillText(bb, tx, 140);
        }
      });
    draw();
    this.redraw = draw;
    this.t = 0;
    this.hold = seconds;
  }

  redraw: () => void = () => undefined;

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    const a = Math.min(1, this.t / 0.2) * (this.t > this.hold ? Math.max(0, 1 - (this.t - this.hold) / 0.4) : 1);
    this.plane.opacity = a;
    if (this.t > this.hold + 0.4) {
      this.t = -1;
      this.plane.opacity = 0;
    }
  }
}

/** The world-space burst where someone got tagged: a shock ring, sparks, and a rising tag. */
class TagBurst {
  readonly group = new THREE.Group();
  private ringMat = new THREE.MeshBasicMaterial({ color: ACCENT_HEX, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
  private ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 64), this.ringMat);
  private sparkMat = new THREE.MeshBasicMaterial({ color: ACCENT_HEX, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
  private sparks: THREE.InstancedMesh;
  private dirs: THREE.Vector3[] = [];
  private label = new CanvasPlane(512, 160, 0.62, 0.194, { order: ORDER.burst + 1 });
  private t = 0;
  private m = new THREE.Matrix4();

  constructor(at: THREE.Vector3, headY: number) {
    this.sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.03, 0), this.sparkMat, 28);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + Math.random() * 0.3;
      const up = 0.4 + Math.random() * 1.1;
      this.dirs.push(new THREE.Vector3(Math.cos(a) * (1.2 + Math.random()), up, Math.sin(a) * (1.2 + Math.random())));
    }
    this.group.position.copy(at);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    for (const o of [this.ring, this.sparks, this.label.mesh]) {
      o.renderOrder = ORDER.burst;
      o.frustumCulled = false;
    }
    this.label.mesh.position.y = headY - at.y + 0.45;
    this.label.draw((g, W, H) => {
      roundRect(g, 10, 10, W - 20, H - 20, (H - 20) / 2);
      g.fillStyle = GLASS;
      g.fill();
      g.fillStyle = ACCENT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `600 96px ${FONT}`;
      g.fillText('Tagged', W / 2, H / 2 + 4);
    });
    this.group.add(this.ring, this.sparks, this.label.mesh);
  }

  /** Returns false when finished. */
  update(dt: number, viewer: THREE.Vector3): boolean {
    this.t += dt;
    const t = this.t;
    const r = easeOut(Math.min(1, t / 0.7));
    this.ring.scale.setScalar(0.3 + r * 2.2);
    this.ringMat.opacity = Math.max(0, 1 - t / 0.75);
    for (let i = 0; i < this.dirs.length; i++) {
      const d = this.dirs[i];
      const s = Math.max(0, 1 - t / 0.9);
      this.m.makeScale(s, s, s).setPosition(d.x * t, 1.0 + d.y * t - 2.2 * t * t, d.z * t);
      this.sparks.setMatrixAt(i, this.m);
    }
    this.sparks.instanceMatrix.needsUpdate = true;
    this.sparkMat.opacity = Math.max(0, 1 - t / 0.9);
    const lp = this.label.mesh;
    lp.position.y += dt * 0.25;
    const pop = Math.min(1, t / 0.18);
    lp.scale.setScalar(0.6 + 0.4 * easeOut(pop) + (t < 0.3 ? 0.12 * Math.sin((t / 0.3) * Math.PI) : 0));
    lp.lookAt(viewer);
    this.label.opacity = Math.min(1, t / 0.08) * Math.max(0, t > 1.4 ? 1 - (t - 1.4) / 0.4 : 1);
    return t < 1.85;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.sparks.geometry.dispose();
    this.sparkMat.dispose();
    this.sparks.dispose();
    this.label.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// the HUD (desktop DOM + headset)

export interface TagHudHost {
  scene: THREE.Object3D;
  camera: THREE.Camera;
  presenting(): boolean;
  session(): XRSession | null;
  serverNow(): number;
  nameOf(id: string): string;
  /** Where a person is drawn now (world), with their head height. */
  whereIs(id: string): { position: THREE.Vector3; head: THREE.Vector3 } | null;
  myIds(): ReadonlySet<string>;
  head(): { position: THREE.Vector3; yaw: number };
  sounds: { tag(): void; roundStart(): void; roundEnd(): void; tick(): void };
}

export class TagHud {
  readonly game: TagGame;
  readonly toast = new XrToast();
  private banner = new HeadBanner();
  private panel = new RoundPanel();
  private bursts: TagBurst[] = [];
  private dom: HTMLElement;
  private domRound: HTMLElement;
  private domTime: HTMLElement;
  private domLabel: HTMLElement;
  private domScores: HTMLElement;
  private lastTick = -1;
  private endShownUntil = 0;
  private domKey = '';

  constructor(private host: TagHudHost, root: HTMLElement) {
    this.game = new TagGame(() => host.myIds());
    host.camera.add(this.banner.plane.mesh, this.toast.plane.mesh);
    headLock(this.banner.plane.mesh, host.camera);
    headLock(this.toast.plane.mesh, host.camera);
    host.scene.add(this.panel.plane.mesh);
    this.dom = root;
    this.domRound = document.createElement('div');
    this.domRound.className = 'dvs-round';
    this.domRound.innerHTML = '<div class="dvs-round__clock"><span class="dvs-round__label">TAG</span><span class="dvs-round__time">1:30</span></div><div class="dvs-round__scores"></div>';
    this.domTime = this.domRound.querySelector('.dvs-round__time')!;
    this.domLabel = this.domRound.querySelector('.dvs-round__label')!;
    this.domScores = this.domRound.querySelector('.dvs-round__scores')!;
    root.append(this.domRound);
    redrawWhenFontsLoad(() => {
      this.banner.redraw();
      this.toast.redraw();
    });
  }

  /** A {type:'roblox'} message (or a bare event). */
  handle(raw: unknown): void {
    const e = parseTagEvent(raw);
    if (!e) return;
    const effect = this.game.apply(e, this.host.serverNow());
    if (!effect) return;
    if (effect.kind === 'tagged') this.onTagged(effect.by, effect.target, effect.mine, effect.me, e.type === 'tag' ? e.targetName : undefined);
    else if (effect.kind === 'start') this.onStart(effect.youAreIt, effect.duration);
    else this.onEnd(effect.winner);
  }

  private onTagged(by: string, target: string, mine: boolean, me: boolean, targetName?: string): void {
    const tName = targetName ?? this.host.nameOf(target);
    const byName = this.host.nameOf(by);
    const sub = me ? `${byName} got you` : mine ? `You got ${tName}` : `${byName} got ${tName}`;
    this.host.sounds.tag();
    if (this.host.presenting()) {
      this.banner.show('Tagged', sub, ACCENT, 1.6);
      pulseControllers(this.host.session(), mine || me ? 1 : 0.5, 140);
      if (mine || me) setTimeout(() => pulseControllers(this.host.session(), 0.6, 110), 200);
    }
    this.domFlash('Tagged', sub);
    const where = this.host.whereIs(target);
    if (where) {
      const b = new TagBurst(where.position, where.head.y);
      this.bursts.push(b);
      this.host.scene.add(b.group);
    }
  }

  private onStart(youAreIt: boolean, duration: number): void {
    this.host.sounds.roundStart();
    const word = youAreIt ? "You're it" : 'Tag!';
    const sub = youAreIt ? `${Math.round(duration)} s · tag them with your hands` : `${Math.round(duration)} s round`;
    if (this.host.presenting()) {
      this.banner.show(word, sub, ACCENT, 2.4);
      pulseControllers(this.host.session(), 0.6, 120);
    }
    this.domFlash(youAreIt ? "Tag: you're it" : 'Tag!', sub, 'banner');
    this.lastTick = -1;
  }

  private onEnd(winner: string | null): void {
    this.host.sounds.roundEnd();
    const name = winner ? this.host.nameOf(winner) : null;
    const me = winner ? this.host.myIds().has(winner) : false;
    const sub = name ? (me ? 'You win!' : `${name} wins`) : "It's a tie";
    if (this.host.presenting()) this.banner.show('Round over', sub, ACCENT, 3.4);
    this.domFlash('Round over', sub, 'end', 3200);
    this.endShownUntil = this.host.serverNow() + 6;
  }

  private domFlash(word: string, sub: string | null, kind: '' | 'banner' | 'end' = '', ms = 1700): void {
    if (this.host.presenting()) return;
    const el = document.createElement('div');
    el.className = `dvs-flash${kind ? ` dvs-flash--${kind}` : ''}`;
    el.setAttribute('role', 'status');
    const box = document.createElement('div');
    box.className = 'dvs-flash__box';
    box.style.animationDuration = `${ms}ms`;
    const w = document.createElement('div');
    w.className = 'dvs-flash__word';
    w.textContent = word;
    box.append(w);
    if (sub) {
      const s = document.createElement('div');
      s.className = 'dvs-flash__sub';
      s.textContent = sub;
      box.append(s);
    }
    el.append(box);
    for (const old of this.dom.querySelectorAll('.dvs-flash')) old.remove();
    this.dom.append(el);
    setTimeout(() => el.remove(), ms + 100);
  }

  update(dt: number): void {
    const now = this.host.serverNow();
    const left = this.game.remaining(now);
    const showRound = left !== null || now < this.endShownUntil;
    const rows = showRound ? this.game.rows((id) => this.host.nameOf(id)) : [];
    const time = left !== null ? formatClock(left) : '0:00';
    const urgent = left !== null && left <= 10;
    const title = left !== null ? (this.game.it && this.host.myIds().has(this.game.it) ? "You're it" : 'Tag') : 'Final';
    if (left !== null && left <= 5 && left > 0) {
      const s = Math.ceil(left);
      if (s !== this.lastTick) {
        this.lastTick = s;
        this.host.sounds.tick();
      }
    }
    // desktop
    const domOn = showRound && !this.host.presenting();
    this.domRound.classList.toggle('is-on', domOn);
    if (domOn) {
      const key = `${time}|${urgent}|${title}|${rows.map((r) => `${r.id}:${r.score}`).join(',')}`;
      if (key !== this.domKey) {
        this.domKey = key;
        this.domTime.textContent = time;
        this.domLabel.textContent = title;
        this.domRound.classList.toggle('is-urgent', urgent);
        this.domScores.replaceChildren(
          ...rows.slice(0, 5).map((r) => {
            const d = document.createElement('div');
            d.className = `dvs-score${r.me ? ' is-me' : ''}`;
            const n = document.createElement('span');
            n.className = 'dvs-score__name';
            n.textContent = r.me ? `${r.name} (you)` : r.name;
            const p = document.createElement('span');
            p.className = 'dvs-score__pts';
            p.textContent = String(r.score);
            d.append(n, p);
            return d;
          }),
        );
      }
    }
    // headset
    const head = this.host.head();
    const xrOn = showRound && this.host.presenting();
    if (xrOn) this.panel.draw(time, urgent, rows, title);
    this.panel.update(dt, xrOn, head.position, head.yaw);
    this.banner.update(dt);
    this.toast.update(dt);
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!this.bursts[i].update(dt, head.position)) {
        this.bursts[i].dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const b of this.bursts) b.dispose();
    this.bursts = [];
    this.banner.plane.dispose();
    this.toast.plane.dispose();
    this.panel.plane.dispose();
    this.domRound.remove();
  }
}
