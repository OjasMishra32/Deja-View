// The public match scoreboard: every Roblox match that ends in a Déjà View world is written to Solana DEVNET as one
// signed memo, so anyone can check a result and nobody can quietly change it afterwards.
//
//   POST /api/roblox/:sceneId/event  {"type":"game.result","game":"pingpong","round":"<unique per match>",
//        "winner":"rbx-123","winnerName":"Seb","loser":"rbx-456","loserName":"Shivin","score":"7-4","durationS":312}
//     -> presence.publishEvent -> onEvent (here) -> memo {"app":"dejaview","v":1,scene,game,round,winner,loser,score,t}
//
//   GET /api/scores            the latest 50 matches in every world, each with its transaction and explorer link
//   GET /api/scores/:sceneId   the same for one world
//
// One memo per (scene, round), however often Roblox retries. The subscriber only records the match and returns:
// signing, sending, confirming and retrying run on the scoreboard's own queue, so the event route never waits on
// Solana. Every change is a new line in data/solana/results.jsonl (append only, the last line of a match wins), and a
// restart picks up whatever was still pending. A signature is on disk before its transaction goes out, and a match is
// only signed again when the RPC refused the first one outright or its blockhash expired unseen, so a crash or a lost
// answer never makes a second memo. A draw (`draw: true`) is shown as one and counts for nobody; a "bot" side never
// makes the leaders. Off unless SOLANA_SCOREBOARD=1; the routes answer {enabled:false} then.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  devnetRpcUrl,
  DevnetOnlyError,
  explorerAddressUrl,
  explorerTxUrl,
  FEE_LAMPORTS,
  isLocalRpc,
  LAMPORTS_PER_SOL,
  rpcHost,
  RpcError,
  SolanaClient,
  type FetchLike,
} from './solana.ts';

/** The event Roblox posts when a match ends ("game_result" is taken as well). */
export const RESULT_TYPES: ReadonlySet<string> = new Set(['game.result', 'game_result']);
export const MEMO_MAX_BYTES = 400;
export const LIST_LIMIT = 50;
export const LEADERS_LIMIT = 5;

const SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;
const GAME_RE = /^[a-z0-9_-]{1,16}$/;
/** Refusals that are not about money, rate limits or a stale blockhash: this many and the match is marked failed. */
const MAX_REJECTIONS = 5;
const SENDS_PER_TICK = 8;
/** Matches still to write before new ones are turned away (a flood never grows the queue without end). */
const MAX_PENDING = 500;
const NAME_TTL_MS = 60_000;
/** The id the games give a side they play themselves (contracts 6.5). */
const BOT_ID = 'bot';

export type ScoreStatus = 'pending' | 'confirmed' | 'failed';

export interface GameResult {
  scene: string;
  game: string;
  round: string;
  winnerId: string | null;
  winnerName: string;
  loserId: string | null;
  loserName: string;
  score: string;
  durationS?: number;
  /** A drawn match (chess stalemate): winner and loser are just the two sides. */
  draw?: boolean;
  /** Unix seconds on the server's clock (presence adds `t` to every event). */
  t: number;
}

/** One match as kept in results.jsonl. */
export interface ScoreRecord extends GameResult {
  key: string;
  /** The exact memo text written (or to be written) on chain. */
  memo: string;
  status: ScoreStatus;
  /** Known as soon as it is signed, before it is sent. */
  signature: string | null;
  lastValidBlockHeight?: number;
  slot?: number;
  rejections: number;
  error?: string;
  /** When this line was written (ISO). */
  at: string;
}

export interface ScoreRow {
  scene: string;
  sceneName: string | null;
  game: string;
  round: string;
  winner: string;
  winnerId: string | null;
  loser: string;
  loserId: string | null;
  score: string;
  durationS: number | null;
  draw: boolean;
  /** ISO time the match ended. */
  time: string;
  signature: string | null;
  explorer: string | null;
  status: ScoreStatus;
}

export interface Leader {
  name: string;
  id: string | null;
  wins: number;
  losses: number;
}

export interface ScoresView {
  enabled: boolean;
  cluster: 'devnet' | 'localnet';
  /** The account that signs every result, and where to see all of them. */
  account: string | null;
  accountExplorer: string | null;
  scene?: string;
  sceneName?: string | null;
  scores: ScoreRow[];
  leaders: Leader[];
  error?: string;
}

type EventIn = { type: string; [key: string]: unknown };

export interface ScoreboardOptions {
  /** Subscribes to Roblox events (presence.onEvent); may return the unsubscribe function. */
  onEvent: (fn: (sceneId: string, event: EventIn) => void) => unknown;
  /** World names for the rows. */
  getScene?: (id: string) => Promise<{ name?: string } | null>;
  /** The server's data folder: everything goes to <dataDir>/solana/. */
  dataDir: string;
  /** Default SOLANA_RPC_URL, then https://api.devnet.solana.com. */
  rpcUrl?: string | null;
  /** Default SOLANA_SCOREBOARD === "1". */
  enabled?: boolean;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  now?: () => number;
  /** How often pending matches are looked at again. Default 2000 ms. */
  pollMs?: number;
}

export type ScoresHandler = (req: Request) => Promise<Response>;

export interface Scoreboard {
  readonly enabled: boolean;
  routes: Record<string, ScoresHandler>;
  start(): void;
  stop(): void;
  /** Runs the queue now; resolves once it is idle and the log is written. */
  tick(): Promise<void>;
  /** Every match known, newest first. */
  list(sceneId?: string): ScoreRecord[];
}

// ---------------------------------------------------------------- the match and its memo

/** Printable text: no control characters, single spaces, at most `max` code points. */
function clip(raw: string, max: number): string {
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, max)
    .join('');
}

function text(v: unknown, max: number): string {
  if (typeof v === 'string') return clip(v, max);
  if (typeof v === 'number' && Number.isFinite(v)) return clip(String(v), max);
  return '';
}

/** "rbx-123", a bare UserId (number or digits), or another short person id. */
function personId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return `rbx-${v}`;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{1,20}$/.test(s)) return `rbx-${s}`;
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

export function resultKey(scene: string, round: string): string {
  return `${scene}|${round}`;
}

/** A game.result event as a match, or null when it lacks a game or a winner. */
export function parseGameResult(sceneId: string, ev: Record<string, unknown>, nowSec: number): GameResult | null {
  const game = text(ev.game, 32).toLowerCase();
  if (!GAME_RE.test(game)) return null;
  const winnerId = personId(ev.winner);
  const winnerName = text(ev.winnerName, 40) || winnerId || text(ev.winner, 40);
  if (!winnerName) return null;
  const loserId = personId(ev.loser);
  const loserName = text(ev.loserName, 40) || loserId || text(ev.loser, 40);
  const score = text(ev.score, 16);
  const t = typeof ev.t === 'number' && Number.isFinite(ev.t) && ev.t > 0 ? Math.floor(ev.t) : nowSec;
  let round = text(ev.round, 64);
  if (!round) {
    // no round id: the same result within the same minute is the same match
    const h = createHash('sha256').update([game, winnerId ?? winnerName, loserId ?? loserName, score, Math.floor(t / 60)].join('|'));
    round = `auto-${h.digest('hex').slice(0, 12)}`;
  }
  const d = ev.durationS;
  const durationS = typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= 86_400 ? Math.round(d) : undefined;
  const draw = ev.draw === true;
  return { scene: sceneId, game, round, winnerId, winnerName, loserId, loserName, score, ...(durationS ? { durationS } : {}), ...(draw ? { draw } : {}), t };
}

/**
 * JSON with every character past ASCII written as a \u escape. The Memo program logs what it is given, and multi-byte
 * text costs it far more: two names of 24 emoji take about 900k compute units on devnet, over the 200k an instruction
 * gets, while 400 ASCII bytes take about 155k.
 */
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The memo for a match: ASCII JSON of at most MEMO_MAX_BYTES (names start trimmed to 24 characters, and whichever
 * field is longest keeps losing a fifth until the whole thing fits). `draw: true` only for a draw.
 */
export function buildMemo(r: Pick<GameResult, 'scene' | 'game' | 'round' | 'winnerName' | 'loserName' | 'score' | 'draw' | 't'>): string {
  const f = {
    scene: clip(r.scene, 64),
    game: clip(r.game, 16),
    round: clip(r.round, 48),
    winner: clip(r.winnerName, 24),
    loser: clip(r.loserName, 24),
    score: clip(r.score, 16),
  };
  const render = () => asciiJson({ app: 'dejaview', v: 1, ...f, ...(r.draw ? { draw: true } : {}), t: r.t });
  const size = (s: string) => asciiJson(s).length;
  let memo = render();
  while (memo.length > MEMO_MAX_BYTES) {
    const k = (Object.keys(f) as (keyof typeof f)[]).reduce((a, b) => (size(f[b]) > size(f[a]) ? b : a));
    const cps = Array.from(f[k]);
    f[k] = cps.slice(0, Math.max(0, cps.length - Math.max(1, Math.ceil(cps.length / 5)))).join('');
    memo = render();
  }
  return memo;
}

// ---------------------------------------------------------------- HTTP helpers

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers },
  });
}

function segment(req: Request, index: number): string | null {
  try {
    const raw = new URL(req.url).pathname.split('/')[index];
    return raw === undefined ? null : decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the scoreboard

export function createScoreboard(o: ScoreboardOptions): Scoreboard {
  const log = o.log ?? ((m: string) => console.log(m));
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 2000;
  const dir = join(o.dataDir, 'solana');
  const logFile = join(dir, 'results.jsonl');
  const wanted = o.enabled ?? process.env.SOLANA_SCOREBOARD === '1';

  let rpcUrl: string | null = null;
  let refused: string | null = null;
  if (wanted) {
    try {
      rpcUrl = devnetRpcUrl(o.rpcUrl === undefined ? process.env.SOLANA_RPC_URL : o.rpcUrl);
    } catch (e) {
      refused = (e as Error).message;
    }
  }
  const client = wanted && rpcUrl ? new SolanaClient({ rpcUrl, keypairFile: join(dir, 'devnet-keypair.json'), fetch: o.fetch, log, now }) : null;
  const cluster: ScoresView['cluster'] = rpcUrl && isLocalRpc(rpcUrl) ? 'localnet' : 'devnet';

  const records = new Map<string, ScoreRecord>();
  const names = new Map<string, { name: string | null; at: number }>();
  let unsubscribe: (() => unknown) | null = null;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;
  let running: Promise<void> | null = null;
  let again = false;
  let notBefore = 0;
  let failures = 0;
  let turnedAwayAt = -Infinity;

  // ------------------------------------------------------------ the log

  /**
   * Applies `patch` and appends the match's new line. Synchronous (a line is a few hundred bytes): once it returns
   * true the line is on disk, so a signature saved here survives a crash or a shutdown right after.
   */
  function save(r: ScoreRecord, patch: Partial<ScoreRecord> = {}): boolean {
    Object.assign(r, patch);
    for (const k of Object.keys(patch) as (keyof ScoreRecord)[]) if (patch[k] === undefined) delete r[k];
    r.at = new Date(now()).toISOString();
    try {
      appendFileSync(logFile, JSON.stringify(r) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      log(`[scores] could not write ${logFile}: ${(e as Error).message}`);
      return false;
    }
  }

  /** The RPC serves another cluster: nothing more is signed or sent, and the routes say why. */
  function halt(e: DevnetOnlyError): void {
    if (refused) return;
    refused = e.message;
    if (timer) clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
    log(`[scores] ${refused} The scoreboard stays off.`);
  }

  function load(): void {
    let raw = '';
    try {
      raw = readFileSync(logFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`[scores] could not read ${logFile}: ${(e as Error).message}`);
      return;
    }
    // a crash mid-line: close it off, so the next line is not glued onto it
    if (raw && !raw.endsWith('\n')) {
      try {
        appendFileSync(logFile, '\n');
      } catch {
        /* the next append reports it */
      }
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ScoreRecord;
        // a line cut short by a crash is skipped; the line before it still holds that match
        if (typeof r.key !== 'string' || typeof r.memo !== 'string' || !['pending', 'confirmed', 'failed'].includes(r.status)) continue;
        records.delete(r.key);
        records.set(r.key, r);
      } catch {
        /* skipped */
      }
    }
    const pending = [...records.values()].filter((r) => r.status === 'pending').length;
    if (records.size) log(`[scores] ${records.size} match(es) on file${pending ? `, ${pending} still to confirm` : ''}`);
  }

  // ------------------------------------------------------------ events in

  function onEvent(sceneId: string, ev: EventIn): void {
    try {
      if (refused || !RESULT_TYPES.has(ev.type) || !SCENE_ID_RE.test(sceneId)) return;
      const r = parseGameResult(sceneId, ev, Math.floor(now() / 1000));
      if (!r) {
        log(`[scores] ${sceneId}: a game.result without a game or a winner was skipped`);
        return;
      }
      const key = resultKey(r.scene, r.round);
      if (records.has(key)) return;
      if (pendingNow().length >= MAX_PENDING) {
        if (now() - turnedAwayAt > 60_000) {
          turnedAwayAt = now();
          log(`[scores] ${MAX_PENDING} matches are still waiting for Solana; new ones are skipped until they clear`);
        }
        return;
      }
      const rec: ScoreRecord = { ...r, key, memo: buildMemo(r), status: 'pending', signature: null, rejections: 0, at: '' };
      records.set(key, rec);
      save(rec);
      schedule(0);
    } catch (e) {
      log(`[scores] ${sceneId}: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ the queue

  function schedule(ms: number): void {
    if (!started || refused) return;
    const at = Date.now() + ms;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      void tick();
    }, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  }

  function tick(): Promise<void> {
    if (!client || !started || refused) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        // the queue never takes the server down with it
        await step(client).catch((e) => log(`[scores] ${(e as Error).message}`));
      } while (again && started && !refused);
    })().finally(() => (running = null));
    return running;
  }

  const pendingNow = () => [...records.values()].filter((r) => r.status === 'pending');

  async function step(c: SolanaClient): Promise<void> {
    const t = now();
    if (t < notBefore) return schedule(notBefore - t);
    if (!pendingNow().length) return;
    try {
      await confirmSent(c, pendingNow().filter((r) => r.signature));
      await sendUnsent(c, pendingNow().filter((r) => !r.signature));
      failures = 0;
    } catch (e) {
      if (e instanceof DevnetOnlyError) return halt(e);
      failures++;
      const ra = e instanceof RpcError ? (e.retryAfterMs ?? 0) : 0;
      const wait = Math.max(ra, Math.min(60_000, 2000 * 2 ** (failures - 1)));
      notBefore = now() + wait;
      if (failures === 1 || failures % 5 === 0) log(`[scores] ${(e as Error).message}; trying again in ${Math.round(wait / 1000)} s`);
    }
    if (pendingNow().length) schedule(Math.max(pollMs, notBefore - now()));
  }

  /** Signed and (maybe) sent: confirmed, failed on chain, or expired unseen (then it is signed again). */
  async function confirmSent(c: SolanaClient, sent: ScoreRecord[]): Promise<void> {
    if (!sent.length) return;
    const statuses = await c.statuses(sent.map((r) => r.signature!));
    const unseen: ScoreRecord[] = [];
    for (let i = 0; i < sent.length; i++) {
      const r = sent[i]!;
      const s = statuses[i] ?? null;
      if (s?.err) {
        save(r, { status: 'failed', slot: s.slot, error: `Solana refused it: ${JSON.stringify(s.err).slice(0, 160)}` });
      } else if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
        save(r, { status: 'confirmed', slot: s.slot, error: undefined });
      } else if (!s) {
        unseen.push(r);
      }
    }
    if (!unseen.length) return;
    // past its blockhash (finalized height) it can never land, so a second signature cannot make a second memo
    const height = unseen.some((r) => r.lastValidBlockHeight !== undefined) ? await c.blockHeight() : 0;
    const expired = unseen.filter((r) => r.lastValidBlockHeight === undefined || height > r.lastValidBlockHeight);
    if (!expired.length) return;
    // asked again after the height: one that landed just before its blockhash ran out shows up now, and is kept
    const again = await c.statuses(expired.map((r) => r.signature!));
    expired.forEach((r, i) => {
      if (!again[i]) save(r, { signature: null, lastValidBlockHeight: undefined, error: 'Expired before it landed; signing again.' });
    });
  }

  async function sendUnsent(c: SolanaClient, unsent: ScoreRecord[]): Promise<void> {
    if (!unsent.length) return;
    const funded = await c.ensureFunded();
    if (!funded.ok) {
      // the faucet's own backoff lives in the client; this only decides when to look again
      notBefore = now() + (funded.retryInMs ?? 30_000);
      return;
    }
    for (const r of unsent.slice(0, SENDS_PER_TICK)) {
      if (!started || refused) return;
      const signed = await c.signMemo(r.memo);
      // on disk before it goes out: after a crash right here, the status check finds it (or its blockhash expires).
      // Not on disk: not sent either (the record keeps the signature, so it waits out the blockhash and signs again)
      if (!save(r, { signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight, error: undefined })) {
        throw new Error('the results log cannot be written, so nothing is sent');
      }
      try {
        await c.send(signed.transaction);
        c.spent(FEE_LAMPORTS);
      } catch (e) {
        // no answer, a gateway error, an internal error: it may have gone out; the status check (or expiry) decides
        if (!(e instanceof RpcError) || !e.refused) throw e;
        // turned down by the RPC itself (bad request, preflight, rate limit): never forwarded, so signing again is safe
        const money = /prior credit|insufficient|AccountNotFound/i.test(e.message);
        const transient = e.rateLimited || money || e.code === -32005 || e.code === -32016 || /blockhash not found|behind|unhealthy/i.test(e.message);
        const rejections = r.rejections + (transient ? 0 : 1);
        save(r, {
          signature: null,
          lastValidBlockHeight: undefined,
          rejections,
          error: e.message.slice(0, 200),
          ...(rejections >= MAX_REJECTIONS ? { status: 'failed' as const } : {}),
        });
        if (money) c.forgetBalance();
        if (transient) throw e;
      }
    }
    if (unsent.length > SENDS_PER_TICK) again = true;
  }

  async function warmup(c: SolanaClient): Promise<void> {
    try {
      const kp = await c.keypair();
      const f = await c.ensureFunded();
      const sol = f.lamports === null ? '?' : (f.lamports / LAMPORTS_PER_SOL).toFixed(3);
      log(`[scores] Solana ${cluster} scoreboard on: account ${kp.address} (${sol} SOL) via ${rpcHost(c.rpcUrl)}`);
    } catch (e) {
      if (e instanceof DevnetOnlyError) return halt(e);
      log(`[scores] Solana ${cluster} scoreboard on, but ${(e as Error).message}; matches wait in the queue`);
    }
  }

  // ------------------------------------------------------------ reading

  function list(sceneId?: string): ScoreRecord[] {
    const all = [...records.values()];
    const seq = new Map(all.map((r, i) => [r, i]));
    return all.filter((r) => !sceneId || r.scene === sceneId).sort((a, b) => b.t - a.t || seq.get(b)! - seq.get(a)!);
  }

  async function sceneName(id: string): Promise<string | null> {
    const hit = names.get(id);
    if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
    let name: string | null = null;
    try {
      name = (await o.getScene?.(id))?.name?.trim() || null;
    } catch {
      name = hit?.name ?? null;
    }
    names.set(id, { name, at: Date.now() });
    return name;
  }

  function leaders(rows: ScoreRecord[]): Leader[] {
    const by = new Map<string, Leader>();
    const entry = (id: string | null, name: string) => {
      const k = id ?? `name:${name}`;
      let l = by.get(k);
      if (!l) by.set(k, (l = { name, id, wins: 0, losses: 0 }));
      return l;
    };
    // oldest first, so each player keeps the latest name they played under; a draw counts for nobody
    for (const r of [...rows].reverse()) {
      if (r.status === 'failed' || r.draw) continue;
      if (r.winnerId !== BOT_ID) {
        const w = entry(r.winnerId, r.winnerName);
        w.wins++;
        w.name = r.winnerName;
      }
      if (r.loserName && r.loserId !== BOT_ID) {
        const l = entry(r.loserId, r.loserName);
        l.losses++;
        l.name = r.loserName;
      }
    }
    return [...by.values()]
      .filter((l) => l.wins > 0)
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name))
      .slice(0, LEADERS_LIMIT);
  }

  async function view(sceneId?: string): Promise<ScoresView> {
    const scoped = sceneId ? { scene: sceneId, sceneName: await sceneName(sceneId) } : {};
    if (!client || refused) {
      return {
        enabled: false,
        cluster,
        account: null,
        accountExplorer: null,
        ...scoped,
        scores: [],
        leaders: [],
        ...(refused ? { error: 'The scoreboard writes to Solana devnet only, and this server points at another network.' } : {}),
      };
    }
    const all = list(sceneId);
    const top = all.slice(0, LIST_LIMIT);
    const sceneNames = new Map<string, string | null>();
    for (const id of new Set(top.map((r) => r.scene))) sceneNames.set(id, await sceneName(id));
    const account = client.address;
    return {
      enabled: true,
      cluster,
      account,
      accountExplorer: account ? explorerAddressUrl(account, rpcUrl!) : null,
      ...scoped,
      scores: top.map((r) => ({
        scene: r.scene,
        sceneName: sceneNames.get(r.scene) ?? null,
        game: r.game,
        round: r.round,
        winner: r.winnerName,
        winnerId: r.winnerId,
        loser: r.loserName,
        loserId: r.loserId,
        score: r.score,
        durationS: r.durationS ?? null,
        draw: r.draw === true,
        time: new Date(r.t * 1000).toISOString(),
        signature: r.signature,
        explorer: r.signature ? explorerTxUrl(r.signature, rpcUrl!) : null,
        status: r.status,
      })),
      leaders: leaders(all),
    };
  }

  const handler =
    (scoped: boolean): ScoresHandler =>
    async (req) => {
      try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
        if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: "That action isn't supported here." }, 405, { Allow: 'GET, HEAD, OPTIONS' });
        let sceneId: string | undefined;
        if (scoped) {
          const id = segment(req, 3);
          if (!id || !SCENE_ID_RE.test(id)) return json({ error: "We couldn't find that world." }, 404);
          sceneId = id;
        }
        const res = json(await view(sceneId));
        return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
      } catch (e) {
        log(`[scores] ${(e as Error).message}`);
        return json({ error: 'Something went wrong on our side.' }, 500);
      }
    };

  return {
    get enabled() {
      return !!client && !refused;
    },
    routes: {
      '/api/scores': handler(false),
      '/api/scores/:sceneId': handler(true),
    },
    start() {
      if (started) return;
      if (refused) {
        log(`[scores] ${refused} The scoreboard stays off.`);
        return;
      }
      if (!client) return;
      started = true;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (e) {
        log(`[scores] could not make ${dir}: ${(e as Error).message}`);
      }
      if (!records.size) load();
      const un = o.onEvent(onEvent);
      unsubscribe = typeof un === 'function' ? (un as () => unknown) : null;
      void warmup(client);
      schedule(0);
    },
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
    },
    tick,
    list,
  };
}
