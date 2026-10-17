// Notes left inside a memory (contracts 7.2): fetched from GET /api/notes/:sceneId and pushed as
// {type:'note'} on /ws, drawn as floating lime sticky notes that turn to face you about the
// vertical axis, pop in with a soft sound, and stay. From the headset (or desktop) a note can be
// pinned where you point, with a few quick phrases.
//
// Also the social layer's small synthesised sound set (no audio files to load).

import * as THREE from 'three';
import { CanvasPlane, FONT, INK, LIME, LIME_HEX, ORDER, damp, redrawWhenFontsLoad, roundRect, wrapText } from './ghosts.ts';
import { fetchJson, joinUrl, localNow, NAME_MAX, type FetchLike, type V3 } from './presence-client.ts';

export interface Note {
  id: string;
  sceneId?: string;
  author: string;
  text: string;
  /** Room frame metres. */
  x: number;
  y: number;
  z: number;
  createdAt?: string;
}

export const NOTE_TEXT_MAX = 120;
/** Height above the floor when a note has none (the map sets 1.4 m). */
export const NOTE_DEFAULT_Y = 1.4;
export const QUICK_PHRASES = ['I was here', 'Best seat in the house', 'Remember this?', 'Wish you were here', 'Same time next week?'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const id = typeof n.id === 'string' || typeof n.id === 'number' ? String(n.id) : '';
  const text = typeof n.text === 'string' ? n.text.replace(/\s+/g, ' ').trim().slice(0, NOTE_TEXT_MAX) : '';
  if (!id || !text || !finite(n.x) || !finite(n.z)) return null;
  const author = typeof n.author === 'string' && n.author.trim() ? n.author.trim().slice(0, NAME_MAX) : 'Someone';
  return {
    id,
    sceneId: typeof n.sceneId === 'string' ? n.sceneId : undefined,
    author,
    text,
    x: n.x,
    y: finite(n.y) ? n.y : NOTE_DEFAULT_Y,
    z: n.z,
    createdAt: typeof n.createdAt === 'string' ? n.createdAt : undefined,
  };
}

/** `{notes:[...]}` or a bare array; bad entries are skipped, duplicates keep the first. */
export function parseNotes(raw: unknown): Note[] | null {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { notes?: unknown }).notes) ? (raw as { notes: unknown[] }).notes : null;
  if (!list) return null;
  const out: Note[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const n = parseNote(r);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

const NOTE_W = 0.42;
/** Footprint used to keep notes from overlapping (metres). */
export const NOTE_GAP = { radius: 0.4, height: 0.34 };

function timeOf(n: Note): number {
  const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Where to draw each note: at its own x, y, z, except that a note landing on an earlier one (closer
 * than NOTE_GAP) is stacked above it. Heights are kept between 0.35 and 2.6 m so every note is
 * readable from a standing eye. Deterministic: oldest first.
 */
export function placeNotes(notes: readonly Note[], gap = NOTE_GAP): Map<string, V3> {
  const order = [...notes].sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed: Array<{ id: string; p: V3 }> = [];
  const out = new Map<string, V3>();
  for (const n of order) {
    const p: V3 = [n.x, THREE.MathUtils.clamp(n.y, 0.35, 2.6), n.z];
    for (let guard = 0; guard < 12; guard++) {
      const hit = placed.find((q) => Math.hypot(q.p[0] - p[0], q.p[2] - p[2]) < gap.radius && Math.abs(q.p[1] - p[1]) < gap.height);
      if (!hit) break;
      if (hit.p[1] + gap.height + 0.02 <= 2.6) p[1] = hit.p[1] + gap.height + 0.02;
      else {
        // no room above: step sideways
        p[0] = hit.p[0] + gap.radius + 0.02;
        p[1] = THREE.MathUtils.clamp(n.y, 0.35, 2.6);
      }
    }
    placed.push({ id: n.id, p });
    out.set(n.id, p);
  }
  return out;
}

/** Overshooting ease for the pop-in (0..1 -> 0..1, peaks ~1.1). */
export function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// ---------------------------------------------------------------------------------------------
// sounds

export class SocialSounds {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  volume = 0.7;

  private onGesture = () => this.unlock();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture, { passive: true });
      window.addEventListener('keydown', this.onGesture);
    }
  }

  /** Creates or resumes the audio context; call from a user gesture (or the XR session start). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  private ready(): { c: AudioContext; out: AudioNode; t: number } | null {
    if (this.muted) return null;
    if (!this.ctx) this.unlock();
    const c = this.ctx;
    if (!c || !this.master || c.state !== 'running') return null;
    return { c, out: this.master, t: c.currentTime + 0.01 };
  }

  private tone(c: AudioContext, out: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, pan = 0): void {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = g;
    if (pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    o.connect(g);
    node.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A soft bubble pop for a new note. */
  pop(pan = 0): void {
    const r = this.ready();
    if (!r) return;
    this.tone(r.c, r.out, 'sine', 420, 940, r.t, 0.16, 0.22, pan);
    this.tone(r.c, r.out, 'sine', 1320, 1760, r.t + 0.035, 0.09, 0.05, pan);
  }

  /** The TAGGED hit: a thump, a bright blip and a little noise. */
  tag(): void {
    const r = this.ready();
    if (!r) return;
    const { c, out, t } = r;
    this.tone(c, out, 'sine', 160, 48, t, 0.32, 0.5);
    this.tone(c, out, 'square', 880, 1320, t + 0.02, 0.14, 0.07);
    this.tone(c, out, 'triangle', 1320, 1980, t + 0.09, 0.2, 0.09);
    const len = Math.floor(c.sampleRate * 0.18);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = 0.25;
    src.connect(bp).connect(g).connect(out);
    src.start(t);
  }

  roundStart(): void {
    const r = this.ready();
    if (!r) return;
    this.tone(r.c, r.out, 'triangle', 660, 660, r.t, 0.18, 0.16);
    this.tone(r.c, r.out, 'triangle', 990, 990, r.t + 0.16, 0.32, 0.18);
  }

  roundEnd(): void {
    const r = this.ready();
    if (!r) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(r.c, r.out, 'triangle', f, f, r.t + i * 0.11, 0.3, 0.15));
  }

  tick(): void {
    const r = this.ready();
    if (!r) return;
    this.tone(r.c, r.out, 'square', 1400, 1400, r.t, 0.04, 0.04);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onGesture);
      window.removeEventListener('keydown', this.onGesture);
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

// ---------------------------------------------------------------------------------------------
// network

export interface NotesClientOptions {
  baseUrl: string;
  sceneId: string;
  onList: (notes: Note[], initial: boolean) => void;
  onStatus?: (ok: boolean) => void;
  /** Whether the /ws socket is up (polls less often then). */
  socketUp?: () => boolean;
  fetchImpl?: FetchLike;
}

export class NotesClient {
  private acc = 1e9;
  private inFlight = false;
  private loaded = false;
  private failures = 0;
  private ok: boolean | null = null;
  stopped = false;

  constructor(private o: NotesClientOptions) {}

  get interval(): number {
    const base = this.o.socketUp?.() ? 6 : 2.5;
    return Math.min(20, base * (1 + Math.min(this.failures, 4)));
  }

  tick(dt: number): void {
    if (this.stopped) return;
    this.acc += Math.max(0, Math.min(dt, 0.5));
    if (this.acc < this.interval || this.inFlight) return;
    this.acc = 0;
    void this.poll();
  }

  /** Fetches now (also used when the socket reconnects). */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const res = await fetchJson(joinUrl(this.o.baseUrl, `/api/notes/${encodeURIComponent(this.o.sceneId)}`), { timeoutMs: 3000, fetchImpl: this.o.fetchImpl });
      const list = res.ok ? parseNotes(res.data) : null;
      if (list) {
        this.failures = 0;
        this.setOk(true);
        const initial = !this.loaded;
        this.loaded = true;
        this.o.onList(list, initial);
      } else {
        this.failures++;
        if (this.failures >= 2) this.setOk(false);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private setOk(ok: boolean): void {
    if (this.ok === ok) return;
    this.ok = ok;
    this.o.onStatus?.(ok);
  }

  /** POST /api/notes/:sceneId {author, text, x, y, z}; resolves with the stored note (or an error sentence). */
  async post(author: string, text: string, pos: V3): Promise<{ ok: true; note: Note } | { ok: false; error: string }> {
    const body = {
      author: author.trim().slice(0, NAME_MAX) || 'Someone',
      text: text.replace(/\s+/g, ' ').trim().slice(0, NOTE_TEXT_MAX),
      x: Math.round(pos[0] * 1000) / 1000,
      y: Math.round(pos[1] * 1000) / 1000,
      z: Math.round(pos[2] * 1000) / 1000,
    };
    if (!body.text) return { ok: false, error: 'A note needs some text.' };
    const res = await fetchJson<{ note?: unknown }>(joinUrl(this.o.baseUrl, `/api/notes/${encodeURIComponent(this.o.sceneId)}`), {
      method: 'POST',
      body,
      timeoutMs: 6000,
      fetchImpl: this.o.fetchImpl,
    });
    if (!res.ok) return { ok: false, error: res.status === 502 || res.down ? 'Notes are offline right now.' : res.error ?? 'The note was not saved.' };
    const note = parseNote(res.data?.note ?? res.data) ?? parseNote({ ...body, id: `local-${Date.now().toString(36)}`, createdAt: new Date().toISOString() });
    return note ? { ok: true, note } : { ok: false, error: 'The note was not saved.' };
  }
}

// ---------------------------------------------------------------------------------------------
// visuals

/** One sticky note: lime paper, near-black bold text, "— Author" underneath. */
export class StickyNote {
  readonly group = new THREE.Group();
  readonly plane: CanvasPlane;
  private glow: THREE.Mesh;
  private glowMat: THREE.MeshBasicMaterial;
  private unhook: () => void;
  /** Seconds since the pop-in started (negative = waiting). */
  age = 0;
  removing = 0;
  pending = false;
  readonly target = new THREE.Vector3();
  private bobPhase = Math.random() * Math.PI * 2;
  private yaw = 0;

  constructor(public note: Note, delay = 0) {
    const lines = StickyNote.measure(note.text);
    const pxH = Math.round(150 + lines * 58 + 70);
    const hm = (NOTE_W * pxH) / 512;
    this.plane = new CanvasPlane(512, pxH, NOTE_W, hm, { order: ORDER.note });
    this.plane.mesh.name = 'note';
    this.glowMat = new THREE.MeshBasicMaterial({ color: LIME_HEX, transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false, blending: THREE.AdditiveBlending });
    this.glow = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.265, 48), this.glowMat);
    this.glow.renderOrder = ORDER.note - 1;
    this.group.add(this.glow, this.plane.mesh);
    this.group.name = `note-${note.id}`;
    this.age = -delay;
    this.redraw();
    this.unhook = redrawWhenFontsLoad(() => this.redraw());
    this.group.scale.setScalar(0.001);
  }

  static measure(text: string): number {
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = `800 46px ${FONT}`;
    return Math.max(1, wrapText((s) => c.measureText(s).width, text, 512 - 84, 22, 4).length);
  }

  redraw(): void {
    const note = this.note;
    const pending = this.pending;
    this.plane.draw((g, W, H) => {
      const pad = 18;
      // soft shadow
      g.shadowColor = 'rgba(0,0,0,0.45)';
      g.shadowBlur = 22;
      g.shadowOffsetY = 8;
      roundRect(g, pad, pad, W - pad * 2, H - pad * 2 - 6, 22);
      const grad = g.createLinearGradient(0, pad, 0, H - pad);
      grad.addColorStop(0, pending ? '#a6c860' : '#d4ff63');
      grad.addColorStop(1, pending ? '#90ad55' : LIME);
      g.fillStyle = grad;
      g.fill();
      g.shadowColor = 'transparent';
      // folded corner
      g.beginPath();
      g.moveTo(W - pad - 46, H - pad - 6);
      g.lineTo(W - pad, H - pad - 52);
      g.lineTo(W - pad, H - pad - 6 - 22);
      g.arcTo(W - pad, H - pad - 6, W - pad - 22, H - pad - 6, 22);
      g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fill();
      // tape
      g.save();
      g.translate(W / 2, pad + 4);
      g.rotate(-0.04);
      g.fillStyle = 'rgba(255,255,255,0.42)';
      g.fillRect(-58, -14, 116, 30);
      g.restore();
      // text
      g.fillStyle = INK;
      g.font = `800 46px ${FONT}`;
      g.textBaseline = 'alphabetic';
      const lines = wrapText((s) => g.measureText(s).width, note.text, W - 84, 22, 4);
      let y = 104;
      for (const line of lines) {
        g.fillText(line, 42, y);
        y += 58;
      }
      g.font = `600 30px ${FONT}`;
      g.fillStyle = 'rgba(11,12,10,0.72)';
      g.fillText(`— ${note.author}`, 42, y + 14);
      if (pending) {
        g.font = `600 22px ${FONT}`;
        g.textAlign = 'right';
        g.fillText('posting…', W - 44, 58);
        g.textAlign = 'left';
      }
    });
  }

  setPending(p: boolean): void {
    if (p === this.pending) return;
    this.pending = p;
    this.redraw();
  }

  /** Every frame: pop-in, gentle bob, turn to face the viewer about +Y. Returns false once removed. */
  update(dt: number, viewer: THREE.Vector3): boolean {
    this.age += dt;
    if (this.age < 0) {
      this.group.visible = false;
      return true;
    }
    this.group.visible = true;
    const pop = easeOutBack(this.age / 0.5);
    let s = Math.max(0.001, pop);
    let fade = 1;
    if (this.removing > 0) {
      this.removing += dt;
      const f = Math.min(1, (this.removing - 1) / 0.45);
      s *= 1 - f * 0.4;
      fade = 1 - f;
      if (f >= 1) return false;
    }
    const bob = Math.sin(this.age * 1.4 + this.bobPhase) * 0.012;
    const g = this.group;
    g.position.lerp(this.target, damp(10, dt));
    g.position.y = THREE.MathUtils.lerp(g.position.y, this.target.y + bob, damp(10, dt));
    const dx = viewer.x - g.position.x, dz = viewer.z - g.position.z;
    const want = Math.atan2(dx, dz);
    const d = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    this.yaw += d * damp(this.age < 0.6 ? 30 : 6, dt);
    g.rotation.set(0, this.yaw, Math.sin(this.age * 9) * 0.12 * Math.max(0, 1 - this.age / 0.8));
    // a little bigger far away, so a note across the room is still readable
    const dist = Math.hypot(dx, dz, viewer.y - g.position.y);
    s *= THREE.MathUtils.clamp(0.85 + dist * 0.09, 1, 1.7);
    g.scale.setScalar(s);
    this.plane.opacity = (this.pending ? 0.75 : 1) * fade;
    // arrival ring
    const ring = Math.max(0, Math.min(1, this.age / 0.8));
    this.glowMat.opacity = (1 - ring) * (1 - ring) * 0.7 * fade;
    this.glow.scale.setScalar(1 + ring * 0.6);
    this.glow.visible = ring < 1;
    return true;
  }

  remove(): void {
    if (!this.removing) this.removing = 1;
  }

  dispose(): void {
    this.unhook();
    this.plane.dispose();
    this.glow.geometry.dispose();
    this.glowMat.dispose();
    this.group.removeFromParent();
  }
}

/** All notes in this world. */
export class NotesLayer {
  readonly group = new THREE.Group();
  private items = new Map<string, { view: StickyNote; addedAt: number }>();
  private notes = new Map<string, Note>();
  /** Called for every note that arrives after the first load (sound, toast). */
  onArrive: (n: Note, position: THREE.Vector3) => void = () => undefined;

  constructor() {
    this.group.name = 'social-notes';
  }

  get count(): number {
    return this.notes.size;
  }

  has(id: string): boolean {
    return this.notes.has(id);
  }

  /** A full list from GET: adds new notes, drops ones that are gone (unless just added). */
  sync(list: Note[], initial: boolean, now = localNow()): void {
    const ids = new Set(list.map((n) => n.id));
    let stagger = 0;
    for (const n of list) {
      if (this.notes.has(n.id)) continue;
      this.add(n, initial ? { delay: 0.25 + stagger++ * 0.12, quiet: true } : {}, now);
    }
    for (const [id, it] of this.items) {
      if (!ids.has(id) && !it.view.pending && now - it.addedAt > 8) this.delete(id);
    }
  }

  /** One note (WebSocket push or a note we just posted). */
  add(n: Note, opts: { delay?: number; quiet?: boolean; pending?: boolean } = {}, now = localNow()): StickyNote | null {
    if (!opts.pending && !this.items.has(n.id)) {
      // our own note coming back over the socket before the POST answered: it is the placeholder
      for (const [id, it] of this.items) {
        if (it.view.pending && it.view.note.text === n.text && it.view.note.author === n.author) {
          this.confirm(id, n);
          return this.items.get(n.id)?.view ?? null;
        }
      }
    }
    const existing = this.items.get(n.id);
    if (existing) {
      existing.view.note = n;
      this.notes.set(n.id, n);
      existing.view.setPending(!!opts.pending);
      this.layout();
      return existing.view;
    }
    this.notes.set(n.id, n);
    const view = new StickyNote(n, opts.delay ?? 0);
    view.setPending(!!opts.pending);
    this.items.set(n.id, { view, addedAt: now });
    this.group.add(view.group);
    this.layout(n.id);
    if (!opts.quiet && !opts.pending) this.onArrive(n, view.target);
    return view;
  }

  /** Replaces a placeholder (posting) note with the stored one. */
  confirm(tempId: string, stored: Note): void {
    const it = this.items.get(tempId);
    this.items.delete(tempId);
    this.notes.delete(tempId);
    if (!it) {
      this.add(stored);
      return;
    }
    if (this.items.has(stored.id)) {
      // the socket brought the stored note first: let the placeholder go
      it.view.remove();
      this.items.set(`${tempId}#leaving`, it);
      this.layout();
      return;
    }
    it.view.note = stored;
    it.view.setPending(false);
    it.view.redraw();
    this.items.set(stored.id, { view: it.view, addedAt: localNow() });
    this.notes.set(stored.id, stored);
    this.layout();
  }

  delete(id: string): void {
    const it = this.items.get(id);
    this.notes.delete(id);
    it?.view.remove();
  }

  private layout(fresh?: string): void {
    const pos = placeNotes([...this.notes.values()]);
    for (const [id, it] of this.items) {
      const p = pos.get(id);
      if (!p) continue;
      it.view.target.set(p[0], p[1], p[2]);
      if (id === fresh) it.view.group.position.copy(it.view.target);
    }
  }

  update(dt: number, viewer: THREE.Vector3): void {
    for (const [id, it] of this.items) {
      if (!it.view.update(dt, viewer)) {
        it.view.dispose();
        this.items.delete(id);
      }
    }
  }

  /** Where a note is drawn (tests, debugging). */
  positionOf(id: string): THREE.Vector3 | null {
    return this.items.get(id)?.view.target.clone() ?? null;
  }

  dispose(): void {
    for (const it of this.items.values()) it.view.dispose();
    this.items.clear();
    this.notes.clear();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------------------------
// creating a note

export interface SolidQuery {
  solidAt(x: number, y: number, z: number): boolean;
}

/**
 * Where a note pointed at from `origin` along `dir` should go: just in front of the first solid
 * cell within `max` metres, else `fallback` metres along the ray. Heights stay readable.
 */
export function aimNoteTarget(origin: THREE.Vector3, dir: THREE.Vector3, world: SolidQuery | null, max = 6, fallback = 1.6): { point: THREE.Vector3; hit: boolean } {
  const d = dir.clone().normalize();
  let hitAt = -1;
  if (world) {
    const p = new THREE.Vector3();
    for (let s = 0.25; s <= max; s += 0.04) {
      p.copy(origin).addScaledVector(d, s);
      if (p.y < -0.05) {
        hitAt = s;
        break;
      }
      if (world.solidAt(p.x, p.y, p.z)) {
        hitAt = s;
        break;
      }
    }
  }
  const dist = hitAt > 0 ? Math.max(0.3, hitAt - 0.16) : fallback;
  const point = origin.clone().addScaledVector(d, dist);
  point.y = THREE.MathUtils.clamp(point.y, 0.45, 2.4);
  return { point, hit: hitAt > 0 };
}

/** Where the note will go: a dashed lime card with a pulsing ring, and a beam from the hand. */
class AimMarker {
  readonly group = new THREE.Group();
  private card = new CanvasPlane(384, 256, 0.3, 0.2, { order: ORDER.burst });
  private ringMat = new THREE.MeshBasicMaterial({ color: LIME_HEX, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  private ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.185, 48), this.ringMat);
  private beamMat = new THREE.MeshBasicMaterial({ color: LIME_HEX, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, toneMapped: false });
  private beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), this.beamMat);
  private t = 0;

  constructor() {
    for (const m of [this.ring, this.beam]) {
      m.renderOrder = ORDER.burst;
      m.frustumCulled = false;
    }
    this.card.draw((g, W, H) => {
      roundRect(g, 8, 8, W - 16, H - 16, 26);
      g.fillStyle = 'rgba(198,255,61,0.22)';
      g.fill();
      g.setLineDash([22, 14]);
      g.lineWidth = 8;
      g.strokeStyle = LIME;
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = LIME;
      g.font = `800 64px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('+', W / 2, H / 2 - 30);
      g.font = `800 38px ${FONT}`;
      g.fillText('NOTE HERE', W / 2, H / 2 + 42);
    });
    this.group.add(this.card.mesh, this.ring);
    this.group.visible = false;
    this.beam.visible = false;
  }

  get beamLine(): THREE.Object3D {
    return this.beam;
  }

  show(at: THREE.Vector3, viewer: THREE.Vector3, dt: number, from?: THREE.Vector3): void {
    this.t += dt;
    this.group.visible = true;
    this.card.opacity = 1;
    this.group.position.copy(at);
    // face the viewer about the vertical axis, like the notes do
    this.group.rotation.set(0, Math.atan2(viewer.x - at.x, viewer.z - at.z), 0);
    // keep a readable size far away
    this.group.scale.setScalar(THREE.MathUtils.clamp(viewer.distanceTo(at) / 1.6, 1, 2.4));
    this.ring.scale.setScalar(1 + 0.1 * Math.sin(this.t * 6));
    if (from) {
      const d = at.clone().sub(from);
      this.beam.position.copy(from);
      this.beam.lookAt(at);
      this.beam.scale.set(1, 1, Math.max(0.01, d.length()));
      this.beam.visible = true;
    } else this.beam.visible = false;
  }

  hide(): void {
    this.group.visible = false;
    this.beam.visible = false;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.beam.removeFromParent();
    this.card.dispose();
    this.ring.geometry.dispose();
    this.beam.geometry.dispose();
    this.ringMat.dispose();
    this.beamMat.dispose();
  }
}

/** The phrase picker shown in the headset where the note will go. */
class PhrasePicker {
  readonly plane: CanvasPlane;
  private buttons: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }> = [];
  hover: string | null = null;
  status: { text: string; kind: 'info' | 'error' } | null = null;
  private dirty = true;

  constructor(private phrases: string[]) {
    this.plane = new CanvasPlane(768, 640, 0.48, 0.4, { order: ORDER.hud });
    this.plane.mesh.name = 'note-picker';
    redrawWhenFontsLoad(() => {
      this.dirty = true;
      this.redraw();
    });
  }

  setHover(id: string | null): void {
    if (id !== this.hover) {
      this.hover = id;
      this.dirty = true;
    }
  }

  setStatus(s: PhrasePicker['status']): void {
    this.status = s;
    this.dirty = true;
  }

  hit(local: THREE.Vector3): string | null {
    const px = (local.x / this.plane.width + 0.5) * this.plane.canvas.width;
    const py = (0.5 - local.y / this.plane.height) * this.plane.canvas.height;
    for (const b of this.buttons) if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
    return null;
  }

  redraw(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.plane.draw((g, W, H) => {
      roundRect(g, 6, 6, W - 12, H - 12, 34);
      g.fillStyle = 'rgba(12,13,11,0.94)';
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = LIME;
      g.stroke();
      g.fillStyle = LIME;
      g.font = `800 40px ${FONT}`;
      g.fillText('Leave a note here', 40, 72);
      g.fillStyle = 'rgba(244,247,236,0.6)';
      g.font = `500 24px ${FONT}`;
      g.fillText(this.status ? '' : 'Point and pull the trigger · grip again for “I was here”', 40, 110);
      this.buttons = [];
      const list = this.phrases.slice(0, 4);
      const bw = (W - 80 - 20) / 2, bh = 112;
      list.forEach((p, i) => {
        const x = 40 + (i % 2) * (bw + 20), y = 140 + Math.floor(i / 2) * (bh + 18);
        this.buttons.push({ id: `p${i}`, label: p, x, y, w: bw, h: bh });
        const hov = this.hover === `p${i}`;
        roundRect(g, x, y, bw, bh, 22);
        g.fillStyle = hov ? LIME : 'rgba(255,255,255,0.08)';
        g.fill();
        g.fillStyle = hov ? INK : '#f4f7ec';
        g.font = `700 32px ${FONT}`;
        const lines = wrapText((s) => g.measureText(s).width, p, bw - 40, 18, 2);
        lines.forEach((ln, k) => g.fillText(ln, x + 22, y + (lines.length === 1 ? 68 : 48 + k * 38)));
      });
      const cy = 140 + 2 * (bh + 18);
      this.buttons.push({ id: 'cancel', label: 'Cancel', x: 40, y: cy, w: W - 80, h: 84 });
      roundRect(g, 40, cy, W - 80, 84, 22);
      g.fillStyle = this.hover === 'cancel' ? 'rgba(255,109,94,0.9)' : 'rgba(255,255,255,0.05)';
      g.fill();
      g.fillStyle = this.hover === 'cancel' ? INK : 'rgba(244,247,236,0.75)';
      g.font = `700 30px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('Cancel', W / 2, cy + 54);
      g.textAlign = 'left';
      if (this.status) {
        g.fillStyle = this.status.kind === 'error' ? '#ff8a7a' : LIME;
        g.font = `700 26px ${FONT}`;
        g.fillText(this.status.text, 40, 112);
      }
    });
  }

  phrase(id: string): string | null {
    const b = this.buttons.find((x) => x.id === id);
    return b && id !== 'cancel' ? b.label : null;
  }

  dispose(): void {
    this.plane.dispose();
  }
}

/** Controller input for one frame, prepared by the social layer from the XR session. */
export interface XrPointer {
  /** Target-ray space of the pointing controller (world matrix up to date). */
  ray: THREE.Object3D;
  /** Edge-detected buttons of that controller. */
  pressed(button: number): boolean;
  released(button: number): boolean;
  held(button: number): boolean;
}

export interface ComposerHost {
  scene: THREE.Object3D;
  camera: THREE.Camera;
  world(): SolidQuery | null;
  /** Head position (world). */
  head(): THREE.Vector3;
  author(): string;
  post(text: string, pos: V3): Promise<boolean>;
  notify(title: string, body?: string, kind?: 'info' | 'error' | 'ok'): void;
  /** Releases desktop pointer lock while the dialog is open. */
  releasePointer?(): void;
}

type ComposerState = 'idle' | 'aiming' | 'choosing' | 'posting';

/** Pin a note where you point: grip (headset) or N (desktop). */
export class NoteComposer {
  state: ComposerState = 'idle';
  private marker = new AimMarker();
  private picker: PhrasePicker;
  private target = new THREE.Vector3();
  private openedAt = new THREE.Vector3();
  private stateT = 0;
  private raycaster = new THREE.Raycaster();
  private dialog: HTMLElement | null = null;
  /** Controller button that aims and confirms (1 = grip / squeeze). */
  aimButton = 1;
  selectButton = 0;

  constructor(private host: ComposerHost, private phrases: string[] = QUICK_PHRASES) {
    this.picker = new PhrasePicker(phrases);
    this.picker.plane.opacity = 0;
    host.scene.add(this.marker.group, this.marker.beamLine, this.picker.plane.mesh);
  }

  get busy(): boolean {
    return this.state !== 'idle';
  }

  /** XR: call every frame while presenting. */
  updateXr(dt: number, pointer: XrPointer | null): void {
    this.stateT += dt;
    const head = this.host.head();
    if (!pointer) {
      if (this.state === 'aiming') this.cancel();
    } else if (this.state === 'idle') {
      if (pointer.pressed(this.aimButton)) this.setState('aiming');
    } else if (this.state === 'aiming') {
      const { origin, dir } = rayOf(pointer.ray);
      const aim = aimNoteTarget(origin, dir, this.host.world(), 4.5);
      this.target.lerp(aim.point, this.stateT < 0.05 ? 1 : damp(25, dt));
      this.marker.show(this.target, head, dt, origin);
      if (pointer.released(this.aimButton) || !pointer.held(this.aimButton)) this.openPicker(head);
    } else if (this.state === 'choosing') {
      this.marker.show(this.target, head, dt);
      const { origin, dir } = rayOf(pointer.ray);
      this.raycaster.set(origin, dir);
      const hit = this.raycaster.intersectObject(this.picker.plane.mesh, false)[0];
      const id = hit ? this.picker.hit(this.picker.plane.mesh.worldToLocal(hit.point.clone())) : null;
      this.picker.setHover(id);
      if (pointer.pressed(this.selectButton) && id) {
        if (id === 'cancel') this.cancel();
        else void this.submit(this.picker.phrase(id) ?? this.phrases[0]);
      } else if (pointer.pressed(this.aimButton)) void this.submit(this.phrases[0]);
      // walked away or forgot about it
      else if (this.stateT > 12 || head.distanceTo(this.openedAt) > 2.5) this.cancel();
    }
    this.animatePicker(dt, head);
  }

  /** Desktop: every frame (keeps the preview pin alive). */
  updateDesktop(dt: number): void {
    this.stateT += dt;
    if (this.state === 'choosing' || this.state === 'posting') this.marker.show(this.target, this.host.head(), dt);
    this.animatePicker(dt, this.host.head());
  }

  private animatePicker(dt: number, head: THREE.Vector3): void {
    const want = this.dialog ? 0 : this.state === 'choosing' || this.state === 'posting' ? 1 : 0;
    const p = this.picker.plane;
    const o = p.opacity + (want - p.opacity) * damp(want ? 14 : 10, dt);
    p.opacity = o < 0.01 && !want ? 0 : o;
    if (p.mesh.visible) {
      p.mesh.scale.setScalar(0.85 + 0.15 * o);
      this.picker.redraw();
    }
    if (this.state === 'idle' || !this.marker.group.visible) return;
    void head;
  }

  private setState(s: ComposerState): void {
    this.state = s;
    this.stateT = 0;
  }

  private openPicker(head: THREE.Vector3): void {
    this.setState('choosing');
    this.openedAt.copy(head);
    this.picker.setStatus(null);
    this.picker.setHover(null);
    // between the head and the pin, facing the head, a little below eye level
    const p = this.picker.plane.mesh;
    const toPin = this.target.clone().sub(head);
    const dist = toPin.length();
    const at = head.clone().addScaledVector(toPin.normalize(), Math.min(0.95, Math.max(0.5, dist - 0.3)));
    at.y = Math.min(at.y, head.y - 0.12);
    p.position.copy(at);
    p.lookAt(head);
  }

  /** Desktop: opens the note dialog for the spot in front of the camera. */
  openDesktop(): void {
    if (this.state !== 'idle') return;
    this.host.releasePointer?.();
    const cam = this.host.camera;
    cam.updateMatrixWorld();
    const { origin, dir } = rayOf(cam);
    this.target.copy(aimNoteTarget(origin, dir, this.host.world(), 4.5).point);
    this.setState('choosing');
    this.showDialog();
  }

  private showDialog(): void {
    this.closeDialog();
    const el = document.createElement('div');
    el.className = 'dvs-note-dialog';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Leave a note');
    const title = document.createElement('div');
    title.className = 'dvs-note-dialog__title';
    title.textContent = 'Leave a note here';
    const chips = document.createElement('div');
    chips.className = 'dvs-note-dialog__chips';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = NOTE_TEXT_MAX;
    input.placeholder = 'Write something, or pick one';
    input.className = 'dvs-note-dialog__input';
    for (const p of this.phrases) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dvs-chip';
      b.textContent = p;
      b.addEventListener('click', () => void this.submit(p));
      chips.append(b);
    }
    const row = document.createElement('div');
    row.className = 'dvs-note-dialog__row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dvs-btn dvs-btn--ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    const post = document.createElement('button');
    post.type = 'button';
    post.className = 'dvs-btn';
    post.textContent = 'Post note';
    post.addEventListener('click', () => void this.submit(input.value || this.phrases[0]));
    row.append(cancel, post);
    const status = document.createElement('div');
    status.className = 'dvs-note-dialog__status';
    el.append(title, chips, input, status, row);
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.submit(input.value || this.phrases[0]);
      else if (e.key === 'Escape') this.cancel();
    });
    document.body.append(el);
    this.dialog = el;
    setTimeout(() => input.focus(), 30);
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  private dialogStatus(text: string, kind: 'info' | 'error'): void {
    const s = this.dialog?.querySelector('.dvs-note-dialog__status');
    if (s) {
      s.textContent = text;
      s.classList.toggle('is-error', kind === 'error');
    }
  }

  private async submit(text: string): Promise<void> {
    if (this.state === 'posting') return;
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_TEXT_MAX);
    if (!clean) return;
    this.setState('posting');
    this.picker.setStatus({ text: 'Posting…', kind: 'info' });
    this.dialogStatus('Posting…', 'info');
    const pos: V3 = [this.target.x, this.target.y, this.target.z];
    let ok = false;
    try {
      ok = await this.host.post(clean, pos);
    } catch {
      ok = false;
    }
    if (ok) {
      this.closeDialog();
      this.marker.hide();
      this.setState('idle');
      return;
    }
    this.picker.setStatus({ text: 'Notes are offline right now', kind: 'error' });
    this.dialogStatus('Notes are offline right now. Try again in a moment.', 'error');
    if (!this.dialog) {
      setTimeout(() => {
        if (this.state === 'posting') this.cancel();
      }, 1600);
    } else this.setState('choosing');
  }

  cancel(): void {
    this.closeDialog();
    this.marker.hide();
    this.picker.setHover(null);
    this.setState('idle');
  }

  dispose(): void {
    this.cancel();
    this.marker.dispose();
    this.picker.dispose();
  }
}

function rayOf(obj: THREE.Object3D): { origin: THREE.Vector3; dir: THREE.Vector3 } {
  obj.updateMatrixWorld();
  const origin = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(obj.matrixWorld);
  return { origin, dir };
}
