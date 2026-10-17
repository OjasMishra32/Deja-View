// Desktop and touch input: pointer-lock mouse look (drag look as a fallback), WASD + Shift,
// F fly with Q/E, shortcut keys, and twin-zone touch (left half walks, right half looks).

import type { Hud } from './hud.ts';
import type { MoveInput } from './player.ts';

export type DesktopAction = 'play' | 'reset' | 'fly' | 'mute' | 'help' | 'flip' | 'voxels' | 'perf' | 'gesture';

const MOUSE_SENS = 0.0022;
const DRAG_SENS = 0.0042;
const TOUCH_LOOK_SENS = 0.0055;
const STICK_RADIUS = 56;

interface TouchState {
  id: number;
  kind: 'move' | 'look';
  x0: number;
  y0: number;
  x: number;
  y: number;
}

export class DesktopControls {
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private dragging = false;
  private touches = new Map<number, TouchState>();
  private stick = { x: 0, y: 0 };
  private gestured = false;
  enabled = true;
  onAction: (a: DesktopAction) => void = () => undefined;
  /** Called the first time the user touches/clicks/presses anything ('pointer' or a key code). */
  onFirstGesture: (source: string) => void = () => undefined;

  constructor(private canvas: HTMLCanvasElement, private hud: Hud) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    document.addEventListener('pointerlockchange', () => this.hud.setHint(!this.locked && this.enabled));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private gesture(source: string): void {
    if (this.gestured) return;
    this.gestured = true;
    this.onFirstGesture(source);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.gesture(e.code);
    const code = e.code;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) e.preventDefault();
    if (e.repeat) {
      this.keys.add(code);
      return;
    }
    this.keys.add(code);
    switch (code) {
      case 'Space': this.onAction('play'); break;
      case 'KeyR': this.onAction('reset'); break;
      case 'KeyF': this.onAction('fly'); break;
      case 'KeyM': this.onAction('mute'); break;
      case 'KeyH': this.onAction('help'); break;
      case 'KeyU': this.onAction('flip'); break;
      case 'KeyV': this.onAction('voxels'); break;
      case 'Backquote': this.onAction('perf'); break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent) => {
    this.gesture('pointer');
    if (e.pointerType === 'touch') {
      const kind = e.clientX < window.innerWidth / 2 ? 'move' : 'look';
      // one finger per zone
      for (const t of this.touches.values()) if (t.kind === kind) return;
      this.touches.set(e.pointerId, { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
      if (kind === 'move') this.hud.showStick(e.clientX, e.clientY);
      this.hud.setCoach(false);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (!this.locked && this.enabled) {
      const req = this.canvas.requestPointerLock?.() as unknown;
      if (req instanceof Promise) req.catch(() => undefined);
    }
    this.dragging = true;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      if (t.kind === 'look') {
        this.lookX += (e.clientX - t.x) * TOUCH_LOOK_SENS;
        this.lookY += (e.clientY - t.y) * TOUCH_LOOK_SENS;
      } else {
        let dx = e.clientX - t.x0, dy = e.clientY - t.y0;
        const d = Math.hypot(dx, dy);
        if (d > STICK_RADIUS) {
          dx *= STICK_RADIUS / d;
          dy *= STICK_RADIUS / d;
        }
        this.stick.x = dx / STICK_RADIUS;
        this.stick.y = dy / STICK_RADIUS;
        this.hud.moveStick(dx, dy);
      }
      t.x = e.clientX;
      t.y = e.clientY;
      return;
    }
    if (this.locked) {
      this.lookX += e.movementX * MOUSE_SENS;
      this.lookY += e.movementY * MOUSE_SENS;
    } else if (this.dragging && (e.buttons & 3) !== 0) {
      this.lookX += e.movementX * DRAG_SENS;
      this.lookY += e.movementY * DRAG_SENS;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      const t = this.touches.get(e.pointerId);
      if (t?.kind === 'move') {
        this.stick.x = this.stick.y = 0;
        this.hud.hideStick();
      }
      this.touches.delete(e.pointerId);
      return;
    }
    this.dragging = false;
  };

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Movement intent this frame. */
  read(): MoveInput {
    const k = this.keys;
    const on = (...c: string[]) => c.some((x) => k.has(x));
    let forward = (on('KeyW', 'ArrowUp') ? 1 : 0) - (on('KeyS', 'ArrowDown') ? 1 : 0);
    let right = (on('KeyD', 'ArrowRight') ? 1 : 0) - (on('KeyA', 'ArrowLeft') ? 1 : 0);
    const up = (on('KeyE', 'PageUp') ? 1 : 0) - (on('KeyQ', 'PageDown') ? 1 : 0);
    const run = on('ShiftLeft', 'ShiftRight');
    if (this.stick.x !== 0 || this.stick.y !== 0) {
      // analogue stick with a small dead zone; full deflection is walking pace
      const m = Math.hypot(this.stick.x, this.stick.y);
      const s = m < 0.12 ? 0 : (m - 0.12) / 0.88;
      forward = (-this.stick.y / (m || 1)) * s;
      right = (this.stick.x / (m || 1)) * s;
    }
    if (!this.enabled) return { forward: 0, right: 0, up: 0, run: false };
    return { forward, right, up, run };
  }

  /** Accumulated look deltas (radians) since the last call. */
  consumeLook(): { x: number; y: number } {
    const r = { x: this.lookX, y: this.lookY };
    this.lookX = this.lookY = 0;
    if (!this.enabled) r.x = r.y = 0;
    return r;
  }

  get anyInput(): boolean {
    return this.keys.size > 0 || this.touches.size > 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }
}
