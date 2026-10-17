// A glass panel in the headset: one canvas-textured quad holds the panel and all its items, and one
// small "lift" quad carries the hovered item a few millimetres toward you with a soft shadow under
// it. Hovering only redraws that small canvas; the panel itself is drawn when its content changes.
// Two draw calls per panel at most, and nothing is allocated per frame.

import * as THREE from 'three';
import { CanvasSurface, GLASS, glassMaterial, roundRect, setGlassOpacity } from './xr-text.ts';

export interface PanelItem {
  id: string;
  /** Top-left corner and size in design pixels, inside the panel's content box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius of the item's plate (the lifted copy is cut to it). */
  r: number;
  enabled: boolean;
  /** Hover without the lifted copy (an item with its own live drawing on top, like a scrubber). */
  flat?: boolean;
}

/** Draws one item with its top-left corner at (0, 0); `hovered` is the lifted copy. */
export type DrawItem = (g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean) => void;

export interface PanelOptions {
  name: string;
  /** Content box in design pixels (the most it will ever need; setHeight() shows less). */
  width: number;
  height: number;
  /** Transparent margin around the content for its shadow. */
  pad: number;
  /** Metres per design pixel. */
  mpp: number;
  depthTest: boolean;
  renderOrder: number;
  /** The largest item a hover can lift. */
  liftMax: { w: number; h: number };
  /** How far a hovered item rises (metres). */
  liftZ?: number;
  scale?: number;
}

export interface PanelHit {
  item: PanelItem | null;
  /** Hit point in design pixels of the content box (may be outside it). */
  x: number;
  y: number;
  distance: number;
}

const LIFT_PAD = 14;

export class GlassPanel {
  readonly group = new THREE.Group();
  readonly surface: CanvasSurface;
  readonly mesh: THREE.Mesh;
  items: PanelItem[] = [];
  private mat: THREE.MeshBasicMaterial;
  private lift: CanvasSurface;
  private liftMesh: THREE.Mesh;
  private liftMat: THREE.MeshBasicMaterial;
  private hovered: PanelItem | null = null;
  private shown: PanelItem | null = null;
  private liftT = 0;
  private pressT = 0;
  private opacity = 1;
  private height: number;
  private inv = new THREE.Matrix4();
  private lo = new THREE.Vector3();
  private ld = new THREE.Vector3();

  constructor(private opts: PanelOptions, private drawItem: DrawItem) {
    const { width, height, pad } = opts;
    this.height = height;
    this.surface = new CanvasSurface(width + pad * 2, height + pad * 2, opts.scale ?? 2);
    this.mat = glassMaterial(this.surface.texture, opts.depthTest);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.name = opts.name;
    this.mesh.renderOrder = opts.renderOrder;
    this.mesh.frustumCulled = false;
    this.lift = new CanvasSurface(opts.liftMax.w + LIFT_PAD * 2, opts.liftMax.h + LIFT_PAD * 2, opts.scale ?? 2);
    this.liftMat = glassMaterial(this.lift.texture, opts.depthTest);
    this.liftMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.liftMat);
    this.liftMesh.name = `${opts.name}-lift`;
    this.liftMesh.renderOrder = opts.renderOrder + 1;
    this.liftMesh.frustumCulled = false;
    this.liftMesh.visible = false;
    this.group.name = opts.name;
    this.group.add(this.mesh, this.liftMesh);
    this.setHeight(height);
  }

  get width(): number {
    return this.opts.width;
  }

  /** Content height in design pixels (at most the height the panel was made with). */
  setHeight(h: number): void {
    const { width, pad, mpp } = this.opts;
    this.height = Math.min(this.opts.height, Math.max(1, h));
    this.mesh.scale.set((width + pad * 2) * mpp, (this.height + pad * 2) * mpp, 1);
    this.surface.crop(width + pad * 2, this.height + pad * 2);
  }

  get contentHeight(): number {
    return this.height;
  }

  /** Metres from the content's top-left corner, in the group's frame (y up). */
  toLocal(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const { mpp, width } = this.opts;
    return out.set((x - width / 2) * mpp, (this.height / 2 - y) * mpp, 0);
  }

  /** Redraws the panel: `content` paints the glass and static text, then every item is drawn on it. */
  draw(content: (g: CanvasRenderingContext2D) => void): void {
    const g = this.surface.begin();
    g.translate(this.opts.pad, this.opts.pad);
    content(g);
    for (const it of this.items) {
      g.save();
      g.translate(it.x, it.y);
      this.drawItem(g, it, false);
      g.restore();
    }
    this.surface.commit();
    // the hovered item may have changed with the content
    if (this.hovered) {
      const fresh = this.items.find((i) => i.id === this.hovered!.id && i.enabled) ?? null;
      this.hovered = fresh;
      if (fresh && !fresh.flat) this.drawLift(fresh);
    }
  }

  /** Sets the hovered item; true when it changed. */
  setHover(item: PanelItem | null): boolean {
    if (item === this.hovered) return false;
    this.hovered = item;
    if (item) {
      this.liftT = 0;
      if (item.flat) this.shown = null;
      else this.drawLift(item);
    }
    return true;
  }

  get hoveredId(): string | null {
    return this.hovered?.id ?? null;
  }

  /** A short dip of the lifted item (selection feedback). */
  press(): void {
    this.pressT = 1;
  }

  setOpacity(o: number): void {
    this.opacity = o;
    setGlassOpacity(this.mat, o);
  }

  update(dt: number): void {
    const want = this.hovered ? 1 : 0;
    this.liftT += (want - this.liftT) * (1 - Math.exp(-dt * 16));
    if (Math.abs(want - this.liftT) < 0.002) this.liftT = want;
    this.pressT = Math.max(0, this.pressT - dt * 6);
    const item = this.shown;
    const visible = !!item && this.liftT > 0.01 && this.opacity > 0.01;
    this.liftMesh.visible = visible;
    if (!visible || !item) return;
    const { mpp, liftZ = 0.008 } = this.opts;
    const e = this.liftT * (2 - this.liftT);
    const s = 1 + 0.035 * e - 0.05 * Math.sin(this.pressT * Math.PI);
    this.toLocal(item.x + item.w / 2, item.y + item.h / 2, this.liftMesh.position);
    this.liftMesh.position.z = 0.0006 + liftZ * e;
    this.liftMesh.scale.set((item.w + LIFT_PAD * 2) * mpp * s, (item.h + LIFT_PAD * 2) * mpp * s, 1);
    setGlassOpacity(this.liftMat, this.opacity * Math.min(1, this.liftT * 3));
  }

  /**
   * Ray against the panel's plane (world origin and unit direction). Fills `out` and returns true when the plane is
   * hit in front of the ray; `out.item` is the enabled item under the point, if any.
   */
  hit(origin: THREE.Vector3, dir: THREE.Vector3, out: PanelHit, maxDistance = 4): boolean {
    this.mesh.updateWorldMatrix(true, false);
    this.inv.copy(this.mesh.matrixWorld).invert();
    const o = this.lo.copy(origin).applyMatrix4(this.inv);
    const d = this.ld.copy(origin).add(dir).applyMatrix4(this.inv).sub(o);
    if (Math.abs(d.z) < 1e-6) return false;
    const t = -o.z / d.z;
    if (t <= 0 || t > maxDistance) return false;
    const lx = o.x + d.x * t, ly = o.y + d.y * t;
    const { width, pad } = this.opts;
    out.x = (lx + 0.5) * (width + pad * 2) - pad;
    out.y = (0.5 - ly) * (this.height + pad * 2) - pad;
    out.distance = t;
    out.item = null;
    if (out.x < -pad || out.y < -pad || out.x > width + pad || out.y > this.height + pad) return false;
    for (const it of this.items) {
      if (it.enabled && out.x >= it.x && out.x <= it.x + it.w && out.y >= it.y && out.y <= it.y + it.h) {
        out.item = it;
        break;
      }
    }
    return true;
  }

  private drawLift(item: PanelItem): void {
    this.shown = item;
    const g = this.lift.begin();
    g.translate(LIFT_PAD, LIFT_PAD);
    // the plate hides the panel's own copy of the item and casts a soft shadow onto the glass
    g.save();
    roundRect(g, 0, 0, item.w, item.h, item.r);
    g.shadowColor = 'rgba(0,0,0,0.34)';
    g.shadowBlur = 10;
    g.shadowOffsetY = 3;
    g.fillStyle = GLASS.plate;
    g.fill();
    g.restore();
    g.save();
    roundRect(g, 0, 0, item.w, item.h, item.r);
    g.clip();
    this.drawItem(g, item, true);
    g.restore();
    this.lift.crop(item.w + LIFT_PAD * 2, item.h + LIFT_PAD * 2);
    this.lift.commit();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.liftMesh.geometry.dispose();
    this.mat.dispose();
    this.liftMat.dispose();
    this.surface.dispose();
    this.lift.dispose();
  }
}
