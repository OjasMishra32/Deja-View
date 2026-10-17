// DOM overlay: loader, title, buttons, help card, video transport, toasts, touch joystick.

import type { SceneMode } from '../../../shared/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type ToastKind = 'info' | 'error' | 'ok';

export interface HudHandlers {
  onEnterVr?: () => void;
  onPlayToggle?: () => void;
  onSeek?: (fraction: number) => void;
  onMute?: () => void;
}

const MODE_LABEL: Record<SceneMode, string> = {
  rentfree: 'Rent Free',
  thirdwheel: 'Third Wheel',
  reconstruct: 'Reconstruct',
  sample: 'Sample',
};

export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class Hud {
  readonly root = $('tw-hud');
  private loader = $('tw-loader');
  private fill = $('tw-progress-fill');
  private bar = this.loader.querySelector('.tw-progress') as HTMLElement;
  private percent = $('tw-percent');
  private stageText = $('tw-stage-text');
  private note = $('tw-loader-note');
  private help = $('tw-help');
  private hint = $('tw-hint');
  private coach = $('tw-coach');
  private stick = $('tw-stick');
  private knob = $('tw-stick-knob');
  private motion = $('tw-motion');
  private motionText = $('tw-motion-text');
  private perf = $('tw-perf');
  private transport = $('tw-transport');
  private play = $('tw-btn-play');
  private scrub = $<HTMLInputElement>('tw-scrub');
  private time = $('tw-time');
  private duration = $('tw-duration');
  private mute = $('tw-btn-mute');
  private vr = $<HTMLButtonElement>('tw-btn-vr');
  private toasts = $('tw-toasts');
  private scrubbing = false;
  private idleTimer = 0;
  handlers: HudHandlers = {};

  constructor() {
    $('tw-btn-help').addEventListener('click', () => this.toggleHelp());
    $('tw-help-close').addEventListener('click', () => this.toggleHelp(false));
    $('tw-btn-full').addEventListener('click', () => this.toggleFullscreen());
    this.vr.addEventListener('click', () => this.handlers.onEnterVr?.());
    this.play.addEventListener('click', () => this.handlers.onPlayToggle?.());
    this.mute.addEventListener('click', () => this.handlers.onMute?.());
    this.scrub.addEventListener('input', () => {
      this.scrubbing = true;
      this.setScrubFill(Number(this.scrub.value) / 1000);
      this.handlers.onSeek?.(Number(this.scrub.value) / 1000);
    });
    this.scrub.addEventListener('change', () => {
      this.scrubbing = false;
      this.scrub.blur();
    });
    // keep keyboard shortcuts working after clicking a HUD button
    for (const b of this.root.querySelectorAll('button')) b.addEventListener('mouseup', () => (b as HTMLButtonElement).blur());
    if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) document.body.classList.add('is-touch');
    const wake = () => this.wake();
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('keydown', wake);
  }

  get isTouch(): boolean {
    return document.body.classList.contains('is-touch');
  }

  // ---------- loader ----------
  setLoaderTitle(name: string, mode?: SceneMode): void {
    $('tw-loader-name').textContent = name;
    $('tw-loader-mode').textContent = mode ? MODE_LABEL[mode] ?? mode : 'ThirdWheel';
  }

  setProgress(stage: string, fraction: number | null, note?: string): void {
    this.stageText.textContent = stage;
    this.loader.classList.toggle('is-indeterminate', fraction === null);
    if (fraction !== null) {
      const p = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      this.fill.style.width = `${p}%`;
      this.percent.textContent = `${p}%`;
      this.bar.setAttribute('aria-valuenow', String(p));
    } else {
      this.percent.textContent = '';
    }
    if (note !== undefined) this.note.textContent = note;
  }

  loaderError(stage: string, message: string, link?: { href: string; label: string }): void {
    this.root.classList.add('is-loading');
    this.loader.classList.add('is-error');
    this.loader.classList.remove('is-indeterminate');
    this.stageText.textContent = stage;
    this.percent.textContent = 'Error';
    this.note.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      this.note.append(' ', a);
    }
  }

  finishLoading(): void {
    this.root.classList.remove('is-loading');
  }

  // ---------- identity ----------
  setScene(name: string, mode: SceneMode, caption?: string): void {
    $('tw-name').textContent = name;
    $('tw-mode').textContent = MODE_LABEL[mode] ?? mode;
    if (caption) $('tw-name').title = caption;
    document.title = `${name} · ThirdWheel`;
  }

  // ---------- buttons ----------
  showVr(show: boolean, enabled = true): void {
    this.vr.hidden = !show;
    this.vr.disabled = !enabled;
  }

  setVrLabel(text: string): void {
    const span = this.vr.querySelector('span');
    if (span) span.textContent = text;
  }

  toggleHelp(force?: boolean): void {
    const show = force ?? this.help.hidden;
    this.help.hidden = !show;
    $('tw-btn-help').classList.toggle('is-active', show);
    if (!show) {
      try {
        localStorage.setItem('tw.help.seen', '1');
      } catch {
        /* storage may be unavailable */
      }
    }
  }

  get helpVisible(): boolean {
    return !this.help.hidden;
  }

  helpSeen(): boolean {
    try {
      return localStorage.getItem('tw.help.seen') === '1';
    } catch {
      return false;
    }
  }

  setHint(visible: boolean): void {
    this.hint.hidden = !visible || this.isTouch;
  }

  setCoach(visible: boolean): void {
    this.coach.hidden = !visible;
  }

  setFly(fly: boolean): void {
    this.motion.classList.toggle('is-fly', fly);
    this.motionText.textContent = fly ? 'Flying · Q/E' : 'Walking';
  }

  setPerf(text: string | null): void {
    this.perf.hidden = text === null;
    if (text !== null) this.perf.textContent = text;
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  private wake(): void {
    this.root.classList.remove('is-idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.root.classList.add('is-idle'), 4500);
  }

  // ---------- video ----------
  showTransport(show: boolean, hasAudio = true): void {
    this.transport.hidden = !show;
    this.root.classList.toggle('has-transport', show);
    this.mute.hidden = !show || !hasAudio;
  }

  setPlaying(playing: boolean, waiting = false): void {
    this.play.classList.toggle('is-playing', playing);
    this.play.classList.toggle('is-waiting', waiting && !playing);
    this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setMuted(muted: boolean): void {
    this.mute.classList.toggle('is-muted', muted);
    this.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  setTime(current: number, total: number): void {
    this.time.textContent = formatTime(current);
    this.duration.textContent = formatTime(total);
    if (!this.scrubbing && total > 0) {
      const f = Math.min(1, current / total);
      this.scrub.value = String(Math.round(f * 1000));
      this.setScrubFill(f);
    }
  }

  private setScrubFill(f: number): void {
    this.scrub.style.setProperty('--p', `${(f * 100).toFixed(2)}%`);
  }

  // ---------- touch joystick ----------
  showStick(x: number, y: number): void {
    this.stick.hidden = false;
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.knob.style.transform = 'translate(0px, 0px)';
  }

  moveStick(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  hideStick(): void {
    this.stick.hidden = true;
  }

  // ---------- toasts ----------
  toast(title: string, body = '', kind: ToastKind = 'info', ms = kind === 'error' ? 9000 : 4500): void {
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
    const close = document.createElement('button');
    close.className = 'tw-toast__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    el.append(bar, text, close);
    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    };
    close.addEventListener('click', remove);
    this.toasts.append(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    if (ms > 0) setTimeout(remove, ms);
  }
}
