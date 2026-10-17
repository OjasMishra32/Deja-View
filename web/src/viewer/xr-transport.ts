// The Video memory transport in the headset: a glass bar below eye level with play/pause, a scrubber
// you drag with the ray, the clip time and a 0.5x / 1x switch. It tags along lazily (it re-centres
// when you turn away, then glides), shows when you look down at it, while paused and while you use
// it, and drives the video layer's own element and clock.

import * as THREE from 'three';
import { formatTime } from './hud.ts';
import { GlassPanel, type PanelHit, type PanelItem } from './xr-panel.ts';
import { CanvasSurface, drawGlass, drawIcon, font, GLASS, glassMaterial, roundRect, setGlassOpacity } from './xr-text.ts';

/** What the transport needs from the video layer (web/src/viewer/thirdwheel.ts's handle has all of it). */
export interface TransportVideo {
  video?: { playbackRate: number } | null;
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number;
  seek(t: number): void;
}

const W = 500;
const H = 64;
const MPP = 0.001;
const TRACK = { x: 126, w: 232 };
const TIME_W = 56;
const SPEEDS = [0.5, 1] as const;
/** Where it rests: this far ahead, this far below the eyes (about 25 degrees down). */
export const TRANSPORT_FOLLOW = { distance: 0.82, drop: 0.38, recentreDeg: 22 };

/** Horizontal angle between the heading `yaw` and the direction from `head` to `p` (radians, -pi..pi). */
export function headingOffset(head: THREE.Vector3, yaw: number, p: THREE.Vector3): number {
  let d = Math.atan2(-(p.x - head.x), -(p.z - head.z)) - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Scrubber position (0..1) for a point at design-pixel x on the bar. */
export function scrubFraction(x: number): number {
  return Math.min(1, Math.max(0, (x - TRACK.x - 10) / (TRACK.w - 20)));
}

const trackVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A capsule track (filled up to the playhead), a knob that grows on hover; premultiplied output.
const trackFragment = /* glsl */ `
uniform float uProgress;
uniform float uHover;
uniform float uOpacity;
uniform vec2 uSize;
varying vec2 vUv;
float capsule(vec2 p, float halfLen, float r) {
  p.x = max(abs(p.x) - halfLen, 0.0);
  return length(p) - r;
}
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float r = mix(2.6, 4.2, uHover);
  float halfLen = uSize.x * 0.5 - 10.0;
  float d = capsule(p, halfLen, r);
  float aa = max(fwidth(d), 1e-3);
  float track = 1.0 - smoothstep(-aa, aa, d);
  float xEnd = -halfLen + 2.0 * halfLen * uProgress;
  float filled = 1.0 - smoothstep(xEnd - aa, xEnd + aa, p.x);
  float a = track * mix(0.24, 0.96, filled);
  float kr = mix(0.0, 8.5, uHover);
  float kd = length(p - vec2(xEnd, 0.0)) - kr;
  float knob = (1.0 - smoothstep(-aa, aa, kd)) * step(0.05, uHover);
  float shade = (1.0 - smoothstep(0.0, 4.0, kd)) * 0.22 * uHover;
  // premultiplied layers: the knob's shadow, the track over it, the knob on top
  vec4 c = vec4(0.0, 0.0, 0.0, shade);
  c = vec4(vec3(a), a) + c * (1.0 - a);
  c = vec4(vec3(knob), knob) + c * (1.0 - knob);
  gl_FragColor = c * uOpacity;
}`;

export class VideoTransport {
  readonly panel: GlassPanel;
  private trackMat: THREE.ShaderMaterial;
  private trackMesh: THREE.Mesh;
  private time: CanvasSurface;
  private timeMat: THREE.MeshBasicMaterial;
  private timeMesh: THREE.Mesh;
  private video: TransportVideo | null = null;
  private playing = false;
  private rate = 1;
  private duration = -1;
  private durationText = '';
  private shownSecond = -1;
  private dirty = true;
  private vis = 0;
  private hoverT = 0;
  private gazeNear = false;
  private awake = 0;
  private placed = false;
  private following = false;
  private pos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private dragging = false;
  private dragFraction = 0;
  private lastSeek = 0;
  shown = false;

  constructor() {
    this.panel = new GlassPanel(
      { name: 'xr-transport', width: W, height: H, pad: 26, mpp: MPP, depthTest: true, renderOrder: 985, liftMax: { w: 56, h: 56 } },
      (g, item, hovered) => this.drawItem(g, item, hovered),
    );
    const items: PanelItem[] = [
      { id: 'play', x: 8, y: 8, w: 48, h: 48, r: 24, enabled: true },
      { id: 'track', x: TRACK.x, y: 8, w: TRACK.w, h: 48, r: 24, enabled: true, flat: true },
      { id: 'speed:0.5', x: 412, y: 16, w: 40, h: 32, r: 16, enabled: true },
      { id: 'speed:1', x: 452, y: 16, w: 40, h: 32, r: 16, enabled: true },
    ];
    this.panel.items = items;

    this.trackMat = new THREE.ShaderMaterial({
      uniforms: { uProgress: { value: 0 }, uHover: { value: 0 }, uOpacity: { value: 0 }, uSize: { value: new THREE.Vector2(TRACK.w, 28) } },
      vertexShader: trackVertex,
      fragmentShader: trackFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.trackMesh = new THREE.Mesh(new THREE.PlaneGeometry(TRACK.w * MPP, 28 * MPP), this.trackMat);
    this.trackMesh.renderOrder = 987;
    this.trackMesh.frustumCulled = false;
    this.panel.toLocal(TRACK.x + TRACK.w / 2, H / 2, this.trackMesh.position);
    this.trackMesh.position.z = 0.0004;

    this.time = new CanvasSurface(TIME_W, 24, 3);
    this.timeMat = glassMaterial(this.time.texture, true);
    this.timeMesh = new THREE.Mesh(new THREE.PlaneGeometry(TIME_W * MPP, 24 * MPP), this.timeMat);
    this.timeMesh.renderOrder = 987;
    this.timeMesh.frustumCulled = false;
    this.panel.toLocal(TRACK.x - 4 - TIME_W / 2, H / 2, this.timeMesh.position);
    this.timeMesh.position.z = 0.0004;
    this.panel.group.add(this.trackMesh, this.timeMesh);
    this.panel.group.visible = false;
  }

  get group(): THREE.Group {
    return this.panel.group;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  bind(video: TransportVideo | null): void {
    if (video === this.video) return;
    this.video = video;
    this.shownSecond = -1;
    this.dirty = true;
  }

  /** Wakes the bar for a few seconds (arrival, a button, a seek). */
  wake(seconds = 3): void {
    this.awake = Math.max(this.awake, seconds);
  }

  setRate(rate: number): void {
    const el = this.video?.video;
    if (el) el.playbackRate = rate;
    this.wake();
  }

  beginDrag(x: number): void {
    if (!this.video) return;
    this.dragging = true;
    this.lastSeek = 0;
    this.drag(x, 0);
  }

  drag(x: number, now: number): void {
    if (!this.dragging || !this.video) return;
    this.dragFraction = scrubFraction(x);
    // a seek is not free (the decoder jumps): at most about 14 a second while dragging
    if (now - this.lastSeek > 70) {
      this.lastSeek = now;
      this.video.seek(this.dragFraction * this.video.duration);
    }
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.video?.seek(this.dragFraction * this.video.duration);
    this.wake();
  }

  /**
   * `allowed`: a ready Video memory and nothing else in the way (the wrist menu, the photo intro). `hovered`: the
   * ray is on the bar. `head`/`yaw`/`gaze` are the eyes in world space.
   */
  update(dt: number, allowed: boolean, hovered: boolean, head: THREE.Vector3, yaw: number, gaze: THREE.Vector3): void {
    const v = this.video;
    this.awake = Math.max(0, this.awake - dt);
    if (!allowed || !v) {
      this.shown = false;
      this.dragging = false;
    } else {
      // looking down at it (with some slack once it is up)
      this.tmp.copy(this.pos).sub(head).normalize();
      const c = this.tmp.dot(gaze);
      this.gazeNear = c > Math.cos(THREE.MathUtils.degToRad(this.gazeNear ? 27 : 18));
      this.shown = !v.playing || this.gazeNear || hovered || this.dragging || this.awake > 0;
    }
    const want = this.shown ? 1 : 0;
    this.vis += (want - this.vis) * (1 - Math.exp(-dt * (want ? 10 : 4)));
    if (Math.abs(want - this.vis) < 0.004) this.vis = want;
    const group = this.panel.group;
    group.visible = this.vis > 0.01 && !!v;
    this.place(dt, head, yaw, hovered || this.dragging);
    if (!group.visible || !v) return;

    if (v.playing !== this.playing) {
      this.playing = v.playing;
      this.dirty = true;
    }
    const rate = v.video?.playbackRate ?? 1;
    if (rate !== this.rate) {
      this.rate = rate;
      this.dirty = true;
    }
    if (v.duration !== this.duration) {
      this.duration = v.duration;
      this.durationText = formatTime(v.duration);
      this.dirty = true;
    }
    if (this.dirty) this.redraw();
    const t = this.dragging ? this.dragFraction * v.duration : v.currentTime;
    const sec = Math.floor(Math.max(0, t));
    if (sec !== this.shownSecond) {
      this.shownSecond = sec;
      this.drawTime(sec);
    }

    const e = this.vis * (2 - this.vis);
    this.panel.setOpacity(e);
    setGlassOpacity(this.timeMat, e);
    this.panel.update(dt);
    const trackHover = this.dragging || this.panel.hoveredId === 'track' ? 1 : 0;
    this.hoverT += (trackHover - this.hoverT) * (1 - Math.exp(-dt * 16));
    const u = this.trackMat.uniforms;
    u.uOpacity.value = e;
    u.uHover.value = this.hoverT;
    u.uProgress.value = this.dragging ? this.dragFraction : v.duration > 0 ? Math.min(1, v.currentTime / v.duration) : 0;
  }

  hit(origin: THREE.Vector3, dir: THREE.Vector3, out: PanelHit): boolean {
    return this.panel.group.visible && this.vis > 0.5 && this.panel.hit(origin, dir, out, 3);
  }

  /** Plane hit while dragging (the ray may leave the bar; the scrubber still follows it). */
  dragHit(origin: THREE.Vector3, dir: THREE.Vector3, out: PanelHit): boolean {
    return this.panel.hit(origin, dir, out, 3);
  }

  /** Lazy follow: stays put until you turn well away (or walk off), then glides back below your gaze. */
  private place(dt: number, head: THREE.Vector3, yaw: number, frozen: boolean): void {
    const f = TRANSPORT_FOLLOW;
    const group = this.panel.group;
    if (!group.visible || !this.placed) {
      // while hidden it keeps to where it would appear, so looking down finds it right there
      this.aim(head, yaw);
      this.pos.copy(this.target);
      this.placed = group.visible;
      this.following = false;
    } else if (!frozen) {
      const off = Math.abs(headingOffset(head, yaw, this.pos));
      const dist = Math.hypot(this.pos.x - head.x, this.pos.z - head.z);
      if (off > THREE.MathUtils.degToRad(f.recentreDeg) || Math.abs(dist - f.distance) > 0.3 || Math.abs(this.pos.y - (head.y - f.drop)) > 0.22) this.following = true;
      if (this.following) {
        this.aim(head, yaw);
        this.pos.lerp(this.target, 1 - Math.exp(-dt * 3.2));
        if (this.pos.distanceToSquared(this.target) < 1e-4) this.following = false;
      }
    }
    if (!group.visible) return;
    group.position.copy(this.pos);
    // upright, tilted back toward the eyes
    group.lookAt(head);
  }

  private aim(head: THREE.Vector3, yaw: number): void {
    const f = TRANSPORT_FOLLOW;
    this.target.set(head.x - Math.sin(yaw) * f.distance, head.y - f.drop, head.z - Math.cos(yaw) * f.distance);
  }

  private redraw(): void {
    this.dirty = false;
    this.panel.draw((g) => {
      drawGlass(g, 0, 0, W, H, H / 2, 16);
      font(g, 500, 14);
      g.fillStyle = GLASS.secondary;
      g.fillText(this.durationText, TRACK.x + TRACK.w + 6, H / 2 + 5);
      // the speed switch's track
      roundRect(g, 410, 14, 84, 36, 18);
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fill();
    });
  }

  private drawTime(sec: number): void {
    const g = this.time.begin();
    font(g, 500, 14);
    g.fillStyle = GLASS.text;
    g.textAlign = 'right';
    g.fillText(formatTime(sec), TIME_W - 2, 17);
    this.time.commit();
  }

  private drawItem(g: CanvasRenderingContext2D, item: PanelItem, hovered: boolean): void {
    if (item.id === 'play') {
      g.beginPath();
      g.arc(item.w / 2, item.h / 2, item.w / 2, 0, Math.PI * 2);
      g.fillStyle = hovered ? GLASS.fillHover : 'rgba(255,255,255,0.13)';
      g.fill();
      drawIcon(g, this.playing ? 'pause' : 'play', item.w / 2 + (this.playing ? 0 : 1.5), item.h / 2, 18, GLASS.text);
      return;
    }
    if (item.id.startsWith('speed:')) {
      const r = Number(item.id.slice(6));
      const active = Math.abs(r - this.rate) < 0.01 || (r === 1 && !SPEEDS.some((s) => Math.abs(s - this.rate) < 0.01));
      if (active || hovered) {
        roundRect(g, 2, 2, item.w - 4, item.h - 4, item.r - 2);
        g.fillStyle = active ? GLASS.on : GLASS.fillHover;
        g.fill();
      }
      font(g, 600, 13);
      g.fillStyle = active ? GLASS.onText : hovered ? GLASS.text : GLASS.secondary;
      g.textAlign = 'center';
      g.fillText(r === 0.5 ? '0.5×' : '1×', item.w / 2, item.h / 2 + 4.5);
      g.textAlign = 'left';
    }
  }

  dispose(): void {
    this.panel.dispose();
    this.trackMesh.geometry.dispose();
    this.trackMat.dispose();
    this.timeMesh.geometry.dispose();
    this.timeMat.dispose();
    this.time.dispose();
  }
}
