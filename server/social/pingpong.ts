// Cross-play ping pong: the headset plays the Roblox game's real ping pong (roblox/src/server/DejaView/PingPong.luau)
// against someone in Roblox. The Roblox server stays the referee; this relays between it and the headsets.
//
//   POST /api/roblox/:sceneId/pingpong          Roblox -> headsets: the table, the board and the last shot (on every
//                                               change, at most ~3 a second). Sent on to the scene's viewers over /ws
//                                               as a "pingpong" Roblox event. Answers with headset events the game has
//                                               not had yet and the headset's latest paddle.
//   GET  /api/roblox/:sceneId/pingpong/wait     Roblox long-poll (?after=<seq>): returns as soon as a headset joins,
//                                               leaves or hits, or after ~15 s with nothing.
//   GET  /api/pingpong/:sceneId                 headset: the latest table, board and shot (on load)
//   POST /api/pingpong/:sceneId                 headset -> Roblox: {kind: join | leave | shot | paddle, id, ...}
//
// Shots carry Roblox server time (Unix seconds); the game checks them against the ball's recent path and lets a hit
// count that arrives a moment late. Positions are in the table frame in studs (PingPongSim), so no unit conversion
// happens here except the table itself, which the viewer maps to metres.
import type { SocialHandler } from './routes.ts';
import { fail, json, keyRejected, methodNotAllowed, pathSegment, preflight, readJson, SCENE_ID_RE, type RequestIpSource } from './http.ts';

const BODY_MAX = 16 * 1024;
const WAIT_MS = 15_000;
const KEEP_EVENTS = 64;
const PADDLE_FRESH_MS = 1500;
const EVENT_TTL_MS = 10_000;

export interface HeadsetEvent {
  seq: number;
  kind: 'join' | 'leave' | 'shot';
  id: string;
  name?: string;
  side?: string;
  shot?: { t: number; p: number[]; aim: number; flight: number; serve?: boolean };
  at: number;
}

interface SceneRelay {
  seq: number;
  events: HeadsetEvent[];
  waiters: Set<(events: HeadsetEvent[]) => void>;
  paddle: { id: string; p: number[]; n: number[]; f: number[]; at: number } | null;
  latest: Record<string, unknown> | null;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const vec = (x: unknown): number[] | null => (Array.isArray(x) && x.length === 3 && x.every(num) ? (x as number[]) : null);
const str = (x: unknown, max = 64): string | null => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null);

export class PingPongRelay {
  private scenes = new Map<string, SceneRelay>();

  constructor(private publish: (sceneId: string, ev: { type: string; [k: string]: unknown }) => void) {}

  private scene(id: string): SceneRelay {
    let s = this.scenes.get(id);
    if (!s) {
      // numbered from the clock, so a game server keeps seeing higher numbers across a restart of this server
      s = { seq: Date.now(), events: [], waiters: new Set(), paddle: null, latest: null };
      this.scenes.set(id, s);
    }
    return s;
  }

  /** Headset events after `after`, from the last EVENT_TTL_MS only: a game server that starts later does not replay
   *  an old join or hit. */
  since(sceneId: string, after: number): HeadsetEvent[] {
    const old = Date.now() - EVENT_TTL_MS;
    return this.scene(sceneId).events.filter((e) => e.seq > after && e.at > old);
  }

  seqOf(sceneId: string): number {
    return this.scene(sceneId).seq;
  }

  paddleOf(sceneId: string): SceneRelay['paddle'] {
    const p = this.scene(sceneId).paddle;
    return p && Date.now() - p.at < PADDLE_FRESH_MS ? p : null;
  }

  latest(sceneId: string): Record<string, unknown> | null {
    return this.scene(sceneId).latest;
  }

  /** Roblox posted its table: keep it for headsets that load later and send it to everyone in the scene now. */
  fromRoblox(sceneId: string, body: Record<string, unknown>): void {
    const msg = { ...body, serverNow: Date.now() / 1000 };
    this.scene(sceneId).latest = msg;
    this.publish(sceneId, { type: 'pingpong', ...msg });
  }

  /** A headset's message. Returns an error sentence, or null when it was taken. */
  fromHeadset(sceneId: string, body: Record<string, unknown>): string | null {
    const s = this.scene(sceneId);
    const kind = body.kind;
    const id = str(body.id);
    if (!id) return 'id is required.';
    if (kind === 'paddle') {
      const p = vec(body.p);
      const n = vec(body.n);
      const f = vec(body.f);
      if (!p || !n || !f) return 'paddle needs p, n and f (table-frame studs).';
      s.paddle = { id, p, n, f, at: Date.now() };
      return null;
    }
    if (kind !== 'join' && kind !== 'leave' && kind !== 'shot') return 'kind must be join, leave, shot or paddle.';
    const ev: HeadsetEvent = { seq: ++s.seq, kind, id, at: Date.now() };
    const name = str(body.name, 40);
    if (name) ev.name = name;
    if (body.side === 'A' || body.side === 'B') ev.side = body.side;
    if (kind === 'shot') {
      const sh = body.shot as Record<string, unknown> | undefined;
      const p = vec(sh?.p);
      if (!sh || !p || !num(sh.t) || !num(sh.aim) || !num(sh.flight)) return 'shot needs t, p, aim and flight.';
      ev.shot = { t: sh.t, p, aim: Math.max(-1, Math.min(1, sh.aim)), flight: Math.max(0.4, Math.min(1, sh.flight)), serve: sh.serve === true };
    }
    s.events.push(ev);
    if (s.events.length > KEEP_EVENTS) s.events.splice(0, s.events.length - KEEP_EVENTS);
    for (const w of s.waiters) w([ev]);
    s.waiters.clear();
    return null;
  }

  /** Resolves with new headset events as soon as there are any after `after`, or [] after `ms`. */
  wait(sceneId: string, after: number, ms = WAIT_MS): Promise<HeadsetEvent[]> {
    const ready = this.since(sceneId, after);
    if (ready.length) return Promise.resolve(ready);
    const s = this.scene(sceneId);
    return new Promise((resolve) => {
      const done = (evs: HeadsetEvent[]) => {
        clearTimeout(timer);
        s.waiters.delete(done);
        resolve(evs);
      };
      const timer = setTimeout(() => done([]), ms);
      s.waiters.add(done);
    });
  }
}

export interface PingPongRouteDeps {
  relay: PingPongRelay;
  sceneExists: (id: string | undefined) => Promise<boolean>;
  dvKey?: string | null;
}

/** The routes above, for createSocialRoutes' table. */
export function pingPongRoutes(deps: PingPongRouteDeps): Record<string, SocialHandler> {
  const { relay } = deps;
  const gate = async (req: Request, server: RequestIpSource | undefined, roblox: boolean, segment: number) => {
    if (roblox) {
      const denied = keyRejected(req, deps.dvKey, server);
      if (denied) return { error: denied };
    }
    const sceneId = pathSegment(req, segment);
    if (!sceneId || !SCENE_ID_RE.test(sceneId) || !(await deps.sceneExists(sceneId))) return { error: fail(404, 'No such scene') };
    return { sceneId };
  };

  const robloxPost: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    const g = await gate(req, server, true, 3);
    if (g.error) return g.error;
    const body = await readJson(req, BODY_MAX);
    if (!body.ok) return fail(body.status, body.error);
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return fail(400, 'Send a JSON object.');
    const b = body.value as Record<string, unknown>;
    const after = num(b.after) ? b.after : 0;
    delete b.after;
    relay.fromRoblox(g.sceneId!, b);
    return json({ ok: true, seq: relay.seqOf(g.sceneId!), events: relay.since(g.sceneId!, after), paddle: relay.paddleOf(g.sceneId!) });
  };

  const robloxWait: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    if (req.method !== 'GET') return methodNotAllowed('GET, OPTIONS');
    const g = await gate(req, server, true, 3);
    if (g.error) return g.error;
    const after = Number(new URL(req.url).searchParams.get('after') ?? '0');
    const events = await relay.wait(g.sceneId!, Number.isFinite(after) ? after : 0);
    return json({ seq: relay.seqOf(g.sceneId!), events, paddle: relay.paddleOf(g.sceneId!) });
  };

  const headset: SocialHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    const g = await gate(req, server, false, 3);
    if (g.error) return g.error;
    if (req.method === 'GET' || req.method === 'HEAD') return json({ latest: relay.latest(g.sceneId!), serverNow: Date.now() / 1000 });
    if (req.method !== 'POST') return methodNotAllowed('GET, POST, OPTIONS');
    const body = await readJson(req, BODY_MAX);
    if (!body.ok) return fail(body.status, body.error);
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return fail(400, 'Send a JSON object.');
    const err = relay.fromHeadset(g.sceneId!, body.value as Record<string, unknown>);
    if (err) return fail(400, err);
    return json({ ok: true, serverNow: Date.now() / 1000 });
  };

  return {
    '/api/roblox/:sceneId/pingpong': robloxPost,
    '/api/roblox/:sceneId/pingpong/wait': robloxWait,
    '/api/pingpong/:sceneId': headset,
  };
}
