// GET /api/host/status (team/contracts.md 11 and 13.4): everything the host checks before and during the demo, in one
// call, for the /host page and scripts/preflight.ts.
//
//   GPU worker   HiPerGator session + warm worker heartbeat (server/health.ts)
//   guide        the guide's GET /health, and whether Gemini answers (ok / degraded / mock)
//   DeepSpace    presence push and notes relay (server/integrations/deepspace.ts)
//   public link  the tunnel URL scripts/tunnel.ts writes, and whether it answers
//   worlds       every scene, newest first, with stage and progress
//   people       who is in the open world (the one the headset is in): headsets, Roblox players, browsers
//
// Each part comes with `checks.<part>`: a state (ok, idle, warn, bad, off), plain words, and what to do when it is not
// ok. A dependency that throws or hangs turns into "can't check", never into a failed request.
//
// There is no warm-up route: server/hpg.ts can check the worker but cannot start it, so the page shows the command to
// run on HiPerGator instead (WARM_COMMAND).
//
// Who may ask: the same rules as POST /api/host/cue. Anything on this machine; from elsewhere `x-dejaview-key` when
// DV_KEY is set; never a browser page from another site. The answer carries no CORS headers.

import type { HealthInfo, Scene } from '../shared/types.ts';
import { originAllowed, type GuardOptions } from './guard.ts';
import { cached, type Cached } from './health.ts';
import type { WorkerStatus } from './hpg.ts';
import { callJson, hostOf, type CallResult, type FetchLike } from './integrations/config.ts';
import type { DeepSpace } from './integrations/deepspace.ts';
import type { GuideClient } from './integrations/guide.ts';
import type { PresenceStore } from './social/presence.ts';
import { keyRejected, type RequestIpSource } from './social/http.ts';

/** What the host runs on HiPerGator to start the warm worker for 3 hours. */
export const WARM_COMMAND = 'hpg/tw.sh start 3';
/** What the host runs on this Mac to open the public link. */
export const TUNNEL_COMMAND = 'bun run tunnel';

export type CheckState = 'ok' | 'idle' | 'warn' | 'bad' | 'off';

export interface HostCheck {
  state: CheckState;
  /** Plain words: "Awake on RTX 6000", "Down", "Live". */
  text: string;
  /** A little more: last heartbeat, address, latency. */
  detail?: string;
  /** What to do about it, when it is not ok. */
  fix?: string;
  /** A command to copy, when the fix is one... */
  command?: string;
  /** ...and where to run it: "on HiPerGator", "on this Mac". */
  where?: string;
}

export type CheckName = 'gpu' | 'guide' | 'deepspace' | 'tunnel' | 'roblox' | 'people';

/** A scene as the host page lists it. `mode` is the public name; `thumb` is a URL path or null. */
export interface HostScene {
  id: string;
  name: string;
  mode: 'photo' | 'video' | 'sample';
  status: Scene['status'];
  stage?: string;
  progress?: number;
  error?: string;
  thumb: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostPerson {
  id: string;
  name: string;
  kind: string;
}

export interface HostStatus {
  ok: true;
  /** Unix seconds on the server's clock. */
  t: number;
  version: string;
  readOnly: boolean;
  checks: Record<CheckName, HostCheck>;
  gpu: {
    online: boolean | null;
    alive: boolean | null;
    gpu?: string;
    host?: string;
    lastBeat?: string;
    /** Seconds since the last heartbeat. */
    age?: number;
    status?: string;
    /** False: nothing on this server starts the worker; run `warmCommand` on HiPerGator. */
    canWarm: false;
    warmCommand: string;
  };
  guide: { enabled: boolean; host: string | null; reachable: boolean | null; gemini?: string; ms?: number; lastError?: string | null };
  deepspace: {
    enabled: boolean;
    host: string | null;
    push: { up: boolean | null; lastError: string | null; pushes: number; failures: number };
    notes: { up: boolean | null; lastError: string | null };
  };
  tunnel: { url: string | null; reachable: boolean | null; ms?: number };
  scenes: { total: number; ready: number; building: number; failed: number; list: HostScene[] };
  presence: {
    /** The open world: where the headset is, else the world with the most people. */
    sceneId: string | null;
    sceneName: string | null;
    headset: boolean;
    people: number;
    vr: number;
    roblox: number;
    web: number;
    names: HostPerson[];
    /** A tag round in progress in the open world. */
    round: { state: string; t: number; duration?: number } | null;
    /** Every world with someone in it. */
    scenes: Array<{ sceneId: string; people: number; roblox: number }>;
  };
  lan: string[];
}

export interface HostDeps {
  /** HealthInfo (server/health.ts HealthMonitor.info). `force` re-probes instead of using the cache. */
  health: (force?: boolean) => Promise<HealthInfo>;
  /** The worker heartbeat with its age and status (HealthMonitor.worker.get). Optional: HealthInfo has the basics. */
  worker?: (force?: boolean) => Promise<WorkerStatus>;
  /** False when HiPerGator is turned off for this server (hpgConfig().enabled): the GPU tile says so. Default true. */
  hpgEnabled?: boolean;
  listScenes: () => Promise<Scene[]>;
  presence?: Pick<PresenceStore, 'activeScenes' | 'snapshot' | 'activeHeadset' | 'currentRound'>;
  guide?: Pick<GuideClient, 'enabled' | 'status' | 'health'>;
  deepspace?: Pick<DeepSpace, 'status'>;
  /** The public https BASE (integrations/config.ts readPublicUrl), or null when no tunnel runs. */
  publicUrl?: () => Promise<string | null>;
  /** Used to check that the public link answers. Default: fetch. */
  fetch?: FetchLike;
  /** DV_KEY: when set, requests from other machines need it in x-dejaview-key. */
  dvKey?: string | null;
  guard?: GuardOptions;
  readOnly?: boolean;
  /** Millisecond clock. Default Date.now. */
  now?: () => number;
  /** How long one slow dependency may hold up the answer (ms). Default 4000. */
  waitMs?: number;
}

const MESSAGES = {
  notAllowed: 'This action only works from the Déjà View app.',
  method: "That action isn't supported here.",
  server: 'Something went wrong on the server. Try again.',
} as const;

const BUILDING = new Set<Scene['status']>(['queued', 'uploading', 'running', 'downloading']);
const WARMING = new Set(['starting', 'loading']);
const MAX_LISTED = 40;
const MAX_NAMES = 32;

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
}

/** A browser page from another site (its Origin or Sec-Fetch-Site says so). Same rule as server/cue.ts. */
function crossSite(req: Request, guard: GuardOptions): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null) return !originAllowed(origin, req, guard);
  const site = req.headers.get('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
}

/** The value of `fn`, or undefined when it throws or takes longer than `ms`. */
async function within<T>(ms: number, fn: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** "12 s ago", "4 min ago", "2 h ago". */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** "NVIDIA RTX 6000 Ada Generation" -> "RTX 6000 Ada". */
export function gpuName(raw: string | undefined): string | undefined {
  const s = (raw ?? '').replace(/^NVIDIA\s+/i, '').replace(/\s+Generation$/i, '').trim();
  return s || undefined;
}

function publicMode(mode: Scene['mode']): HostScene['mode'] {
  if (mode === 'thirdwheel') return 'video';
  if (mode === 'sample') return 'sample';
  return 'photo';
}

function hostScene(s: Scene): HostScene {
  const out: HostScene = {
    id: s.id,
    name: s.name || s.id,
    mode: publicMode(s.mode),
    status: s.status,
    thumb: s.thumb ? `/data/scenes/${encodeURIComponent(s.id)}/${s.thumb.split('/').map(encodeURIComponent).join('/')}` : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (s.stage) out.stage = s.stage;
  if (typeof s.progress === 'number' && Number.isFinite(s.progress)) out.progress = Math.min(1, Math.max(0, s.progress));
  if (s.error) out.error = s.error;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One check per part. Each is a pure function of what the probes returned (exported for tests and the preflight).

export function gpuCheck(h: HealthInfo | undefined, w: WorkerStatus | undefined, nowS: number, hpgEnabled = true): HostCheck {
  if (!hpgEnabled) {
    return { state: 'off', text: 'Off', fix: "HiPerGator is turned off in this server's settings. Turn it back on in .env and restart the server to build on the GPU." };
  }
  if (!h) return { state: 'warn', text: "Can't check yet", fix: 'The server is still asking HiPerGator. Refresh in a few seconds.' };
  if (!h.hpg.online) {
    return {
      state: 'bad',
      text: 'Asleep: no HiPerGator session',
      fix: 'Log in to HiPerGator again on this Mac (password and Duo), then start the warm worker.',
    };
  }
  const alive = w ? w.alive : h.hpg.worker.alive;
  const beat = w?.lastBeat ?? h.hpg.worker.lastBeat;
  const age = w?.age ?? (beat && Number.isFinite(Date.parse(beat)) ? nowS - Date.parse(beat) / 1000 : undefined);
  const heard = age !== undefined ? `heartbeat ${agoText(age)}` : 'no heartbeat yet';
  if (!alive) {
    return {
      state: 'bad',
      text: 'Asleep',
      detail: beat ? `last ${heard}` : heard,
      fix: 'Start the warm worker on HiPerGator, then send one photo to warm it up.',
      command: WARM_COMMAND,
      where: 'on HiPerGator',
    };
  }
  const name = gpuName(w?.gpu ?? h.hpg.worker.gpu);
  const status = w?.status;
  if (status && WARMING.has(status)) {
    return { state: 'warn', text: 'Warming up', detail: [name, heard].filter(Boolean).join(' · '), fix: 'Give it a minute or two, then send one photo.' };
  }
  if (status === 'error' || status === 'stopped') {
    return {
      state: 'warn',
      text: status === 'stopped' ? 'Stopping' : 'Awake, but reporting a problem',
      detail: [name, heard].filter(Boolean).join(' · '),
      fix: 'Check the worker log on HiPerGator (hpg/tw.sh logs), and start it again if it stopped.',
      command: WARM_COMMAND,
      where: 'on HiPerGator',
    };
  }
  const doing = status === 'busy' ? 'building now' : status === 'idle' ? 'idle' : '';
  return { state: 'ok', text: name ? `Awake on ${name}` : 'Awake', detail: [doing, heard].filter(Boolean).join(' · ') };
}

export interface GuideProbe {
  enabled: boolean;
  host: string | null;
  /** The GET /health call, or undefined when it could not be made. */
  health?: CallResult;
  lastMs?: Partial<Record<string, number>>;
}

export function guideCheck(g: GuideProbe | undefined): HostCheck {
  if (!g || !g.enabled) {
    return { state: 'off', text: 'Off', fix: 'Set GUIDE_URL in .env and restart the server. Until then the headset uses canned lines.' };
  }
  const r = g.health;
  const reachable = !!r && (r.kind === 'ok' || r.kind === 'http');
  if (!reachable) {
    return {
      state: 'bad',
      text: 'Down',
      detail: [g.host, r?.detail].filter(Boolean).join(' · ') || undefined,
      fix: 'Start the guide on this Mac (port 8795) or fix GUIDE_URL. The headset answers with canned lines meanwhile.',
    };
  }
  const gemini = typeof r!.body?.gemini === 'string' ? (r!.body.gemini as string) : undefined;
  const ask = g.lastMs?.ask;
  const speed = ask !== undefined ? `last answer ${(ask / 1000).toFixed(1)} s` : `answers in ${r!.ms} ms`;
  if (gemini === 'degraded') {
    return { state: 'warn', text: 'Degraded: canned answers', detail: g.host ?? undefined, fix: "Gemini calls are failing. Check the guide's key and quota; answers stay canned until then." };
  }
  if (gemini === 'off' || r!.body?.mock === true) {
    return { state: 'warn', text: 'Mock mode', detail: g.host ?? undefined, fix: 'The guide runs without Gemini. Restart it with its key.' };
  }
  return { state: 'ok', text: 'OK', detail: [gemini === 'ok' ? 'Gemini answering' : 'answering', speed].join(' · ') };
}

type DeepSpaceStatus = ReturnType<DeepSpace['status']>;

export function deepspaceCheck(d: DeepSpaceStatus | undefined, nowMs: number): HostCheck {
  if (!d || !d.enabled) return { state: 'off', text: 'Off', fix: 'Set DS_URL and DS_KEY in .env, then restart the server.' };
  const push = d.presence;
  const notes = d.notes;
  if (push.up === false || notes.up === false) {
    const text = push.up === false && notes.up === false ? 'Down' : push.up === false ? 'Push failing' : 'Notes failing';
    const err = (push.up === false ? push.lastError : notes.lastError) ?? '';
    const keyRefused = /\b(401|403)\b|DS_KEY/.test(err);
    return {
      state: 'bad',
      text,
      detail: [d.host, err].filter(Boolean).join(' · ') || undefined,
      fix: keyRefused
        ? "DeepSpace refused the key. Check that DS_KEY matches the app's secret."
        : `Check that the DeepSpace app is deployed${d.host ? ` at ${d.host}` : ''} and reachable from this Mac.`,
    };
  }
  if (push.up === null && notes.up === null) {
    return { state: 'idle', text: 'Standing by', detail: 'starts pushing when someone walks into a world' };
  }
  const last = Math.max(push.lastOkAt ?? 0, notes.lastOkAt ?? 0);
  const parts = [`${push.pushes} pushes`, notes.up ? 'notes synced' : 'notes waiting'];
  if (last) parts.push(`last ok ${agoText((nowMs - last) / 1000)}`);
  return { state: 'ok', text: 'OK', detail: parts.join(' · ') };
}

export interface TunnelProbe {
  url: string | null;
  reachable: boolean | null;
  ms?: number;
}

export function tunnelCheck(t: TunnelProbe | undefined): HostCheck {
  if (!t || !t.url) {
    return { state: 'bad', text: 'No public link', fix: 'Run the tunnel on this Mac, then post the new link in the team chat.', command: TUNNEL_COMMAND, where: 'on this Mac' };
  }
  const host = hostOf(t.url) ?? t.url;
  if (t.reachable === false) {
    return {
      state: 'bad',
      text: 'Not answering',
      detail: host,
      fix: 'Restart the tunnel (the address will change), then post the new link in the team chat.',
      command: TUNNEL_COMMAND,
      where: 'on this Mac',
    };
  }
  if (t.reachable === null) return { state: 'warn', text: 'Checking', detail: host };
  return { state: 'ok', text: 'Live', detail: t.ms !== undefined ? `${host} · ${t.ms} ms` : host };
}

export function robloxCheck(p: HostStatus['presence'] | undefined): HostCheck {
  if (!p) return { state: 'off', text: "Can't see players", fix: 'The presence layer is not running on this server.' };
  if (!p.roblox) {
    return { state: 'idle', text: 'No players yet', fix: p.sceneName ? `Players press JOIN in the Roblox lobby for ${p.sceneName}.` : 'Players press JOIN in the Roblox lobby.' };
  }
  const names = p.names.filter((n) => n.kind === 'roblox').map((n) => n.name);
  return { state: 'ok', text: `${p.roblox} in the world`, detail: names.join(', ') || undefined };
}

export function peopleCheck(p: HostStatus['presence'] | undefined): HostCheck {
  if (!p) return { state: 'off', text: "Can't see anyone", fix: 'The presence layer is not running on this server.' };
  const parts = [
    p.vr ? `${p.vr} headset${p.vr > 1 ? 's' : ''}` : '',
    p.roblox ? `${p.roblox} Roblox` : '',
    p.web ? `${p.web} browser${p.web > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  const where = p.sceneName ? `in ${p.sceneName}` : '';
  if (!p.headset) {
    return {
      state: p.people ? 'warn' : 'idle',
      text: p.people ? `${p.people} here, no headset` : 'Nobody in a world',
      detail: [parts.join(' · '), where].filter(Boolean).join(' ') || undefined,
      fix: 'Open the world on the Quest with &follow=1 so the cues reach it.',
    };
  }
  return { state: 'ok', text: `${p.people} here`, detail: [parts.join(' · '), where].filter(Boolean).join(' ') };
}

// ---------------------------------------------------------------------------------------------------------------

function presenceSummary(store: NonNullable<HostDeps['presence']>, names: Map<string, string>): HostStatus['presence'] {
  const scenes = store.activeScenes().map((sceneId) => {
    const people = store.snapshot(sceneId).people;
    return { sceneId, list: people, people: people.length, roblox: people.filter((p) => p.kind === 'roblox').length };
  });
  const headset = store.activeHeadset();
  const open = headset ? scenes.find((s) => s.sceneId === headset.sceneId) : [...scenes].sort((a, b) => b.people - a.people)[0];
  const list = open?.list ?? [];
  const round = open ? store.currentRound(open.sceneId) : null;
  return {
    sceneId: open?.sceneId ?? null,
    sceneName: open ? (names.get(open.sceneId) ?? open.sceneId) : null,
    headset: !!headset,
    people: list.length,
    vr: list.filter((p) => p.kind === 'vr').length,
    roblox: list.filter((p) => p.kind === 'roblox').length,
    web: list.filter((p) => p.kind === 'web').length,
    names: list.slice(0, MAX_NAMES).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    round: round ? { state: String(round.state ?? 'start'), t: round.t, ...(typeof round.duration === 'number' ? { duration: round.duration } : {}) } : null,
    scenes: scenes.map(({ sceneId, people, roblox }) => ({ sceneId, people, roblox })),
  };
}

/** The aggregator behind GET /api/host/status. Never throws: a broken part reads "can't check". */
export function createHostStatus(deps: HostDeps): (force?: boolean) => Promise<HostStatus> {
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? 4000;
  const doFetch: FetchLike = deps.fetch ?? fetch;
  const last: { health?: HealthInfo; worker?: WorkerStatus } = {};

  // The guide's /health every 5 s at most; the public link every 15 s at most (both shared by concurrent callers).
  const guideHealth: Cached<CallResult> | null = deps.guide ? cached(5_000, () => deps.guide!.health(1500)) : null;
  let tunnelProbe: { url: string; probe: Cached<TunnelProbe> } | null = null;
  const probeTunnel = (url: string, force: boolean): Promise<TunnelProbe> => {
    if (tunnelProbe?.url !== url) {
      tunnelProbe = {
        url,
        probe: cached(15_000, async () => {
          const r = await callJson(doFetch, `${url}/api/health`, { method: 'GET', timeoutMs: 4000, maxBytes: 64 * 1024 });
          return { url, reachable: r.kind === 'ok', ms: r.ms };
        }),
      };
    }
    return tunnelProbe.probe.get(force);
  };

  return async (force = false) => {
    const [health, worker, scenes, guide, url] = await Promise.all([
      within(waitMs, () => deps.health(force)),
      deps.worker ? within(waitMs, () => deps.worker!(force)) : Promise.resolve(undefined),
      within(waitMs, () => deps.listScenes()),
      guideHealth ? within(waitMs, () => guideHealth.get(force)) : Promise.resolve(undefined),
      deps.publicUrl ? within(waitMs, () => deps.publicUrl!()) : Promise.resolve(null),
    ]);
    // a probe that hung this time keeps its last answer
    if (health) last.health = health;
    if (worker) last.worker = worker;
    const h = health ?? last.health;
    const w = worker ?? last.worker;
    const tunnel: TunnelProbe = url ? ((await within(waitMs + 500, () => probeTunnel(url, force))) ?? { url, reachable: null }) : { url: null, reachable: null };

    const all = [...(scenes ?? [])].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const names = new Map(all.map((s) => [s.id, s.name || s.id]));
    let presence: HostStatus['presence'] | undefined;
    try {
      presence = deps.presence ? presenceSummary(deps.presence, names) : undefined;
    } catch {
      presence = undefined;
    }
    let ds: DeepSpaceStatus | undefined;
    try {
      ds = deps.deepspace?.status();
    } catch {
      ds = undefined;
    }
    let gs: ReturnType<GuideClient['status']> | undefined;
    try {
      gs = deps.guide?.status();
    } catch {
      gs = undefined;
    }
    const guideProbe: GuideProbe = { enabled: !!deps.guide?.enabled, host: gs?.host ?? null, health: guide, lastMs: gs?.lastMs };
    const nowMs = now();

    const noPresence: HostStatus['presence'] = { sceneId: null, sceneName: null, headset: false, people: 0, vr: 0, roblox: 0, web: 0, names: [], round: null, scenes: [] };
    return {
      ok: true,
      t: Math.round(nowMs) / 1000,
      version: h?.version ?? '',
      readOnly: !!deps.readOnly,
      checks: {
        gpu: gpuCheck(h, w, nowMs / 1000, deps.hpgEnabled ?? true),
        guide: guideCheck(guideProbe),
        deepspace: deepspaceCheck(ds, nowMs),
        tunnel: tunnelCheck(tunnel),
        roblox: robloxCheck(presence),
        people: peopleCheck(presence),
      },
      gpu: {
        online: h ? h.hpg.online : null,
        alive: h ? (w ? w.alive : h.hpg.worker.alive) : null,
        ...(gpuName(w?.gpu ?? h?.hpg.worker.gpu) ? { gpu: gpuName(w?.gpu ?? h?.hpg.worker.gpu) } : {}),
        ...((w?.host ?? h?.hpg.worker.host) ? { host: w?.host ?? h?.hpg.worker.host } : {}),
        ...((w?.lastBeat ?? h?.hpg.worker.lastBeat) ? { lastBeat: w?.lastBeat ?? h?.hpg.worker.lastBeat } : {}),
        ...(w?.age !== undefined ? { age: Math.round(w.age) } : {}),
        ...(w?.status ? { status: w.status } : {}),
        canWarm: false,
        warmCommand: WARM_COMMAND,
      },
      guide: {
        enabled: guideProbe.enabled,
        host: guideProbe.host,
        reachable: guideProbe.enabled ? !!guide && (guide.kind === 'ok' || guide.kind === 'http') : null,
        ...(typeof guide?.body?.gemini === 'string' ? { gemini: guide.body.gemini } : {}),
        ...(guide && (guide.kind === 'ok' || guide.kind === 'http') ? { ms: guide.ms } : {}),
        lastError: gs?.lastError ?? null,
      },
      deepspace: {
        enabled: !!ds?.enabled,
        host: ds?.host ?? null,
        push: { up: ds?.presence.up ?? null, lastError: ds?.presence.lastError ?? null, pushes: ds?.presence.pushes ?? 0, failures: ds?.presence.failures ?? 0 },
        notes: { up: ds?.notes.up ?? null, lastError: ds?.notes.lastError ?? null },
      },
      tunnel,
      scenes: {
        total: all.length,
        ready: all.filter((s) => s.status === 'ready').length,
        building: all.filter((s) => BUILDING.has(s.status)).length,
        failed: all.filter((s) => s.status === 'failed').length,
        list: all.slice(0, MAX_LISTED).map(hostScene),
      },
      presence: presence ?? noPresence,
      lan: h?.lan ?? [],
    };
  };
}

export type HostHandler = (req: Request, server?: RequestIpSource) => Promise<Response>;

/** The route table: spread into Bun.serve({ routes }) next to '/api/host/cue'. */
export function createHostRoutes(deps: HostDeps): Record<string, HostHandler> {
  const guard = deps.guard ?? {};
  const status = createHostStatus(deps);

  /** Same rules as the cue: the right key always passes; otherwise this machine, or a same-site page with the key rule. */
  function refused(req: Request, server?: RequestIpSource): Response | null {
    // checked as if remote: null means the right key came with the request
    if (deps.dvKey && keyRejected(req, deps.dvKey, null) === null) return null;
    const denied = keyRejected(req, deps.dvKey, server);
    if (denied) return denied;
    if (crossSite(req, guard)) {
      console.warn(`[guard] refused ${req.method} ${new URL(req.url).pathname} from ${req.headers.get('origin') ?? 'a cross-site page'}`);
      return privateJson({ error: MESSAGES.notAllowed }, 403);
    }
    return null;
  }

  const statusRoute: HostHandler = async (req, server) => {
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS', Vary: 'Origin' } });
      if (req.method !== 'GET' && req.method !== 'HEAD') return privateJson({ error: MESSAGES.method }, 405);
      const no = refused(req, server);
      if (no) return no;
      const body = await status(new URL(req.url).searchParams.get('refresh') === '1');
      const res = privateJson(body);
      return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (e) {
      console.error('[host]', e);
      return privateJson({ error: MESSAGES.server }, 500);
    }
  };

  return { '/api/host/status': statusRoute };
}
