// WebXR for Quest 3S: local-floor session, a rig that locomotion moves, left-stick smooth
// walking relative to the head, right-stick snap turn and teleport arc, A/B buttons, trigger UI,
// comfort vignette, fixed foveation.

import * as THREE from 'three';
import type { Bounds } from './analysis.ts';
import { damp, GRAVITY, groundHeight, slideMove, softBoundary, type Body, type GroundOptions, type P3 } from './physics.ts';
import { DEFAULT_ARC, traceArc, type LandingRules } from './teleport.ts';
import type { CollisionWorld } from './voxels.ts';
import { makeControllerModel, PointerRay, TeleportVisual, WristPanel } from './xr-ui.ts';

export interface XrHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rig: THREE.Group;
  world(): CollisionWorld;
  body: Body;
  ground(): GroundOptions;
  walkBounds(): Bounds | null;
  /** How far past walkBounds the walker may drift before it is stopped (metres). */
  walkMargin(): number;
  /**
   * Eye height above the floor to show the world from, or null for the wearer's own height.
   * A room lifted from one camera only looks right near that camera's height, so such rooms ask
   * for it; the offset is measured once on entry and on "Start point", so head motion stays 1:1.
   */
  eyeLevel(): number | null;
  spawn(): { x: number; y: number; z: number; yaw: number };
  /** Desktop pose to start from (feet position + yaw). */
  startPose(): { x: number; y: number; z: number; yaw: number };
  sceneName(): string;
  video(): { has: boolean; playing: boolean; time: string };
  playToggle(): void;
  restartVideo(): void;
  onEnter(): void;
  onExit(pose: { x: number; y: number; z: number; yaw: number }): void;
}

export interface XrOptions {
  framebufferScale: number;
  foveation: number;
}

interface Hand {
  handedness: XRHandedness;
  ray: THREE.Group;
  grip: THREE.Group;
  model: THREE.Group;
  pointer: PointerRay;
  source: XRInputSource | null;
  prev: boolean[];
}

const SNAP = THREE.MathUtils.degToRad(30);
const MOVE_SPEED = 1.5;
/** Splats are fill-rate bound on a Quest: a steady 72 Hz beats a 90 Hz target that drops frames. */
export const PREFERRED_FRAME_RATE = 72;

/** Frame rate to ask the headset for: 72 Hz when offered, else the highest rate up to 90 Hz. */
export function pickFrameRate(rates: ArrayLike<number> | null | undefined): number | null {
  if (!rates || !rates.length) return null;
  const list = Array.from(rates);
  if (list.some((r) => Math.abs(r - PREFERRED_FRAME_RATE) < 0.5)) return PREFERRED_FRAME_RATE;
  const below = list.filter((r) => r <= 90).sort((a, b) => b - a);
  return below[0] ?? null;
}

/** Vertical rig offset that puts an eye at `eyeY` (above the local floor) at `wanted` metres. */
export function eyeLevelOffset(eyeY: number, wanted: number | null): number {
  if (wanted === null || !Number.isFinite(eyeY) || eyeY < 0.5) return 0;
  // never lift people more than a little (a seated wearer), never sink them below a crouch
  return THREE.MathUtils.clamp(wanted - eyeY, -0.75, 0.3);
}

function stick(gp: Gamepad): [number, number] {
  return gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
}

export class XrSystem {
  supported = false;
  presenting = false;
  private session: XRSession | null = null;
  private hands: Hand[] = [];
  private teleport = new TeleportVisual();
  private panel = new WristPanel();
  private vel = new THREE.Vector2();
  private vy = 0;
  private snapArmed = true;
  private aiming = false;
  private lastArc: ReturnType<typeof traceArc> | null = null;
  private fade: { phase: 'out' | 'in'; t: number; target: { x: number; z: number; y: number; yaw?: number; recalibrate?: boolean } | null } | null = null;
  private vignette = 0;
  /** 0..1 fade to dark (teleports, session start) and comfort vignette, composed by the app. */
  fadeLevel = 0;
  vignetteLevel = 0;
  private snapPulse = 0;
  private placePending = 0;
  /** rig.position.y = feet height + heightOffset (eye-level matching, see XrHost.eyeLevel). */
  private heightOffset = 0;
  private headLocal = new THREE.Vector3();
  private lastPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private headWorld = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private raycaster = new THREE.Raycaster();
  private hoverId: string | null = null;
  private panelShown = false;
  private panelFade = 0;
  /** Debug/test readout. */
  readonly debug = { aiming: false, valid: false, reason: '', snapTurns: 0, teleports: 0, moved: 0, heightOffset: 0 };

  /** The right pointer is on a wrist-panel button (its trigger press belongs to the panel). */
  get panelHovered(): boolean {
    return this.hoverId !== null;
  }

  constructor(private host: XrHost, private opts: XrOptions) {
    const { renderer } = host;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    host.scene.add(this.teleport.group);
    for (let i = 0; i < 2; i++) {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const hand: Hand = { handedness: 'none', ray, grip, model: new THREE.Group(), pointer: new PointerRay(), source: null, prev: [] };
      ray.add(hand.pointer.mesh, hand.pointer.dot);
      ray.visible = grip.visible = false;
      ray.addEventListener('connected', (e: { data?: XRInputSource }) => {
        const src = e.data ?? null;
        hand.source = src;
        hand.handedness = src?.handedness ?? 'none';
        grip.remove(hand.model);
        hand.model = makeControllerModel(hand.handedness === 'left' ? 'left' : 'right');
        grip.add(hand.model);
        if (hand.handedness === 'left') grip.add(this.panel.mesh);
        else if (this.panel.mesh.parent === grip) grip.remove(this.panel.mesh);
        ray.visible = grip.visible = !!src?.gamepad;
        hand.pointer.mesh.visible = hand.handedness !== 'left';
      });
      ray.addEventListener('disconnected', () => {
        hand.source = null;
        ray.visible = grip.visible = false;
      });
      host.rig.add(ray, grip);
      this.hands.push(hand);
    }
  }

  async probe(): Promise<boolean> {
    try {
      this.supported = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
    } catch {
      this.supported = false;
    }
    return this.supported;
  }

  async enter(): Promise<void> {
    if (!navigator.xr || this.session) return;
    const { renderer } = this.host;
    renderer.xr.setFramebufferScaleFactor(this.opts.framebufferScale);
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });
    this.session = session;
    session.addEventListener('end', this.onEnd);
    // Feet on the floor from the very first XR frame: the desktop rig holds the eye height, and the
    // headset adds the wearer's own height on top of whatever the rig says.
    const { rig, camera } = this.host;
    const start = this.host.startPose();
    this.heightOffset = 0;
    rig.position.set(start.x, start.y, start.z);
    rig.rotation.set(0, start.yaw, 0);
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    this.fadeLevel = 1;
    this.fade = { phase: 'in', t: 0, target: null };
    await renderer.xr.setSession(session);
    renderer.xr.setFoveation(this.opts.foveation);
    try {
      const rates = (session as XRSession & { supportedFrameRates?: Float32Array }).supportedFrameRates;
      const want = pickFrameRate(rates);
      if (want && 'updateTargetFrameRate' in session) {
        void (session as XRSession & { updateTargetFrameRate(r: number): Promise<void> }).updateTargetFrameRate(want).catch(() => undefined);
      }
    } catch {
      /* optional */
    }
    this.presenting = true;
    this.placePending = 2;
    this.fadeLevel = 1;
    this.fade = { phase: 'in', t: 0, target: null };
    this.host.onEnter();
  }

  exit(): void {
    void this.session?.end();
  }

  private onEnd = () => {
    const { camera } = this.host;
    this.session = null;
    this.presenting = false;
    this.teleport.hide();
    this.vignetteLevel = 0;
    this.fadeLevel = 0;
    // hand the head pose of the last XR frame back to the desktop walker (the camera's world
    // matrix is not reliable once the session is ending)
    const pose = { ...this.lastPose };
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.updateMatrixWorld();
    this.host.onExit(pose);
  };

  /** World yaw of the head (rotation about +Y, three.js convention), from the latest pose. */
  private headYaw(): number {
    return this.lastPose.yaw;
  }

  private updateHead(): void {
    const { camera, rig } = this.host;
    rig.updateMatrixWorld();
    this.headLocal.copy(camera.position);
    this.headWorld.copy(this.headLocal).applyMatrix4(rig.matrixWorld);
    const d = this.tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const yaw = rig.rotation.y + Math.atan2(-d.x, -d.z);
    this.lastPose = { x: this.headWorld.x, y: rig.position.y - this.heightOffset, z: this.headWorld.z, yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
  }

  /** Measures the eye-level offset from the current head pose (see XrHost.eyeLevel). */
  private calibrateHeight(): void {
    this.heightOffset = eyeLevelOffset(this.host.camera.position.y, this.host.eyeLevel());
    this.debug.heightOffset = this.heightOffset;
  }

  /** Puts the rig so the head stands over (x, z) facing `yaw`, feet at y. */
  placeHead(x: number, y: number, z: number, yaw?: number, recalibrate = false): void {
    const { rig, camera } = this.host;
    if (recalibrate) this.calibrateHeight();
    if (yaw !== undefined) {
      const d = this.tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const localYaw = Math.atan2(-d.x, -d.z);
      rig.rotation.set(0, yaw - localYaw, 0);
    }
    rig.updateMatrixWorld();
    const off = this.tmp.copy(camera.position).applyQuaternion(rig.getWorldQuaternion(this.tmpQ));
    rig.position.set(x - off.x, y + this.heightOffset, z - off.z);
    rig.updateMatrixWorld();
    this.vel.set(0, 0);
    this.vy = 0;
  }

  resetToSpawn(): void {
    const s = this.host.spawn();
    this.fade = { phase: 'out', t: 0, target: { x: s.x, y: s.y, z: s.z, yaw: s.yaw, recalibrate: true } };
  }

  update(dt: number): void {
    if (!this.presenting || !this.session) return;
    dt = Math.min(dt, 0.05);
    const { rig } = this.host;
    const world = this.host.world();
    const ground = this.host.ground();
    if (this.placePending > 0) {
      // wait until the first head pose has been applied to the camera
      if (--this.placePending === 0) {
        const p = this.host.startPose();
        this.placeHead(p.x, p.y, p.z, p.yaw, true);
      }
    }
    this.updateHead();

    let left: Gamepad | null = null, right: Gamepad | null = null;
    let rightHand: Hand | null = null;
    for (const h of this.hands) {
      const gp = h.source?.gamepad;
      if (!gp) continue;
      if (h.handedness === 'left') left = gp;
      else {
        right = gp;
        rightHand = h;
      }
    }

    // ---- smooth locomotion (left stick, relative to the head direction) ----
    let mx = 0, mz = 0;
    if (left && !this.fade) {
      const [x, y] = stick(left);
      const m = Math.hypot(x, y);
      if (m > 0.15) {
        const s = Math.min(1, (m - 0.15) / 0.85);
        const yaw = this.headYaw();
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const f = (-y / m) * s, r = (x / m) * s;
        mx = (fx * f + rx * r) * MOVE_SPEED;
        mz = (fz * f + rz * r) * MOVE_SPEED;
      }
    }
    const k = damp(mx || mz ? 8 : 12, dt);
    this.vel.x += (mx - this.vel.x) * k;
    this.vel.y += (mz - this.vel.y) * k;
    const head = this.headWorld;
    const feet: P3 = { x: head.x, y: rig.position.y - this.heightOffset, z: head.z };
    const body: Body = { ...this.host.body, height: Math.max(1.0, Math.min(2.2, this.headLocal.y + this.heightOffset + 0.08)) };
    const v3: P3 = { x: this.vel.x, y: 0, z: this.vel.y };
    const wb = this.host.walkBounds();
    if (wb) softBoundary(feet, v3, wb, this.host.walkMargin());
    this.vel.set(v3.x, v3.z);
    if (Math.abs(this.vel.x) + Math.abs(this.vel.y) > 1e-4) {
      const ox = feet.x, oz = feet.z;
      slideMove(world, feet, this.vel.x * dt, this.vel.y * dt, body);
      rig.position.x += feet.x - ox;
      rig.position.z += feet.z - oz;
      this.debug.moved += Math.hypot(feet.x - ox, feet.z - oz);
    }

    // ---- floor following under the head ----
    let fy = rig.position.y - this.heightOffset;
    const g = groundHeight(world, feet.x, feet.z, fy, body, ground);
    if (g >= fy) {
      fy += (g - fy) * damp(12, dt);
      if (g - fy < 0.002) fy = g;
      this.vy = 0;
    } else {
      this.vy -= GRAVITY * dt;
      fy = Math.max(g, fy + this.vy * dt);
      if (fy === g) this.vy = 0;
    }
    rig.position.y = fy + this.heightOffset;
    feet.y = fy;

    // ---- right stick: snap turn and teleport ----
    if (right && rightHand && !this.fade) {
      const [x, y] = stick(right);
      if (!this.aiming) {
        if (this.snapArmed && Math.abs(x) > 0.65 && Math.abs(x) > Math.abs(y)) {
          this.snapArmed = false;
          this.snapTurn(x > 0 ? -SNAP : SNAP);
        } else if (Math.abs(x) < 0.35) this.snapArmed = true;
        if (y < -0.6 && Math.abs(x) < 0.6) this.aiming = true;
      }
      if (this.aiming) {
        if (y > -0.3) {
          this.aiming = false;
          const arc = this.lastArc;
          if (arc?.valid && arc.end) {
            this.fade = { phase: 'out', t: 0, target: { x: arc.end.x, y: arc.end.y, z: arc.end.z } };
            this.debug.teleports++;
          }
          this.teleport.hide();
          this.lastArc = null;
        } else {
          this.aimArc(rightHand, feet, body, ground, wb, dt);
        }
      }
    } else if (this.aiming) {
      this.aiming = false;
      this.teleport.hide();
    }
    this.debug.aiming = this.aiming;

    // ---- buttons ----
    if (right && rightHand) {
      const pressed = (i: number) => !!right!.buttons[i]?.pressed;
      const edge = (i: number) => pressed(i) && !rightHand!.prev[i];
      if (edge(4)) this.host.playToggle();
      if (edge(5)) this.resetToSpawn();
      const hoverId = this.pointAtPanel(rightHand);
      if (edge(0) && hoverId) this.clickPanel(hoverId);
      rightHand.prev = right.buttons.map((b) => b.pressed);
    }
    for (const h of this.hands) if (h.handedness === 'left' && left) h.prev = left.buttons.map((b) => b.pressed);

    // ---- panel ----
    const v = this.host.video();
    this.panel.setState({ title: this.host.sceneName(), playing: v.playing, hasVideo: v.has, time: v.time });
    this.panelShown = this.panelWanted(this.panelShown);
    this.panelFade += ((this.panelShown ? 1 : 0) - this.panelFade) * damp(14, dt);
    this.panel.setOpacity(this.panelFade);
    this.panel.mesh.visible = this.panelFade > 0.02;
    this.panel.redraw();

    // ---- teleport fade ----
    if (this.fade) {
      const f = this.fade;
      f.t += dt;
      if (f.phase === 'out') {
        this.fadeLevel = Math.min(1, f.t / 0.1);
        if (f.t >= 0.1) {
          if (f.target) this.placeHead(f.target.x, f.target.y, f.target.z, f.target.yaw, f.target.recalibrate);
          this.fade = { phase: 'in', t: 0, target: null };
        }
      } else {
        this.fadeLevel = Math.max(0, 1 - f.t / 0.22);
        if (f.t >= 0.22) this.fade = null;
      }
    }

    // ---- comfort vignette ----
    const speed = this.vel.length();
    this.snapPulse = Math.max(0, this.snapPulse - dt * 4);
    // full strength at walking speed: a clearly visible tunnel while the world slides past
    const target = Math.min(1, Math.min(1, speed / (0.8 * MOVE_SPEED)) + this.snapPulse * 0.6);
    this.vignette += (target - this.vignette) * damp(target > this.vignette ? 10 : 5, dt);
    this.vignetteLevel = this.vignette;
  }

  private snapTurn(delta: number): void {
    const { rig } = this.host;
    this.updateHead();
    const before = this.headWorld.clone();
    rig.rotation.y += delta;
    rig.updateMatrixWorld();
    const after = this.tmp.copy(this.headLocal).applyMatrix4(rig.matrixWorld);
    rig.position.x += before.x - after.x;
    rig.position.z += before.z - after.z;
    rig.updateMatrixWorld();
    this.snapPulse = 1;
    this.debug.snapTurns++;
  }

  private aimArc(hand: Hand, feet: P3, body: Body, ground: GroundOptions, wb: Bounds | null, dt: number): void {
    hand.ray.updateMatrixWorld();
    const origin = new THREE.Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(hand.ray.matrixWorld);
    const rules: LandingRules = {
      body,
      ground,
      bounds: wb ?? undefined,
      maxRise: 1.2,
      flatTolerance: 0.18,
      maxDistance: 9,
    };
    const arc = traceArc(this.host.world(), origin, dir, feet, rules, DEFAULT_ARC);
    this.lastArc = arc;
    this.debug.valid = arc.valid;
    this.debug.reason = arc.reason;
    this.teleport.show(arc.points, arc.end, arc.valid, dt);
  }

  /**
   * Wrist panel: shown while you look at your left controller and the panel faces you, with
   * hysteresis so it does not flicker at the edge.
   */
  private panelWanted(shown: boolean): boolean {
    if (!this.panel.mesh.parent || !this.panel.mesh.parent.visible) return false;
    const p = this.panel.mesh;
    p.updateMatrixWorld();
    const pos = new THREE.Vector3().setFromMatrixPosition(p.matrixWorld);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(p.matrixWorld);
    const toPanel = pos.clone().sub(this.headWorld);
    const dist = toPanel.length();
    toPanel.divideScalar(dist || 1);
    const facing = -n.dot(toPanel);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.host.camera.quaternion).applyQuaternion(this.host.rig.quaternion);
    const gaze = fwd.dot(toPanel);
    const cosOn = Math.cos(THREE.MathUtils.degToRad(24)), cosOff = Math.cos(THREE.MathUtils.degToRad(36));
    if (dist > 0.9 || facing < 0.25) return false;
    return shown ? gaze > cosOff : gaze > cosOn;
  }

  private pointAtPanel(hand: Hand): string | null {
    let id: string | null = null;
    let len = 1.2;
    if (this.panel.mesh.visible) {
      hand.ray.updateMatrixWorld();
      const o = new THREE.Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
      const d = new THREE.Vector3(0, 0, -1).transformDirection(hand.ray.matrixWorld);
      this.raycaster.set(o, d);
      const hit = this.raycaster.intersectObject(this.panel.mesh, false)[0];
      if (hit) {
        const local = this.panel.mesh.worldToLocal(hit.point.clone());
        id = this.panel.hit(local);
        len = hit.distance;
      }
    }
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.panel.setHover(id);
    }
    hand.pointer.setLength(this.aiming ? 0.001 : len, id !== null);
    return id;
  }

  private clickPanel(id: string): void {
    if (id === 'play') this.host.playToggle();
    else if (id === 'restart') this.host.restartVideo();
    else if (id === 'spawn') this.resetToSpawn();
    else if (id === 'exit') this.exit();
  }
}
