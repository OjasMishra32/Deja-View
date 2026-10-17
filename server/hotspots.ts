// The 3D labels pinned in a world (team/contracts.md 11: GET/PUT /api/scenes/:id/hotspots), stored per scene at
// data/scenes/<id>/hotspots.json as {hotspots:[{label, blurb, x, y, z, u?, v?, source?}], updatedAt}.
//
// Positions are room-frame metres (floor at y = 0): the viewer places the guide's labels once and stores them, so
// the next visit shows them at once. The guide relay reads the same file for its scene context.

import { join } from 'node:path';
import type { StoredHotspot } from '../shared/types.ts';
import { writeJsonAtomic } from './store.ts';

export const HOTSPOTS_FILE = 'hotspots.json';
/** More labels than this would only clutter a room. */
export const MAX_HOTSPOTS = 24;
/** Largest PUT body accepted. */
export const MAX_HOTSPOTS_BODY = 64 * 1024;
/** Positions further than this from the room origin are a bug, not a label. */
const MAX_COORD = 1000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The valid labels in a body ({hotspots:[...]} or a bare list), or null when it is neither. Bad entries are
 * skipped, duplicates (same label, any case) keep the first, at most MAX_HOTSPOTS are kept.
 */
export function cleanStoredHotspots(raw: unknown): StoredHotspot[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { hotspots?: unknown }).hotspots)
      ? (raw as { hotspots: unknown[] }).hotspots
      : null;
  if (!list) return null;
  const out: StoredHotspot[] = [];
  const seen = new Set<string>();
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    const label = text(r.label, 40);
    const pos = Array.isArray(r.position) && r.position.length === 3 ? r.position : [r.x, r.y, r.z];
    if (!label || !pos.every((v) => finite(v) && Math.abs(v) <= MAX_COORD)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const [x, y, z] = pos as number[];
    const spot: StoredHotspot = { label, blurb: text(r.blurb, 220), x: r3(x!), y: r3(y!), z: r3(z!) };
    if (finite(r.u) && r.u >= -0.05 && r.u <= 1.05) spot.u = r3(r.u);
    if (finite(r.v) && r.v >= -0.05 && r.v <= 1.05) spot.v = r3(r.v);
    const source = text(r.source, 24);
    if (source) spot.source = source;
    out.push(spot);
    if (out.length >= MAX_HOTSPOTS) break;
  }
  return out;
}

/** The stored labels of a scene directory ([] when there are none or the file is unreadable). */
export async function readHotspots(sceneDir: string): Promise<StoredHotspot[]> {
  const f = Bun.file(join(sceneDir, HOTSPOTS_FILE));
  try {
    if (!(await f.exists())) return [];
    return cleanStoredHotspots(await f.json()) ?? [];
  } catch (e) {
    console.warn(`[hotspots] unreadable ${join(sceneDir, HOTSPOTS_FILE)}: ${(e as Error).message}`);
    return [];
  }
}

/** Replaces a scene's labels (atomic write). */
export async function writeHotspots(sceneDir: string, hotspots: StoredHotspot[]): Promise<void> {
  await writeJsonAtomic(join(sceneDir, HOTSPOTS_FILE), { hotspots, updatedAt: new Date().toISOString() });
}
