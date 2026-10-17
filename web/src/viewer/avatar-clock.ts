// The media clock for the full-3D people of a Video memory (avatars.ts): which animation time a media time shows,
// how present a person is at the ends of their track, how the people crossfade with the video layer near the
// recording camera, and where that camera was (a handheld clip's <clip>-poses.json track). Pure functions, no
// allocations on the per-frame paths; tests/viewer-avatars.test.ts covers them.

export const AVATAR_TUNING = {
  /** Fade in after a track starts and out before it ends, in seconds of media time. */
  edgeFade: 0.3,
  /**
   * A track that starts or ends within this of the media's own start or end (seconds; avatars.ts widens it to two
   * frames of the clip) has no fade there: the person is in the very first or last frame, and the clip loops.
   */
  edgeSlack: 0.05,
  /** Crossfade with the video layer: no people within blendNear metres of the recording camera, all of them past blendFar. */
  blendNear: 0.4,
  blendFar: 1.2,
  /** setVisible fades over this many seconds of wall time. */
  visibleFade: 0.3,
  /** Below this opacity a person is not drawn at all. */
  minAlpha: 0.004,
  /** People per memory: each is a 25k-triangle skinned mesh, and the headset holds 72 fps with a few. */
  maxPeople: 4,
};

/** Kept below a clip's end: a looping action wraps setTime(duration) back to the first frame. */
export const CLIP_END_GUARD = 1e-4;

/** [start, end] of a person's track in animation seconds; null = the whole clip. */
export type TimeRange = readonly [number, number] | null;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A media element's time, 0 until it is known. */
export function mediaTimeOf(clock: { readonly currentTime: number } | null | undefined): number {
  const t = clock ? clock.currentTime : 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Animation time shown at media time t: t - start, clamped to the clip [0, duration) and held inside the person's
 * track. Never wraps, so a paused or seeked element gives exactly its frame's pose.
 */
export function clipTime(mediaTime: number, start: number, clipDuration: number, range: TimeRange = null): number {
  const end = Math.max(0, clipDuration - CLIP_END_GUARD);
  let t = clamp((Number.isFinite(mediaTime) ? mediaTime : 0) - start, 0, end);
  if (range && range[1] >= range[0]) t = clamp(t, Math.min(range[0], end), Math.min(range[1], end));
  return t;
}

/**
 * 0..1: how present a person is at media time t. Zero outside their track; ramps of `fade` seconds just inside its
 * ends, except at an end that is also the media's own (within `slack`), where they are simply there.
 * `mediaEnd` is the media's end in animation seconds (mediaDuration - start), or null when unknown.
 */
export function presence(
  mediaTime: number,
  start: number,
  range: TimeRange,
  mediaEnd: number | null,
  fade = AVATAR_TUNING.edgeFade,
  slack = AVATAR_TUNING.edgeSlack,
): number {
  if (!range || !(range[1] >= range[0])) return 1;
  const t = (Number.isFinite(mediaTime) ? mediaTime : 0) - start;
  const [r0, r1] = range;
  const fadeIn = r0 <= slack ? 1 : t < r0 ? 0 : fade > 0 ? smoothstep(0, 1, (t - r0) / fade) : 1;
  const atEnd = mediaEnd !== null && r1 >= mediaEnd - slack;
  const fadeOut = atEnd ? 1 : t > r1 ? 0 : fade > 0 ? smoothstep(0, 1, (r1 - t) / fade) : 1;
  return Math.min(fadeIn, fadeOut);
}

/** How much the people stand in for the video layer at this distance (m) from the recording camera: 0 near, 1 far. */
export function blendForDistance(distance: number, near = AVATAR_TUNING.blendNear, far = AVATAR_TUNING.blendFar): number {
  if (!Number.isFinite(distance)) return 1;
  return smoothstep(near, far, distance);
}

/** Linear step of `value` toward `target` by at most `step`. */
export function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The recording camera of a handheld clip: <clip>-poses.json `track`, one sample per video frame.

export interface CameraSample {
  /** Seconds of the played media. */
  time: number;
  position: readonly [number, number, number] | readonly number[];
  /** xyzw, OpenGL camera (looks down -Z). */
  quaternion: readonly [number, number, number, number] | readonly number[];
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface XYZW extends XYZ {
  w: number;
}

/** Track samples in time order, keeping only well-formed ones (null when none are). */
export function parseCameraTrack(doc: unknown): CameraSample[] | null {
  const track = doc && typeof doc === 'object' ? (doc as { track?: unknown }).track : null;
  if (!Array.isArray(track)) return null;
  const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v));
  const out = track.filter(
    (s): s is CameraSample => !!s && typeof s.time === 'number' && Number.isFinite(s.time) && ok(s.position, 3) && ok(s.quaternion, 4),
  );
  out.sort((a, b) => a.time - b.time);
  return out.length ? out : null;
}

/** Index i with track[i].time <= t < track[i + 1].time (0 before the first, n - 1 after the last). */
export function trackIndex(track: readonly CameraSample[], t: number): number {
  let lo = 0, hi = track.length - 1;
  if (hi <= 0 || t <= track[0].time) return 0;
  if (t >= track[hi].time) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].time <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Recording camera position at media time t (linear between samples, held outside the track), written into out. */
export function trackPositionAt<T extends XYZ>(track: readonly CameraSample[], t: number, out: T): T {
  const i = trackIndex(track, t);
  const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
  const span = b.time - a.time;
  const f = span > 0 ? clamp((t - a.time) / span, 0, 1) : 0;
  out.x = a.position[0] + (b.position[0] - a.position[0]) * f;
  out.y = a.position[1] + (b.position[1] - a.position[1]) * f;
  out.z = a.position[2] + (b.position[2] - a.position[2]) * f;
  return out;
}

/** Recording camera orientation at media time t (normalised lerp along the shorter arc), written into out. */
export function trackQuaternionAt<T extends XYZW>(track: readonly CameraSample[], t: number, out: T): T {
  const i = trackIndex(track, t);
  const a = track[i].quaternion, b = track[Math.min(i + 1, track.length - 1)].quaternion;
  const span = track[Math.min(i + 1, track.length - 1)].time - track[i].time;
  const f = span > 0 ? clamp((t - track[i].time) / span, 0, 1) : 0;
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const x = a[0] + (s * b[0] - a[0]) * f;
  const y = a[1] + (s * b[1] - a[1]) * f;
  const z = a[2] + (s * b[2] - a[2]) * f;
  const w = a[3] + (s * b[3] - a[3]) * f;
  const n = Math.hypot(x, y, z, w) || 1;
  out.x = x / n;
  out.y = y / n;
  out.z = z / n;
  out.w = w / n;
  return out;
}
