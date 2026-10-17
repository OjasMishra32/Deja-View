// POST /api/host/cue (team/contracts.md 9 and 11): the host (or the bot) flips the reality check, shows or hides
// the labels, or drops a following headset into another world. The cue goes out on /ws as
// {type:"cue", action, on?, sceneId?, by?, at}; viewers opened with ?follow=1 obey it.
//
//   {"action":"reality","on":true}   {"action":"labels","on":false}   {"action":"load","sceneId":"<id>","by":"bot"}
//
// Who may send one: anything on this machine (the host page, the bot, curl); from elsewhere `x-dejaview-key` when
// DV_KEY is set. A browser page from another site is refused like every other change (server/guard.ts).

import type { HostCue, Scene, ServerEvent } from '../shared/types.ts';
import { originAllowed, type GuardOptions } from './guard.ts';
import { keyRejected, readJson, type RequestIpSource } from './social/http.ts';
import { isValidId } from './store.ts';

export interface CueDeps {
  getScene: (id: string) => Promise<Scene | null>;
  publish: (e: ServerEvent) => void;
  /** DV_KEY: when set, requests from other machines need it in x-dejaview-key. */
  dvKey?: string | null;
  guard?: GuardOptions;
  now?: () => number;
}

const ACTIONS = new Set<HostCue['action']>(['reality', 'labels', 'load']);

const MESSAGES = {
  badAction: 'Unknown cue. Use reality, labels or load.',
  needScene: 'A load cue needs the sceneId of the world to open.',
  noScene: "We couldn't find that scene.",
  notReady: "That world isn't ready yet.",
  notAllowed: 'This action only works from the Déjà View app.',
  method: "That action isn't supported here.",
  server: 'Something went wrong on the server. Try again.',
} as const;

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
}

/** A browser page from another site (its Origin or Sec-Fetch-Site says so). */
function crossSite(req: Request, guard: GuardOptions): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null) return !originAllowed(origin, req, guard);
  const site = req.headers.get('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
}

/** Validates a cue body; returns the cue (without `at`) or an error sentence. */
export function parseCue(body: unknown): Omit<HostCue, 'at'> | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return MESSAGES.badAction;
  const b = body as Record<string, unknown>;
  const action = typeof b.action === 'string' ? (b.action.trim().toLowerCase() as HostCue['action']) : null;
  if (!action || !ACTIONS.has(action)) return MESSAGES.badAction;
  const cue: Omit<HostCue, 'at'> = { action };
  if (typeof b.on === 'boolean') cue.on = b.on;
  else if (action !== 'load') cue.on = true;
  if (typeof b.sceneId === 'string' && b.sceneId.trim()) {
    const id = b.sceneId.trim();
    if (!isValidId(id)) return MESSAGES.noScene;
    cue.sceneId = id;
  }
  if (action === 'load' && !cue.sceneId) return MESSAGES.needScene;
  if (typeof b.by === 'string' && b.by.trim()) cue.by = b.by.trim().slice(0, 40);
  return cue;
}

/** The route handler (Bun passes the server, which tells a request from this machine apart). */
export function createCueRoute(deps: CueDeps): (req: Request, server?: RequestIpSource) => Promise<Response> {
  const guard = deps.guard ?? {};
  const now = deps.now ?? (() => Date.now() / 1000);
  return async (req, server) => {
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS', Vary: 'Origin' } });
      if (req.method !== 'POST') return privateJson({ error: MESSAGES.method }, 405);
      // checked as if remote: null means the right key came with the request
      const keyed = !!deps.dvKey && keyRejected(req, deps.dvKey, null) === null;
      if (!keyed) {
        const denied = keyRejected(req, deps.dvKey, server);
        if (denied) return denied;
        if (crossSite(req, guard)) {
          console.warn(`[guard] refused POST /api/host/cue from ${req.headers.get('origin') ?? 'a cross-site page'}`);
          return privateJson({ error: MESSAGES.notAllowed }, 403);
        }
      }
      const read = await readJson(req, 4096);
      if (!read.ok) return privateJson({ error: read.error }, read.status);
      const cue = parseCue(read.value);
      if (typeof cue === 'string') return privateJson({ error: cue }, 400);
      if (cue.action === 'load') {
        const scene = await deps.getScene(cue.sceneId!);
        if (!scene) return privateJson({ error: MESSAGES.noScene }, 404);
        if (scene.status !== 'ready' || !scene.world) return privateJson({ error: MESSAGES.notReady, status: scene.status }, 409);
      }
      const msg: ServerEvent = { type: 'cue', ...cue, at: Math.round(now() * 1000) / 1000 };
      deps.publish(msg);
      console.log(`[cue] ${cue.action}${cue.on !== undefined ? ` ${cue.on ? 'on' : 'off'}` : ''}${cue.sceneId ? ` ${cue.sceneId}` : ''}${cue.by ? ` (by ${cue.by})` : ''}`);
      return privateJson({ ok: true });
    } catch (e) {
      console.error('[cue]', e);
      return privateJson({ error: MESSAGES.server }, 500);
    }
  };
}
