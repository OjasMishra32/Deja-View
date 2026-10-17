// The landing intro: one long pinned scene. A Meta Quest 3S spins into view under the slogan. As you
// scroll it turns its lenses to you, the camera flies into one of them, and the lens opens onto a short
// film of how Déjà View made the Infinity Hall Game Lawn, told with the real material (lens-film.ts):
// one photo, the flight through the room rebuilt from it, every photo placed where it was taken, the
// splats, both foosball players back in 3D, and finally the place itself, ready to walk in.
//
// The headset is the real Quest 3S model (quest-model.ts; by OG_MATTER, CC BY 4.0, credited in the
// footer). While it loads, or if it cannot, the code-built likeness from headset.ts stands in.
//
// Everything is a function of how far through the section you are (0..1). The film shows through a
// circle drawn exactly over the lens on screen, so the lens itself becomes the doorway. Reduced motion
// or no WebGL: no pinned scroll, the headset at rest, and the film's words as a plain list, each line
// with its picture.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildHeadset, contactShadow, type Headset } from './headset.ts';
import { LensFilm } from './lens-film.ts';

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    // a test context must not stay alive: browsers cap how many a page may hold
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const coarseDevice = (): boolean =>
  typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 734px)').matches);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 before a, 1 after b, smooth in between. */
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** How far through a pinned section the page is: 0 when its top reaches the pin line, 1 when it lets go. */
export function sectionProgress(section: HTMLElement, stage: HTMLElement, navH: number): number {
  const range = Math.max(1, section.offsetHeight - stage.offsetHeight);
  return clamp01((navH - section.getBoundingClientRect().top) / range);
}

const VFOV = 30;
/** Resting yaw: three quarters, the front and the wearer's left side. */
const REST_YAW = -0.62;
/** The resting pose (pitch, yaw): three quarters, from a little above. */
const REST: [number, number] = [0.2, REST_YAW];
/** How long to wait for the real model before spinning in the code-built one. */
const MODEL_WAIT_MS = 3500;

/** The scroll timeline of the whole section (0..1); the section is 6.4 screens tall (styles.css .intro). */
const T = {
  copyOut: [0.004, 0.03],
  turn: [0.02, 0.11],
  strap: [0.03, 0.06],
  /** "Look inside." shows while the face side is round, before the camera goes in. */
  look: [0.08, 0.095, 0.115, 0.13],
  /** The page darkens as the lens fills the screen. */
  dark: [0.125, 0.155],
  fly: [0.11, 0.19],
  open: [0.15, 0.162],
  /** From here the film fills the screen and the headset is gone. */
  full: 0.19,
  journey: [0.19, 0.99],
} as const;

/** The film's captions, in its own progress (they match the shots in lens-film.ts); the last one stays to the end. */
const BEATS: Record<string, [number, number]> = {
  photos: [0, 0.13],
  cameras: [0.14, 0.27],
  // in as the single print comes back, before the flight grows out of it
  rebuild: [0.275, 0.44],
  splats: [0.43, 0.585],
  video: [0.6, 0.7],
  people: [0.71, 0.84],
  walk: [0.84, 2],
};

export class Intro {
  private readonly section = document.getElementById('intro');
  private readonly stage = document.getElementById('intro-stage');
  private readonly host = document.getElementById('intro-canvas');
  private readonly layer = document.getElementById('intro-journey');
  private readonly copy = document.getElementById('intro-copy');
  private readonly look = document.getElementById('intro-look');
  private readonly anchor = document.getElementById('how-it-works');
  private readonly beats = [...document.querySelectorAll<HTMLElement>('#journey-copy [data-beat]')];
  private readonly reduced = reducedMotion();
  private readonly mobile = coarseDevice();

  private renderer: THREE.WebGLRenderer | null = null;
  private scene3 = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(VFOV, 1, 0.01, 60);
  private headset: Headset = buildHeadset();
  private shadow = contactShadow();
  private visible = false;
  private raf = 0;
  private start = Infinity;
  private navH = 48;
  private film: LensFilm | null = null;
  /** Reduced motion or no WebGL: no scroll scene, the words are a plain list. */
  private isStatic = false;
  /** The headset's size and centre on screen at rest (model units), measured when it is shown; `fit` eases to `fitTo`. */
  private fit = { w: 2.6, x: 0, y: 0 };
  private fitTo = { w: 2.6, x: 0, y: 0 };
  private fitSet = false;
  private readonly lensWorld = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    // links on the page scroll smoothly, but a page opened at a link (/#how) jumps straight there
    const smoothLater = () => setTimeout(() => document.documentElement.classList.add('smooth-scroll'), 300);
    if (document.readyState === 'complete') smoothLater();
    else addEventListener('load', smoothLater, { once: true });
    if (!this.section || !this.stage || !this.host) return;
    this.navH = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 48;
    if (!webglAvailable()) {
      this.staticPage(true);
      return;
    }
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      this.staticPage(true);
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.setClearColor(0xffffff, 0);
    this.host.append(r.domElement);
    // a soft studio: the room environment for reflections, a key light from above left and a little fill
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene3.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene3.environmentIntensity = 0.6;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-3, 5, 4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(4, 1, 2);
    this.scene3.add(key, fill, this.headset.group, this.shadow);
    if (this.reduced) this.staticPage(false);

    addEventListener('resize', () => this.resize());
    // only while the intro is on screen; the observer draws the last state as it leaves
    addEventListener('scroll', () => this.visible && this.kick(), { passive: true });
    new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      this.kick();
    }).observe(this.stage);
    document.addEventListener('visibilitychange', () => this.kick());
    this.resize();
    // the headset spins in once we know which one it is: the real model, or the drawn one
    this.headset.group.visible = false;
    this.loadModel();
    requestAnimationFrame(() => this.stage?.classList.add('is-ready'));
  }

  /**
   * No scroll scene: reduced motion (the headset still shows, at rest) or no WebGL (a drawing of it).
   * The walkthrough's words move out of the pinned stage into a plain section after it.
   */
  private staticPage(noWebgl: boolean): void {
    this.isStatic = true;
    this.section?.classList.add('is-static');
    document.getElementById('nav-how')?.setAttribute('href', '#journey-static');
    if (noWebgl) this.stage?.classList.add('no-webgl', 'is-ready');
    const list = document.getElementById('journey-copy');
    const host = document.getElementById('journey-static');
    if (!list || !host) return;
    host.append(list);
    host.hidden = false;
    for (const b of this.beats) {
      b.removeAttribute('inert');
      // words written for the moving film, said again for its still picture
      const words = b.querySelector<HTMLElement>('[data-still-words]');
      if (words) words.textContent = words.dataset.stillWords!;
      if (!b.dataset.still) continue;
      const img = document.createElement('img');
      img.className = 'beat-still';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = b.dataset.still;
      b.prepend(img);
    }
  }

  /** Loads the Quest 3S model; falls back to the drawn headset when it is missing or slow. */
  private loadModel(): void {
    let shown = false;
    if (this.reduced) {
      // a still headset needs no 5.8 MB model: the drawn one is shown at rest
      this.headset.group.visible = true;
      this.measure(this.headset);
      this.start = performance.now();
      this.kick();
      return;
    }
    const show = (h: Headset) => {
      if (h !== this.headset) {
        this.scene3.remove(this.headset.group);
        this.headset.dispose();
        this.headset = h;
        this.scene3.add(h.group);
      }
      h.group.visible = true;
      this.measure(h);
      if (!shown) this.start = performance.now();
      shown = true;
      this.kick();
    };
    // reloaded part way down: no spin-in to protect, so show the drawn one at once
    const timer = setTimeout(() => show(this.headset), this.progress() > T.copyOut[0] ? 0 : MODEL_WAIT_MS);
    import('./quest-model.ts')
      .then((m) => m.loadQuestHeadset())
      .then((h) => {
        clearTimeout(timer);
        // the drawn one already spun in: swap without a second entrance
        show(h);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!shown) show(this.headset);
      });
  }

  /** Measures the headset at rest, as the camera sees it, so it can be framed whole and centred. */
  private measure(h: Headset): void {
    const g = h.group;
    // the strap may be faded out (and hidden) by the scroll; it counts for the resting frame
    h.setStrap(1);
    const keep = g.rotation.clone();
    g.rotation.set(REST[0], REST[1], 0);
    g.updateMatrixWorld(true);
    // visible meshes only: the model file also carries hidden helpers and controllers
    const box = new THREE.Box3(), part = new THREE.Box3();
    g.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox) box.union(part.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
    });
    g.rotation.copy(keep);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    this.fitTo = { w: Math.max(size.x, size.y * 1.6), x: mid.x, y: mid.y };
    // the first headset frames at once; a later swap (the model arriving late) eases over
    if (!this.fitSet) this.fit = { ...this.fitTo };
    this.fitSet = true;
  }

  /** The film inside the lens; its pictures and clips start loading once the visitor starts to scroll. */
  private loadFilm(): void {
    const film = document.getElementById('film');
    if (!film || this.film) return;
    this.film = new LensFilm(film, { mobile: this.mobile, webgl: !!this.renderer, onChange: () => this.kick() });
    this.film.load();
    this.kick();
  }

  private resize(): void {
    // "How it works" lands where the film starts
    if (this.anchor && this.section && this.stage && !this.isStatic) {
      const range = Math.max(1, this.section.offsetHeight - this.stage.offsetHeight);
      // a little way into the first caption's range, so the words are fully in on arrival
      this.anchor.style.top = `${Math.round(range * (T.full + 0.04 * (T.journey[1] - T.journey[0])))}px`;
    }
    if (!this.renderer || !this.host) return;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.film?.resize();
    this.kick();
  }

  private kick(): void {
    if (!this.raf && this.renderer) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private progress(): number {
    if (!this.section || !this.stage || this.reduced) return 0;
    return sectionProgress(this.section, this.stage, this.navH);
  }

  /** Camera distance that shows the headset `px` pixels wide. */
  private distanceFor(px: number, h: number): number {
    return (this.fit.w * h) / (2 * Math.tan(THREE.MathUtils.degToRad(VFOV / 2)) * px);
  }

  private frame(now: number): void {
    this.raf = 0;
    const r = this.renderer, host = this.host, stage = this.stage;
    if (!r || !host || !stage) return;
    const W = host.clientWidth, H = host.clientHeight;
    // until the headset is known (model or drawn) nothing spins: it is hidden and waits at the start pose
    const waiting = !Number.isFinite(this.start);
    const time = waiting ? 0 : (now - this.start) / 1000;
    const p = this.progress();
    // a headset that arrived late eases into its own framing instead of jumping
    const easing = Math.abs(this.fit.w - this.fitTo.w) > 1e-3 || Math.abs(this.fit.x - this.fitTo.x) > 1e-3 || Math.abs(this.fit.y - this.fitTo.y) > 1e-3;
    if (easing) {
      const k = 0.08;
      this.fit = { w: lerp(this.fit.w, this.fitTo.w, k), x: lerp(this.fit.x, this.fitTo.x, k), y: lerp(this.fit.y, this.fitTo.y, k) };
    }

    // ---- the headset: spins in on load, sways while it waits, turns its lenses to you on scroll
    const intro = this.reduced ? 1 : waiting ? 0 : easeOut(clamp01(time / 2.4));
    const copyOut = smooth(T.copyOut[0], T.copyOut[1], p);
    const turn = smooth(T.turn[0], T.turn[1], p);
    const fly = smooth(T.fly[0], T.fly[1], p);
    const sway = (1 - turn) * (this.reduced ? 0 : 1);
    const g = this.headset.group;
    g.rotation.set(
      lerp(0.2, 0, turn),
      lerp(-3.1, REST_YAW, intro) + (Math.PI - REST_YAW) * turn + 0.14 * Math.sin(time * 0.45) * sway,
      0.02 * Math.sin(time * 0.6) * sway,
    );
    this.headset.setStrap(1 - smooth(T.strap[0], T.strap[1], p));
    g.position.y = lerp(-0.4, 0, intro) + 0.035 * Math.sin(time * 0.9) * sway;
    g.scale.setScalar(lerp(0.88, 1, intro));
    this.shadow.position.set(this.fit.x * (1 - turn), -0.8, 0);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = (1 - turn) * intro;

    // ---- framing: under the copy at first, then centred and larger as the lenses come round
    const copyBottom = this.copy ? this.copy.getBoundingClientRect().bottom - host.getBoundingClientRect().top : 0;
    const below = Math.max(120, H - copyBottom - 24);
    const px0 = Math.min(W * (this.mobile ? 0.84 : 0.42), below * 1.75);
    const px1 = Math.min(W * (this.mobile ? 0.9 : 0.62), H * 1.1);
    const dist = this.distanceFor(lerp(px0, px1, copyOut), H);
    const shift = lerp(Math.max(0, copyBottom + below / 2 - H / 2), 0, copyOut);
    this.camera.setViewOffset(W, H, 0, -shift, W, H);

    // ---- the fly-in: into the lens on the wearer's right
    g.updateMatrixWorld(true);
    this.lensWorld.copy(this.headset.lenses[1]).applyMatrix4(g.matrixWorld);
    const e = fly * fly * (3 - 2 * fly);
    // the eye turns to the lens first, so the lens is in the middle well before it opens; the camera follows
    const aim = smooth(T.fly[0], T.fly[0] + 0.03, p);
    // at rest the camera aims at the middle of the whole headset (strap and all); turned round, at its middle
    const ax = this.fit.x * (1 - turn), ay = this.fit.y * (1 - turn);
    this.camera.position.set(lerp(ax, this.lensWorld.x, e), lerp(ay, this.lensWorld.y, e), lerp(dist, this.lensWorld.z + 0.12, e));
    this.tmp.set(lerp(ax, this.lensWorld.x, aim), lerp(ay, this.lensWorld.y, aim), lerp(0, this.lensWorld.z, aim));
    this.camera.lookAt(this.tmp);
    this.camera.updateMatrixWorld();

    // ---- the lens on screen: the walkthrough shows through a circle exactly over it
    const open = smooth(T.open[0], T.open[1], p);
    if (this.layer) {
      const c = this.tmp.copy(this.lensWorld).project(this.camera);
      const cx = (c.x * 0.5 + 0.5) * W, cy = (-c.y * 0.5 + 0.5) * H;
      this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
      const rim = this.right.multiplyScalar(this.headset.lensRadius * 0.96).add(this.lensWorld).project(this.camera);
      const rad = Math.hypot((rim.x * 0.5 + 0.5) * W - cx, (-rim.y * 0.5 + 0.5) * H - cy);
      const full = p >= T.full ? Math.hypot(W, H) : rad;
      this.layer.style.clipPath = `circle(${full.toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px)`;
      this.layer.style.opacity = String(open);
      this.layer.toggleAttribute('inert', p < T.full);
    }
    stage.style.setProperty('--copy-out', copyOut.toFixed(3));
    // the faded slogan and buttons must not take clicks or focus over the headset and the film
    this.copy?.toggleAttribute('inert', copyOut > 0.5);
    // "Look inside." while the face side is round (a short CSS fade, never left half-way)
    this.look?.classList.toggle('is-on', p >= T.look[1] && p < T.look[2]);
    // inside the headset it gets dark: the page round the lens goes black as the lens fills the screen
    const dark = Math.round(255 * (1 - smooth(T.dark[0], T.dark[1], p)));
    stage.style.backgroundColor = dark === 255 ? '' : `rgb(${dark}, ${dark}, ${dark})`;
    const headsetGone = smooth(T.full - 0.006, T.full, p);
    r.domElement.style.opacity = String(1 - headsetGone);
    if (headsetGone < 1) r.render(this.scene3, this.camera);

    // ---- the film and its words
    const jp = clamp01((p - T.journey[0]) / (T.journey[1] - T.journey[0]));
    const inside = open > 0 && this.visible && document.visibilityState === 'visible';
    // the film's pictures and clips load once the visitor starts down the page with the intro in view
    if (p > 0.005 && this.visible && !this.film) this.loadFilm();
    this.film?.update(jp, inside);
    if (!this.isStatic) this.captions(p >= T.full ? jp : -1);

    // keep animating while the spin-in, the sway or a framing ease is on screen; scrolling wakes it up too
    const busy = !waiting && (time < 2.6 || sway > 0.01 || easing);
    if (this.visible && !this.reduced && busy) this.kick();
  }

  /**
   * Shows the film's current caption (jp < 0: none yet). One caption at a time, chosen from the scroll:
   * the last one whose range has started, so a caption holds until the next one takes over. The change
   * itself is a short CSS fade, so no caption is ever left half-faded when the scrolling stops.
   */
  private captions(jp: number): void {
    let current: HTMLElement | null = null;
    if (jp >= 0) for (const el of this.beats) if ((BEATS[el.dataset.beat ?? '']?.[0] ?? 2) <= jp) current = el;
    for (const el of this.beats) {
      const on = el === current;
      el.classList.toggle('is-on', on);
      el.toggleAttribute('inert', !on);
      // a line that waits for its picture (the splats grow first, then the count)
      const subAt = Number(el.dataset.subAt);
      el.classList.toggle('sub-wait', !!subAt && jp < subAt);
    }
    document.getElementById('journey-copy')?.classList.toggle('has-words', !!current);
  }
}
