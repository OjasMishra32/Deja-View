// Other people in the world: Roblox players, other headsets and browser viewers as stylised
// glowing avatars with a lime outline and a floating name tag. Positions arrive at 4 Hz and are
// drawn about 0.32 s in the past, interpolated between samples (yaw the short way round), so
// nobody ever teleports; people fade when they go quiet and fade out when they leave.
//
// Also home of the small canvas/colour helpers the rest of the social layer draws with.

import * as THREE from 'three';
import { ClockSync, wrapAngle, type Person, type PersonKind, type PresenceSnapshot, type V3 } from './presence-client.ts';

// ---------------------------------------------------------------------------------------------
// look

export const LIME = '#C6FF3D';
export const LIME_HEX = 0xc6ff3d;
export const INK = '#0b0c0a';
export const KIND_COLOR: Record<PersonKind, number> = {
  vr: 0xc6ff3d,
  roblox: 0xff4f9a,
  web: 0x63e3ff,
};
export const KIND_LABEL: Record<PersonKind, string> = { vr: 'VR', roblox: 'ROBLOX', web: 'WEB' };
export const FONT = '"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
export const MONO = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Render order bands: after the splats, before the head veil (10000). */
export const ORDER = { ghost: 700, ghostOutline: 701, label: 760, note: 740, burst: 900, hud: 980 } as const;

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/**
 * Greedy word wrap by measured width (and at most `maxChars` per line); long words are split.
 * Returns at most `maxLines` lines, the last one ellipsised when text was cut.
 */
export function wrapText(measure: (s: string) => number, text: string, maxWidth: number, maxChars = 22, maxLines = 6): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const fits = (s: string) => s.length <= maxChars && measure(s) <= maxWidth;
  for (let w of words) {
    while (!fits(w) && w.length > 1) {
      // split an over-long word
      let k = w.length - 1;
      while (k > 1 && !fits(w.slice(0, k) + '-')) k--;
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(w.slice(0, k) + '-');
      w = w.slice(k);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    let last = cut[maxLines - 1];
    while (last.length > 1 && !fits(last + '…')) last = last.slice(0, -1);
    cut[maxLines - 1] = last.replace(/[\s-]+$/, '') + '…';
    return cut;
  }
  return lines;
}

const redrawers = new Set<() => void>();
let fontsHooked = false;
/** Calls `fn` again once the web fonts have loaded (canvas text drawn earlier used a fallback). */
export function redrawWhenFontsLoad(fn: () => void): () => void {
  redrawers.add(fn);
  if (!fontsHooked && typeof document !== 'undefined' && document.fonts?.ready) {
    fontsHooked = true;
    void document.fonts.ready.then(() => {
      for (const f of redrawers) {
        try {
          f();
        } catch {
          /* disposed */
        }
      }
    });
  }
  return () => redrawers.delete(fn);
}

/** A canvas-textured plane (metres) for in-world UI. */
export class CanvasPlane {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  readonly mesh: THREE.Mesh;

  constructor(pxW: number, pxH: number, readonly width: number, readonly height: number, opts: { depthTest?: boolean; order?: number } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.renderOrder = opts.order ?? ORDER.hud;
    this.mesh.frustumCulled = false;
  }

  draw(fn: (g: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const g = this.ctx;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.save();
    fn(g, this.canvas.width, this.canvas.height);
    g.restore();
    this.texture.needsUpdate = true;
  }

  set opacity(o: number) {
    this.material.opacity = Math.max(0, Math.min(1, o));
    this.mesh.visible = o > 0.004;
  }

  get opacity(): number {
    return this.material.opacity;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// pure motion logic

export interface PoseSample {
  /** Server seconds when the server heard this pose. */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  head: V3 | null;
  hands: [V3, V3] | null;
}

/** How far in the past others are drawn (contracts 3.4: 0.3 to 0.35 s). */
export const INTERP_DELAY = 0.32;
/** How far past the newest sample motion is continued before holding still. */
export const MAX_EXTRAPOLATION = 0.25;
const MAX_SPEED = 7;
const KEEP = 24;

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Interpolates angles the short way round. */
export function lerpAngle(a: number, b: number, f: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return wrapAngle(a + d * f);
}

function lerpV(a: V3 | null, b: V3 | null, f: number): V3 | null {
  if (a && b) return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
  return f < 0.5 ? a ?? b : b ?? a;
}

/**
 * Opacity for someone the server last heard from `age` seconds ago: full while they stream
 * normally, easing down to 0.3 by 3 s (the server drops people after 3 s of silence).
 */
export function staleAlpha(age: number): number {
  if (!(age > 1.0)) return 1;
  const f = Math.min(1, (age - 1.0) / 2.0);
  const e = f * f * (3 - 2 * f);
  return 1 - 0.7 * e;
}

/** Frame-rate independent smoothing factor for rate `k` (1/s). */
export function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * Math.max(0, dt));
}

/** A person's recent poses, sampled at any time between and a little past them. */
export class PoseTrack {
  readonly samples: PoseSample[] = [];

  get newest(): PoseSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /** Adds a sample in time order. Duplicates (same time) are dropped; a jump back in time restarts the track. */
  push(s: PoseSample): boolean {
    const last = this.newest;
    if (last) {
      if (Math.abs(s.t - last.t) < 1e-3) return false;
      if (s.t < last.t) {
        // out of order by a little: drop it; by a lot (server restart): start over
        if (last.t - s.t < 2) return false;
        this.samples.length = 0;
      }
    }
    this.samples.push(s);
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
    return true;
  }

  /** How fast the person really moves (m/s, horizontal), from the newest samples; 0 when unknown. */
  speed(): number {
    const s = this.samples;
    let best = 0;
    // the newest two spans, so one dropped sample does not read as standing still
    for (let i = s.length - 1; i > 0 && i >= s.length - 2; i--) {
      const span = s[i].t - s[i - 1].t;
      if (span > 0.04 && span < 1.5) best = Math.max(best, Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z) / span);
    }
    return Math.min(best, MAX_SPEED);
  }

  /** The pose at server time `t` (interpolated, briefly extrapolated, else held). */
  at(t: number, out?: PoseSample): PoseSample | null {
    const s = this.samples;
    const n = s.length;
    if (!n) return null;
    const o = out ?? { t, x: 0, y: 0, z: 0, yaw: 0, head: null, hands: null };
    o.t = t;
    if (n === 1 || t <= s[0].t) return copy(s[t <= s[0].t ? 0 : n - 1], o, t);
    const last = s[n - 1];
    if (t >= last.t) {
      const prev = s[n - 2];
      const span = last.t - prev.t;
      const dt = Math.min(t - last.t, MAX_EXTRAPOLATION);
      copy(last, o, t);
      if (span > 0.04 && span < 1.2 && dt > 0) {
        let vx = (last.x - prev.x) / span, vy = (last.y - prev.y) / span, vz = (last.z - prev.z) / span;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > MAX_SPEED) {
          vx *= MAX_SPEED / sp;
          vy *= MAX_SPEED / sp;
          vz *= MAX_SPEED / sp;
        }
        // ease the continuation out so a stop does not overshoot much
        const k = dt * (1 - dt / (2 * MAX_EXTRAPOLATION));
        o.x += vx * k;
        o.y += vy * k;
        o.z += vz * k;
        if (o.head) o.head = [o.head[0] + vx * k, o.head[1] + vy * k, o.head[2] + vz * k];
      }
      return o;
    }
    // binary search the bracket
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = s[lo], b = s[hi];
    const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
    o.x = lerp(a.x, b.x, f);
    o.y = lerp(a.y, b.y, f);
    o.z = lerp(a.z, b.z, f);
    o.yaw = lerpAngle(a.yaw, b.yaw, f);
    o.head = lerpV(a.head, b.head, f);
    if (a.hands && b.hands) o.hands = [lerpV(a.hands[0], b.hands[0], f)!, lerpV(a.hands[1], b.hands[1], f)!];
    else o.hands = f < 0.5 ? a.hands : b.hands;
    return o;
  }
}

function copy(src: PoseSample, o: PoseSample, t: number): PoseSample {
  o.t = t;
  o.x = src.x;
  o.y = src.y;
  o.z = src.z;
  o.yaw = src.yaw;
  o.head = src.head ? [...src.head] as V3 : null;
  o.hands = src.hands ? [[...src.hands[0]] as V3, [...src.hands[1]] as V3] : null;
  return o;
}

/** Head position for a pose: the given eye position, else feet + 1.6 m. */
export function headOf(p: { x: number; y: number; z: number; head?: V3 | null }): V3 {
  return p.head ?? [p.x, p.y + 1.6, p.z];
}

// ---------------------------------------------------------------------------------------------
// visuals

const bodyVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
// translucent body in the person's colour, a crisp lime outline where the surface turns away
// (no extra outline mesh, so nothing bleeds through the glass), soft scanlines, fading at the feet
const bodyFrag = /* glsl */ `
  uniform vec3 color;
  uniform vec3 lime;
  uniform float opacity;
  uniform float time;
  uniform float floorY;
  uniform float edgeWidth;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 v = normalize(cameraPosition - vW);
    float ndv = abs(dot(normalize(vN), v));
    float fr = 1.0 - ndv;
    float edge = smoothstep(1.0 - edgeWidth - 0.07, 1.0 - edgeWidth, fr);
    float scan = 0.5 + 0.5 * sin(vW.y * 46.0 - time * 2.4);
    vec3 core = color * (0.62 + 0.18 * scan) + color * pow(fr, 1.5) * 0.7;
    vec3 c = mix(core, lime * 1.1, edge);
    float feet = smoothstep(floorY + 0.03, floorY + 0.6, vW.y);
    float a = mix(0.5 + 0.35 * pow(fr, 1.5), 1.0, edge) * opacity * mix(0.3, 1.0, feet);
    gl_FragColor = vec4(c, a);
  }`;
// a soft lime halo just outside the silhouette (additive, so it never darkens what is behind)
const glowVert = /* glsl */ `
  uniform float thickness;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    wp.xyz += n * thickness;
    vW = wp.xyz;
    vN = n;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const glowFrag = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float floorY;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 v = normalize(cameraPosition - vW);
    float ndv = abs(dot(normalize(vN), v));
    float feet = smoothstep(floorY + 0.03, floorY + 0.6, vW.y);
    gl_FragColor = vec4(color * pow(ndv, 2.2) * 0.55 * opacity * feet, 1.0);
  }`;
const ringFrag = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float time;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.72, 0.8, r) * (1.0 - smoothstep(0.86, 0.98, r));
    float pulse = 0.65 + 0.35 * sin(time * 3.0);
    float fill = (1.0 - smoothstep(0.0, 0.8, r)) * 0.22;
    gl_FragColor = vec4(color, (ring * pulse + fill) * opacity);
  }`;
const uvVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

interface Shared {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  time: { value: number };
}
const HEAD_R = 0.125;
let shared: Shared | null = null;
function geo(): Shared {
  if (shared) return shared;
  // unit-height torso (0..1 in y): scaled to the person's height every frame
  const torso = new THREE.CapsuleGeometry(0.165, 0.67, 10, 24);
  torso.translate(0, 0.5, 0);
  // a headset visor: a curved band on the front of the head
  const visor = new THREE.SphereGeometry(HEAD_R + 0.006, 28, 10, Math.PI * 1.5 - 0.95, 1.9, Math.PI * 0.5 - 0.3, 0.5);
  shared = {
    torso,
    head: new THREE.SphereGeometry(HEAD_R, 32, 20),
    hand: new THREE.SphereGeometry(0.042, 18, 12),
    visor,
    eye: new THREE.CircleGeometry(0.019, 18),
    ring: new THREE.PlaneGeometry(0.85, 0.85),
    time: { value: 0 },
  };
  return shared;
}

function glowMaterial(thickness: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(LIME_HEX) }, opacity: { value: 1 }, floorY: { value: 0 }, thickness: { value: thickness } },
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
}

function bodyMaterial(color: number, edgeWidth = 0.2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      lime: { value: new THREE.Color(LIME_HEX) },
      opacity: { value: 1 },
      time: geo().time,
      floorY: { value: 0 },
      edgeWidth: { value: edgeWidth },
    },
    vertexShader: bodyVert,
    fragmentShader: bodyFrag,
    transparent: true,
    depthWrite: false,
  });
}

/** Floating name tag (always faces the viewer). */
export class NameTag {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private material: THREE.SpriteMaterial;
  private unhook: () => void;
  private aspect = 4;
  /** World height of the tag at 1 m (grows with distance so it stays readable). */
  baseHeight = 0.11;

  constructor(private name: string, private kind: PersonKind) {
    this.canvas.width = 640;
    this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.material = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = ORDER.label;
    this.sprite.center.set(0.5, 0);
    this.redraw();
    this.unhook = redrawWhenFontsLoad(() => this.redraw());
  }

  set(name: string, kind: PersonKind): void {
    if (name === this.name && kind === this.kind) return;
    this.name = name;
    this.kind = kind;
    this.redraw();
  }

  private redraw(): void {
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const badge = KIND_LABEL[this.kind];
    g.font = `800 64px ${FONT}`;
    let name = this.name;
    const maxName = W - 210;
    while (g.measureText(name).width > maxName && name.length > 3) name = name.slice(0, -1);
    if (name !== this.name) name = name.replace(/\s+$/, '') + '…';
    const nameW = g.measureText(name).width;
    g.font = `700 26px ${MONO}`;
    const badgeW = g.measureText(badge).width + 28;
    const w = Math.min(W - 8, nameW + badgeW + 76);
    const x = (W - w) / 2, y = 22, h = H - 36;
    roundRect(g, x, y, w, h, h / 2);
    g.fillStyle = 'rgba(11,12,10,0.86)';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = LIME;
    g.stroke();
    // kind badge
    const col = '#' + KIND_COLOR[this.kind].toString(16).padStart(6, '0');
    const bx = x + 22, by = y + (h - 44) / 2;
    roundRect(g, bx, by, badgeW, 44, 12);
    g.fillStyle = col;
    g.fill();
    g.fillStyle = INK;
    g.textBaseline = 'middle';
    g.fillText(badge, bx + 14, by + 23);
    g.font = `800 64px ${FONT}`;
    g.fillStyle = '#f4f7ec';
    g.fillText(name, bx + badgeW + 18, y + h / 2 + 3);
    this.aspect = W / H;
    this.tex.needsUpdate = true;
  }

  /** Keeps the tag readable: about baseHeight per metre of distance, clamped. */
  fit(distance: number): void {
    const h = this.baseHeight * THREE.MathUtils.clamp(distance, 1.6, 7) * 0.62 + 0.06;
    this.sprite.scale.set(h * this.aspect, h, 1);
  }

  set opacity(o: number) {
    this.material.opacity = o;
    this.sprite.visible = o > 0.01;
  }

  dispose(): void {
    this.unhook();
    this.sprite.removeFromParent();
    this.material.dispose();
    this.tex.dispose();
  }
}

/** One person's avatar. Lives in world space (the room frame). */
export class GhostAvatar {
  readonly root = new THREE.Group();
  private body: THREE.Mesh;
  private bodyGlow: THREE.Mesh;
  private glows: THREE.ShaderMaterial[] = [];
  private headGroup = new THREE.Group();
  private head: THREE.Mesh;
  private visor: THREE.Mesh;
  private eyes: THREE.Mesh[] = [];
  private ring: THREE.Mesh;
  private handMeshes: THREE.Mesh[] = [];
  readonly tag: NameTag;
  private mats: THREE.ShaderMaterial[] = [];
  private ringMat: THREE.ShaderMaterial;
  private faceMat: THREE.MeshBasicMaterial;
  private kind: PersonKind;
  private blink = Math.random() * 4;

  constructor(name: string, kind: PersonKind) {
    const s = geo();
    this.kind = kind;
    this.root.name = 'ghost';
    const color = KIND_COLOR[kind];
    const bm = bodyMaterial(color, 0.24);
    const hm = bodyMaterial(color, 0.28);
    this.mats.push(bm, hm);
    this.body = new THREE.Mesh(s.torso, bm);
    this.head = new THREE.Mesh(s.head, hm);
    const bg = glowMaterial(0.045);
    const hg = glowMaterial(0.04);
    this.glows.push(bg, hg);
    this.bodyGlow = new THREE.Mesh(s.torso, bg);
    this.bodyGlow.renderOrder = ORDER.ghost - 2;
    this.body.add(this.bodyGlow);
    const headGlow = new THREE.Mesh(s.head, hg);
    headGlow.renderOrder = ORDER.ghost - 2;
    this.head.add(headGlow);
    this.bodyGlow.frustumCulled = headGlow.frustumCulled = false;
    this.faceMat = new THREE.MeshBasicMaterial({ color: 0x0d0f0a, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.visor = new THREE.Mesh(s.visor, this.faceMat);
    for (let i = 0; i < 2; i++) {
      const e = new THREE.Mesh(s.eye, this.faceMat);
      e.position.set(i ? 0.042 : -0.042, 0.018, -HEAD_R - 0.002);
      e.rotation.y = Math.PI;
      e.renderOrder = ORDER.ghostOutline;
      this.eyes.push(e);
    }
    this.body.renderOrder = ORDER.ghost;
    this.head.renderOrder = ORDER.ghost;
    this.visor.renderOrder = ORDER.ghostOutline;
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 1 }, time: s.time },
      vertexShader: uvVert,
      fragmentShader: ringFrag,
      transparent: true,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(s.ring, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = ORDER.ghost - 1;
    this.headGroup.add(this.head, this.visor, ...this.eyes);
    this.tag = new NameTag(name, kind);
    this.root.add(this.body, this.ring, this.headGroup, this.tag.sprite);
    for (let i = 0; i < 2; i++) {
      const hmat = bodyMaterial(color, 0.3);
      this.mats.push(hmat);
      const hand = new THREE.Mesh(s.hand, hmat);
      hand.renderOrder = ORDER.ghost;
      hand.visible = false;
      this.handMeshes.push(hand);
      this.root.add(hand);
    }
    this.applyFace();
    for (const o of [this.body, this.head, this.visor, ...this.eyes, this.ring, ...this.handMeshes]) o.frustumCulled = false;
  }

  /** Headset wearers get a visor; everyone else gets eyes. */
  private applyFace(): void {
    const vr = this.kind === 'vr';
    this.visor.visible = vr;
    for (const e of this.eyes) e.visible = !vr;
  }

  setIdentity(name: string, kind: PersonKind): void {
    this.tag.set(name, kind);
    if (kind !== this.kind) {
      this.kind = kind;
      const c = KIND_COLOR[kind];
      for (const m of this.mats) (m.uniforms.color.value as THREE.Color).setHex(c);
      (this.ringMat.uniforms.color.value as THREE.Color).setHex(c);
      this.applyFace();
    }
  }

  /** Places the avatar: feet (x, y, z), yaw, eye position, hands (world space). */
  pose(x: number, y: number, z: number, yaw: number, head: V3, hands: [V3, V3] | null, viewer: THREE.Vector3, opacity: number, dt = 0): void {
    const eyeAbove = THREE.MathUtils.clamp(head[1] - y, 0.7, 2.1);
    // torso from the hips to just under the head, leaning a little toward the head
    const top = eyeAbove - 0.2;
    const bottom = Math.max(0.1, top * 0.16);
    const hgt = Math.max(0.35, top - bottom);
    this.body.position.set(x + (head[0] - x) * 0.35, y + bottom, z + (head[2] - z) * 0.35);
    this.body.scale.set(1, hgt, 1);
    this.body.rotation.set(0, yaw, 0);
    this.headGroup.position.set(head[0], y + eyeAbove + 0.02, head[2]);
    this.headGroup.rotation.set(0, yaw, 0);
    this.ring.position.set(x, y + 0.012, z);
    for (const m of this.mats) m.uniforms.floorY.value = y;
    for (const m of this.glows) m.uniforms.floorY.value = y;
    for (let i = 0; i < 2; i++) {
      const h = this.handMeshes[i];
      h.visible = !!hands && opacity > 0.01;
      if (hands) h.position.set(hands[i][0], hands[i][1], hands[i][2]);
    }
    // an occasional blink
    this.blink -= dt;
    const shut = this.blink < 0.12 && this.blink > 0;
    if (this.blink <= 0) this.blink = 2.5 + Math.random() * 3;
    for (const e of this.eyes) e.scale.set(1, shut ? 0.15 : 1, 1);
    const tagAt = this.tag.sprite.position.set(head[0], y + eyeAbove + 0.25, head[2]);
    this.tag.fit(viewer.distanceTo(tagAt));
    this.setOpacity(opacity);
  }

  private setOpacity(o: number): void {
    for (const m of this.mats) m.uniforms.opacity.value = o;
    for (const m of this.glows) m.uniforms.opacity.value = o;
    this.ringMat.uniforms.opacity.value = o;
    this.faceMat.opacity = 0.92 * o;
    this.tag.opacity = o;
    this.root.visible = o > 0.005;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of [...this.mats, ...this.glows, this.ringMat]) m.dispose();
    this.faceMat.dispose();
    this.tag.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// the layer

interface GhostEntry {
  id: string;
  name: string;
  kind: PersonKind;
  track: PoseTrack;
  avatar: GhostAvatar | null;
  /** Local seconds when first seen (fade in). */
  born: number;
  /** Local seconds when it left the list (fade out), or null. */
  goneAt: number | null;
  /** Smoothed display pose. */
  disp: PoseSample | null;
  scratch: PoseSample;
}

const FADE_IN = 0.45;
const FADE_OUT = 0.7;

export function presenceAlpha(now: number, born: number, goneAt: number | null): number {
  const fin = Math.min(1, Math.max(0, (now - born) / FADE_IN));
  const fout = goneAt === null ? 1 : Math.max(0, 1 - (now - goneAt) / FADE_OUT);
  return fin * fin * (3 - 2 * fin) * fout;
}

export interface GhostInfo {
  id: string;
  name: string;
  kind: PersonKind;
  position: THREE.Vector3;
  head: THREE.Vector3;
  visible: boolean;
}

/** Everyone else in the world. Feed snapshots in; call update() every frame. */
export class GhostLayer {
  readonly group = new THREE.Group();
  private entries = new Map<string, GhostEntry>();
  private names = new Map<string, string>();
  private viewer = new THREE.Vector3();
  private time = 0;
  /** Set false for tests without WebGL/canvas (the motion still runs). */
  visuals = true;
  delay = INTERP_DELAY;

  constructor(private clock: ClockSync) {
    this.group.name = 'social-ghosts';
  }

  /** Applies one full presence list received at local time `receivedAt`. */
  applySnapshot(snap: PresenceSnapshot, receivedAt: number, localNow = receivedAt): void {
    // the presence client already did this; a snapshot from elsewhere (tests, the socket) syncs too
    if (snap.t !== null) this.clock.add(snap.t, receivedAt);
    const serverAt = snap.t ?? this.clock.serverNow(receivedAt);
    const present = new Set<string>();
    for (const p of snap.people) {
      present.add(p.id);
      this.names.set(p.id, p.name);
      let e = this.entries.get(p.id);
      if (!e) {
        e = { id: p.id, name: p.name, kind: p.kind, track: new PoseTrack(), avatar: null, born: localNow, goneAt: null, disp: null, scratch: emptySample() };
        this.entries.set(p.id, e);
      }
      if (e.goneAt !== null) {
        // came back while fading out: fade back in from where the fade-out was
        const a = presenceAlpha(localNow, e.born, e.goneAt);
        e.born = localNow - Math.sqrt(a) * FADE_IN;
        e.goneAt = null;
      }
      if (p.name !== e.name || p.kind !== e.kind) {
        e.name = p.name;
        e.kind = p.kind;
        e.avatar?.setIdentity(p.name, p.kind);
      }
      e.track.push(personSample(p, serverAt - p.age));
    }
    for (const e of this.entries.values()) if (!present.has(e.id) && e.goneAt === null) e.goneAt = localNow;
  }

  /** Every frame: interpolate, smooth, fade, draw. `viewer` is the head position (for tag sizing). */
  update(dt: number, viewer: THREE.Vector3, localNow: number): void {
    this.time += dt;
    geo().time.value = this.time;
    this.viewer.copy(viewer);
    const renderT = this.clock.serverNow(localNow) - this.delay;
    const serverNow = this.clock.serverNow(localNow);
    for (const e of this.entries.values()) {
      const target = e.track.at(renderT, e.scratch);
      if (!target) continue;
      if (!e.disp) e.disp = { ...target, head: target.head ? [...target.head] as V3 : null, hands: target.hands ? [[...target.hands[0]] as V3, [...target.hands[1]] as V3] : null };
      else smoothInto(e.disp, target, dt, Math.max(CATCHUP_SPEED, CATCHUP_FACTOR * e.track.speed()));
      const newest = e.track.newest!;
      const alpha = presenceAlpha(localNow, e.born, e.goneAt) * staleAlpha(serverNow - newest.t);
      if (e.goneAt !== null && alpha <= 0.001) {
        e.avatar?.dispose();
        this.entries.delete(e.id);
        continue;
      }
      if (!this.visuals) continue;
      if (!e.avatar) {
        e.avatar = new GhostAvatar(e.name, e.kind);
        this.group.add(e.avatar.root);
      }
      const d = e.disp;
      e.avatar.pose(d.x, d.y, d.z, d.yaw, headOf(d), d.hands, this.viewer, alpha, dt);
    }
  }

  /** Where someone is drawn right now (for the TAGGED burst), or null. */
  info(id: string): GhostInfo | null {
    const e = this.entries.get(id);
    if (!e || !e.disp) return null;
    const h = headOf(e.disp);
    return { id, name: e.name, kind: e.kind, position: new THREE.Vector3(e.disp.x, e.disp.y, e.disp.z), head: new THREE.Vector3(h[0], h[1], h[2]), visible: e.goneAt === null };
  }

  /** Display name for an id (people who left are remembered). */
  nameOf(id: string): string | null {
    return this.names.get(id) ?? null;
  }

  get count(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.goneAt === null) n++;
    return n;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Display pose for tests and debugging. */
  displayPose(id: string): PoseSample | null {
    return this.entries.get(id)?.disp ?? null;
  }

  dispose(): void {
    for (const e of this.entries.values()) e.avatar?.dispose();
    this.entries.clear();
    this.group.removeFromParent();
  }
}

function emptySample(): PoseSample {
  return { t: 0, x: 0, y: 0, z: 0, yaw: 0, head: null, hands: null };
}

export function personSample(p: Person, t: number): PoseSample {
  return { t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, head: p.head ?? null, hands: p.hands ?? null };
}

/** Fastest a ghost is ever drawn moving (m/s): a respawn across the room glides at this speed. */
export const GLIDE_SPEED = 14;
/**
 * Fastest a ghost catches up after a late sample (m/s), unless the person really moves faster (then CATCHUP_FACTOR
 * times their speed). Over a jittery tunnel a stall longer than the delay plus the extrapolation leaves the ghost
 * behind; it then hurries back at a little over walking pace instead of lurching at GLIDE_SPEED.
 */
export const CATCHUP_SPEED = 4;
export const CATCHUP_FACTOR = 1.6;
/** A jump farther than this (m) is a respawn: it glides at GLIDE_SPEED. */
const RESPAWN_M = 2.5;

/**
 * Light smoothing on top of the interpolation (hides sample jitter without adding much lag);
 * far jumps (a respawn) glide quickly instead of snapping. `catchup` caps the speed of smaller catch-ups (m/s).
 */
export function smoothInto(d: PoseSample, t: PoseSample, dt: number, catchup = GLIDE_SPEED): void {
  const jump = Math.hypot(t.x - d.x, t.y - d.y, t.z - d.z);
  let k = damp(jump > RESPAWN_M ? 9 : 22, dt);
  // never faster than a sprint: a respawn across the room is a quick glide, not a jump; a late sample, a short hurry
  const maxStep = (jump > RESPAWN_M ? GLIDE_SPEED : Math.min(GLIDE_SPEED, catchup)) * dt;
  if (jump * k > maxStep) k = maxStep / jump;
  d.x += (t.x - d.x) * k;
  d.y += (t.y - d.y) * k;
  d.z += (t.z - d.z) * k;
  d.yaw = lerpAngle(d.yaw, t.yaw, damp(16, dt));
  if (t.head) {
    if (!d.head) d.head = [...t.head] as V3;
    else for (let i = 0; i < 3; i++) d.head[i] += (t.head[i] - d.head[i]) * k;
  } else d.head = null;
  if (t.hands) {
    if (!d.hands) d.hands = [[...t.hands[0]] as V3, [...t.hands[1]] as V3];
    else for (let h = 0; h < 2; h++) for (let i = 0; i < 3; i++) d.hands[h][i] += (t.hands[h][i] - d.hands[h][i]) * damp(28, dt);
  } else d.hands = null;
  d.t = t.t;
}

// ---------------------------------------------------------------------------------------------
// DOM styles for the desktop overlays (TAGGED flash, round HUD, note dialog, reality legend)

const STYLE_ID = 'dvs-style';
const CSS = `
.dvs-root { position: fixed; inset: 0; pointer-events: none; z-index: 30; font-family: ${FONT}; color: #f4f7ec; }
.dvs-root * { box-sizing: border-box; }
.dvs-flash { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 40; overflow: hidden; }
.dvs-flash::before { content: ''; position: absolute; inset: -10%; background: radial-gradient(circle at 50% 50%, rgba(198,255,61,0.34), rgba(198,255,61,0.0) 58%); animation: dvs-burst 0.9s ease-out forwards; }
.dvs-flash__box { position: relative; display: grid; justify-items: center; gap: 10px; animation: dvs-slam 1.7s cubic-bezier(.2,1.3,.3,1) forwards; }
.dvs-flash__word { font: 900 clamp(52px, 10.5vw, 150px)/0.86 ${FONT}; letter-spacing: -0.045em; color: ${LIME}; text-shadow: 0 0 46px rgba(198,255,61,0.55), 0 8px 0 #0b0c0a; transform: rotate(-4deg); }
.dvs-flash__sub { font: 800 clamp(16px, 2.2vw, 26px)/1.1 ${FONT}; color: #0b0c0a; background: ${LIME}; padding: 8px 16px; border-radius: 999px; transform: rotate(-4deg); }
.dvs-flash--banner .dvs-flash__word, .dvs-flash--end .dvs-flash__word { font-size: clamp(40px, 7.5vw, 112px); }
.dvs-flash--end .dvs-flash__word { color: #f4f7ec; text-shadow: 0 0 36px rgba(198,255,61,0.4), 0 6px 0 #0b0c0a; }
@keyframes dvs-slam { 0% { opacity: 0; transform: scale(1.9); } 12% { opacity: 1; transform: scale(0.94); } 20% { transform: scale(1.03); } 28% { transform: scale(1); } 82% { opacity: 1; } 100% { opacity: 0; transform: scale(1.04); } }
@keyframes dvs-burst { 0% { opacity: 0; transform: scale(0.6); } 15% { opacity: 1; } 100% { opacity: 0; transform: scale(1.4); } }
.dvs-round { position: fixed; top: calc(16px + env(safe-area-inset-top, 0px)); left: 50%; transform: translate(-50%, -12px); opacity: 0; transition: opacity .35s, transform .35s; display: flex; align-items: stretch; gap: 0; background: rgba(12,13,11,0.86); border: 1.5px solid rgba(198,255,61,0.55); border-radius: 18px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); overflow: hidden; pointer-events: none; max-width: calc(100vw - 32px); }
.dvs-round.is-on { opacity: 1; transform: translate(-50%, 0); }
.dvs-round__clock { display: grid; place-items: center; padding: 10px 18px; background: ${LIME}; color: #0b0c0a; min-width: 96px; }
.dvs-round__label { font: 800 10px/1 ${MONO}; letter-spacing: .14em; opacity: .7; }
.dvs-round__time { font: 900 30px/1 ${MONO}; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; margin-top: 3px; }
.dvs-round.is-urgent .dvs-round__clock { background: #ff4f9a; }
.dvs-round__scores { display: flex; gap: 4px; padding: 8px 10px; align-items: center; overflow: hidden; }
.dvs-score { display: grid; gap: 2px; padding: 4px 10px; border-radius: 10px; min-width: 64px; }
.dvs-score.is-me { background: rgba(198,255,61,0.12); }
.dvs-score__name { font: 700 12px/1.1 ${FONT}; color: rgba(244,247,236,0.7); white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.dvs-score__pts { font: 900 20px/1 ${MONO}; color: #f4f7ec; }
.dvs-score.is-me .dvs-score__pts { color: ${LIME}; }
.dvs-note-dialog { position: fixed; left: 50%; bottom: calc(92px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); width: min(480px, calc(100vw - 32px)); background: rgba(12,13,11,0.94); border: 1.5px solid ${LIME}; border-radius: 20px; padding: 18px; display: grid; gap: 12px; z-index: 45; pointer-events: auto; font-family: ${FONT}; color: #f4f7ec; box-shadow: 0 20px 60px rgba(0,0,0,0.5); animation: dvs-rise .28s cubic-bezier(.2,1.2,.3,1); user-select: text; -webkit-user-select: text; }
@keyframes dvs-rise { from { opacity: 0; transform: translate(-50%, 16px); } to { opacity: 1; transform: translate(-50%, 0); } }
.dvs-note-dialog__title { font: 800 20px/1.1 ${FONT}; color: ${LIME}; letter-spacing: -0.01em; }
.dvs-note-dialog__chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dvs-chip { font: 700 13px/1 ${FONT}; color: #f4f7ec; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 9px 13px; cursor: pointer; }
.dvs-chip:hover, .dvs-chip:focus-visible { background: ${LIME}; color: #0b0c0a; border-color: ${LIME}; outline: none; }
.dvs-note-dialog__input { font: 600 16px/1.2 ${FONT}; color: #f4f7ec; background: rgba(255,255,255,0.06); border: 1.5px solid rgba(255,255,255,0.14); border-radius: 12px; padding: 12px 14px; outline: none; width: 100%; }
.dvs-note-dialog__input:focus { border-color: ${LIME}; }
.dvs-note-dialog__row { display: flex; justify-content: flex-end; gap: 8px; }
.dvs-note-dialog__status { font: 600 13px/1.2 ${FONT}; color: rgba(244,247,236,0.6); min-height: 1em; }
.dvs-note-dialog__status.is-error { color: #ff8a7a; }
.dvs-btn { font: 800 14px/1 ${FONT}; color: #0b0c0a; background: ${LIME}; border: 0; border-radius: 12px; padding: 12px 16px; cursor: pointer; }
.dvs-btn--ghost { background: transparent; color: rgba(244,247,236,0.75); border: 1px solid rgba(255,255,255,0.16); }
.dvs-reality { position: fixed; left: calc(16px + env(safe-area-inset-left, 0px)); bottom: calc(84px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 6px; padding: 12px 14px; background: rgba(12,13,11,0.86); border: 1.5px solid rgba(198,255,61,0.4); border-radius: 16px; font-family: ${FONT}; opacity: 0; transform: translateY(8px); transition: opacity .4s, transform .4s; pointer-events: none; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.dvs-reality.is-on { opacity: 1; transform: none; }
.dvs-reality__title { font: 800 11px/1 ${MONO}; letter-spacing: .16em; color: ${LIME}; }
.dvs-reality__row { display: flex; align-items: center; gap: 8px; font: 700 13px/1.1 ${FONT}; color: #f4f7ec; }
.dvs-reality__dot { width: 12px; height: 12px; border-radius: 4px; flex: none; }
.dvs-reality__pct { font: 800 12px/1 ${MONO}; color: rgba(244,247,236,0.6); margin-left: auto; padding-left: 10px; }
@media (max-width: 560px) { .dvs-round__time { font-size: 24px; } .dvs-score { min-width: 52px; padding: 4px 6px; } .dvs-reality { bottom: calc(96px + env(safe-area-inset-bottom, 0px)); } }
@media (prefers-reduced-motion: reduce) { .dvs-flash__box, .dvs-flash::before, .dvs-note-dialog { animation-duration: 0.01s; } }
`;

/** Adds the social layer's stylesheet once. */
export function ensureSocialStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}
