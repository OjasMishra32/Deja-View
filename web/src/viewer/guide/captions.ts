// Captions for the guide: what you asked and what the room answered.
//   Desktop: a card over the bottom of the page, a hold-to-ask mic button, and a typed-question box
//            when there is no microphone.
//   Headset: a canvas-textured panel that tags along in front of you (it re-centres when you look
//            away, then glides; it never sticks to your face).
// Both show the same CaptionState: listening (with a live level), thinking, speaking, a hint, an error.

import * as THREE from 'three';
import { drawGlass, GLASS } from '../xr-text.ts';
import { wrapLines } from './hotspots.ts';

export type CaptionMode = 'hidden' | 'hint' | 'listening' | 'thinking' | 'speaking' | 'answer' | 'error';

export interface CaptionState {
  mode: CaptionMode;
  /** Small line above the answer (the question, or the hint's second line). */
  question?: string;
  /** The main text. */
  answer?: string;
  /** Eyebrow text override. */
  title?: string;
}

// Apple colours: the question is a blue sent bubble, the answer a gray received one.
const ACCENT = '#007AFF';
const BUBBLE = '#E9E9EB';
/** In the headset the panel is the same dark glass as the wrist menu, with the dark-mode blue. */
const XR_ACCENT = '#0A84FF';
const XR_QUESTION = '#6CB2FF';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", Roboto, system-ui, sans-serif';

export const STATUS_TEXT: Record<CaptionMode, string> = {
  hidden: '',
  hint: 'Your guide',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Guide',
  answer: 'Guide',
  error: 'Guide',
};

// ---------------------------------------------------------------------------------------------
// Desktop

const STYLE_ID = 'dvg-styles';
const CSS = `
.dvg-root { position: fixed; inset: 0; pointer-events: none; z-index: 12; font-family: ${FONT}; color: #1d1d1f; }
.dvg-card {
  position: absolute; left: 50%; bottom: calc(26px + env(safe-area-inset-bottom, 0px));
  width: min(560px, calc(100vw - 32px)); box-sizing: border-box;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  transform: translate(-50%, 14px); opacity: 0;
  transition: opacity 0.28s ease, transform 0.36s cubic-bezier(0.25, 0.1, 0.25, 1), bottom 0.3s ease;
}
.dvg-root.is-shown .dvg-card { opacity: 1; transform: translate(-50%, 0); }
.dvg-root.has-transport .dvg-card { bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
.dvg-top { display: flex; align-items: center; gap: 8px; min-height: 18px; width: 100%; }
.dvg-eyebrow { display: inline-flex; align-items: center; padding: 5px 10px; border-radius: 999px; font: 600 12px/1 ${FONT}; color: #6e6e73; background: rgba(255,255,255,0.86); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
.dvg-root[data-mode="error"] .dvg-eyebrow { color: #d70015; }
.dvg-wave { display: none; align-items: center; gap: 3px; height: 26px; padding: 0 10px; border-radius: 999px; background: rgba(255,255,255,0.86); box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
.dvg-wave i { display: block; width: 3px; height: 4px; border-radius: 2px; background: ${ACCENT}; transition: height 0.08s linear; }
.dvg-root[data-mode="listening"] .dvg-wave { display: inline-flex; }
/* thinking: the iMessage typing bubble */
.dvg-dots { display: none; gap: 5px; padding: 12px 14px; border-radius: 20px; background: ${BUBBLE}; box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
.dvg-dots i { width: 8px; height: 8px; border-radius: 50%; background: #8e8e93; animation: dvg-bounce 1.2s infinite ease-in-out; }
.dvg-dots i:nth-child(2) { animation-delay: 0.15s; } .dvg-dots i:nth-child(3) { animation-delay: 0.3s; }
.dvg-root[data-mode="thinking"] .dvg-dots { display: inline-flex; }
@keyframes dvg-bounce { 0%, 70%, 100% { opacity: 0.35; } 35% { opacity: 1; } }
.dvg-q { align-self: flex-end; max-width: 80%; margin: 0; padding: 8px 14px 9px; border-radius: 20px; font: 400 15px/1.35 ${FONT}; color: #fff; background: ${ACCENT}; box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
.dvg-q:empty { display: none; }
.dvg-a { max-width: 88%; margin: 0; padding: 10px 16px 11px; border-radius: 22px; font: 400 18px/1.35 ${FONT}; letter-spacing: -0.01em; color: #000; background: ${BUBBLE}; box-shadow: 0 2px 12px rgba(0,0,0,0.14); text-wrap: pretty; }
.dvg-a:empty { display: none; }
.dvg-mic {
  pointer-events: auto; position: absolute; right: calc(18px + env(safe-area-inset-right, 0px)); bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  width: 60px; height: 60px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
  display: grid; place-items: center; background: ${ACCENT}; color: #fff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25), 0 0 0 0 rgba(0, 122, 255, 0);
  transition: transform 0.18s ease, box-shadow 0.25s ease, opacity 0.3s ease, bottom 0.3s ease;
  -webkit-tap-highlight-color: transparent; touch-action: none; user-select: none; -webkit-user-select: none;
}
.dvg-mic svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.dvg-mic:hover { transform: scale(1.04); }
.dvg-mic.is-live { transform: scale(1.08); background: #ff3b30; box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 0 0 calc(6px + var(--lvl, 0) * 14px) rgba(255, 59, 48, 0.2); }
.dvg-mic.is-busy { opacity: 0.75; }
.dvg-mic:focus-visible { outline: 3px solid rgba(0,122,255,0.45); outline-offset: 4px; }
.dvg-key { position: absolute; right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(86px + env(safe-area-inset-bottom, 0px)); width: 72px; padding: 4px 6px; box-sizing: border-box; border-radius: 9px; text-align: center; font: 500 11px/1.2 ${FONT}; color: #1d1d1f; background: rgba(255,255,255,0.86); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); box-shadow: 0 2px 10px rgba(0,0,0,0.12); transition: bottom 0.3s ease, opacity 0.3s ease; }
.dvg-root.has-transport.is-narrow .dvg-mic { bottom: calc(76px + env(safe-area-inset-bottom, 0px)); }
.dvg-root.has-transport.is-narrow .dvg-key { bottom: calc(144px + env(safe-area-inset-bottom, 0px)); }
.dvg-root.has-transport.is-narrow .dvg-card { bottom: calc(150px + env(safe-area-inset-bottom, 0px)); }
.dvg-root.no-mic .dvg-key { opacity: 0; }
.dvg-ask {
  pointer-events: auto; position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(26px + env(safe-area-inset-bottom, 0px)); width: min(560px, calc(100vw - 120px));
  display: flex; gap: 8px; padding: 5px; border-radius: 999px; box-sizing: border-box;
  background: rgba(255, 255, 255, 0.9); border: 1px solid rgba(60, 60, 67, 0.18);
  -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); box-shadow: 0 10px 30px rgba(0,0,0,0.2);
}
.dvg-root.has-transport .dvg-ask { bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
.dvg-root.is-typing .dvg-card { bottom: calc(92px + env(safe-area-inset-bottom, 0px)); }
.dvg-root.is-typing.has-transport .dvg-card { bottom: calc(146px + env(safe-area-inset-bottom, 0px)); }
.dvg-ask input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: #1d1d1f; font: 400 16px/1 ${FONT}; padding: 0 14px; user-select: text; -webkit-user-select: text; }
.dvg-ask input::placeholder { color: #8e8e93; }
.dvg-ask button { border: 0; border-radius: 999px; padding: 10px 18px; background: ${ACCENT}; color: #fff; font: 600 14px/1 ${FONT}; cursor: pointer; }
@media (max-width: 760px) { .dvg-a { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .dvg-card, .dvg-mic { transition: none; } .dvg-dots i { animation: none; opacity: 0.8; } }
`;

export function injectGuideStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/** A toast in the viewer's own toast stack (same look as hud.ts), for when no toast hook is given. */
export function fallbackToast(title: string, body = '', kind: 'info' | 'error' | 'ok' = 'info', ms = 5000): void {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('tw-toasts') ?? document.body;
  const el = document.createElement('div');
  el.className = `tw-toast is-${kind}`;
  el.setAttribute('role', 'status');
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
  setTimeout(() => el.remove(), ms);
}

const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>';
const TYPE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/><path d="m16 16 4 2-4 2"/></svg>';

export interface DesktopCaptionHandlers {
  onMicDown(): void;
  onMicUp(): void;
  onTyped(question: string): void;
}

export class DesktopCaptions {
  readonly root: HTMLDivElement;
  private card: HTMLDivElement;
  private eyebrow: HTMLSpanElement;
  private q: HTMLDivElement;
  private a: HTMLDivElement;
  private bars: HTMLElement[] = [];
  private mic: HTMLButtonElement;
  private key: HTMLDivElement;
  private form: HTMLFormElement;
  private input: HTMLInputElement;
  private state: CaptionState = { mode: 'hidden' };
  private micDown = false;
  private layoutTimer = 0;
  private phase = 0;

  constructor(private handlers: DesktopCaptionHandlers, keyLabel: string) {
    injectGuideStyles();
    const root = document.createElement('div');
    root.className = 'dvg-root';
    root.dataset.mode = 'hidden';
    root.innerHTML = `
      <div class="dvg-card" role="status" aria-live="polite">
        <div class="dvg-top"><span class="dvg-eyebrow"></span><span class="dvg-wave">${'<i></i>'.repeat(18)}</span><span class="dvg-dots"><i></i><i></i><i></i></span></div>
        <div class="dvg-q"></div>
        <div class="dvg-a"></div>
      </div>
      <form class="dvg-ask" hidden><input type="text" maxlength="200" placeholder="Ask about this place" aria-label="Ask the guide" autocomplete="off"><button type="submit">Ask</button></form>
      <div class="dvg-key"></div>
      <button class="dvg-mic" type="button" aria-label="Hold to ask the guide">${MIC_SVG}</button>`;
    this.root = root;
    this.card = root.querySelector('.dvg-card')!;
    this.eyebrow = root.querySelector('.dvg-eyebrow')!;
    this.q = root.querySelector('.dvg-q')!;
    this.a = root.querySelector('.dvg-a')!;
    this.bars = Array.from(root.querySelectorAll('.dvg-wave i'));
    this.mic = root.querySelector('.dvg-mic')!;
    this.key = root.querySelector('.dvg-key')!;
    this.form = root.querySelector('.dvg-ask')!;
    this.input = this.form.querySelector('input')!;
    this.key.textContent = keyLabel;
    this.mic.title = `Hold to ask (${keyLabel.replace(/^hold\s+/i, '')})`;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        this.mic.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable */
      }
      this.micDown = true;
      this.handlers.onMicDown();
    };
    const up = (e: PointerEvent) => {
      if (!this.micDown) return;
      e.preventDefault();
      this.micDown = false;
      this.handlers.onMicUp();
    };
    this.mic.addEventListener('pointerdown', down);
    this.mic.addEventListener('pointerup', up);
    this.mic.addEventListener('pointercancel', up);
    this.mic.addEventListener('lostpointercapture', up);
    this.mic.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mic.addEventListener('keydown', (e) => {
      if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat && !this.micDown) {
        e.preventDefault();
        e.stopPropagation();
        this.micDown = true;
        this.handlers.onMicDown();
      }
    });
    this.mic.addEventListener('keyup', (e) => {
      if ((e.code === 'Enter' || e.code === 'Space') && this.micDown) {
        e.preventDefault();
        e.stopPropagation();
        this.micDown = false;
        this.handlers.onMicUp();
      }
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      this.showTyping(false);
      this.handlers.onTyped(text);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') this.showTyping(false);
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    document.body.append(root);
  }

  /** No microphone: the button opens the typed box instead. */
  setNoMic(noMic: boolean): void {
    this.root.classList.toggle('no-mic', noMic);
    this.mic.innerHTML = noMic ? TYPE_SVG : MIC_SVG;
    this.mic.setAttribute('aria-label', noMic ? 'Type a question for the guide' : 'Hold to ask the guide');
  }

  setKeyLabel(text: string): void {
    this.key.textContent = text;
  }

  get typing(): boolean {
    return !this.form.hidden;
  }

  showTyping(on: boolean): void {
    this.form.hidden = !on;
    this.root.classList.toggle('is-typing', on);
    if (on) setTimeout(() => this.input.focus({ preventScroll: true }), 0);
    else this.input.blur();
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  set(state: CaptionState): void {
    this.state = state;
    this.root.dataset.mode = state.mode;
    this.root.classList.toggle('is-shown', state.mode !== 'hidden');
    this.eyebrow.textContent = state.title ?? STATUS_TEXT[state.mode];
    this.q.textContent = state.question ?? '';
    this.a.textContent = state.answer ?? '';
    this.mic.classList.toggle('is-live', state.mode === 'listening');
    this.mic.classList.toggle('is-busy', state.mode === 'thinking');
    if (state.mode !== 'listening') this.mic.style.setProperty('--lvl', '0');
  }

  update(dt: number, level: number): void {
    this.layoutTimer -= dt;
    if (this.layoutTimer <= 0) {
      this.layoutTimer = 0.5;
      const hud = document.getElementById('tw-hud');
      const transport = document.getElementById('tw-transport');
      this.root.classList.toggle('has-transport', !!hud?.classList.contains('has-transport') && !!transport && !transport.hidden);
      this.root.classList.toggle('is-narrow', window.innerWidth < 760);
    }
    if (this.state.mode === 'listening') {
      this.phase += dt;
      this.mic.style.setProperty('--lvl', level.toFixed(2));
      const n = this.bars.length;
      for (let i = 0; i < n; i++) {
        const wobble = 0.55 + 0.45 * Math.sin(this.phase * 9 + i * 0.9) * Math.sin(this.phase * 3.3 + i * 0.37);
        const env = Math.sin((Math.PI * (i + 0.5)) / n);
        this.bars[i].style.height = `${(3 + Math.min(1, level * 1.4) * 15 * env * wobble + 1).toFixed(1)}px`;
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// Headset panel

const PW = 1024;
const PH = 400;
const PANEL_W = 0.62;
const PANEL_H = PANEL_W * (PH / PW);

export interface FollowOptions {
  distance: number;
  drop: number;
  /** Re-centre when the panel is this far (degrees) from where you look. */
  recentreDeg: number;
  /** How quickly it glides (1/s). */
  glide: number;
}

export const DEFAULT_FOLLOW: FollowOptions = { distance: 1.25, drop: 0.2, recentreDeg: 24, glide: 4.5 };

/** Where the panel wants to be: in front of the head (yaw only), a little below eye level. */
export function followTarget(head: THREE.Vector3, yaw: number, o: FollowOptions = DEFAULT_FOLLOW, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(head.x - Math.sin(yaw) * o.distance, head.y - o.drop, head.z - Math.cos(yaw) * o.distance);
}

/** Horizontal angle (radians) between the gaze yaw and the direction from the head to a point. */
export function yawOffset(head: THREE.Vector3, yaw: number, p: THREE.Vector3): number {
  const a = Math.atan2(-(p.x - head.x), -(p.z - head.z));
  let d = a - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class XrCaptionPanel {
  readonly mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private mat: THREE.MeshBasicMaterial;
  private state: CaptionState = { mode: 'hidden' };
  private dirty = true;
  private opacity = 0;
  private target = new THREE.Vector3();
  private placed = false;
  private animT = 0;
  private time = 0;
  private level = 0;
  private head = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private follow: FollowOptions;

  constructor(follow: Partial<FollowOptions> = {}) {
    this.follow = { ...DEFAULT_FOLLOW, ...follow };
    this.canvas = document.createElement('canvas');
    this.canvas.width = PW;
    this.canvas.height = PH;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, opacity: 0 });
    // origin at the top edge, so the panel grows downward as the answer gets longer
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H).translate(0, -PANEL_H / 2, 0), this.mat);
    this.mesh.name = 'guide-captions';
    this.mesh.renderOrder = 980;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  set(state: CaptionState): void {
    const wasHidden = this.state.mode === 'hidden';
    this.state = state;
    this.dirty = true;
    if (wasHidden && state.mode !== 'hidden') this.placed = false;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Call every frame while presenting (or not: it hides itself outside XR). */
  update(dt: number, camera: THREE.Camera, presenting: boolean, level: number): void {
    this.time += dt;
    this.level = level;
    const want = presenting && this.state.mode !== 'hidden' ? 1 : 0;
    this.opacity += (want - this.opacity) * Math.min(1, dt * (want ? 8 : 5));
    this.mesh.visible = presenting && this.opacity > 0.01;
    if (!this.mesh.visible) {
      if (!presenting) this.placed = false;
      return;
    }
    this.mat.opacity = this.opacity;

    camera.getWorldPosition(this.head);
    camera.getWorldDirection(this.fwd);
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    const off = Math.abs(yawOffset(this.head, yaw, this.mesh.position));
    const dist = Math.hypot(this.mesh.position.x - this.head.x, this.mesh.position.z - this.head.z);
    if (!this.placed) {
      followTarget(this.head, yaw, this.follow, this.target);
      this.mesh.position.copy(this.target);
      this.placed = true;
    } else if (off > THREE.MathUtils.degToRad(this.follow.recentreDeg) || Math.abs(dist - this.follow.distance) > 0.45 || Math.abs(this.mesh.position.y - (this.head.y - this.follow.drop)) > 0.35) {
      followTarget(this.head, yaw, this.follow, this.target);
    }
    this.mesh.position.lerp(this.target, 1 - Math.exp(-this.follow.glide * dt));
    // face the head, upright, tilted back a touch toward the eyes
    this.mesh.lookAt(this.head.x, this.mesh.position.y + (this.head.y - this.mesh.position.y) * 0.5, this.head.z);

    const animating = this.state.mode === 'listening' || this.state.mode === 'thinking';
    if (animating) {
      this.animT -= dt;
      if (this.animT <= 0) {
        this.animT = 1 / 24;
        this.dirty = true;
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
  }

  private draw(): void {
    const g = this.g;
    const s = this.state;
    g.clearRect(0, 0, PW, PH);
    if (s.mode === 'hidden') {
      this.tex.needsUpdate = true;
      return;
    }
    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };

    // layout first, so the panel can be exactly as tall as what it says
    const maxW = PW - 140;
    let y = 118;
    let question = '';
    if (s.question) {
      g.font = `500 34px ${FONT}`;
      question = wrapLines(s.question, maxW, (t) => g.measureText(t).width, 1)[0] ?? '';
    }
    const qY = y;
    y += question ? 52 : 12;
    const text = s.answer ?? '';
    let size = 44;
    let lines: string[] = [];
    if (text) {
      const room = PH - 40 - y;
      for (; size >= 30; size -= 4) {
        g.font = `400 ${size}px ${FONT}`;
        const maxLines = Math.max(1, Math.floor(room / (size * 1.24)));
        lines = wrapLines(text, maxW, (t) => g.measureText(t).width, maxLines);
        if (!lines.length || !lines[lines.length - 1].endsWith('…')) break;
      }
      size = Math.max(30, size);
    }
    const lh = size * 1.24;
    const used = Math.min(PH, Math.max(150, Math.ceil((lines.length ? y + lines.length * lh : y) + 34)));

    drawGlass(g, 6, 6, PW - 12, used - 12, 48, 0);

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = `600 30px ${FONT}`;
    g.fillStyle = s.mode === 'error' ? GLASS.red : GLASS.secondary;
    const eyebrow = s.title ?? STATUS_TEXT[s.mode];
    g.fillText(eyebrow, 70, 62);

    // live indicator at the right of the eyebrow
    if (s.mode === 'listening') {
      const n = 22, x0 = PW - 60 - n * 11;
      for (let i = 0; i < n; i++) {
        const env = Math.sin((Math.PI * (i + 0.5)) / n);
        const wob = 0.55 + 0.45 * Math.sin(this.time * 9 + i * 0.9) * Math.sin(this.time * 3.3 + i * 0.37);
        const h = 6 + Math.min(1, this.level * 1.4) * 38 * env * wob;
        rr(x0 + i * 11, 62 - h / 2, 6, h, 3);
        g.fillStyle = XR_ACCENT;
        g.fill();
      }
    } else if (s.mode === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const t = (this.time * 1.2 - i * 0.15) % 1;
        const up = t < 0.4 ? Math.sin((t / 0.4) * Math.PI) : 0;
        g.globalAlpha = 0.35 + 0.65 * up;
        g.beginPath();
        g.arc(PW - 130 + i * 30, 62, 9, 0, Math.PI * 2);
        g.fillStyle = GLASS.secondary;
        g.fill();
      }
      g.globalAlpha = 1;
    }

    if (question) {
      g.font = `400 34px ${FONT}`;
      g.fillStyle = XR_QUESTION;
      g.fillText(question, 70, qY);
    }
    if (lines.length) {
      g.font = `400 ${size}px ${FONT}`;
      g.fillStyle = GLASS.text;
      lines.forEach((l, i) => g.fillText(l, 70, y + lh / 2 + i * lh - 4));
    }

    // show only the used top part of the canvas; the mesh hangs from its top edge
    const f = used / PH;
    this.tex.repeat.set(1, f);
    this.tex.offset.set(0, 1 - f);
    this.mesh.scale.y = f;
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
