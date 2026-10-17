// The arrival card: when you step into a world in the headset, its name in big clean type and a
// one-line caption float ahead of you for three seconds, then drift up a touch and fade. It stays
// where it appeared (world-locked), and its canvas and texture are freed when it is gone.

import * as THREE from 'three';
import { CanvasSurface, drawGlass, drawIcon, ellipsize, font, GLASS, glassMaterial, setGlassOpacity, tracking } from './xr-text.ts';

const MAX_W = 760;
const H = 176;
const PAD = 32;
const SIDE = 52;
const MPP = 0.0013;
/** Seconds: fade in, hold, fade out. */
export const ARRIVAL_TIMING = { in: 0.6, hold: 3.0, out: 0.8 };
const DISTANCE = 2.1;
const LIFT = 0.12;

/** Opacity and vertical drift (metres) of the card `t` seconds after it appears; null once it is gone. */
export function arrivalAt(t: number): { opacity: number; rise: number; scale: number } | null {
  const { in: tin, hold, out } = ARRIVAL_TIMING;
  if (t < 0 || t >= tin + hold + out) return null;
  const a = Math.min(1, t / tin);
  const easeIn = 1 - (1 - a) ** 3;
  const b = THREE.MathUtils.smoothstep(t, tin + hold, tin + hold + out);
  return { opacity: easeIn * (1 - b), rise: -0.025 * (1 - easeIn) + 0.02 * b, scale: 0.97 + 0.03 * easeIn };
}

export class ArrivalCard {
  readonly group = new THREE.Group();
  private surface: CanvasSurface | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private t = -1;
  private base = new THREE.Vector3();
  private head = new THREE.Vector3();

  constructor() {
    this.group.name = 'xr-arrival';
    this.group.visible = false;
  }

  get active(): boolean {
    return this.t >= 0;
  }

  /** Shows the card ahead of the eyes at `head`, facing them, along the heading `yaw`. */
  show(title: string, mode: 'Photo' | 'Video', caption: string, head: THREE.Vector3, yaw: number): void {
    this.build(title, mode, caption);
    this.t = 0;
    this.head.copy(head);
    this.base.set(head.x - Math.sin(yaw) * DISTANCE, head.y + LIFT, head.z - Math.cos(yaw) * DISTANCE);
    this.group.visible = true;
    this.step();
  }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    this.step();
  }

  private step(): void {
    const s = arrivalAt(this.t);
    if (!s || !this.mesh || !this.mat) {
      this.cancel();
      return;
    }
    this.group.position.copy(this.base);
    this.group.position.y += s.rise;
    this.group.scale.setScalar(s.scale);
    this.group.lookAt(this.head);
    setGlassOpacity(this.mat, s.opacity);
  }

  private build(title: string, mode: 'Photo' | 'Video', caption: string): void {
    this.cancel();
    const surface = new CanvasSurface(MAX_W + PAD * 2, H + PAD * 2, 2);
    const g = surface.begin();
    font(g, 700, 46, true);
    tracking(g, -0.6);
    const maxText = MAX_W - SIDE * 2;
    const name = ellipsize(title, maxText, (t) => g.measureText(t).width);
    const nameW = g.measureText(name).width;
    tracking(g, 0);
    font(g, 400, 19);
    const line = caption ? ellipsize(caption, maxText, (t) => g.measureText(t).width) : '';
    const lineW = line ? g.measureText(line).width : 0;
    const w = Math.min(MAX_W, Math.max(380, Math.max(nameW, lineW) + SIDE * 2));
    const x0 = PAD + (MAX_W - w) / 2, y0 = PAD;
    const cx = x0 + w / 2;
    drawGlass(g, x0, y0, w, H, 40, 26);

    // eyebrow: the mode, small and spaced, with its glyph
    font(g, 600, 14);
    tracking(g, 1.8);
    const eyebrow = mode.toUpperCase();
    const ew = g.measureText(eyebrow).width;
    drawIcon(g, mode === 'Video' ? 'video' : 'photo', cx - (ew + 22) / 2 + 7, y0 + 45, 15, GLASS.secondary);
    g.fillStyle = GLASS.secondary;
    g.fillText(eyebrow, cx - (ew + 22) / 2 + 22, y0 + 50);
    tracking(g, 0);

    g.textAlign = 'center';
    font(g, 700, 46, true);
    tracking(g, -0.6);
    g.fillStyle = GLASS.text;
    g.fillText(name, cx, y0 + (line ? 106 : 116));
    tracking(g, 0);
    if (line) {
      font(g, 400, 19);
      g.fillStyle = GLASS.secondary;
      g.fillText(line, cx, y0 + 144);
    }
    surface.commit();

    const mat = glassMaterial(surface.texture, false);
    setGlassOpacity(mat, 0);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry((MAX_W + PAD * 2) * MPP, (H + PAD * 2) * MPP), mat);
    mesh.renderOrder = 975;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.surface = surface;
    this.mat = mat;
    this.mesh = mesh;
  }

  /** Hides the card now and frees its canvas, texture and mesh (it is shown once per visit). */
  cancel(): void {
    this.t = -1;
    this.group.visible = false;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mat?.dispose();
    this.surface?.dispose();
    this.mesh = null;
    this.mat = null;
    this.surface = null;
  }

  dispose(): void {
    this.cancel();
    this.group.removeFromParent();
  }
}
