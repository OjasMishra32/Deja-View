// Cross-play physics: three serves run through the game's own ball physics (web/src/viewer/social/pingpong-sim.ts,
// the same code the headset and Roblox share): no spin, topspin, sidespin. Gravity, drag and the Magnus force from
// spin, stepped 240 times a second; the trails show spin bending the path.
import * as THREE from 'three';
import { SIM, assistReturn, newState, step, v3 } from '../../../web/src/viewer/social/pingpong-sim';
import { ease, el, lerp, orbit, seg, stage, story, type Shot, BLUE, INK } from '../lib';

const DUR = 9.5;
const L = SIM.LEN, Wd = SIM.WID;
type Path = { pts: THREE.Vector3[]; bounces: THREE.Vector3[] };
let S: ReturnType<typeof stage>;
const paths: Path[] = [];
const lines: THREE.Line[] = [];
const balls: THREE.Mesh[] = [];
const rings: THREE.Mesh[][] = [];
let words: ReturnType<typeof story>;
const labels: HTMLElement[] = [];
const SHOTS = [
  { at: 0.9, name: 'No spin', w: v3(0, 0, 0), aim: 0.15 },
  { at: 3.3, name: 'Topspin dips sooner', w: v3(-650, 0, 0), aim: -0.45 },
  { at: 5.7, name: 'Sidespin curves', w: v3(0, 620, 0), aim: 0.55 },
];
const SLOW = 0.55; // play the flights at a little over half speed

function simulate(w: ReturnType<typeof v3>, aim: number): Path {
  const p0 = v3(-1.2 + aim, 1.6, L / 2 + 0.4);
  const v = assistReturn(p0, 'A', aim, 0.72, L, Wd);
  const st = newState(p0, v, 0, w);
  const pts: THREE.Vector3[] = [], bounces: THREE.Vector3[] = [];
  for (let i = 0; i < 240 * 1.6 && st.live; i++) {
    const ev = step(st, 1 / 240, L, Wd);
    pts.push(new THREE.Vector3(st.p.x, st.p.y, st.p.z));
    if (ev.table) bounces.push(new THREE.Vector3(st.p.x, SIM.TOP_Y + 0.01, st.p.z));
  }
  return { pts, bounces };
}

const shot: Shot = {
  duration: DUR,
  async setup() {
    S = stage();
    S.camera.fov = 34;
    S.camera.setViewOffset(1920, 1080, 0, 40, 1920, 1080);
    // the table: a dark slab with white lines and a net
    const top = new THREE.Mesh(new THREE.BoxGeometry(Wd, 0.25, L), new THREE.MeshStandardMaterial({ color: 0x1d2a44, roughness: 0.6 }));
    top.position.y = SIM.TOP_Y - 0.125;
    S.scene.add(top);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0.85 });
    const y = SIM.TOP_Y + 0.006;
    const edge = [[-Wd / 2, -L / 2], [Wd / 2, -L / 2], [Wd / 2, L / 2], [-Wd / 2, L / 2], [-Wd / 2, -L / 2]].map(([x, z]) => new THREE.Vector3(x, y, z));
    S.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(edge), lineMat));
    S.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, y, -L / 2), new THREE.Vector3(0, y, L / 2)]), lineMat));
    const net = new THREE.Mesh(new THREE.PlaneGeometry(SIM.NET_L, SIM.NET_H), new THREE.MeshBasicMaterial({ color: 0xf5f5f7, transparent: true, opacity: 0.22, side: THREE.DoubleSide }));
    net.position.set(0, SIM.TOP_Y + SIM.NET_H / 2, 0);
    S.scene.add(net);
    S.scene.add(new THREE.HemisphereLight(0xffffff, 0x101010, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(6, 12, 4);
    S.scene.add(sun);

    SHOTS.forEach((s, i) => {
      const p = simulate(s.w, s.aim);
      paths.push(p);
      const g = new THREE.BufferGeometry().setFromPoints(p.pts);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: i === 0 ? 0xf5f5f7 : BLUE, transparent: true, opacity: 0.95 }));
      g.setDrawRange(0, 0);
      lines.push(line);
      S.scene.add(line);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(SIM.BALL_R, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 }));
      ball.visible = false;
      balls.push(ball);
      S.scene.add(ball);
      rings.push(p.bounces.map((b) => {
        const r = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40), new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0, side: THREE.DoubleSide }));
        r.rotation.x = -Math.PI / 2;
        r.position.copy(b);
        S.scene.add(r);
        return r;
      }));
      labels.push(el('callout', 0, 0, s.name));
    });
    labels.push(el('callout', 1430, 120, 'Gravity · air drag · spin<br><span>240 steps a second, the same in the headset and in Roblox</span>'));
    labels[3].style.whiteSpace = 'normal';
    labels[3].style.width = '360px';
    words = story('Cross-play', 'One table. Two worlds.',
      'The headset and Roblox run the same ball physics. Roblox referees, and a hit that lands a moment late still counts if it matches the ball’s path.');
  },

  frame(t) {
    orbit(S.camera, new THREE.Vector3(0, 0.3, 0), lerp(24, 21, ease.site(seg(t, 0, DUR))), lerp(58, 72, ease.sine(seg(t, 0, DUR))), lerp(26, 22, ease.site(seg(t, 0, DUR))));
    S.camera.updateMatrixWorld();
    SHOTS.forEach((s, i) => {
      const p = paths[i];
      const k = Math.max(0, (t - s.at) * SLOW);
      const n = Math.min(p.pts.length, Math.floor(k * 240));
      lines[i].geometry.setDrawRange(0, n);
      (lines[i].material as THREE.LineBasicMaterial).opacity = i === 0 ? 0.55 : 0.95;
      const live = n > 0 && n < p.pts.length;
      balls[i].visible = live;
      if (live) balls[i].position.copy(p.pts[n - 1]);
      rings[i].forEach((r, j) => {
        const bi = p.pts.findIndex((q) => q.distanceToSquared(p.bounces[j]) < 0.05);
        const age = (n - bi) / 240 / SLOW;
        (r.material as THREE.MeshBasicMaterial).opacity = bi >= 0 && n >= bi ? Math.max(0.25, 1 - age) : 0;
        r.scale.setScalar(bi >= 0 && n >= bi ? 1 + Math.min(age, 0.6) : 1);
      });
      // label at the end of the path, once it is drawn
      const end = (p.bounces[0] ?? p.pts[p.pts.length - 1]).clone().project(S.camera);
      const L2 = labels[i];
      L2.style.left = `${(end.x * 0.5 + 0.5) * 1920 + [22, -120, 22][i]}px`;
      L2.style.top = `${(-end.y * 0.5 + 0.5) * 1080 + [6, 30, -30][i]}px`;
      const hitAt = s.at + (p.pts.findIndex((q) => q.distanceToSquared(p.bounces[0] ?? q) < 0.05) / 240) / SLOW;
      L2.style.opacity = String(ease.site(seg(t, hitAt, hitAt + 0.4)));
    });
    labels[3].style.opacity = String(ease.site(seg(t, 0.4, 1.2)));
    words.show(t, 0.5);
    S.renderer.render(S.scene, S.camera);
  },
};

export default shot;
