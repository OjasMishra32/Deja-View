// Product copy the server writes into scenes and API errors, plus the public names of the modes.
//
// Everything a person can read (Scene.stage, Scene.error, Scene.caption, API error bodies) is a short product
// sentence written here or at its source. Technical detail (backend names, exit codes, tool output) goes to the
// scene's log.txt or the server console only.

import type { SceneMode } from '../shared/types.ts';

export const PRODUCT = 'Déjà View';

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
