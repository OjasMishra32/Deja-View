// The backdrop: what shows where the splat world has no coverage. A reconstruction only knows what its footage saw,
// so a ceiling nobody filmed, the sky over a lawn or the top of a palm tree is a hole, and through a hole the viewer
// used to show its flat sky gradient. When the scene has a backdrop (pipeline/backdrop.py: backdrop.glb, the scene's
// photo-textured Roblox room in metres, and backdrop-sky.jpg, its sky as one equirect image), those holes show real
// surfaces instead.
//
// Draw order, all before anything else (the gradient SkyDome is -1000):
//   -995  the room, unlit, writing depth so it hides its own back walls;
//   -990  the sky image at infinity, depth-tested, so it only fills what the room leaves open;
//   -985  a depth clear: the splats (transparent, depth-tested) and every other object draw as if the backdrop were
//         not there, so the splats always composite over it and it only shows where they leave alpha.
// Once the sky image covers everything the SkyDome is hidden (one full-screen pass fewer in the headset).
//
// It fades with the world: the room only shows inside the reveal front (SplatFx, the same front the splats grow
// with on load and in the memory intro), the sky image follows the SkyDome's own fade from the dark space of the
// memory intro to the world's sky, and both hide while the world's splat mesh is hidden (the reality check).
//
// ?backdrop=0 turns it off, ?backdrop=1 looks for one in any scene. window.__viewerBackdrop drives it in tests.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { BackdropAsset, Scene } from '../../../shared/types.ts';
import type { SkyPalette } from './analysis.ts';
import type { SkyDome, SplatFx } from './effects.ts';
import { DARK_SKY } from './memory-intro.ts';

/** What the backdrop needs from the viewer (app.ts's Viewer has all of it). */
export interface BackdropHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** The world's parent: the splat mesh hangs under it with the scene transform, the backdrop with its floor. */
  readonly flip: THREE.Object3D;
  readonly mesh: SplatMesh | null;
  readonly fx: SplatFx;
  readonly sky: SkyDome;
  readonly data: Scene;
  readonly analysis: { palette: SkyPalette } | null;
}

export const ORDER = { room: -995, sky: -990, clear: -985 } as const;
const APPEAR_S = 0.6;
/** Reveal radius at or above which the world counts as fully shown (SplatFx parks it at 1e5). */
const SHOWN = 1e4;

/** What backdrop.json (or world.backdrop) says, resolved against the scene folder. */
export interface BackdropRef extends BackdropAsset {
  base: string;
}

/** world.backdrop when the scene names one, else backdrop.json next to the world (photo worlds, or ?backdrop=1). */
export async function findBackdrop(scene: Scene, base: string, force = false): Promise<BackdropRef | null> {
  const named = scene.world?.backdrop;
  if (named && typeof named.file === 'string') return { ...named, base };
  const mode = scene.mode as string;
  if (!force && mode !== 'photo' && mode !== 'reconstruct') return null;
  try {
    const res = await fetch(`${base}backdrop.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<BackdropAsset>;
    if (typeof m.file !== 'string' || !m.file) return null;
    return { file: m.file, sky: typeof m.sky === 'string' ? m.sky : null, floorY: Number(m.floorY) || 0, base };
  } catch {
    return null;
  }
}

const ROOM_VERT_DECL = /* glsl */ `
varying vec3 vBdWorld;`;
const ROOM_VERT = /* glsl */ `
vBdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`;
const ROOM_FRAG_DECL = /* glsl */ `
uniform float uBdFront;
uniform float uBdBand;
uniform vec3 uBdOrigin;
uniform float uBdOpacity;
varying vec3 vBdWorld;`;
// the same front as SplatFx: shown inside `front`, fading over `band` metres behind it
const ROOM_FRAG = /* glsl */ `
#ifdef BD_FADE
  float bdBw = max(uBdBand, 1e-3);
  float bdShown = (1.0 - smoothstep(uBdFront - bdBw, uBdFront, distance(vBdWorld, uBdOrigin))) * uBdOpacity;
  if (bdShown < 0.004) discard;
  gl_FragColor.a = bdShown;
#endif`;

interface RoomUniforms {
  uBdFront: THREE.IUniform<number>;
  uBdBand: THREE.IUniform<number>;
  uBdOrigin: THREE.IUniform<THREE.Vector3>;
  uBdOpacity: THREE.IUniform<number>;
}

/** Unlit, sRGB map, writes depth; while the world fades in, alpha-blended and cut at the reveal front. */
function roomMaterial(map: THREE.Texture | null, u: RoomUniforms, maxAniso: number): THREE.MeshBasicMaterial {
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.min(4, maxAniso);
  }
  const m = new THREE.MeshBasicMaterial({ map, color: 0xffffff, side: THREE.FrontSide, depthTest: true, depthWrite: true, fog: false });
  m.toneMapped = false;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${ROOM_VERT_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>${ROOM_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${ROOM_FRAG_DECL}`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>${ROOM_FRAG}`);
  };
  m.customProgramCacheKey = () => 'dv-backdrop-room';
  return m;
}

/** The sky image on a sphere around the eye, at the far plane, oriented like the world. */
function skyMesh(map: THREE.Texture): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  map.colorSpace = THREE.NoColorSpace; // sRGB values written straight out, like the SkyDome
  map.generateMipmaps = false; // magnified everywhere; mips would draw a line down the atan seam
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, opacity: { value: 1 } },
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // on the far plane: drawn only where the room left the depth buffer clear
        gl_Position.z = gl_Position.w * 0.999999;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float opacity;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        // three.js equirect convention (pipeline/backdrop.py writes the image for it)
        vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309189535 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5);
        gl_FragColor = vec4(texture2D(map, uv).rgb, opacity);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(380, 48, 24), material);
  mesh.name = 'backdrop-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = ORDER.sky;
  mesh.matrixAutoUpdate = false;
  return { mesh, material };
}

/** Clears the depth buffer when drawn (it draws nothing itself). */
function depthClear(): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  m.name = 'backdrop-depth-clear';
  m.frustumCulled = false;
  m.renderOrder = ORDER.clear;
  m.onBeforeRender = (renderer) => renderer.clearDepth();
  return m;
}

/** How far the SkyDome is from the memory intro's dark space toward the world's own sky (0..1). */
function skyFade(sky: SkyDome, palette: SkyPalette | null): number {
  if (!palette) return 1;
  const u = (sky.mesh.material as THREE.ShaderMaterial).uniforms;
  let num = 0, den = 0;
  for (const k of ['top', 'horizon', 'bottom'] as const) {
    const cur = u[k]?.value as THREE.Vector3 | undefined;
    if (!cur) return 1;
    const dark = DARK_SKY[k], want = palette[k];
    for (let i = 0; i < 3; i++) {
      const w = want[i]! - dark[i]!;
      num += (cur.getComponent(i) - dark[i]!) * w;
      den += w * w;
    }
  }
  return den > 1e-8 ? THREE.MathUtils.clamp(num / den, 0, 1) : 1;
}

function shownInScene(o: THREE.Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return !!o;
}

export interface BackdropStats {
  file: string;
  sky: string | null;
  meshes: number;
  triangles: number;
  textures: number;
  loadMs: number;
}

export class Backdrop {
  /** The room under the world's parent (floor shift included). */
  readonly root = new THREE.Group();
  enabled = true;
  /** Measurement switches: the room and the sky image on their own. */
  roomOn = true;
  skyOn = true;
  private readonly uniforms: RoomUniforms = {
    uBdFront: { value: SHOWN * 10 },
    uBdBand: { value: 0.8 },
    uBdOrigin: { value: new THREE.Vector3() },
    uBdOpacity: { value: 1 },
  };
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly clear = depthClear();
  private skyMat: THREE.ShaderMaterial | null = null;
  private skyObj: THREE.Mesh | null = null;
  private readonly worldQuat = new THREE.Quaternion();
  private fading: boolean | null = null;
  private skyOpaque: boolean | null = null;
  private domeHidden = false;
  /** 0 -> 1 over APPEAR_S from mount: a backdrop that arrives after the world fades in rather than pops. */
  private appear = 0;
  private last = 0;
  private prevHook: THREE.Scene['onBeforeRender'] | null = null;
  readonly stats: BackdropStats;

  constructor(private readonly host: BackdropHost, room: THREE.Object3D, sky: THREE.Texture | null, ref: BackdropRef, loadMs: number) {
    this.root.name = 'backdrop';
    this.root.position.y = ref.floorY ?? 0;
    const maxAniso = host.renderer.capabilities.getMaxAnisotropy();
    let triangles = 0, meshes = 0;
    const textures = new Set<THREE.Texture>();
    room.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshBasicMaterial;
      const map = (old as { map?: THREE.Texture | null }).map ?? null;
      if (map) textures.add(map);
      const mat = roomMaterial(map, this.uniforms, maxAniso);
      old.dispose();
      mesh.material = mat;
      mesh.renderOrder = ORDER.room;
      this.materials.push(mat);
      meshes++;
      const g = mesh.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    this.root.add(room, this.clear);
    if (sky) {
      const s = skyMesh(sky);
      this.skyObj = s.mesh;
      this.skyMat = s.material;
      this.skyObj.onBeforeRender = (_r, _s, camera) => {
        // centred on whichever camera draws (desktop or each XR eye), turned like the world
        this.skyObj!.position.setFromMatrixPosition(camera.matrixWorld);
        this.skyObj!.quaternion.copy(this.worldQuat);
        this.skyObj!.updateMatrix();
        this.skyObj!.matrixWorld.copy(this.skyObj!.matrix);
      };
    }
    this.stats = { file: ref.file, sky: ref.sky ?? null, meshes, triangles, textures: textures.size, loadMs: Math.round(loadMs) };
    this.setFading(false);
  }

  /** Puts it in the scene and starts following the world. */
  mount(): void {
    this.host.flip.add(this.root);
    if (this.skyObj) this.host.scene.add(this.skyObj);
    const scene = this.host.scene;
    this.prevHook = scene.onBeforeRender;
    const prev = this.prevHook;
    scene.onBeforeRender = (...args) => {
      prev.apply(scene, args);
      this.update();
    };
    this.update();
  }

  dispose(): void {
    if (this.prevHook) this.host.scene.onBeforeRender = this.prevHook;
    this.prevHook = null;
    this.root.removeFromParent();
    this.skyObj?.removeFromParent();
    if (this.domeHidden) this.host.sky.mesh.visible = true;
    this.domeHidden = false;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
    this.skyMat?.uniforms.map?.value?.dispose();
    this.skyMat?.dispose();
    this.skyObj?.geometry.dispose();
  }

  /** Once per frame, before the scene is drawn. */
  update(): void {
    const host = this.host;
    const now = performance.now();
    if (this.last) this.appear = Math.min(1, this.appear + Math.min(0.1, (now - this.last) / 1000) / APPEAR_S);
    this.last = now;
    const world = host.mesh;
    const on = this.enabled && !!world && world.visible && shownInScene(host.flip);
    this.root.visible = on && this.roomOn;
    // the reveal front the splats grow with
    const fx = host.fx;
    const front = fx.reveal.value as number;
    const u = this.uniforms;
    u.uBdFront.value = front;
    u.uBdBand.value = fx.revealBand.value as number;
    u.uBdOrigin.value.copy(fx.origin.value as THREE.Vector3);
    u.uBdOpacity.value = this.appear;
    this.setFading(front < SHOWN || u.uBdOpacity.value < 0.999);
    // the sky image: turned like the world, faded like the SkyDome
    const showSky = on && this.skyOn && !!this.skyObj;
    let fade = 0;
    if (this.skyObj && this.skyMat) {
      this.skyObj.visible = showSky;
      if (showSky) {
        host.flip.getWorldQuaternion(this.worldQuat);
        fade = skyFade(host.sky, host.analysis?.palette ?? null) * this.appear;
        this.skyMat.uniforms.opacity!.value = fade;
        this.setSkyOpaque(fade >= 0.999);
      }
    }
    // the gradient dome only matters while the sky image is not fully there
    const hideDome = showSky && fade >= 0.999;
    if (hideDome !== this.domeHidden) {
      host.sky.mesh.visible = !hideDome;
      this.domeHidden = hideDome;
    }
  }

  /** Compiles both room variants (fading and steady) and the sky now, while the loader is still up. */
  async precompile(): Promise<void> {
    const r = this.host.renderer;
    // compile skips hidden objects
    this.root.visible = true;
    if (this.skyObj) this.skyObj.visible = true;
    for (const fade of [true, false]) {
      this.setFading(fade);
      try {
        await r.compileAsync(this.root, this.host.camera, this.host.scene);
        if (this.skyObj) await r.compileAsync(this.skyObj, this.host.camera, this.host.scene);
      } catch {
        /* compiled on first use instead */
      }
    }
    this.update();
  }

  private setFading(on: boolean): void {
    if (on === this.fading) return;
    this.fading = on;
    for (const m of this.materials) {
      // steady state: plain opaque (no blending, no discard, so early depth testing works)
      m.blending = on ? THREE.CustomBlending : THREE.NoBlending;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.defines = on ? { BD_FADE: '' } : {};
      m.needsUpdate = true;
    }
  }

  private setSkyOpaque(on: boolean): void {
    if (!this.skyMat || on === this.skyOpaque) return;
    this.skyOpaque = on;
    this.skyMat.blending = on ? THREE.NoBlending : THREE.CustomBlending;
    this.skyMat.blendSrc = THREE.SrcAlphaFactor;
    this.skyMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.skyMat.needsUpdate = true;
  }

  debug(): Record<string, unknown> {
    return {
      ...this.stats,
      enabled: this.enabled,
      room: this.root.visible,
      sky: !!this.skyObj?.visible,
      skyOpacity: this.skyMat ? Math.round((this.skyMat.uniforms.opacity!.value as number) * 1000) / 1000 : null,
      fading: this.fading,
      domeHidden: this.domeHidden,
    };
  }
}

async function loadRoom(url: string): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  return gltf.scene;
}

async function loadSky(url: string): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.flipY = true;
  return tex;
}

/**
 * Finds and loads the scene's backdrop and puts it under the world. Never throws: a scene without one, or a
 * backdrop that fails to load, leaves the viewer as it was.
 */
export async function attachBackdrop(host: BackdropHost): Promise<Backdrop | null> {
  const params = new URLSearchParams(location.search);
  const want = params.get('backdrop');
  if (want === '0') return null;
  const base = `/data/scenes/${encodeURIComponent(host.data.id)}/`;
  const info = (window as unknown as { __viewer?: { info?: Record<string, unknown> } }).__viewer?.info;
  try {
    const t0 = performance.now();
    const ref = await findBackdrop(host.data, base, want === '1');
    if (!ref) return null;
    const [room, sky] = await Promise.all([
      loadRoom(ref.base + ref.file),
      ref.sky ? loadSky(ref.base + ref.sky).catch((e) => {
        console.warn('backdrop sky not loaded', e);
        return null;
      }) : Promise.resolve(null),
    ]);
    const bd = new Backdrop(host, room, sky, ref, performance.now() - t0);
    // upload the textures and compile the shaders now, not on the first frame that shows them
    room.traverse((o) => {
      const map = ((o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined)?.map;
      if (map) host.renderer.initTexture(map);
    });
    if (sky) host.renderer.initTexture(sky);
    bd.mount();
    await bd.precompile();
    (window as unknown as { __viewerBackdrop: Backdrop }).__viewerBackdrop = bd;
    if (info) Object.defineProperty(info, 'backdrop', { get: () => bd.debug(), enumerable: true, configurable: true });
    return bd;
  } catch (e) {
    console.warn('backdrop not shown', e);
    if (info) info.backdrop = { error: e instanceof Error ? e.message : String(e) };
    return null;
  }
}
