// The wrist menu: turn the left palm up (or click the left stick) and a glass panel floats above the
// hand, facing you. It names the world and its mode, lists the other worlds with their thumbnails,
// and holds Recenter, Labels, People (Video), Ask the room (when the guide is there) and Exit.
// Point with the right ray and pull the trigger (or pinch) to choose.

import * as THREE from 'three';
import { GlassPanel, type PanelHit, type PanelItem } from './xr-panel.ts';
import { CanvasSurface, drawGlass, drawIcon, ellipsize, font, GLASS, glassMaterial, roundRect, setGlassOpacity, tracking, wrapText, type IconName } from './xr-text.ts';
import { BRAND } from './hud.ts';

export interface MenuWorld {
  id: string;
  name: string;
  /** Thumbnail URL, if the world has one. */
  thumb: string | null;
  current: boolean;
}

export type AskPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

const W = 380;
const MAX_H = 660;
const PAD = 22;
const INNER = W - PAD * 2;
const GAP = 10;
const MAX_WORLDS = 6;
/** Room under a world's thumbnail for its name (two lines). */
const NAME_H = 40;
/** Metres per design pixel: the panel is about 18 cm wide, read at a forearm's length. */
export const MENU_MPP = 0.00048;

/** How much the left palm faces the eyes or the sky (-1..1). `palm` is the unit +X axis of the left grip space. */
export function palmFacing(palm: THREE.Vector3, wrist: THREE.Vector3, head: THREE.Vector3, tmp = new THREE.Vector3()): number {
  const toHead = tmp.copy(head).sub(wrist);
  const len = toHead.length() || 1;
  return Math.max(palm.dot(toHead) / len, palm.y * 0.95);
}

/**
 * Whether the palm-up menu should show, with hysteresis: it opens on a clear palm-up near the eyes, and stays while
 * the palm is still roughly up. `gazeCos` is the cosine between where you look and the direction to the wrist.
 */
export function palmWants(open: boolean, score: number, distance: number, gazeCos: number): boolean {
  if (!open) return score > 0.6 && distance < 0.85 && gazeCos > 0.5;
  return score > 0.3 && distance < 1.0 && gazeCos > 0.26;
}

export class WristMenu {
  readonly panel: GlassPanel;
  private title = BRAND;
  private mode: 'Photo' | 'Video' = 'Photo';
  private caption = '';
  private worlds: MenuWorld[] | null = null;
  private images = new Map<string, HTMLImageElement>();
  private labels: boolean | null = null;
  private people: boolean | null = null;
  private ask: AskPhase | null = null;
  private opening: string | null = null;
  private pinned = false;
  private dirty = true;
  private vis = 0;
  private placed = false;
  private target = new THREE.Vector3();
  private anchor = new THREE.Vector3();
  private right = new THREE.Vector3();
  private disposed = false;
  shown = false;

  constructor() {
    this.panel = new GlassPanel(
      { name: 'xr-wrist-menu', width: W, height: MAX_H, pad: 28, mpp: MENU_MPP, depthTest: true, renderOrder: 990, liftMax: { w: INNER, h: 120 } },
      (g, item, hovered) => this.drawItem(g, item, hovered),
    );
    this.panel.group.visible = false;
  }

  // ---------- state (each setter redraws only when something changed) ----------

  setScene(title: string, mode: 'Photo' | 'Video', caption: string): void {
    if (title === this.title && mode === this.mode && caption === this.caption) return;
    this.title = title;
    this.mode = mode;
    this.caption = caption;
    this.dirty = true;
  }

  setWorlds(list: MenuWorld[] | null): void {
    this.worlds = list ? list.slice(0, MAX_WORLDS) : null;
    for (const w of this.worlds ?? []) {
      if (!w.thumb || this.images.has(w.id)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (!this.disposed) this.dirty = true;
      };
      img.src = w.thumb;
      this.images.set(w.id, img);
    }
    this.dirty = true;
  }

  setToggles(labels: boolean | null, people: boolean | null): void {
    if (labels === this.labels && people === this.people) return;
    this.labels = labels;
    this.people = people;
    this.dirty = true;
  }

  setAsk(phase: AskPhase | null): void {
    if (phase === this.ask) return;
    this.ask = phase;
    this.dirty = true;
  }

  setOpening(id: string | null): void {
    if (id === this.opening) return;
    this.opening = id;
    this.dirty = true;
  }

  setPinned(on: boolean): void {
    if (on === this.pinned) return;
    this.pinned = on;
    this.dirty = true;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  // ---------- frame ----------

  /**
   * Places the menu above the left hand facing the eyes and fades it in or out. `grip` is the left grip position
   * (world), `head` the eyes; `yaw` the head's heading.
   */
  update(dt: number, show: boolean, grip: THREE.Vector3 | null, head: THREE.Vector3, yaw: number): void {
    if (show && grip && this.dirty) this.redraw();
    this.shown = show && !!grip;
    const want = this.shown ? 1 : 0;
    this.vis += (want - this.vis) * (1 - Math.exp(-dt * (want ? 14 : 20)));
    if (Math.abs(want - this.vis) < 0.004) this.vis = want;
    const group = this.panel.group;
    group.visible = this.vis > 0.01;
    if (!group.visible) {
      this.placed = false;
      return;
    }
    if (grip) {
      const h = this.panel.contentHeight * MENU_MPP;
      this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      // above the hand, nudged toward the middle so the right hand reaches it without crossing over
      this.target.copy(grip).addScaledVector(this.right, 0.025);
      this.target.y += 0.07 + h / 2;
      if (!this.placed) {
        this.anchor.copy(this.target);
        this.placed = true;
      } else this.anchor.lerp(this.target, 1 - Math.exp(-dt * 18));
    }
    const e = this.vis * (2 - this.vis);
    group.scale.setScalar(0.94 + 0.06 * e);
    // a little rise as it opens; it always faces the eyes, upright
    group.position.copy(this.anchor);
    group.position.y -= 0.012 * (1 - e);
    group.lookAt(head);
    this.panel.setOpacity(e);
    this.panel.update(dt);
  }

  hit(origin: THREE.Vector3, dir: THREE.Vector3, out: PanelHit): boolean {
    return this.panel.group.visible && this.vis > 0.6 && this.panel.hit(origin, dir, out, 1.6);
  }

  // ---------- drawing ----------

  private worldFor(id: string): MenuWorld | undefined {
    return this.worlds?.find((w) => `world:${w.id}` === id);
  }

  private controls(): string[] {
    const ids = ['recenter'];
    if (this.labels !== null) ids.push('labels');
    if (this.people !== null) ids.push('people');
    if (this.ask !== null) ids.push('ask');
    return ids;
  }

  private redraw(): void {
    this.dirty = false;
    const items: PanelItem[] = [];
    const g0 = this.panel.surface.g;
    // header layout first, so the panel is exactly as tall as what it says
    font(g0, 700, 24, true);
    const titleLines = wrapText(this.title, INNER, 2, (t) => g0.measureText(t).width);
    font(g0, 400, 13);
    const caption = this.caption ? ellipsize(this.caption, INNER, (t) => g0.measureText(t).width) : '';
    let y = PAD + 12;
    const eyebrowY = y;
    y += 30;
    const titleY = y;
    y += (titleLines.length - 1) * 28;
    const captionY = caption ? y + 21 : y;
    y = captionY + 22;

    let worldsY = -1;
    const list = this.worlds ?? [];
    const n = this.worlds === null ? 3 : list.length;
    // one even row where it fits (four go side by side), else rows of three
    const cols = n === 4 ? 4 : 3;
    const tileW = (INNER - GAP * (cols - 1)) / cols, imgH = Math.round(tileW * 0.63), tileH = imgH + NAME_H;
    if (n > 0) {
      worldsY = y + 12;
      y = worldsY + 12;
      for (let i = 0; i < n; i++) {
        const x = PAD + (i % cols) * (tileW + GAP);
        const ty = y + Math.floor(i / cols) * (tileH + GAP);
        const w = list[i];
        if (w) items.push({ id: `world:${w.id}`, x, y: ty, w: tileW, h: tileH, r: 12, enabled: !w.current && !this.opening });
      }
      y += Math.ceil(n / cols) * (tileH + GAP) - GAP + 20;
    }

    const ids = this.controls();
    const cw = (INNER - GAP) / 2, ch = 58;
    ids.forEach((id, i) => {
      const full = i === ids.length - 1 && ids.length % 2 === 1;
      items.push({ id, x: PAD + (full ? 0 : (i % 2) * (cw + GAP)), y: y + Math.floor(i / 2) * (ch + GAP), w: full ? INNER : cw, h: ch, r: 16, enabled: !this.opening });
    });
    y += Math.ceil(ids.length / 2) * (ch + GAP) - GAP + 12;
    items.push({ id: 'exit', x: PAD, y, w: INNER, h: 44, r: 22, enabled: !this.opening });
    y += 44 + 22;
    const hintY = y;
    const height = Math.min(MAX_H, hintY + PAD - 4);

    this.panel.items = items;
    this.panel.setHeight(height);
    this.panel.draw((g) => {
      drawGlass(g, 0, 0, W, height, 30, 20);
      // eyebrow: mode on the left, the product on the right
      drawIcon(g, this.mode === 'Video' ? 'video' : 'photo', PAD + 7, eyebrowY - 4, 13, GLASS.secondary);
      font(g, 600, 11.5);
      tracking(g, 0.9);
      g.fillStyle = GLASS.secondary;
      g.fillText(this.mode.toUpperCase(), PAD + 20, eyebrowY);
      tracking(g, 0);
      font(g, 500, 11.5);
      g.fillStyle = GLASS.tertiary;
      g.textAlign = 'right';
      g.fillText(BRAND, W - PAD, eyebrowY);
      g.textAlign = 'left';
      font(g, 700, 24, true);
      tracking(g, -0.3);
      g.fillStyle = GLASS.text;
      titleLines.forEach((l, i) => g.fillText(l, PAD, titleY + i * 28));
      tracking(g, 0);
      if (caption) {
        font(g, 400, 13);
        g.fillStyle = GLASS.secondary;
        g.fillText(caption, PAD, captionY);
      }
      if (worldsY >= 0) {
        font(g, 600, 12);
        g.fillStyle = GLASS.secondary;
        g.fillText('Worlds', PAD, worldsY);
        if (this.worlds === null) {
          for (let i = 0; i < 3; i++) {
            roundRect(g, PAD + i * (tileW + GAP), worldsY + 12, tileW, imgH, 12);
            g.fillStyle = GLASS.fill;
            g.fill();
          }
        }
      }
      font(g, 500, 11.5);
      g.fillStyle = GLASS.tertiary;
      g.textAlign = 'center';
      const opening = this.opening ? this.worlds?.find((w) => w.id === this.opening) : null;
      const hint = opening
        ? `Opening ${opening.name}…`
        : this.pinned
          ? 'Click the left stick to close'
          : 'Turn your palm down to close';
      g.fillStyle = opening ? GLASS.secondary : GLASS.tertiary;
      g.fillText(ellipsize(hint, INNER, (t) => g.measureText(t).width), W / 2, hintY);
      g.textAlign = 'left';
    });
  }

  private drawItem(g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean): void {
    if (item.id.startsWith('world:')) this.drawWorld(g, item, hovered);
    else if (item.id === 'exit') this.drawExit(g, item, hovered);
    else this.drawControl(g, item, hovered);
  }

  private drawWorld(g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean): void {
    const w = this.worldFor(item.id);
    if (!w) return;
    const imgH = item.h - NAME_H;
    const img = this.images.get(w.id);
    g.save();
    roundRect(g, 0, 0, item.w, imgH, 12);
    g.clip();
    if (img && img.complete && img.naturalWidth > 0) {
      // cover-fit
      const s = Math.max(item.w / img.naturalWidth, imgH / img.naturalHeight);
      const sw = item.w / s, sh = imgH / s;
      g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, item.w, imgH);
    } else {
      g.fillStyle = GLASS.fill;
      g.fillRect(0, 0, item.w, imgH);
      font(g, 600, 22, true);
      g.fillStyle = GLASS.tertiary;
      g.textAlign = 'center';
      g.fillText((w.name.trim()[0] ?? '?').toUpperCase(), item.w / 2, imgH / 2 + 8);
      g.textAlign = 'left';
    }
    if (hovered) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, 0, item.w, imgH);
    }
    g.restore();
    // a hairline keeps bright thumbnails from bleeding into the glass
    roundRect(g, 0.5, 0.5, item.w - 1, imgH - 1, 11.5);
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 1;
    g.stroke();
    if (w.current) {
      const cx = item.w - 13, cy = 13;
      g.beginPath();
      g.arc(cx, cy, 8.5, 0, Math.PI * 2);
      g.fillStyle = GLASS.on;
      g.fill();
      drawIcon(g, 'check', cx, cy + 0.5, 10, GLASS.onText);
    }
    font(g, w.current || hovered ? 600 : 500, item.w < 90 ? 11.5 : 12);
    g.fillStyle = w.current || hovered ? GLASS.text : GLASS.secondary;
    wrapText(w.name, item.w - 2, 2, (t) => g.measureText(t).width).forEach((l, i) => g.fillText(l, 1, imgH + 17 + i * 14));
  }

  private controlInfo(id: string): { icon: IconName; label: string; detail: string; on: boolean } {
    switch (id) {
      case 'labels':
        return { icon: 'labels', label: 'Labels', detail: this.labels ? 'On' : 'Off', on: !!this.labels };
      case 'people':
        return { icon: 'people', label: 'People', detail: this.people ? 'On' : 'Off', on: !!this.people };
      case 'ask': {
        const p = this.ask ?? 'idle';
        const detail = p === 'listening' ? 'Listening · tap to send' : p === 'thinking' ? 'Thinking…' : p === 'speaking' ? 'Answering' : 'Tap, then speak';
        return { icon: 'ask', label: 'Ask the room', detail, on: p === 'listening' };
      }
      default:
        return { icon: 'recenter', label: 'Recenter', detail: 'Back to start', on: false };
    }
  }

  private drawControl(g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean): void {
    const c = this.controlInfo(item.id);
    roundRect(g, 0, 0, item.w, item.h, item.r);
    g.fillStyle = c.on ? GLASS.on : hovered ? GLASS.fillHover : GLASS.fill;
    g.fill();
    const cx = 14 + 17, cy = item.h / 2;
    g.beginPath();
    g.arc(cx, cy, 17, 0, Math.PI * 2);
    g.fillStyle = c.on ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.12)';
    g.fill();
    drawIcon(g, c.icon, cx, cy, 17, c.on ? GLASS.onText : GLASS.text);
    const tx = cx + 17 + 11, maxW = item.w - tx - 10;
    font(g, 600, 14.5);
    g.fillStyle = c.on ? GLASS.onText : GLASS.text;
    g.fillText(ellipsize(c.label, maxW, (t) => g.measureText(t).width), tx, cy - 2);
    font(g, 500, 12);
    g.fillStyle = c.on ? GLASS.onSecondary : GLASS.secondary;
    g.fillText(ellipsize(c.detail, maxW, (t) => g.measureText(t).width), tx, cy + 15);
  }

  private drawExit(g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean): void {
    roundRect(g, 0, 0, item.w, item.h, item.r);
    g.fillStyle = hovered ? GLASS.fillHover : GLASS.fill;
    g.fill();
    font(g, 600, 15);
    const label = 'Exit VR';
    const tw = g.measureText(label).width;
    const x = (item.w - tw - 26) / 2;
    drawIcon(g, 'exit', x + 9, item.h / 2, 16, GLASS.red);
    g.fillStyle = GLASS.red;
    g.fillText(label, x + 26, item.h / 2 + 5.5);
  }

  dispose(): void {
    this.disposed = true;
    for (const img of this.images.values()) img.onload = null;
    this.images.clear();
    this.panel.dispose();
  }
}

const HINT_W = 250;
const HINT_H = 40;

/**
 * A small glass tag over the left hand that teaches the gesture ("Turn your palm up for the menu"). It shows after the
 * arrival card until the menu has been opened once (remembered on this device) or for a few seconds.
 */
export class WristHint {
  readonly group = new THREE.Group();
  private surface: CanvasSurface | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private vis = 0;
  private anchor = new THREE.Vector3();
  private placed = false;

  constructor() {
    this.group.name = 'xr-wrist-hint';
    this.group.visible = false;
  }

  update(dt: number, show: boolean, grip: THREE.Vector3 | null, head: THREE.Vector3): void {
    const want = show && grip ? 1 : 0;
    this.vis += (want - this.vis) * (1 - Math.exp(-dt * (want ? 6 : 10)));
    if (Math.abs(want - this.vis) < 0.004) this.vis = want;
    this.group.visible = this.vis > 0.01;
    if (!this.group.visible) {
      this.placed = false;
      if (!want) this.release();
      return;
    }
    if (!this.mesh) this.build();
    if (grip) {
      if (!this.placed) this.anchor.copy(grip);
      else this.anchor.lerp(grip, 1 - Math.exp(-dt * 18));
      this.placed = true;
    }
    this.group.position.copy(this.anchor);
    this.group.position.y += 0.085 + 0.01 * this.vis;
    this.group.lookAt(head);
    setGlassOpacity(this.mat!, this.vis * (2 - this.vis));
  }

  private build(): void {
    const s = new CanvasSurface(HINT_W + 24, HINT_H + 24, 2);
    const g = s.begin();
    font(g, 600, 13);
    const text = 'Turn your palm up for the menu';
    const tw = g.measureText(text).width;
    const w = Math.min(HINT_W, tw + 36), x0 = 12 + (HINT_W - w) / 2;
    drawGlass(g, x0, 12, w, HINT_H, HINT_H / 2, 8);
    g.fillStyle = GLASS.text;
    g.textAlign = 'center';
    g.fillText(text, 12 + HINT_W / 2, 12 + HINT_H / 2 + 4.5);
    s.commit();
    this.surface = s;
    this.mat = glassMaterial(s.texture, true);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry((HINT_W + 24) * MENU_MPP, (HINT_H + 24) * MENU_MPP), this.mat);
    this.mesh.renderOrder = 989;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  private release(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat?.dispose();
    this.surface?.dispose();
    this.mesh = null;
    this.mat = null;
    this.surface = null;
  }

  dispose(): void {
    this.release();
    this.group.removeFromParent();
  }
}
