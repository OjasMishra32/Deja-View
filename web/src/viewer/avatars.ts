// Full-3D people in a Video memory: the skinned, textured GLBs pipeline/avatar builds from the clip (one per person,
// avatar.json next to them, found by avatar-files.ts), played on the video element's clock so you can walk around
// someone while the footage plays, or paused.
//
// Each GLB sits at identity under the video layer's parent (viewer frame, y up, metres, floor y = 0) with its own
// AnimationMixer on the clip 'video'. Every frame sets mixer.setTime(currentTime - start), clamped to the clip and
// the person's track: the mixer never runs on its own clock, so seeking and pausing are exact and a paused video is
// a frozen pose. Skinning runs on the GPU (three's bone texture).
//
// Look: the baked texture is the footage, so the material is unlit (MeshBasicMaterial with the same map, sRGB, no
// tone mapping, no shadows). Fades (track ends, setVisible, the crossfade with the video layer near the recording
// camera) dissolve with alpha hashing: the people stay in the opaque pass and keep writing depth, so the splats
// around them composite exactly as they do at full opacity. Frustum culling uses bounds of the whole clip (the
// skinned vertices sampled over it once at load).

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  approach,
  AVATAR_TUNING,
  blendForDistance,
  CLIP_END_GUARD,
  clipTime,
  mediaTimeOf,
  parseCameraTrack,
  presence,
  trackPositionAt,
  type CameraSample,
  type TimeRange,
} from './avatar-clock.ts';
import { avatarSources, parseAvatarDoc, selectPeople, type AvatarDoc, type AvatarSceneRef, type AvatarSources } from './avatar-files.ts';

/** Anything with the played media's time: the video layer's HTMLVideoElement (or its handle). */
export interface MediaClock {
  readonly currentTime: number;
}

export interface AvatarsOptions {
  /** The scene being viewed (its id and video.avatars). */
  scene: AvatarSceneRef;
  /** The media whose clock the people follow. */
  video: MediaClock;
  /** The video layer's parent: the people's frame. */
  parent: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
  /** Where scene folders are served (default /data/scenes/). */
  root?: string;
  /** Use these files instead of resolving them from `scene`. */
  sources?: AvatarSources;
}

export interface AvatarPersonDebug {
  id: string;
  /** Animation time last applied to the mixer (NaN before the person is first shown). */
  time: number;
  /** Animation time for the media time now. */
  target: number;
  alpha: number;
  visible: boolean;
  timeRange: TimeRange;
}

export interface AvatarsDebug {
  mediaTime: number;
  start: number;
  blend: number;
  coverage: number;
  visible: number;
  opacity: number;
  people: AvatarPersonDebug[];
  failed: string[];
}

export interface AvatarsHandle {
  /** Resolves once every person has loaded or failed (never rejects). */
  readonly ready: Promise<void>;
  /** The people's group, at identity under `parent`. */
  readonly object: THREE.Group;
  /** People loaded so far. */
  readonly count: number;
  /**
   * How much the people stand in for the video layer this frame: 0 with nobody shown, 1 when they are all there.
   * The integrator fades the layer by (1 - coverage).
   */
  readonly coverage: number;
  /** Credits from avatar.json (models and code the people were built with). */
  readonly credits: readonly string[];
  /** Call every frame, after setBlend: reads the media time and poses everyone. Allocation-free. */
  update(dt: number): void;
  /** Distance (m) from the eye to the recording camera at this time: no people within ~0.4 m, all of them past 1.2 m. */
  setBlend(distance: number): void;
  /** Shows or hides the people (fades over 0.3 s). */
  setVisible(on: boolean): void;
  /** Overall opacity, e.g. the memory intro's video alpha (immediate). */
  setOpacity(o: number): void;
  /**
   * World position of the recording camera at the current media time when the scene has its per-frame track
   * (video.avatars.poses, else the memory's own video.cameraTrack), else null: a fixed camera is the video layer's
   * own pose (VideoLayerHandle.object; with a camera track that object sits at the origin, so the track is needed).
   */
  recordingCamera(out: THREE.Vector3): THREE.Vector3 | null;
  debug(): AvatarsDebug;
  dispose(): void;
}

interface Person {
  id: string;
  url: string;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  duration: number;
  range: TimeRange;
  materials: THREE.MeshBasicMaterial[];
  skinned: THREE.SkinnedMesh[];
  /** Animation time last applied (NaN: none yet). */
  time: number;
  alpha: number;
  presence: number;
}

const CLIP_NAME = 'video';
/** Pose samples for the clip bounds (one every this many seconds) and vertices per sample. */
const BOUNDS_STEP = 0.25;
const BOUNDS_VERTICES = 3000;
/** Slack around the sampled bounds: motion between samples (m). */
const BOUNDS_MARGIN = 0.1;

const logged = new Set<string>();
function logOnce(key: string, level: 'info' | 'warn', ...args: unknown[]): void {
  if (logged.has(key)) return;
  logged.add(key);
  console[level]('[avatars]', ...args);
}

/** The material a person is drawn with: unlit, the footage's colours as they are, fading by alpha hashing. */
function unlitMaterial(src: THREE.Material, renderer: THREE.WebGLRenderer): THREE.MeshBasicMaterial {
  let m: THREE.MeshBasicMaterial;
  if ((src as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    m = src as THREE.MeshBasicMaterial;
  } else {
    // a lit material would be black: the worlds have no lights (the splats carry their own colour)
    const s = src as THREE.MeshStandardMaterial;
    m = new THREE.MeshBasicMaterial({
      name: s.name,
      map: s.map ?? null,
      color: s.color ? s.color.clone() : new THREE.Color(1, 1, 1),
      vertexColors: s.vertexColors,
      side: s.side,
      alphaTest: s.alphaTest,
    });
    src.dispose();
  }
  m.toneMapped = false;
  m.fog = false;
  m.transparent = false;
  m.depthWrite = true;
  m.depthTest = true;
  m.alphaHash = true;
  m.opacity = 1;
  if (m.map) {
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  }
  m.needsUpdate = true;
  return m;
}

/**
 * Local bounds of a skinned mesh over its whole clip: the skinned positions of a subset of its vertices at poses
 * spread over the clip, plus a margin. Skins on the CPU with the skeleton's bone matrices (one matrix product per
 * bone per pose, not per vertex), so a 12 s clip costs a few milliseconds.
 */
function clipBounds(mesh: THREE.SkinnedMesh, root: THREE.Object3D, mixer: THREE.AnimationMixer, duration: number, out: THREE.Box3): THREE.Box3 {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const skinIndex = geo.getAttribute('skinIndex');
  const skinWeight = geo.getAttribute('skinWeight');
  const B = mesh.skeleton?.boneMatrices;
  out.makeEmpty();
  if (!pos || !skinIndex || !skinWeight || !B) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    return out.copy(geo.boundingBox!).expandByScalar(BOUNDS_MARGIN);
  }
  const stride = Math.max(1, Math.floor(pos.count / BOUNDS_VERTICES));
  const n = Math.ceil(pos.count / stride);
  // bind-space positions (bindMatrix x position), the joints and weights of each sampled vertex
  const bindPos = new Float32Array(n * 3);
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  for (let k = 0, i = 0; i < pos.count; i += stride, k++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    bindPos[k * 3] = v.x;
    bindPos[k * 3 + 1] = v.y;
    bindPos[k * 3 + 2] = v.z;
    joints[k * 4] = skinIndex.getX(i);
    joints[k * 4 + 1] = skinIndex.getY(i);
    joints[k * 4 + 2] = skinIndex.getZ(i);
    joints[k * 4 + 3] = skinIndex.getW(i);
    weights[k * 4] = skinWeight.getX(i);
    weights[k * 4 + 1] = skinWeight.getY(i);
    weights[k * 4 + 2] = skinWeight.getZ(i);
    weights[k * 4 + 3] = skinWeight.getW(i);
  }
  const bones = mesh.skeleton.bones.length;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const steps = Math.max(1, Math.ceil(duration / BOUNDS_STEP));
  for (let s = 0; s <= steps; s++) {
    mixer.setTime(Math.min((s * duration) / steps, Math.max(0, duration - CLIP_END_GUARD)));
    root.updateMatrixWorld(true);
    mesh.skeleton.update();
    for (let k = 0; k < n; k++) {
      const px = bindPos[k * 3], py = bindPos[k * 3 + 1], pz = bindPos[k * 3 + 2];
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 4; j++) {
        const w = weights[k * 4 + j];
        if (w === 0) continue;
        const b = joints[k * 4 + j];
        if (b >= bones) continue;
        const o = b * 16;
        x += w * (B[o] * px + B[o + 4] * py + B[o + 8] * pz + B[o + 12]);
        y += w * (B[o + 1] * px + B[o + 5] * py + B[o + 9] * pz + B[o + 13]);
        z += w * (B[o + 2] * px + B[o + 6] * py + B[o + 10] * pz + B[o + 14]);
      }
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
  }
  if (!(x1 >= x0)) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    return out.copy(geo.boundingBox!).expandByScalar(BOUNDS_MARGIN);
  }
  // skinned positions are in the skeleton's frame; the mesh's own frame is bindMatrixInverse of it
  out.min.set(x0, y0, z0);
  out.max.set(x1, y1, z1);
  return out.applyMatrix4(mesh.bindMatrixInverse).expandByScalar(BOUNDS_MARGIN);
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      for (const value of Object.values(m)) if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      m.dispose();
    }
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
  });
}

export function createAvatars(opts: AvatarsOptions): AvatarsHandle {
  const { video, parent, renderer } = opts;
  const T = AVATAR_TUNING;
  const group = new THREE.Group();
  group.name = 'deja-view-avatars';
  parent.add(group);

  const people: Person[] = [];
  const failed: string[] = [];
  let credits: string[] = [];
  let doc: AvatarDoc | null = null;
  let start = 0;
  let mediaEnd: number | null = null;
  let slack: number = T.edgeSlack;
  let track: CameraSample[] | null = null;
  let blend = 1;
  let visibleTarget = 1;
  let visible = 0; // fades in once the people are there
  let opacity = 1;
  let coverage = 0;
  let disposed = false;
  /** Settles once the recording camera track is known (or not used): nobody is shown before it. */
  let trackKnown: Promise<void> = Promise.resolve();

  const sources = opts.sources ?? avatarSources(opts.scene, opts.root);
  const loader = new GLTFLoader();

  async function fetchJson(url: string): Promise<unknown | null> {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function loadPerson(id: string, url: string, range: TimeRange): Promise<void> {
    let gltf: GLTF;
    try {
      gltf = await loader.loadAsync(url);
    } catch (e) {
      failed.push(id);
      logOnce(`load:${url}`, 'warn', `${id} not loaded from ${url}:`, e instanceof Error ? e.message : e);
      return;
    }
    const root = gltf.scene;
    if (disposed) {
      disposeObject(root);
      return;
    }
    const clip = gltf.animations.find((a) => a.name === CLIP_NAME) ?? null;
    if (!clip) {
      // without its animation a person would stand in the bind pose wherever the pipeline left the skeleton
      failed.push(id);
      logOnce(`clip:${url}`, 'warn', `${id} (${url}) has no '${CLIP_NAME}' animation; not shown`);
      disposeObject(root);
      return;
    }
    root.name = `avatar-${id}`;
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.scale.setScalar(1);
    const materials: THREE.MeshBasicMaterial[] = [];
    const skinned: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => unlitMaterial(m, renderer));
      else mesh.material = unlitMaterial(mesh.material, renderer);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.push(m as THREE.MeshBasicMaterial);
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
    });
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    // frustum culling with bounds that hold for the whole clip (three would otherwise bound the first pose only)
    root.updateMatrixWorld(true);
    for (const mesh of skinned) {
      const box = clipBounds(mesh, root, mixer, clip.duration, new THREE.Box3());
      mesh.boundingBox = box;
      mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      mesh.frustumCulled = true;
    }
    // upload the texture and compile the program now rather than on the frame the person first shows
    let compiled: Promise<unknown> = Promise.resolve();
    try {
      for (const m of materials) if (m.map) renderer.initTexture(m.map);
      let top: THREE.Object3D = group;
      while (top.parent) top = top.parent;
      // (compileAsync gathers the programs synchronously, then waits for the driver)
      compiled = renderer.compileAsync(root, new THREE.PerspectiveCamera(), top as THREE.Scene);
    } catch {
      /* uploaded and compiled on first draw instead */
    }
    root.visible = false;
    // (shown only once the crossfade knows where the recording camera is)
    await Promise.all([compiled.catch(() => undefined), trackKnown]);
    if (disposed) {
      disposeObject(root);
      return;
    }
    group.add(root);
    people.push({ id, url, root, mixer, duration: clip.duration, range, materials, skinned, time: NaN, alpha: 0, presence: 0 });
  }

  const ready = (async () => {
    if (!sources) {
      logOnce(`none:${opts.scene.id}`, 'info', `no people folder for ${opts.scene.id}`);
      return;
    }
    const raw = await fetchJson(sources.json);
    if (disposed) return;
    doc = raw ? parseAvatarDoc(raw, sources.json) : null;
    start = sources.start ?? doc?.start ?? 0;
    mediaEnd = doc?.mediaDuration != null ? doc.mediaDuration - start : null;
    slack = Math.max(T.edgeSlack, doc?.fps ? 2 / doc.fps : 0);
    credits = doc?.credits ?? [];
    let list = selectPeople(sources, doc);
    if (!list.length) {
      if (sources.explicit || raw) logOnce(`empty:${sources.json}`, 'warn', `no people to load (${sources.json} ${raw ? 'lists none' : 'is missing'})`);
      else logOnce(`none:${sources.json}`, 'info', `no people for ${opts.scene.id}`);
      return;
    }
    if (list.length > T.maxPeople) {
      logOnce(`many:${sources.json}`, 'warn', `${list.length} people; showing the first ${T.maxPeople}`);
      list = list.slice(0, T.maxPeople);
    }
    // the recording camera (only needed with people to crossfade), while the people load
    const posesUrl = sources.poses;
    if (posesUrl) {
      trackKnown = fetchJson(posesUrl).then((d) => {
        if (disposed) return;
        track = parseCameraTrack(d);
        if (!track) logOnce(`poses:${posesUrl}`, 'warn', `recording camera track ${posesUrl} not usable; the crossfade uses the video layer's pose`);
      });
    }
    await Promise.all(list.map((p) => loadPerson(p.id, p.url, p.timeRange)));
    // keep avatar.json's order whatever finished loading first
    people.sort((a, b) => list.findIndex((p) => p.id === a.id) - list.findIndex((p) => p.id === b.id));
  })().catch((e) => {
    logOnce(`ready:${opts.scene.id}`, 'warn', 'people not loaded:', e);
  });

  const handle: AvatarsHandle = {
    ready,
    object: group,
    get count() {
      return people.length;
    },
    get coverage() {
      return coverage;
    },
    get credits() {
      return credits;
    },
    update(dt: number) {
      if (disposed) return;
      if (!people.length) {
        coverage = 0;
        return;
      }
      visible = approach(visible, visibleTarget, dt > 0 ? dt / T.visibleFade : 1);
      const media = mediaTimeOf(video);
      const shared = blend * visible;
      let present = 0;
      for (let i = 0; i < people.length; i++) {
        const p = people[i];
        p.presence = presence(media, start, p.range, mediaEnd, T.edgeFade, slack);
        if (p.presence > present) present = p.presence;
        const a = p.presence * shared * opacity;
        const show = a > T.minAlpha;
        p.root.visible = show;
        if (!show) {
          p.alpha = 0;
          continue;
        }
        const t = clipTime(media, start, p.duration, p.range);
        if (t !== p.time) {
          p.mixer.setTime(t);
          p.time = t;
        }
        const alpha = a > 0.999 ? 1 : a;
        if (alpha !== p.alpha) {
          p.alpha = alpha;
          for (let m = 0; m < p.materials.length; m++) p.materials[m].opacity = alpha;
        }
      }
      coverage = shared * present;
    },
    setBlend(distance: number) {
      blend = blendForDistance(distance, T.blendNear, T.blendFar);
    },
    setVisible(on: boolean) {
      visibleTarget = on ? 1 : 0;
    },
    setOpacity(o: number) {
      opacity = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1;
    },
    recordingCamera(out: THREE.Vector3) {
      if (!track) return null;
      trackPositionAt(track, mediaTimeOf(video), out);
      group.updateWorldMatrix(true, false);
      return out.applyMatrix4(group.matrixWorld);
    },
    debug() {
      const media = mediaTimeOf(video);
      return {
        mediaTime: media,
        start,
        blend,
        coverage,
        visible,
        opacity,
        people: people.map((p) => ({
          id: p.id,
          time: p.time,
          target: clipTime(media, start, p.duration, p.range),
          alpha: p.alpha,
          visible: p.root.visible,
          timeRange: p.range,
        })),
        failed: failed.slice(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of people) {
        p.mixer.stopAllAction();
        p.mixer.uncacheRoot(p.root);
        disposeObject(p.root);
      }
      people.length = 0;
      group.removeFromParent();
      track = null;
      coverage = 0;
    },
  };
  return handle;
}
