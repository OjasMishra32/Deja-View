// The contract shared by the server, the viewer and the pipelines.
// Python pipelines write the same shapes as JSON (see docs/ARCHITECTURE.md).

export type Vec3 = [number, number, number];
/** three.js order: x, y, z, w */
export type Quat = [number, number, number, number];

/**
 * rentfree    one photo (or a prompt) -> a generated world that fills in what the camera missed
 * thirdwheel  a video -> generated room + the real footage lifted into 3D, played with its audio
 * reconstruct many photos -> a faithful reconstruction of exactly what was photographed
 * sample      bundled demo content
 */
export type SceneMode = 'rentfree' | 'thirdwheel' | 'reconstruct' | 'sample';

export type SceneStatus = 'queued' | 'uploading' | 'running' | 'downloading' | 'ready' | 'failed';

/** Where a scene's heavy lifting ran. */
export type Backend = 'hpg-worker' | 'hpg-batch' | 'hf-space' | 'local' | 'bundled';

export interface Transform {
  position: Vec3;
  quaternion: Quat;
  /** Uniform scale. */
  scale: number;
}

export interface WorldAsset {
  /** Splat file relative to the scene directory: .spz (preferred) or .ply. */
  file: string;
  /** Maps the file's coordinates into the viewer frame: y-up, metres, camera looking down -Z. */
  transform: Transform;
  /** Floor height in the viewer frame after `transform`. null = viewer estimates it from the splats. */
  floorY: number | null;
  /** Where to stand at load. position.y is the floor height there (eye height is added by the viewer). */
  spawn?: { position: Vec3; yaw: number };
  /** Optional precomputed bounds in the viewer frame. */
  bounds?: { min: Vec3; max: Vec3 };
  /** Optional collider mesh (GLB) in the same file frame as the splat. */
  collider?: string;
  source: 'flashworld' | 'anysplat' | 'marble-sample' | 'plate-depth' | 'other';
  splatCount?: number;
}

/**
 * Packed RGB + depth + mask video, layout 'tw-pack-v1':
 *   full frame = width x (height * 1.5)
 *   rows [0, height)            RGB at width x height
 *   rows [height, height*1.5)   left half: depth (grayscale, width/2 x height/2)
 *                               right half: mask  (grayscale, width/2 x height/2; white = moving foreground)
 * Depth value v in [0,1] (gray/255) decodes as inverse depth: 1/d = 1/far + v * (1/near - 1/far), d in metres.
 */
export interface VideoLayer {
  file: string;
  layout: 'tw-pack-v1';
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
  /** Pinhole intrinsics in pixels of the RGB region. */
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  depth: { encoding: 'inverse'; near: number; far: number };
  /** Video camera pose in the viewer frame (OpenGL camera: looks down -Z, +Y up). */
  cameraPose: { position: Vec3; quaternion: Quat };
  /** Optional people-free background plate (jpg) relative to the scene directory. */
  plate?: string;
}

export interface Scene {
  id: string;
  name: string;
  mode: SceneMode;
  status: SceneStatus;
  /** Human-readable current step, e.g. "Generating the room". */
  stage?: string;
  /** 0..1 when known. */
  progress?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  backend?: Backend;
  /** Thumbnail relative to the scene directory. */
  thumb?: string;
  input?: { files: string[]; prompt?: string };
  world?: WorldAsset;
  video?: VideoLayer;
  /** Free-form notes for the gallery card (e.g. what the AI filled in). */
  caption?: string;
}

export interface HealthInfo {
  ok: true;
  version: string;
  https: boolean;
  lan: string[];
  hpg: { online: boolean; user: string; worker: { alive: boolean; host?: string; gpu?: string; lastBeat?: string } };
  space: { available: boolean };
  local: { python: boolean };
}

/** Messages pushed over /ws. */
export type ServerEvent = { type: 'scene'; scene: Scene } | { type: 'scene_deleted'; id: string } | { type: 'health'; health: HealthInfo };

/** Fragment a pipeline job writes to out/scene.json; the server merges it into the Scene. */
export interface JobResult {
  world?: WorldAsset;
  video?: VideoLayer;
  thumb?: string;
  caption?: string;
}

/** Progress a pipeline job writes to progress.json while it runs. */
export interface JobProgress {
  stage: string;
  progress?: number;
  error?: string;
  done?: boolean;
}
