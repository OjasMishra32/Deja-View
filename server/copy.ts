// Product copy the server writes into scenes and API errors, plus the public names of the modes.
//
// Everything a person can read (Scene.stage, Scene.error, Scene.caption, API error bodies) is a short product
// sentence written here or at its source. Technical detail (backend names, exit codes, tool output) goes to the
// scene's log.txt or the server console only.

import type { PublicMode, PublicScene, Scene, SceneMode, SceneStatus } from '../shared/types.ts';

export const PRODUCT = 'Déjà View';

/** The mode name the API reports (contracts 4.1): video for thirdwheel, sample for samples, photo for every place. */
export function publicMode(mode: unknown): PublicMode {
  if (mode === 'thirdwheel' || mode === 'video') return 'video';
  if (mode === 'sample') return 'sample';
  return 'photo';
}

/** The job's own captions say how a world was made, not what is in it (pipeline/run_job.py, bundled samples). */
const PIPELINE_CAPTION =
  /^(generated from (one photo|the sharpest frame|your prompt)|built from the depth|the room (is built|was imagined) from|room generated from|this clip has no sound|sample world|synthetic rgbd clip)/i;

/** True for a caption that only describes the pipeline ("Generated from one photo: ..."), never the place. */
export function isPipelineCaption(caption: string | null | undefined): boolean {
  return !!caption && PIPELINE_CAPTION.test(caption.trim());
}

/** Whether a scene is a Video memory (it stays in the headset and the browser; no Roblox room). */
export function isVideoScene(scene: Pick<Scene, 'mode' | 'video'> | null | undefined): boolean {
  return !!scene && (publicMode(scene.mode) === 'video' || !!scene.video);
}

const DEFAULT_STAGE: Record<SceneStatus, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  running: 'Building',
  downloading: 'Finishing',
  ready: 'Ready',
  failed: 'Failed',
};

/**
 * A scene as the API and /ws send it (contracts 4.1, 4.2): `mode` as photo / video / sample, and `stage`,
 * `progress` and `error` always present (a ready scene reads stage "Ready", progress 1, error null). Idempotent.
 */
export function publicScene(scene: Scene | PublicScene): PublicScene {
  const status = scene.status;
  const stage = typeof scene.stage === 'string' && scene.stage.trim() ? scene.stage : (DEFAULT_STAGE[status] ?? 'Building');
  let progress = typeof scene.progress === 'number' && Number.isFinite(scene.progress) ? Math.min(1, Math.max(0, scene.progress)) : null;
  if (status === 'ready') progress = 1;
  const error = status === 'failed' ? (typeof scene.error === 'string' && scene.error ? scene.error : GENERIC_FAILURE.rentfree) : null;
  return { ...scene, mode: publicMode(scene.mode), stage, progress: progress ?? 0, error };
}

/** Modes a scene can be created in. Internal ids stay rentfree/thirdwheel; the app calls them Photo and Video. */
export const UPLOAD_MODES = ['rentfree', 'thirdwheel', 'reconstruct'] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

/** Public names accepted by the API next to the internal ids. */
export const MODE_ALIASES: Record<string, UploadMode> = {
  photo: 'rentfree',
  video: 'thirdwheel',
  rentfree: 'rentfree',
  thirdwheel: 'thirdwheel',
  reconstruct: 'reconstruct',
};

/** Maps "photo", "Video", "rentfree" ... to the internal mode id, or null. */
export function normalizeMode(raw: unknown): UploadMode | null {
  if (typeof raw !== 'string') return null;
  return MODE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** The 400 message for a missing or unknown mode. */
export function unknownModeMessage(raw: string | null | undefined): string {
  const r = (raw ?? '').trim();
  return r ? `Unknown mode "${r.slice(0, 40)}". Use photo or video.` : 'Choose a mode: photo or video.';
}

/** The name a person sees for a mode. */
export const MODE_NAME: Record<SceneMode, string> = {
  rentfree: 'Photo',
  thirdwheel: 'Video',
  reconstruct: 'Reconstruct',
  sample: 'Sample',
};

/** Where a job runs, as stage copy: "Starting on the GPU cluster". Never a vendor or project name. */
export const PLACE = {
  cluster: 'the GPU cluster',
  cloud: 'the cloud GPU',
  laptop: 'this laptop',
} as const;

/** Shown when a job failed and no step gave a more specific reason. */
export const GENERIC_FAILURE: Record<SceneMode, string> = {
  rentfree: "We couldn't build this world. Try again in a minute.",
  thirdwheel: "We couldn't turn this video into a room. Try again in a minute.",
  reconstruct: "We couldn't reconstruct this place. Try again in a minute.",
  sample: "This sample couldn't be loaded.",
};

/** Shown when nothing could even start the job (every GPU offline or busy, nothing installed locally). */
export const NOTHING_AVAILABLE = 'No GPU is free to build this right now. Try again in a few minutes.';

export function waitingInLine(ahead: number): string {
  return ahead > 0 ? `Waiting in line (${ahead} ahead)` : 'Waiting in line';
}

/** API error sentences (the JSON body is always { error: <one of these> }). */
export const API = {
  noScene: 'This scene no longer exists.',
  sampleDelete: 'Samples are part of the demo and stay in the gallery.',
  sampleRetry: 'Samples are ready as they are, so there is nothing to rebuild.',
  busy: 'This scene is already being built.',
  method: 'That request is not supported here.',
  route: 'That API route does not exist.',
  badPath: 'That file path is not allowed.',
  notFound: 'Not found.',
  formOnly: 'Send the upload as a form with a mode and files.',
  unreadable: 'The upload did not arrive in one piece. Try again.',
  saveFailed: 'Something went wrong while saving the upload. Try again.',
  server: 'Something went wrong on the server. Try again.',
  notAllowed: `This action only works from the ${PRODUCT} app.`,
} as const;

export function tooBigMessage(bytes: number | null, limitBytes: number): string {
  const limit = `${(limitBytes / 1024 ** 3).toFixed(0)} GB`;
  return bytes ? `This upload is too big (${(bytes / 1024 ** 3).toFixed(1)} GB). The limit is ${limit}.` : `This upload is too big. The limit is ${limit}.`;
}

/** Ends a sentence with a full stop when it has no closing punctuation. */
export function sentence(s: string): string {
  const t = s.trim();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
}
