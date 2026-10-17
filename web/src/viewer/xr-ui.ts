// In-headset visuals: stylised controller models, pointer rays, the teleport arc and landing
// ring, and a wrist panel with buttons (selected with the trigger).

import * as THREE from 'three';

const ACCENT = 0xffb547;
const OK = 0x7ee2a8;
const BAD = 0xff6d5e;

let matcapTex: THREE.Texture | null = null;

/** Small procedural matcap so the controllers read as shaded objects without scene lights. */
function matcap(): THREE.Texture {
  if (matcapTex) return matcapTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const base = g.createRadialGradient(46, 40, 6, 64, 64, 64);
  base.addColorStop(0, '#d8d4cc');
  base.addColorStop(0.35, '#8d8a85');
  base.addColorStop(0.8, '#2b2a2c');
  base.addColorStop(1, '#141416');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const rim = g.createRadialGradient(64, 64, 48, 64, 64, 64);
  rim.addColorStop(0, 'rgba(255,200,130,0)');
  rim.addColorStop(1, 'rgba(255,200,130,0.35)');
  g.fillStyle = rim;
  g.fillRect(0, 0, 128, 128);
  matcapTex = new THREE.CanvasTexture(c);
  matcapTex.colorSpace = THREE.SRGBColorSpace;
  return matcapTex;
}

/** A simple controller shape in grip space: grip, head with a thumbstick, trigger accent. */
export function makeControllerModel(hand: 'left' | 'right'): THREE.Group {
  const g = new THREE.Group();
  g.name = `controller-${hand}`;
  const body = new THREE.MeshMatcapMaterial({ matcap: matcap(), color: 0x9c9893 });
  const dark = new THREE.MeshMatcapMaterial({ matcap: matcap(), color: 0x3a383a });
  const accent = new THREE.MeshBasicMaterial({ color: ACCENT });

  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, 0.07, 6, 14), body);
  grip.rotation.x = Math.PI / 2 - 0.55;
  grip.position.set(0, -0.012, 0.035);
  g.add(grip);

  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.024, 28), body);
  head.position.set(hand === 'left' ? 0.006 : -0.006, 0.012, -0.022);
  head.rotation.x = 0.35;
  g.add(head);

  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.0255, 0.0255, 0.002, 28), dark);
  face.position.set(0, 0.0125, 0);
  head.add(face);

  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.009, 16), dark);
  stick.position.set(hand === 'left' ? 0.006 : -0.006, 0.017, 0.004);
  head.add(stick);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), body);
  cap.position.set(0, 0.0045, 0);
  stick.add(cap);

  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.02), accent);
  trigger.position.set(0, -0.016, -0.03);
  trigger.rotation.x = -0.4;
  g.add(trigger);
  return g;
}

/** Pointer ray in target-ray space (along -Z), fading out with distance. */
export class PointerRay {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  readonly dot: THREE.Mesh;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { color: { value: new THREE.Color(0xffffff) }, len: { value: 1.2 }, strength: { value: 0.55 } },
      vertexShader: `varying float vT; void main(){ vT = -position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float len; uniform float strength; varying float vT;
        void main(){ float a = (1.0 - smoothstep(0.0, len, vT)) * strength; gl_FragColor = vec4(color, a); }`,
    });
    const geo = new THREE.CylinderGeometry(0.0012, 0.0022, 1, 6, 1, true);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.5);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 900;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, depthTest: false }));
    this.dot.renderOrder = 901;
    this.dot.visible = false;
  }

  setLength(len: number, hovering: boolean): void {
    this.mesh.scale.set(1, 1, len);
    this.mat.uniforms.len.value = 1;
    this.mat.uniforms.strength.value = hovering ? 0.9 : 0.5;
    (this.mat.uniforms.color.value as THREE.Color).set(hovering ? ACCENT : 0xffffff);
    this.dot.visible = hovering;
    this.dot.position.set(0, 0, -len);
  }
}

/** Dotted parabola and a landing ring. Lives in world space. */
export class TeleportVisual {
  readonly group = new THREE.Group();
  private dots: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private dotMat: THREE.MeshBasicMaterial;
  private discMat: THREE.MeshBasicMaterial;
  private readonly maxDots = 48;
  private m = new THREE.Matrix4();
  private time = 0;

  constructor() {
    this.dotMat = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.95, depthWrite: false });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.011, 10, 6), this.dotMat, this.maxDots);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 950;
    this.ringMat = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.235, 48), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 951;
    this.discMat = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.2, 48), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.renderOrder = 950;
    this.group.add(this.dots, this.ring, this.disc);
    this.group.visible = false;
  }

  /** points: xyz triples along the arc. */
  show(points: number[], end: { x: number; y: number; z: number } | null, valid: boolean, dt: number): void {
    this.time += dt;
    this.group.visible = true;
    const color = valid ? OK : BAD;
    this.dotMat.color.setHex(color);
    this.ringMat.color.setHex(color);
    this.discMat.color.setHex(color);
    const n = points.length / 3;
    // resample the polyline to evenly spaced dots
    let total = 0;
    const seg: number[] = [];
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2], points[i * 3 + 2] - points[i * 3 - 1]);
      seg.push(d);
      total += d;
    }
    const count = Math.min(this.maxDots, Math.max(2, Math.floor(total / 0.09)));
    const offset = (this.time * 0.35) % (total / count);
    let si = 0, acc = 0;
    for (let k = 0; k < count; k++) {
      const s = offset + (k / count) * total;
      while (si < seg.length - 1 && acc + seg[si] < s) {
        acc += seg[si];
        si++;
      }
      const t = seg[si] > 0 ? (s - acc) / seg[si] : 0;
      const a = si * 3, b = (si + 1) * 3;
      const x = points[a] + (points[b] - points[a]) * t;
      const y = points[a + 1] + (points[b + 1] - points[a + 1]) * t;
      const z = points[a + 2] + (points[b + 2] - points[a + 2]) * t;
      const sc = 0.6 + 0.4 * (k / count);
      this.m.makeScale(sc, sc, sc).setPosition(x, y, z);
      this.dots.setMatrixAt(k, this.m);
    }
    this.dots.count = count;
    this.dots.instanceMatrix.needsUpdate = true;
    if (end) {
      this.ring.visible = this.disc.visible = true;
      this.ring.position.set(end.x, end.y + 0.01, end.z);
      this.disc.position.set(end.x, end.y + 0.008, end.z);
      const pulse = valid ? 1 + 0.06 * Math.sin(this.time * 7) : 1;
      this.ring.scale.setScalar(pulse);
    } else {
      this.ring.visible = this.disc.visible = false;
    }
  }

  hide(): void {
    this.group.visible = false;
  }
}

export interface PanelButton {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
}

/** Canvas-textured panel attached to the left controller. */
export class WristPanel {
  readonly mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  readonly width = 0.2;
  readonly height = 0.1125;
  private buttons: PanelButton[] = [];
  private hover: string | null = null;
  private state = { title: '', playing: false, hasVideo: false, time: '', sub: '' };
  private dirty = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 360;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.width, this.height), mat);
    this.mesh.name = 'wrist-panel';
    this.mesh.renderOrder = 960;
    // above the left controller, tilted toward the face
    this.mesh.position.set(0.01, 0.075, -0.02);
    this.mesh.rotation.set(-0.85, 0, 0);
  }

  setState(s: Partial<WristPanel['state']>): void {
    for (const [k, v] of Object.entries(s)) {
      if ((this.state as Record<string, unknown>)[k] !== v) {
        (this.state as Record<string, unknown>)[k] = v;
        this.dirty = true;
      }
    }
  }

  setOpacity(o: number): void {
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = o;
  }

  setHover(id: string | null): void {
    if (id !== this.hover) {
      this.hover = id;
      this.dirty = true;
    }
  }

  /** Button id under a point given in the panel's local coordinates. */
  hit(local: THREE.Vector3): string | null {
    const px = (local.x / this.width + 0.5) * this.canvas.width;
    const py = (0.5 - local.y / this.height) * this.canvas.height;
    for (const b of this.buttons) if (b.enabled && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
    return null;
  }

  redraw(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const round = (x: number, y: number, w: number, h: number, r: number) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };
    round(4, 4, W - 8, H - 8, 34);
    g.fillStyle = 'rgba(18,17,21,0.9)';
    g.fill();
    g.strokeStyle = 'rgba(255,250,240,0.14)';
    g.lineWidth = 2;
    g.stroke();

    g.fillStyle = '#ffb547';
    g.font = '500 22px "Geist Mono", ui-monospace, monospace';
    g.fillText('THIRDWHEEL', 36, 58);
    g.fillStyle = 'rgba(242,238,231,0.55)';
    g.textAlign = 'right';
    g.fillText(this.state.time, W - 36, 58);
    g.textAlign = 'left';
    g.fillStyle = '#f2eee7';
    g.font = 'italic 46px "Instrument Serif", Georgia, serif';
    let title = this.state.title || 'ThirdWheel';
    while (g.measureText(title).width > W - 72 && title.length > 4) title = title.slice(0, -2);
    if (title !== (this.state.title || 'ThirdWheel')) title += '…';
    g.fillText(title, 36, 116);

    const defs: Array<[string, string, boolean]> = [
      ['play', this.state.playing ? 'Pause' : 'Play', this.state.hasVideo],
      ['restart', 'Restart', this.state.hasVideo],
      ['spawn', 'Start point', true],
      ['exit', 'Exit VR', true],
    ];
    this.buttons = [];
    const bw = (W - 72 - 3 * 14) / 4, bh = 150, by = H - 36 - bh;
    defs.forEach(([id, label, enabled], i) => {
      const x = 36 + i * (bw + 14);
      this.buttons.push({ id, label, x, y: by, w: bw, h: bh, enabled });
      const hov = this.hover === id && enabled;
      round(x, by, bw, bh, 24);
      g.fillStyle = !enabled ? 'rgba(255,255,255,0.03)' : hov ? '#ffb547' : 'rgba(255,255,255,0.08)';
      g.fill();
      g.fillStyle = !enabled ? 'rgba(242,238,231,0.25)' : hov ? '#201505' : '#f2eee7';
      g.strokeStyle = g.fillStyle;
      this.icon(id, x + bw / 2, by + 58, this.state.playing);
      g.font = '500 22px "Geist", system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(label, x + bw / 2, by + bh - 28);
      g.textAlign = 'left';
    });
    this.tex.needsUpdate = true;
  }

  private icon(id: string, cx: number, cy: number, playing: boolean): void {
    const g = this.ctx;
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    if (id === 'play') {
      if (playing) {
        g.fillRect(cx - 16, cy - 20, 11, 40);
        g.fillRect(cx + 5, cy - 20, 11, 40);
      } else {
        g.moveTo(cx - 12, cy - 22);
        g.lineTo(cx + 20, cy);
        g.lineTo(cx - 12, cy + 22);
        g.closePath();
        g.fill();
      }
      return;
    }
    if (id === 'restart') {
      g.arc(cx, cy, 19, -Math.PI * 0.85, Math.PI * 0.75);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 22, cy - 22);
      g.lineTo(cx - 17, cy - 8);
      g.lineTo(cx - 4, cy - 14);
      g.stroke();
      return;
    }
    if (id === 'spawn') {
      g.arc(cx, cy - 6, 13, Math.PI, 0);
      g.lineTo(cx, cy + 22);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.arc(cx, cy - 6, 4, 0, Math.PI * 2);
      g.fill();
      return;
    }
    if (id === 'exit') {
      g.moveTo(cx - 16, cy - 16);
      g.lineTo(cx + 16, cy + 16);
      g.moveTo(cx + 16, cy - 16);
      g.lineTo(cx - 16, cy + 16);
      g.stroke();
    }
  }
}
