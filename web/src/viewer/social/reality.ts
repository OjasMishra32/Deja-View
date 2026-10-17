// Reality check: shows which parts of the world the camera really captured and which the world
// model imagined. pipeline/reality_split.py writes world-seen.spz, world-imagined.spz and
// reality.json next to the world; when they exist the toggle swaps the world for the two parts
// (identical at rest) and washes the imagined part in a desaturated violet, spreading out from
// where you stand as a soft wave with a lime edge. Without them it says the world has no
// reality map.

import * as THREE from 'three';
import { SplatMesh, dyno } from '@sparkjsdev/spark';
import { joinUrl, fetchJson, type FetchLike } from './presence-client.ts';

export interface RealityReport {
  version: number;
  seen: { file: string; count: number };
  imagined: { file: string; count: number };
  total: number;
  seenFraction: number;
  camera?: { source?: string };
}

export function parseRealityReport(raw: unknown): RealityReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const part = (v: unknown) => {
    if (!v || typeof v !== 'object') return null;
    const p = v as Record<string, unknown>;
    if (typeof p.file !== 'string' || !/^[\w.-]+\.(spz|ply)$/i.test(p.file)) return null;
    const count = typeof p.count === 'number' && Number.isFinite(p.count) ? Math.max(0, Math.floor(p.count)) : -1;
    return { file: p.file, count };
  };
  const seen = part(r.seen);
  const imagined = part(r.imagined);
  if (!seen || !imagined) return null;
  const total = typeof r.total === 'number' && r.total > 0 ? r.total : Math.max(0, seen.count) + Math.max(0, imagined.count);
  const frac = typeof r.seenFraction === 'number' ? r.seenFraction : total > 0 ? Math.max(0, seen.count) / total : 0;
  return {
    version: typeof r.version === 'number' ? r.version : 1,
    seen,
    imagined,
    total,
    seenFraction: Math.min(1, Math.max(0, frac)),
    camera: r.camera && typeof r.camera === 'object' ? (r.camera as { source?: string }) : undefined,
  };
}

/** The SplatFx uniforms (effects.ts) the parts copy so they keep the world's soft edges. */
export interface SplatFxLike {
  boxMin: { value: THREE.Vector3 };
  boxMax: { value: THREE.Vector3 };
  edge: { value: number };
  conePos: { value: THREE.Vector3 };
  coneRight: { value: THREE.Vector3 };
  coneUp: { value: THREE.Vector3 };
  coneFwd: { value: THREE.Vector3 };
  coneTans: { value: THREE.Vector4 };
  coneSoft: { value: THREE.Vector4 };
}

export interface RealityHost {
  sceneId: string;
  baseUrl: string;
  /** False when the world cannot have reality parts (a bundled sample): no reality.json lookup, so no 404. */
  expected?: boolean;
  /** The world mesh as loaded by the viewer. */
  mesh(): SplatMesh | null;
  fx?: SplatFxLike | null;
  /** Loads a splat file (defaults to a plain SplatMesh). */
  load?(url: string): Promise<SplatMesh>;
  /** Applies the viewer's own per-splat fixes (camera-room hidden-splat repair) to a part. */
  prepare?(mesh: SplatMesh): void;
  notify(title: string, body?: string, kind?: 'info' | 'error' | 'ok'): void;
  /** Where the wave starts (the viewer's head, world space). */
  head(): THREE.Vector3;
  fetchImpl?: FetchLike;
}

/** Imagined wash colour (sRGB, written straight to the framebuffer like the splat colours). */
export const IMAGINED_TINT = new THREE.Vector3(0.55, 0.36, 1.0);
export const EDGE_GLOW = new THREE.Vector3(0.78, 1.0, 0.24);

interface PartUniforms {
  amount: ReturnType<typeof dyno.dynoFloat>;
  front: ReturnType<typeof dyno.dynoFloat>;
  origin: ReturnType<typeof dyno.dynoVec3>;
}

function partModifier(u: PartUniforms, imagined: boolean, fx: SplatFxLike | null | undefined) {
  // own copies when there is no SplatFx to share (tests, other hosts)
  const f = fx ?? {
    boxMin: dyno.dynoVec3(new THREE.Vector3(-1e4, -1e4, -1e4)),
    boxMax: dyno.dynoVec3(new THREE.Vector3(1e4, 1e4, 1e4)),
    edge: dyno.dynoFloat(2.5),
    conePos: dyno.dynoVec3(new THREE.Vector3()),
    coneRight: dyno.dynoVec3(new THREE.Vector3(1, 0, 0)),
    coneUp: dyno.dynoVec3(new THREE.Vector3(0, 1, 0)),
    coneFwd: dyno.dynoVec3(new THREE.Vector3(0, 0, -1)),
    coneTans: dyno.dynoVec4(new THREE.Vector4(1e3, 1e3, 1e3, 1e3)),
    coneSoft: dyno.dynoVec4(new THREE.Vector4(0.3, 0, 0, 0)),
  };
  const tint = dyno.dynoVec3(IMAGINED_TINT.clone());
  const glow = dyno.dynoVec3(EDGE_GLOW.clone());
  const isImagined = dyno.dynoFloat(imagined ? 1 : 0);
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat, amount: 'float', front: 'float', origin: 'vec3', tint: 'vec3', glow: 'vec3', imagined: 'float',
        bmin: 'vec3', bmax: 'vec3', edge: 'float', cpos: 'vec3', cright: 'vec3', cup: 'vec3', cfwd: 'vec3', ctans: 'vec4', csoft: 'vec4',
      },
      outTypes: { gsplat: dyno.Gsplat },
      inputs: {
        gsplat, amount: u.amount, front: u.front, origin: u.origin, tint, glow, imagined: isImagined,
        bmin: f.boxMin as never, bmax: f.boxMax as never, edge: f.edge as never, cpos: f.conePos as never, cright: f.coneRight as never,
        cup: f.coneUp as never, cfwd: f.coneFwd as never, ctans: f.coneTans as never, csoft: f.coneSoft as never,
      },
      statements: ({ inputs, outputs }) => [
        `${outputs.gsplat} = ${inputs.gsplat};`,
        `{`,
        `  vec3 c = ${inputs.gsplat}.center;`,
        // the world's own soft edge (same as SplatFx)
        `  vec3 q = max(max(${inputs.bmin} - c, c - ${inputs.bmax}), vec3(0.0));`,
        `  float keep = 1.0 - smoothstep(0.0, ${inputs.edge}, length(q));`,
        `  if (${inputs.csoft}.y > 0.5) {`,
        `    vec3 dc = c - ${inputs.cpos};`,
        `    float dz = dot(dc, ${inputs.cfwd});`,
        `    float tx = dot(dc, ${inputs.cright}) / max(dz, 1e-3);`,
        `    float ty = dot(dc, ${inputs.cup}) / max(dz, 1e-3);`,
        `    float sx = max(-${inputs.ctans}.x - tx, tx - ${inputs.ctans}.y);`,
        `    float sy = max(-${inputs.ctans}.z - ty, ty - ${inputs.ctans}.w);`,
        `    float out_ = length(max(vec2(sx, sy), 0.0)) + min(max(sx, sy), 0.0);`,
        `    if (dz <= 0.02) out_ = 10.0;`,
        `    keep *= 1.0 - smoothstep(-${inputs.csoft}.z, ${inputs.csoft}.x, out_);`,
        `  }`,
        `  ${outputs.gsplat}.rgba.a *= keep;`,
        // the wave: everything inside the front is in its reality-check colours
        `  float r = distance(c, ${inputs.origin});`,
        `  float fr = ${inputs.front};`,
        `  float k = ${inputs.amount} * (1.0 - smoothstep(fr - 0.7, fr, r));`,
        `  float band = ${inputs.amount} * smoothstep(fr - 0.9, fr - 0.3, r) * (1.0 - smoothstep(fr - 0.3, fr, r));`,
        `  vec3 rgb = ${outputs.gsplat}.rgba.rgb;`,
        `  float l = dot(rgb, vec3(0.299, 0.587, 0.114));`,
        `  vec3 washed = mix(mix(rgb, vec3(l), 0.7), ${inputs.tint} * (0.28 + 0.95 * l), 0.58) * 0.94;`,
        `  rgb = mix(rgb, washed, k * ${inputs.imagined});`,
        `  rgb += band * ${inputs.glow} * 0.38;`,
        `  ${outputs.gsplat}.rgba.rgb = rgb;`,
        `}`,
      ],
    });
    return { gsplat: d.outputs.gsplat };
  });
}

async function defaultLoad(url: string): Promise<SplatMesh> {
  const m = new SplatMesh({ url });
  await m.initialized;
  return m;
}

type Phase = 'off' | 'loading' | 'on' | 'leaving';

export class RealityCheck {
  /** null until reality.json was looked for. */
  available: boolean | null = null;
  report: RealityReport | null = null;
  wanted = false;
  phase: Phase = 'off';
  private parts: SplatMesh[] = [];
  private loadPromise: Promise<boolean> | null = null;
  private u: PartUniforms = { amount: dyno.dynoFloat(0), front: dyno.dynoFloat(0), origin: dyno.dynoVec3(new THREE.Vector3()) };
  private t = 0;
  private reach = 30;
  private fxKey = '';
  private disposed = false;
  /** 0..1 how much the reality colours show (for the legend). */
  level = 0;
  onChange: (on: boolean, report: RealityReport | null) => void = () => undefined;

  constructor(private host: RealityHost) {}

  private base(): string {
    return joinUrl(this.host.baseUrl, `/data/scenes/${encodeURIComponent(this.host.sceneId)}/`);
  }

  /** Looks for reality.json (cached). */
  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    if (this.host.expected === false) {
      this.available = false;
      return false;
    }
    const res = await fetchJson(this.base() + 'reality.json', { timeoutMs: 4000, fetchImpl: this.host.fetchImpl });
    this.report = res.ok ? parseRealityReport(res.data) : null;
    // a timeout is not an answer: look again next time
    if (!res.ok && res.status === 0) return false;
    this.available = !!this.report;
    return this.available;
  }

  /** Loads both parts in the background (so the toggle is instant later). */
  preload(): Promise<boolean> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadParts().then((ok) => {
      if (!ok) this.loadPromise = null;
      return ok;
    });
    return this.loadPromise;
  }

  private async loadParts(): Promise<boolean> {
    if (!(await this.probe()) || !this.report) return false;
    const original = this.host.mesh();
    if (!original || !original.parent) return false;
    const load = this.host.load ?? defaultLoad;
    const files = [
      { file: this.report.seen.file, count: this.report.seen.count, imagined: false },
      { file: this.report.imagined.file, count: this.report.imagined.count, imagined: true },
    ].filter((p) => p.count !== 0);
    try {
      const meshes = await Promise.all(files.map((p) => load(this.base() + p.file)));
      if (this.disposed) {
        for (const m of meshes) m.dispose();
        return false;
      }
      meshes.forEach((m, i) => {
        m.name = files[i].imagined ? 'world-imagined' : 'world-seen';
        try {
          this.host.prepare?.(m);
        } catch (e) {
          console.warn('[reality] prepare skipped', e);
        }
        m.worldModifier = partModifier(this.u, files[i].imagined, this.host.fx);
        m.updateGenerator();
        m.visible = false;
      });
      this.parts = meshes;
      this.attach();
      return true;
    } catch (e) {
      console.warn('[reality] parts failed to load', e);
      return false;
    }
  }

  /** Keeps the parts next to the world mesh, with its transform (the world can be re-parented or flipped). */
  private attach(): void {
    const original = this.host.mesh();
    if (!original?.parent) return;
    for (const p of this.parts) {
      if (p.parent !== original.parent) original.parent.add(p);
      p.position.copy(original.position);
      p.quaternion.copy(original.quaternion);
      p.scale.copy(original.scale);
    }
  }

  /** Turns the reality check on or off. Resolves false when this world has no reality map. */
  async set(on: boolean): Promise<boolean> {
    this.wanted = on;
    if (!on) {
      if (this.phase === 'on' || this.phase === 'loading') this.phase = this.parts.length ? 'leaving' : 'off';
      this.onChange(false, this.report);
      return true;
    }
    if (this.phase === 'on') return true;
    this.phase = 'loading';
    const had = !!this.parts.length;
    if (!had) {
      const loading = !!this.loadPromise;
      if (!(await this.probe())) {
        this.phase = 'off';
        this.wanted = false;
        if (this.available === false) this.host.notify('No reality map for this world', 'This world was not split into captured and imagined parts.', 'info');
        else this.host.notify('Reality check unavailable', 'The server did not answer. Try again in a moment.', 'error');
        return false;
      }
      if (!loading) this.host.notify('Reality check', 'Loading the captured and imagined parts…', 'info');
    }
    const ok = await this.preload();
    if (!ok) {
      this.phase = 'off';
      this.wanted = false;
      this.host.notify('Reality check unavailable', 'The reality map did not load. The world itself is fine.', 'error');
      return false;
    }
    if (!this.wanted) {
      this.phase = 'off';
      return true;
    }
    this.begin();
    return true;
  }

  toggle(): Promise<boolean> {
    return this.set(!(this.wanted && this.phase !== 'off'));
  }

  private begin(): void {
    const original = this.host.mesh();
    this.attach();
    const head = this.host.head();
    (this.u.origin.value as THREE.Vector3).copy(head);
    this.reach = this.reachFrom(head);
    this.u.front.value = 0;
    this.u.amount.value = 1;
    this.t = 0;
    for (const p of this.parts) {
      p.visible = true;
      p.updateVersion();
    }
    if (original) original.visible = false;
    this.phase = 'on';
    this.onChange(true, this.report);
  }

  private reachFrom(head: THREE.Vector3): number {
    const m = this.host.mesh();
    if (!m) return 30;
    try {
      const box = m.getBoundingBox(true).clone().applyMatrix4(m.matrixWorld);
      let r = 0;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) r = Math.max(r, head.distanceTo(new THREE.Vector3(x, y, z)));
      return Math.min(80, Math.max(6, r + 1));
    } catch {
      return 30;
    }
  }

  get on(): boolean {
    return this.phase === 'on';
  }

  update(dt: number): void {
    if (!this.parts.length) return;
    this.syncFx();
    if (this.phase === 'on') {
      this.t += dt;
      // a visible sweep outward from where you stand: starts at once, reaches the far walls in 1-2 s
      const dur = Math.min(2.0, Math.max(1.1, 0.9 + this.reach * 0.06));
      const x = Math.min(1, this.t / dur);
      const e = x < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * Math.pow(x, 0.8)) : 1;
      const front = 0.2 + e * (this.reach + 1.2);
      if (front !== this.u.front.value || this.u.amount.value !== 1) {
        this.u.front.value = front;
        this.u.amount.value = 1;
        this.touch();
      }
      this.level = e;
    } else if (this.phase === 'leaving') {
      const a = Math.max(0, this.u.amount.value - dt / 0.6);
      this.u.amount.value = a;
      this.level = a;
      this.touch();
      if (a <= 0) {
        const original = this.host.mesh();
        if (original) original.visible = true;
        for (const p of this.parts) p.visible = false;
        this.phase = 'off';
      }
    }
  }

  /** Regenerates the parts when the world's own edge settings changed (a flip re-analyses the world). */
  private syncFx(): void {
    const f = this.host.fx;
    if (!f) return;
    const key = `${f.boxMin.value.toArray()}|${f.boxMax.value.toArray()}|${f.edge.value}|${f.coneSoft.value.toArray()}|${f.conePos.value.toArray()}`;
    if (key !== this.fxKey) {
      this.fxKey = key;
      this.attach();
      this.touch();
    }
  }

  private touch(): void {
    for (const p of this.parts) if (p.visible) p.updateVersion();
  }

  dispose(): void {
    this.disposed = true;
    const original = this.host.mesh();
    if (original && this.parts.length) original.visible = true;
    for (const p of this.parts) {
      p.removeFromParent();
      p.dispose();
    }
    this.parts = [];
  }
}

/** The small desktop legend shown while the reality check is on. */
export class RealityLegend {
  readonly el: HTMLElement;
  private pct: HTMLElement[] = [];

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'dvs-reality';
    this.el.setAttribute('aria-live', 'polite');
    const title = document.createElement('div');
    title.className = 'dvs-reality__title';
    title.textContent = 'REALITY CHECK';
    const row = (label: string, color: string) => {
      const r = document.createElement('div');
      r.className = 'dvs-reality__row';
      const dot = document.createElement('span');
      dot.className = 'dvs-reality__dot';
      dot.style.background = color;
      const l = document.createElement('span');
      l.textContent = label;
      const p = document.createElement('span');
      p.className = 'dvs-reality__pct';
      this.pct.push(p);
      r.append(dot, l, p);
      return r;
    };
    this.el.append(title, row('Captured by the camera', '#f4f1ea'), row('Imagined', '#8c5cff'));
    root.append(this.el);
  }

  set(on: boolean, report: RealityReport | null): void {
    this.el.classList.toggle('is-on', on);
    if (report) {
      const seen = Math.round(report.seenFraction * 100);
      this.pct[0].textContent = `${seen}%`;
      this.pct[1].textContent = `${100 - seen}%`;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
