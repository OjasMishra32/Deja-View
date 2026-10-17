// In-headset visuals: stylised controller models, pointer rays with a cursor, the teleport arc and
// landing ring. The panels themselves (wrist menu, Video transport, arrival card) are xr-overlay.ts.

import * as THREE from 'three';

// Apple system colours, the same as the site.
const ACCENT = 0x007aff;
const OK = 0x34c759;
const BAD = 0xff3b30;

let matcapTex: THREE.Texture | null = null;

/** Small procedural matcap so the controllers read as shaded objects without scene lights. */
function matcap(): THREE.Texture {
  if (matcapTex) return matcapTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const base = g.createRadialGradient(46, 40, 6, 64, 64, 64);
  base.addColorStop(0, '#ffffff');
  base.addColorStop(0.35, '#d1d1d6');
  base.addColorStop(0.8, '#6e6e73');
  base.addColorStop(1, '#3a3a3c');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const rim = g.createRadialGradient(64, 64, 48, 64, 64, 64);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(1, 'rgba(255,255,255,0.3)');
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
  const body = new THREE.MeshMatcapMaterial({ matcap: matcap(), color: 0xf2f2f7 });
  const dark = new THREE.MeshMatcapMaterial({ matcap: matcap(), color: 0x2c2c2e });
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

/** Pointer ray in target-ray space (along -Z), fading out with distance, and a cursor where it rests on a panel. */
export class PointerRay {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  readonly dot: THREE.Mesh;
  private dotMat: THREE.MeshBasicMaterial;
  private pressed = false;

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
    // the cursor draws after the panels it sits on
    this.dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 12, 8), this.dotMat);
    this.dot.renderOrder = 1000;
    this.dot.visible = false;
  }

  setLength(len: number, hovering: boolean): void {
    this.mesh.scale.set(1, 1, len);
    this.mat.uniforms.len.value = 1;
    this.mat.uniforms.strength.value = hovering ? 0.8 : 0.5;
    this.dot.visible = hovering;
    this.dot.position.set(0, 0, -len);
  }

  /** The cursor shrinks while the trigger (or pinch) is held on a button. */
  setPressed(on: boolean): void {
    if (on === this.pressed) return;
    this.pressed = on;
    this.dot.scale.setScalar(on ? 0.7 : 1);
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
