// Finds a scene's full-3D people (pipeline/avatar) and reads their avatar.json. A Video memory names them in
// video.avatars (shared/types.ts VideoAvatars): in its own folder, or in the folder of the place it was filmed in,
// where the people built from the clip already sit next to the world. Without that field the convention is
// avatar.json in the scene's own folder (the-courts: avatar-0.glb, avatar-1.glb and avatar.json beside world.spz).
// The recording camera of a handheld clip is video.avatars.poses, else the memory's own video.cameraTrack
// (camera-track.json, the per-frame poses its video layer is placed with: tw-track.ts).

import type { AvatarFile, VideoAvatars } from '../../../shared/types.ts';
import type { TimeRange } from './avatar-clock.ts';

/** What the resolver needs of a Scene. */
export interface AvatarSceneRef {
  id: string;
  /** cameraTrack: the memory's camera-track.json (relative to its own folder), when its clip was handheld. */
  video?: { avatars?: VideoAvatars | AvatarFile[]; cameraTrack?: string } | null;
}

export interface AvatarSources {
  /** The folder everything resolves against (ends with '/'). */
  base: string;
  /** avatar.json. */
  json: string;
  /** Only these GLBs (absolute URLs), or null for everyone avatar.json lists. */
  people: Array<{ url: string; id: string | null }> | null;
  /** The recording camera track (video.avatars.poses, else the memory's video.cameraTrack), or null. */
  poses: string | null;
  /** Overrides avatar.json's `start`, or null. */
  start: number | null;
  /** True when the scene named its people (video.avatars), false for the folder convention. */
  explicit: boolean;
}

export interface AvatarPerson {
  id: string;
  url: string;
  timeRange: TimeRange;
}

export interface AvatarDoc {
  /** Media time of animation t = 0. */
  start: number;
  /** The media's duration in seconds, or null when avatar.json does not say. */
  mediaDuration: number | null;
  fps: number | null;
  people: AvatarPerson[];
  credits: string[];
}

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** Joins a relative file onto a folder URL; absolute paths and URLs pass through. */
export function joinUrl(base: string, file: string): string {
  if (/^(https?:|blob:|data:)/.test(file) || file.startsWith('/')) return file;
  const b = base.endsWith('/') ? base : base + '/';
  return b + file.replace(/^(\.\/)+/, '');
}

/** The folder of a file URL (with its trailing '/'). */
export function dirOf(url: string): string {
  const q = url.search(/[?#]/);
  const path = q >= 0 ? url.slice(0, q) : url;
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function cleanFile(f: unknown): string | null {
  if (typeof f !== 'string') return null;
  const s = f.trim();
  // relative to the folder only: no way up and out of it
  if (!s || s.split(/[\\/]/).includes('..')) return null;
  return s;
}

/**
 * Where a scene's people are, or null when the scene names a folder that cannot be one. `root` is where scene
 * folders are served (the viewer: /data/scenes/).
 */
export function avatarSources(scene: AvatarSceneRef, root = '/data/scenes/'): AvatarSources | null {
  const raw = scene.video?.avatars;
  const field: VideoAvatars = Array.isArray(raw) ? { people: raw } : raw && typeof raw === 'object' ? raw : {};
  const owner = typeof field.scene === 'string' && field.scene.trim() ? field.scene.trim() : scene.id;
  if (!SCENE_ID.test(owner)) return null;
  const base = joinUrl(root, `${encodeURIComponent(owner)}/`);
  const json = joinUrl(base, cleanFile(field.json) ?? 'avatar.json');
  let people: AvatarSources['people'] = null;
  if (Array.isArray(field.people)) {
    people = [];
    for (const p of field.people) {
      const file = cleanFile(p && typeof p === 'object' ? p.file : null);
      if (file) people.push({ url: joinUrl(base, file), id: typeof p.id === 'string' && p.id ? p.id : null });
    }
  }
  const poses = cleanFile(field.poses);
  // (a handheld memory's own camera track is in its own folder, whichever folder holds the people)
  const track = cleanFile(scene.video?.cameraTrack);
  const ownTrack = track && SCENE_ID.test(scene.id) ? joinUrl(joinUrl(root, `${encodeURIComponent(scene.id)}/`), track) : null;
  return {
    base,
    json,
    people,
    poses: poses ? joinUrl(base, poses) : ownTrack,
    start: typeof field.start === 'number' && Number.isFinite(field.start) ? field.start : null,
    explicit: raw !== undefined && raw !== null,
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function rangeOf(v: unknown): TimeRange {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = num(v[0]), b = num(v[1]);
  return a !== null && b !== null && b >= a ? [a, b] : null;
}

/** Reads avatar.json (fetched from `jsonUrl`); people's GLBs resolve against its folder. Tolerates missing fields. */
export function parseAvatarDoc(doc: unknown, jsonUrl: string): AvatarDoc {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  const dir = dirOf(jsonUrl);
  const people: AvatarPerson[] = [];
  const seen = new Set<string>();
  for (const [i, p] of (Array.isArray(d.people) ? d.people : []).entries()) {
    const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    const file = cleanFile(r.file);
    if (!file) continue;
    const id = typeof r.id === 'string' && r.id ? r.id : `person-${i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    people.push({ id, url: joinUrl(dir, file), timeRange: rangeOf(r.timeRange) });
  }
  const credits = Array.isArray(d.credits) ? d.credits.filter((c): c is string => typeof c === 'string') : [];
  const fps = num(d.fps);
  const duration = num(d.mediaDuration);
  return {
    start: num(d.start) ?? 0,
    mediaDuration: duration !== null && duration > 0 ? duration : null,
    fps: fps !== null && fps > 0 ? fps : null,
    people,
    credits,
  };
}

/**
 * The people to load: the scene's own list matched to avatar.json by id (or file) for their time ranges, else
 * everyone avatar.json lists. `doc` is null when avatar.json is missing: a named list still loads, with whole-clip
 * ranges.
 */
export function selectPeople(src: AvatarSources, doc: AvatarDoc | null): AvatarPerson[] {
  const all = doc?.people ?? [];
  if (!src.people) return all;
  return src.people.map((p, i) => {
    const match = all.find((q) => (p.id !== null && q.id === p.id) || q.url === p.url);
    return { id: p.id ?? match?.id ?? `person-${i}`, url: p.url, timeRange: match?.timeRange ?? null };
  });
}
