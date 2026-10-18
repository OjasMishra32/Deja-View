// Cross-play ping pong in the headset: play the Roblox game's real ping pong at the real table against someone in
// Roblox (or its bot). The Roblox server is the referee (roblox/src/server/DejaView/PingPong.luau); the server relays
// its table, board and shots here as "pingpong" Roblox events (server/social/pingpong.ts) and takes our joins, hits and
// paddle back.
//
// The ball is flown here with the same physics as Roblox (pingpong-sim.ts) from the last shot Roblox sent, in its
// table frame (studs). Our hits are played at once and sent with the time they happened, so the Roblox server can
// check them against the ball's path and count them a moment late. A hit is the same aimed return the bot and the
// desktop assist play: the swing's sideways speed aims it, its speed sets the pace.
//
// Join: walk to an empty end of the table (or click the right stick; P on a desktop). Leave: walk away (or again).
import * as THREE from 'three';
import { assistReturn, flyTo, newState, v3, type BallState, type V3 } from './pingpong-sim.ts';

const STUDS = 3.57; // studs per metre (the Roblox rooms' scale)
const REACH = 1.7; // studs between the blade's centre and the ball for a hit
const JOIN_DIST = 1.4; // metres behind an end line that counts as standing there
const LEAVE_DIST = 3.5; // metres from the table before we give the side back
const PADDLE_HZ = 10;

type Side = 'A' | 'B';
const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');

export interface PingPongDeps {
  sceneId: string;
  baseUrl: string;
  /** Room frame (metres, floor y = 0). */
  scene: THREE.Scene;
  myId: () => string;
  myName: () => string;
  presenting: () => boolean;
  /** The right controller's grip (world matrix), when there is one. */
  grip: () => THREE.Object3D | null;
  /** The right stick was clicked this frame. */
  togglePressed: () => boolean;
  camera: THREE.Camera;
  toast: (title: string, body?: string) => void;
}

interface Relayed {
  active: boolean;
  table: { c: number[]; yaw: number; len: number; wid: number };
  board: { A: string; B: string; scoreA: number; scoreB: number; serve: Side; over: boolean; sides: { A?: string; B?: string } };
  ball?: { p: number[]; v: number[]; w: number[]; t: number; to: Side; live: boolean; serving: boolean; shot: number };
  headset?: { id: string; side: Side };
  paddles?: Array<{ side: Side; p: number[]; n: number[]; f: number[] }>;
  now: number;
}

const arr = (a: unknown): V3 | null =>
  Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v3(a[0], a[1], a[2]) : null;

function paddleMesh(): THREE.Group {
  const g = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 24), new THREE.MeshBasicMaterial({ color: 0xb2161e }));
  const back = new THREE.Mesh(new THREE.CylinderGeometry(0.074, 0.074, 0.004, 24), new THREE.MeshBasicMaterial({ color: 0x161618 }));
  back.position.y = -0.008;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.1), new THREE.MeshBasicMaterial({ color: 0x96623a }));
  handle.position.z = 0.12;
  g.add(blade, back, handle);
  return g;
}

export class PingPongLayer {
  private root = new THREE.Group();
  private ball: THREE.Mesh;
  private mine: THREE.Group;
  private theirs: THREE.Group[] = [];
  private board: THREE.Sprite;
  private boardCanvas = document.createElement('canvas');
  private boardText = '';
  private latest: Relayed | null = null;
  private flight: BallState | null = null;
  private flightTo: Side | null = null;
  private flightShot = -1;
  private flightServing = false;
  private bouncedMine = false;
  private offset: number | null = null; // Roblox time minus our clock, smallest latency seen
  private mySide: Side | null = null;
  private joinSent = 0;
  private lastHit = 0;
  private lastPaddleSent = 0;
  private prevPaddle: THREE.Vector3 | null = null;
  private paddleVel = new THREE.Vector3();
  private optedOut = false;
  private desktopOn = false;
  private lastScore = '';
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'p' || e.key === 'P') this.desktopOn = !this.desktopOn;
  };

  constructor(private deps: PingPongDeps) {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff8a1c }));
    this.mine = paddleMesh();
    this.boardCanvas.width = 512;
    this.boardCanvas.height = 128;
    this.board = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(this.boardCanvas), depthTest: false }));
    this.board.scale.set(0.9, 0.225, 1);
    this.root.add(this.ball, this.mine, this.board);
    this.root.visible = false;
    this.root.name = 'pingpong';
    deps.scene.add(this.root);
    window.addEventListener('keydown', this.onKey);
    void this.load();
  }

  private url(path = ''): string {
    return `${this.deps.baseUrl}/api/pingpong/${encodeURIComponent(this.deps.sceneId)}${path}`;
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch(this.url());
      if (!r.ok) return;
      const d = (await r.json()) as { latest?: unknown };
      if (d.latest && typeof d.latest === 'object') this.ingest(d.latest as Record<string, unknown>);
    } catch {
      /* no table yet: it arrives with Roblox's next post */
    }
  }

  private post(body: Record<string, unknown>): void {
    void fetch(this.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.deps.myId(), name: this.deps.myName(), ...body }),
    }).catch(() => {});
  }

  /** A message from the social socket; takes Roblox "pingpong" events, ignores the rest. */
  handle(m: { type: string; [k: string]: unknown }): void {
    const ev = m.event as Record<string, unknown> | undefined;
    if (m.type === 'roblox' && ev && ev.type === 'pingpong') this.ingest(ev);
  }

  private robloxNow(): number {
    return Date.now() / 1000 + (this.offset ?? 0);
  }

  private ingest(e: Record<string, unknown>): void {
    const d = e as unknown as Relayed;
    if (!d.table || !Array.isArray(d.table.c) || typeof d.now !== 'number') return;
    const off = d.now - Date.now() / 1000;
    // the largest offset is the least delayed message; it decays slowly so a drifting clock is followed too
    this.offset = this.offset === null ? off : Math.max(off, this.offset - 0.001);
    this.latest = d;
    const mine = d.headset && d.headset.id === this.deps.myId() ? d.headset.side : null;
    if (mine !== this.mySide) {
      this.mySide = mine;
      if (mine) this.deps.toast('Ping pong', `You hold the ${mine === 'A' ? 'near' : 'far'} end. Swing through the ball.`);
    }
    const b = d.ball;
    const p = b && arr(b.p);
    const v = b && arr(b.v);
    if (b && p && v && typeof b.t === 'number') {
      // a newer shot than the one we fly (ours, played early, comes back with the next number)
      if (b.shot !== this.flightShot || b.serving !== this.flightServing || !this.flight) {
        if (b.shot !== this.flightShot) this.bouncedMine = false;
        this.flight = newState(p, v, b.t, arr(b.w) ?? v3(0, 0, 0));
        this.flight.live = b.live;
        this.flightTo = b.to;
        this.flightShot = b.shot;
        this.flightServing = b.serving;
      }
    } else {
      this.flight = null;
    }
    const score = `${d.board.A} ${d.board.scoreA} · ${d.board.scoreB} ${d.board.B}`;
    if (score !== this.boardText) this.drawBoard(score);
    const s = `${d.board.scoreA}-${d.board.scoreB}`;
    if (this.mySide && this.lastScore && s !== this.lastScore) this.deps.toast(score);
    this.lastScore = s;
  }

  private drawBoard(text: string): void {
    this.boardText = text;
    const g = this.boardCanvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(16,16,20,0.78)';
    g.beginPath();
    g.roundRect(4, 4, 504, 120, 28);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 46px -apple-system, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 66, 480);
    ((this.board.material as THREE.SpriteMaterial).map as THREE.Texture).needsUpdate = true;
  }

  /** Table frame (studs) to the room (metres). */
  private tableMatrix(): THREE.Matrix4 | null {
    const t = this.latest?.table;
    if (!t) return null;
    return new THREE.Matrix4().compose(
      new THREE.Vector3(t.c[0]! / STUDS, t.c[1]! / STUDS, t.c[2]! / STUDS),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw),
      new THREE.Vector3(1 / STUDS, 1 / STUDS, 1 / STUDS),
    );
  }

  /** Our paddle: the blade's centre and normal and the handle's direction, in the room frame. */
  private paddlePose(): { pos: THREE.Vector3; n: THREE.Vector3; f: THREE.Vector3; quat: THREE.Quaternion } | null {
    const vr = this.deps.presenting();
    const grip = vr ? this.deps.grip() : null;
    const m = new THREE.Matrix4();
    if (grip) {
      // the blade 10 cm past the hand along the controller, upright with its red face to the right, like a real grip
      m.copy(grip.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.1)).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
    } else if (!vr && this.desktopOn) {
      // a desktop stand-in: low and to the right, half a metre in front of the eye, face forward
      this.deps.camera.updateMatrixWorld();
      m.copy(this.deps.camera.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(0.2, -0.15, -0.5)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    } else {
      return null;
    }
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    m.decompose(pos, quat, new THREE.Vector3());
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    return { pos, n, f, quat };
  }

  update(dt: number): void {
    const d = this.latest;
    const tm = this.tableMatrix();
    const active = !!(d && d.active && tm);
    this.root.visible = active;
    if (!active || !tm || !d) return;
    const inv = tm.clone().invert();
    const now = this.robloxNow();
    const len = d.table.len;
    const wid = d.table.wid;

    // the ball
    if (this.flight && !this.flightServing) {
      for (const ev of flyTo(this.flight, now, len, wid)) if (ev.table && ev.table === this.mySide) this.bouncedMine = true;
    }
    const ballLocal = this.flight?.p ?? null;
    this.ball.visible = !!ballLocal;
    if (ballLocal) this.ball.position.set(ballLocal.x, ballLocal.y, ballLocal.z).applyMatrix4(tm);

    // the scoreboard over the net
    this.board.position.set(0, 2.6, 0).applyMatrix4(tm);

    // Roblox players' paddles
    const others = d.paddles ?? [];
    while (this.theirs.length < others.length) {
      const g = paddleMesh();
      this.theirs.push(g);
      this.root.add(g);
    }
    this.theirs.forEach((g, i) => {
      const o = others[i];
      const p = o && arr(o.p);
      const n = o && arr(o.n);
      const f = o && arr(o.f);
      g.visible = !!(p && n && f);
      if (!p || !n || !f) return;
      const P = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(tm);
      const N = new THREE.Vector3(n.x, n.y, n.z).transformDirection(tm);
      const F = new THREE.Vector3(f.x, f.y, f.z).transformDirection(tm);
      const X = new THREE.Vector3().crossVectors(N, F).normalize();
      const target = new THREE.Matrix4().makeBasis(X, N, new THREE.Vector3().crossVectors(X, N)).setPosition(P);
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      target.decompose(pos, q, new THREE.Vector3());
      g.position.lerp(pos, Math.min(1, dt * 10));
      g.quaternion.slerp(q, Math.min(1, dt * 10));
    });

    // our paddle and where we stand
    const pose = this.paddlePose();
    this.mine.visible = !!pose;
    const head = new THREE.Vector3().setFromMatrixPosition(this.deps.camera.matrixWorld);
    const headLocal = head.clone().applyMatrix4(inv);
    this.joinOrLeave(d, headLocal);
    if (!pose) {
      this.prevPaddle = null;
      return;
    }
    this.mine.position.copy(pose.pos);
    this.mine.quaternion.copy(pose.quat);
    const local = pose.pos.clone().applyMatrix4(inv);
    if (this.prevPaddle && dt > 0) this.paddleVel.copy(local).sub(this.prevPaddle).divideScalar(Math.max(0.008, dt));
    this.prevPaddle = local.clone();
    if (!this.mySide) return;

    const t = performance.now() / 1000;
    if (t - this.lastPaddleSent > 1 / PADDLE_HZ) {
      this.lastPaddleSent = t;
      const n = pose.n.clone().transformDirection(inv);
      const f = pose.f.clone().transformDirection(inv);
      const r = (x: number) => Math.round(x * 1000) / 1000;
      this.post({ kind: 'paddle', p: [r(local.x), r(local.y), r(local.z)], n: [r(n.x), r(n.y), r(n.z)], f: [r(f.x), r(f.y), r(f.z)] });
    }

    // a hit: the ball is ours to play (it bounced on our half, or we serve) and the blade reaches it
    const f = this.flight;
    if (!f || t - this.lastHit < 0.35) return;
    const serving = this.flightServing && d.board.serve === this.mySide;
    const ours = serving || (f.live && this.flightTo === this.mySide && this.bouncedMine);
    if (!ours) return;
    const bp = f.p;
    if (Math.hypot(bp.x - local.x, bp.y - local.y, bp.z - local.z) > REACH) return;
    this.lastHit = t;
    const speed = this.paddleVel.length();
    const aim = Math.max(-1, Math.min(1, this.paddleVel.x / 8 + (local.x - bp.x) * 0.2));
    const flight = Math.max(0.5, Math.min(0.85, 0.85 - speed / 60));
    const to = other(this.mySide);
    // play it here at once; Roblox's answer for this shot replaces it
    this.flight = newState(bp, assistReturn(bp, to, aim, flight, len, wid), now);
    this.flightTo = to;
    this.flightServing = false;
    this.bouncedMine = false;
    this.post({ kind: 'shot', shot: { t: now, p: [bp.x, bp.y, bp.z], aim, flight, serve: serving } });
  }

  private joinOrLeave(d: Relayed, headLocal: THREE.Vector3): void {
    const vr = this.deps.presenting();
    const toggled = vr ? this.deps.togglePressed() : false;
    const playing = vr || this.desktopOn;
    const len = d.table.len;
    const wid = d.table.wid;
    // metres from the table's footprint, in its own frame
    const dx = Math.max(0, Math.abs(headLocal.x) - wid / 2) / STUDS;
    const dz = Math.max(0, Math.abs(headLocal.z) - len / 2) / STUDS;
    const away = Math.hypot(dx, dz);
    const end: Side = headLocal.z < 0 ? 'A' : 'B';
    const free = !d.board.sides[end];
    const now = performance.now() / 1000;
    if (this.mySide) {
      if (toggled || !playing || away > LEAVE_DIST) {
        this.post({ kind: 'leave' });
        this.mySide = null;
        this.optedOut = toggled;
      }
      return;
    }
    if (toggled) this.optedOut = !this.optedOut;
    if (!playing || this.optedOut || now - this.joinSent < 3) return;
    const behindEnd = dz > 0 && dz < JOIN_DIST && Math.abs(headLocal.x) < wid;
    if ((behindEnd && free) || (toggled && (free || !d.board.sides[other(end)]))) {
      this.joinSent = now;
      this.post({ kind: 'join', side: free ? end : other(end) });
    }
  }

  dispose(): void {
    if (this.mySide) this.post({ kind: 'leave' });
    window.removeEventListener('keydown', this.onKey);
    this.root.removeFromParent();
  }
}
