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

/**
 * The mode as the HTTP API and /ws report it (team/contracts.md 4.1): `photo` (rentfree and reconstruct), `video`
 * (thirdwheel) or `sample`. The server stores the internal ids above; every response maps them (server/copy.ts
 * publicScene), so clients must accept both spellings.
 */
export type PublicMode = 'photo' | 'video' | 'sample';

/** A Scene as the API sends it: public mode name, and `stage`, `progress` and `error` always present. */
export type PublicScene = Omit<Scene, 'mode' | 'error' | 'stage' | 'progress'> & {
  mode: PublicMode;
  stage: string;
  progress: number;
  error: string | null;
};

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
  /**
   * The floor plan the map bake writes (contracts 4.2): an orthographic view from above, ceiling cut off, covering
   * exactly `min` to `max` in (x, z). Image right = +X, image down = +Z. Relative to the scene directory.
   */
  topdown?: { file: string; min: [number, number]; max: [number, number] };
  /** Optional collider mesh (GLB) in the same file frame as the splat. */
  collider?: string;
  source: 'flashworld' | 'anysplat' | 'marble-sample' | 'plate-depth' | 'other';
  splatCount?: number;
  /**
   * Drawn behind the splats where they leave holes (pipeline/backdrop.py, web/src/viewer/backdrop.ts). Without it the
   * viewer looks for backdrop.json next to the world, which holds the same fields.
   */
  backdrop?: BackdropAsset;
}

/** A world's backdrop: its photo-textured room as a mesh and its sky. Files are relative to the scene directory. */
export interface BackdropAsset {
  /** GLB in the room frame: the viewer frame's axes, metres, floor at y = 0. */
  file: string;
  /** Equirect sky image (three.js convention, the viewer frame's axes), when there is one. */
  sky?: string | null;
  /** Height of the room frame's y = 0 in the viewer frame (the floor the room frame subtracted). Default 0. */
  floorY?: number;
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
  /**
   * Optional full-3D people from this clip (pipeline/avatar), drawn in place of the relief away from the recording
   * camera. The list form is what avatar.json's `sceneAddition` writes: GLBs (and avatar.json) in this scene's folder.
   */
  avatars?: VideoAvatars | AvatarFile[];
}

/** One person's GLB from pipeline/avatar. */
export interface AvatarFile {
  /** Relative to the folder that holds the people (see VideoAvatars.scene). */
  file: string;
  /** The person's id in avatar.json ('person-0', ...), which carries their time range. */
  id?: string;
}

/**
 * Where a Video memory's people are. Each is a skinned, textured GLB at identity in the viewer frame (y up, metres,
 * floor y = 0) under the video layer's parent, with one animation 'video' keyed in seconds of the played media element
 * minus `start`. avatar.json next to the GLBs lists the people, their time ranges, `start` and the credits.
 */
export interface VideoAvatars {
  /**
   * The scene whose folder holds the files. Omitted: this scene's own folder. A memory filmed in a place names that
   * place's scene, whose folder already has the people built from the clip.
   */
  scene?: string;
  /** avatar.json in that folder (default 'avatar.json'). */
  json?: string;
  /** Only these people. Omitted: everyone avatar.json lists. */
  people?: AvatarFile[];
  /** Media time at which the animation's t = 0 plays, when it differs from avatar.json's `start`. */
  start?: number;
  /**
   * The recording camera per frame (<clip>-poses.json from pipeline/recon: `track` of {time, position, quaternion} in
   * the viewer frame, time = seconds of the played media) in that folder, for a handheld clip's crossfade.
   */
  poses?: string;
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
  /**
   * 'guide': `caption` is the guide's description of the input photo (POST /describe at upload). It is also the
   * world model's text prompt and survives the job's own result caption.
   */
  captionSource?: 'guide';
  /** true: a test build kept out of GET /api/scenes (every list of worlds); it still opens by its id. */
  unlisted?: boolean;
}

export interface HealthInfo {
  ok: true;
  version: string;
  https: boolean;
  lan: string[];
  /** `user` (the cluster account) is only in the server's own copy; /api/health and /ws leave it out. */
  hpg: { online: boolean; user?: string; worker: { alive: boolean; host?: string; gpu?: string; lastBeat?: string } };
  space: { available: boolean };
  local: { python: boolean };
}

/**
 * A Roblox moment relayed to the viewer (team/contracts.md 6.4): `tag` ({by, target}) or `round` ({state, scores}).
 * `t` is Unix seconds on the server's clock; tag events also carry the target's `pos` (room-frame metres) and
 * `targetName`. Unknown types pass through with their simple fields.
 */
export interface RobloxEvent {
  type: string;
  t: number;
  [k: string]: unknown;
}

/** A sticky note left in a world (contracts 7.2). Position in room-frame metres; createdAt is ISO UTC. */
export interface SceneNote {
  id: string;
  sceneId: string;
  author: string;
  text: string;
  x: number;
  y: number;
  z: number;
  createdAt: string;
}

/** A host cue (contracts 11): flip the reality check, show or hide labels, or load another world (follow mode). */
export interface HostCue {
  action: 'reality' | 'labels' | 'load';
  on?: boolean;
  /** The world the cue is for (`load`: the world to open). Missing: whatever world is open. */
  sceneId?: string;
  /** Who sent it ('host', 'bot', ...). */
  by?: string;
  /** Unix seconds on the server's clock. */
  at: number;
}

/** A 3D label pinned in a world: room-frame metres (floor at y = 0), plus where it came from in the input image. */
export interface StoredHotspot {
  label: string;
  blurb: string;
  x: number;
  y: number;
  z: number;
  /** Normalized position in the image the guide labelled (0..1, x right, y down), when known. */
  u?: number;
  v?: number;
  source?: string;
}

/**
 * Messages pushed over /ws (contracts 10). Every client ignores types it does not know. On the wire a `scene` is
 * a PublicScene (mode photo / video / sample): server/index.ts maps it when it publishes.
 */
export type ServerEvent =
  | { type: 'scene'; scene: Scene }
  | { type: 'scene_deleted'; id: string }
  | { type: 'health'; health: HealthInfo }
  | { type: 'roblox'; sceneId: string; event: RobloxEvent }
  | { type: 'note'; sceneId: string; note: SceneNote }
  | ({ type: 'cue' } & HostCue)
  | { type: 'hotspots'; sceneId: string; hotspots: StoredHotspot[] };

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
