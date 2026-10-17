// The tab: every memory of a night out keeps what the night cost and who paid, and settles up right there.
// Purchases at the place are booked in Capital One's Nessie sandbox on the payer's account; the fewest transfers
// that even the night out are suggested, and "Settle up" makes them as Nessie P2P transfers between the friends'
// accounts. With "loser covers the table" on, a Roblox game.result books the table fee to the match's loser.
//
//   GET  /api/tab/:sceneId            friends, purchases, balances, suggested and settled transfers, games, mode
//   POST /api/tab/:sceneId/purchase   {payer, merchant, amount, description?, split?: [names], table?, category?}
//   POST /api/tab/:sceneId/settle     {} -> the Nessie transfers it made (none when the tab is already square)
//   POST /api/tab/:sceneId/rules      {loserCoversTable, tableFee?}  (tableFee null: the loser covers the whole table)
//
// One file per memory, data/tab/<sceneId>.json, written atomically and changed one request at a time. Friends get a
// Nessie customer and checking account the first time they pay or owe. Amounts are cents inside and dollars with two
// decimals on the wire. Mock money only: no account number is stored or sent, only Nessie's object ids.
//
// Game results (team contracts 6.5, game.result): {type:"game.result", game, round, winner, winnerName, loser,
// loserName, score, durationS, draw?} from POST /api/roblox/:sceneId/event reach createTab's onEvent subscriber. They
// go on a queue of their own (the event route never waits for Nessie), other types are ignored ("game_result" is
// taken as well, as the scoreboard does), each (sceneId, round) counts once, and a draw or a "bot" side moves no money.

import { join } from 'node:path';
import type { Scene } from '../../shared/types.ts';
import { mutationBlocked, NOT_ALLOWED_MESSAGE, type GuardOptions } from '../guard.ts';
import { fail, json, methodNotAllowed, preflight, readJson, SCENE_ID_RE, type RequestIpSource } from '../social/http.ts';
import { randomSuffix, writeJsonAtomic } from '../store.ts';
import { MOCK_ADDRESS, NessieError, type BankMode, type NessieClient } from './nessie.ts';

// ---------------------------------------------------------------- limits and wording

export const MAX_AMOUNT_CENTS = 50_000;
export const MAX_FRIENDS = 12;
export const MAX_PURCHASES = 200;
const MAX_GAMES = 300;
const MAX_QUEUE = 200;
const BODY_MAX = 4096;
/** A friend's new Nessie checking account opens with this much mock money. */
const OPENING_BALANCE_CENTS = 50_000;
const FAILED_SHOWN = 5;

const MESSAGES = {
  noScene: "We couldn't find that memory.",
  server: 'Something went wrong on the server. Try again.',
  full: 'This tab is full.',
  tooManyFriends: `A tab holds up to ${MAX_FRIENDS} friends.`,
  bank: (msg: string) => `Capital One's Nessie sandbox didn't take that. ${msg}`,
  damaged: "This memory's tab file can't be read. Nothing was changed.",
  readOnly: 'This copy of the app can only show the tab. Make changes from the main Déjà View server.',
} as const;

/** The event types a finished match arrives as (the scoreboard takes the same two). */
const RESULT_TYPES: ReadonlySet<string> = new Set(['game.result', 'game_result']);
/** A payment still pending after this long was cut off by a restart: it shows as unconfirmed. */
const PENDING_STALE_MS = 120_000;

/**
 * The routes that change a tab (and spend mock money). The integrator puts sign-in in front of these, or passes
 * `authorize` to createTab; GET /api/tab/:sceneId stays open like the memories themselves.
 */
export const TAB_MUTATING_ROUTES = ['/api/tab/:sceneId/purchase', '/api/tab/:sceneId/settle', '/api/tab/:sceneId/rules'] as const;

// ---------------------------------------------------------------- the file

export interface TabFriend {
  /** The name folded: lower case, no accents, single spaces. */
  id: string;
  name: string;
  /** Which bank the ids below belong to; ids from the other one are made again. */
  bank?: BankMode;
  customerId?: string;
  accountId?: string;
  /** "rbx-<UserId>", learned from game results that named this friend. */
  robloxId?: string;
}

export interface TabPurchase {
  id: string;
  /** Friend id. */
  payer: string;
  merchant: string;
  merchantId: string | null;
  amountCents: number;
  description: string;
  /** Friend ids who share it equally. */
  split: string[];
  /** The table fee: what "loser covers the table" moves onto a match's loser. */
  table: boolean;
  at: string;
  bank: BankMode;
  nessieId: string | null;
}

export type PaymentStatus = 'pending' | 'paid' | 'unconfirmed' | 'failed';

export interface TabPayment {
  id: string;
  /** settle: from "Settle up"; table: a loser covering the table. */
  kind: 'settle' | 'table';
  from: string;
  to: string;
  amountCents: number;
  description: string;
  at: string;
  bank: BankMode;
  /** pending: written before the call; unconfirmed: the call timed out (counted as paid, never made twice). */
  status: PaymentStatus;
  nessieId: string | null;
  creditId?: string | null;
  error?: string;
  /** The game round a table payment came from. */
  round?: string;
}

export interface TabGame {
  round: string;
  game: string;
  winner?: string;
  winnerName?: string;
  loser?: string;
  loserName?: string;
  score?: string;
  durationS?: number;
  /** A draw: winner and loser are just the two players. */
  draw?: boolean;
  at: string;
  /** charged: the loser pays the table's payer; covered: the loser had paid for it; skipped: see note. */
  status: 'charged' | 'covered' | 'skipped';
  note?: string;
  loserId?: string;
  payeeId?: string;
  purchaseId?: string;
  chargeCents?: number;
  paymentId?: string;
}

export interface TabRules {
  loserCoversTable: boolean;
  /** What one lost match covers; null: whatever is left of the table. */
  tableFeeCents: number | null;
}

export interface TabFile {
  v: 1;
  sceneId: string;
  createdAt: string;
  updatedAt: string;
  friends: TabFriend[];
  purchases: TabPurchase[];
  payments: TabPayment[];
  games: TabGame[];
  rules: TabRules;
  /** Merchant name folded -> its Nessie id. */
  merchants: Record<string, { id: string; bank: BankMode }>;
  settledAt: string | null;
}

export function emptyTab(sceneId: string, at: string): TabFile {
  return {
    v: 1,
    sceneId,
    createdAt: at,
    updatedAt: at,
    friends: [],
    purchases: [],
    payments: [],
    games: [],
    rules: { loserCoversTable: false, tableFeeCents: null },
    // no prototype: a merchant called "__proto__" or "constructor" is just a key
    merchants: Object.create(null),
    settledAt: null,
  };
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A file from disk with every field present (older or hand-edited files may miss some). */
export function normalizeTab(raw: unknown, sceneId: string): TabFile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<TabFile>;
  const base = emptyTab(sceneId, typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString());
  return {
    ...base,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : base.updatedAt,
    friends: arr<TabFriend>(o.friends).filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string'),
    purchases: arr<TabPurchase>(o.purchases).filter((p) => p && Number.isSafeInteger(p.amountCents) && typeof p.payer === 'string'),
    payments: arr<TabPayment>(o.payments).filter((p) => p && Number.isSafeInteger(p.amountCents)),
    games: arr<TabGame>(o.games).filter((g) => g && typeof g.round === 'string'),
    rules: {
      loserCoversTable: o.rules?.loserCoversTable === true,
      tableFeeCents: Number.isSafeInteger(o.rules?.tableFeeCents) ? o.rules!.tableFeeCents! : null,
    },
    merchants: Object.assign(Object.create(null), o.merchants && typeof o.merchants === 'object' ? o.merchants : {}),
    settledAt: typeof o.settledAt === 'string' ? o.settledAt : null,
  };
}

// ---------------------------------------------------------------- validation

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Dollars (a number or "12.50") into cents: more than 0, at most $500, at most two decimals. */
export function parseAmount(raw: unknown, field = 'amount'): Parsed<number> {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\$?\s*\d{1,6}(\.\d{1,2})?\s*$/.test(raw)) n = Number(raw.replace(/[$\s]/g, ''));
  else return { ok: false, error: `${field} must be dollars, like 12.50.` };
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT_CENTS / 100) return { ok: false, error: `${field} must be more than $0 and at most $500.` };
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return { ok: false, error: `${field} can have at most two decimals.` };
  if (cents < 1) return { ok: false, error: `${field} must be more than $0 and at most $500.` };
  return { ok: true, value: cents };
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]*$/u;
const TEXT_RE = /^[^\p{Cc}<>]*$/u;

/** A person's name: letters, digits, spaces and . ' -, at most 24 characters. */
export function parseName(raw: unknown, field = 'name'): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${field} must be a short name.` };
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 24 || !NAME_RE.test(s)) return { ok: false, error: `${field} must be a short name (up to 24 letters).` };
  return { ok: true, value: s };
}

/** A merchant or a description: plain text, no control characters or angle brackets. */
export function parseText(raw: unknown, field: string, max: number): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${field} must be text.` };
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || !TEXT_RE.test(s)) return { ok: false, error: `${field} must be up to ${max} characters of plain text.` };
  return { ok: true, value: s };
}

/** The friend id of a name: lower case, accents dropped, single spaces. */
export function friendId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- the math

/** `total` cents in `n` shares that add up exactly; the first shares carry the leftover cents. */
export function splitCents(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Payments that moved money (or may have): they count toward the balances. */
const counts = (p: TabPayment) => p.status === 'paid' || p.status === 'unconfirmed' || p.status === 'pending';
/** Games whose charge moved part of a table purchase onto the loser. */
const covering = (g: TabGame) => (g.status === 'charged' || g.status === 'covered') && !!g.purchaseId && !!g.loserId && (g.chargeCents ?? 0) > 0;

export interface Balance {
  friend: string;
  paidCents: number;
  shareCents: number;
  /** Positive: the others owe this friend; negative: this friend owes. Payments already made are counted. */
  netCents: number;
}

/**
 * Who paid what, whose share it was, and what is left: per purchase the payer paid it all and its split shares it
 * equally (to the cent); the part of a table purchase a lost match covered is the loser's alone; and every payment
 * made (settle-ups and table covers) moves the difference. The nets always add up to zero.
 */
export function computeBalances(tab: Pick<TabFile, 'friends' | 'purchases' | 'payments' | 'games'>): Balance[] {
  const rows = new Map<string, Balance>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { friend: id, paidCents: 0, shareCents: 0, netCents: 0 }));
    return r;
  };
  for (const f of tab.friends) row(f.id);
  const coveredBy = new Map<string, TabGame[]>();
  for (const g of tab.games) if (covering(g)) coveredBy.set(g.purchaseId!, [...(coveredBy.get(g.purchaseId!) ?? []), g]);
  for (const p of tab.purchases) {
    row(p.payer).paidCents += p.amountCents;
    let left = p.amountCents;
    for (const g of coveredBy.get(p.id) ?? []) {
      const c = Math.min(g.chargeCents!, left);
      row(g.loserId!).shareCents += c;
      left -= c;
    }
    const split = p.split.length ? p.split : [p.payer];
    splitCents(left, split.length).forEach((c, i) => (row(split[i]!).shareCents += c));
  }
  for (const r of rows.values()) r.netCents = r.paidCents - r.shareCents;
  for (const p of tab.payments) {
    if (!counts(p)) continue;
    row(p.from).netCents += p.amountCents;
    row(p.to).netCents -= p.amountCents;
  }
  return [...rows.values()];
}

export interface Transfer {
  from: string;
  to: string;
  amountCents: number;
}

/**
 * The fewest transfers that zero the nets, greedily: a debt that equals a credit settles in one transfer first,
 * then the largest debt pays the largest credit until nothing is owed. At most n-1 transfers for n friends.
 * Ties go to the friend listed first, so the same tab always gives the same transfers.
 */
export function settlement(balances: Pick<Balance, 'friend' | 'netCents'>[]): Transfer[] {
  const order = new Map(balances.map((b, i) => [b.friend, i]));
  const debtors = balances.filter((b) => b.netCents < 0).map((b) => ({ id: b.friend, left: -b.netCents }));
  const creditors = balances.filter((b) => b.netCents > 0).map((b) => ({ id: b.friend, left: b.netCents }));
  const out: Transfer[] = [];
  const byLeft = (a: { id: string; left: number }, b: { id: string; left: number }) => b.left - a.left || order.get(a.id)! - order.get(b.id)!;
  debtors.sort(byLeft);
  for (const d of debtors) {
    const c = creditors.find((x) => x.left === d.left && x.left > 0);
    if (!c) continue;
    out.push({ from: d.id, to: c.id, amountCents: d.left });
    c.left = 0;
    d.left = 0;
  }
  for (;;) {
    const d = debtors.filter((x) => x.left > 0).sort(byLeft)[0];
    const c = creditors.filter((x) => x.left > 0).sort(byLeft)[0];
    if (!d || !c) break;
    const amountCents = Math.min(d.left, c.left);
    out.push({ from: d.id, to: c.id, amountCents });
    d.left -= amountCents;
    c.left -= amountCents;
  }
  return out;
}

/** The purchases that are the table: the ones marked so, else the ones paid at the place itself. */
export function tablePurchases(tab: Pick<TabFile, 'purchases'>, placeName?: string | null): TabPurchase[] {
  const marked = tab.purchases.filter((p) => p.table);
  if (marked.length) return marked;
  const place = placeName ? friendId(placeName) : '';
  return place ? tab.purchases.filter((p) => friendId(p.merchant) === place) : [];
}

/** Cents of each table purchase no lost match has covered yet, oldest first. */
export function uncoveredTable(tab: Pick<TabFile, 'purchases' | 'games'>, placeName?: string | null): { purchase: TabPurchase; leftCents: number }[] {
  return tablePurchases(tab, placeName).map((p) => {
    const covered = tab.games.filter((g) => covering(g) && g.purchaseId === p.id).reduce((s, g) => s + g.chargeCents!, 0);
    return { purchase: p, leftCents: Math.max(0, p.amountCents - covered) };
  });
}

// ---------------------------------------------------------------- the view (GET)

const dollars = (cents: number) => Math.round(cents) / 100;

export interface TabView {
  sceneId: string;
  scene: { name: string; thumb: string | null };
  mode: BankMode;
  currency: 'USD';
  friends: { id: string; name: string; nessie: { customerId: string; accountId: string } | null; robloxId?: string }[];
  purchases: (Omit<TabPurchase, 'payer'> & { payer: string; payerName: string; amount: number; coveredCents: number })[];
  totalCents: number;
  total: number;
  balances: (Balance & { name: string; net: number })[];
  /** Suggested: what "Settle up" would send. */
  transfers: (Transfer & { fromName: string; toName: string; amount: number })[];
  /** Made: settle-ups and table covers, with their Nessie ids. */
  settled: (TabPayment & { fromName: string; toName: string; amount: number })[];
  /** The latest payments that did not go through. */
  failed: (TabPayment & { fromName: string; toName: string; amount: number })[];
  games: (TabGame & { payeeName?: string; charge?: number })[];
  rules: { loserCoversTable: boolean; tableFee: number | null; tableFeeCents: number | null };
  /** Nothing is owed (and something was bought). */
  square: boolean;
  settledAt: string | null;
  updatedAt: string | null;
}

export function viewOf(tab: TabFile, scene: Pick<Scene, 'id' | 'name' | 'thumb'>, mode: BankMode, exists = true, nowMs = Date.now()): TabView {
  const names = new Map(tab.friends.map((f) => [f.id, f.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const balances = computeBalances(tab);
  const transfers = settlement(balances);
  const coveredCents = new Map<string, number>();
  for (const { purchase, leftCents } of uncoveredTable(tab, scene.name)) coveredCents.set(purchase.id, purchase.amountCents - leftCents);
  const stale = (p: TabPayment) => p.status === 'pending' && nowMs - Date.parse(p.at) > PENDING_STALE_MS;
  const payment = (p: TabPayment) => ({
    ...p,
    ...(stale(p) ? { status: 'unconfirmed' as const } : {}),
    fromName: nameOf(p.from),
    toName: nameOf(p.to),
    amount: dollars(p.amountCents),
  });
  const totalCents = tab.purchases.reduce((s, p) => s + p.amountCents, 0);
  return {
    sceneId: tab.sceneId,
    scene: {
      name: scene.name,
      thumb: scene.thumb ? `/data/scenes/${encodeURIComponent(scene.id)}/${scene.thumb.split('/').map(encodeURIComponent).join('/')}` : null,
    },
    mode,
    currency: 'USD',
    friends: tab.friends.map((f) => ({
      id: f.id,
      name: f.name,
      nessie: f.customerId && f.accountId ? { customerId: f.customerId, accountId: f.accountId } : null,
      ...(f.robloxId ? { robloxId: f.robloxId } : {}),
    })),
    purchases: tab.purchases.map((p) => ({ ...p, payerName: nameOf(p.payer), amount: dollars(p.amountCents), coveredCents: coveredCents.get(p.id) ?? 0 })),
    totalCents,
    total: dollars(totalCents),
    balances: balances.map((b) => ({ ...b, name: nameOf(b.friend), net: dollars(b.netCents) })),
    transfers: transfers.map((t) => ({ ...t, fromName: nameOf(t.from), toName: nameOf(t.to), amount: dollars(t.amountCents) })),
    settled: tab.payments.filter((p) => p.status !== 'failed').map(payment),
    failed: tab.payments.filter((p) => p.status === 'failed').slice(-FAILED_SHOWN).map(payment),
    games: tab.games.map((g) => ({
      ...g,
      ...(g.payeeId ? { payeeName: nameOf(g.payeeId) } : {}),
      ...(g.chargeCents ? { charge: dollars(g.chargeCents) } : {}),
    })),
    rules: {
      loserCoversTable: tab.rules.loserCoversTable,
      tableFee: tab.rules.tableFeeCents === null ? null : dollars(tab.rules.tableFeeCents),
      tableFeeCents: tab.rules.tableFeeCents,
    },
    square: tab.purchases.length > 0 && transfers.length === 0,
    settledAt: tab.settledAt,
    updatedAt: exists ? tab.updatedAt : null,
  };
}

// ---------------------------------------------------------------- the service

export class TabError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TabError';
  }
}

/** A Roblox moment as presence hands it to subscribers. */
export interface TabEventIn {
  type: string;
  [key: string]: unknown;
}

export type TabHandler = (req: Request, server?: RequestIpSource) => Promise<Response>;

export interface TabDeps {
  getScene: (id: string) => Promise<Scene | null>;
  /** The server's data folder; tabs live in <dataDir>/tab. */
  dataDir: string;
  nessie: NessieClient;
  /** Subscribes to Roblox moments (presence.onEvent); returns the unsubscribe. */
  onEvent?: (fn: (sceneId: string, event: TabEventIn) => void) => () => void;
  /** Cross-site pages may not spend mock money (server/guard.ts). */
  guard?: GuardOptions;
  /** Sign-in in front of every mutating route: null to go ahead, else the response to send. */
  authorize?: (req: Request, server?: RequestIpSource) => Promise<Response | null>;
  /** A server on a data folder another server owns: the tab is shown, never changed, and game results are ignored. */
  readOnly?: boolean;
  now?: () => number;
  log?: (msg: string) => void;
  /** Opening balance of a friend's new Nessie account, cents. Default $500. */
  openingBalanceCents?: number;
}

export interface PurchaseInput {
  payer: unknown;
  merchant: unknown;
  amount: unknown;
  description?: unknown;
  split?: unknown;
  table?: unknown;
  category?: unknown;
}

export interface SettleResult {
  /** True when nothing was owed: no transfer was made. */
  already: boolean;
  made: TabPayment[];
  tab: TabView;
}

export interface TabService {
  routes: Record<string, TabHandler>;
  /** Subscribes to game results (again after stop). Safe to call more than once. */
  start(): void;
  /** Unsubscribes and resolves once the game result in hand is handled; the ones still queued are dropped. */
  stop(): Promise<void>;
  /** Resolves once every queued game result is handled (tests, the seed). */
  idle(): Promise<void>;
  view(sceneId: string): Promise<TabView>;
  addPurchase(sceneId: string, input: PurchaseInput): Promise<{ purchase: TabPurchase; tab: TabView }>;
  setRules(sceneId: string, input: { loserCoversTable: unknown; tableFee?: unknown }): Promise<TabView>;
  settle(sceneId: string): Promise<SettleResult>;
  /** Hands one event to the game queue, as the onEvent subscription does. */
  onGameEvent(sceneId: string, event: TabEventIn): void;
}

const short = (v: unknown, max = 40): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function createTab(deps: TabDeps): TabService {
  const dir = join(deps.dataDir, 'tab');
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const nessie = deps.nessie;
  const opening = deps.openingBalanceCents ?? OPENING_BALANCE_CENTS;
  const iso = () => new Date(now()).toISOString();
  const ref = (prefix: string) => `${prefix}_${randomSuffix(8)}`;
  const show = (tab: TabFile, scene: Scene, exists = true) => viewOf(tab, scene, nessie.mode, exists, now());

  // ------------------------------------------------------------ files, one change at a time per memory

  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(sceneId: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(sceneId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(sceneId, tail);
    void tail.then(() => chains.get(sceneId) === tail && chains.delete(sceneId));
    return run;
  }

  const fileOf = (sceneId: string) => join(dir, `${sceneId}.json`);

  async function readTab(sceneId: string): Promise<TabFile | null> {
    const f = Bun.file(fileOf(sceneId));
    if (!(await f.exists())) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      log(`[tab] ${sceneId}: tab file is not valid JSON; left as it is`);
      throw new TabError(500, MESSAGES.damaged);
    }
    return normalizeTab(raw, sceneId);
  }

  async function writeTab(tab: TabFile): Promise<void> {
    tab.updatedAt = iso();
    await writeJsonAtomic(fileOf(tab.sceneId), tab);
  }

  async function sceneOrThrow(sceneId: string): Promise<Scene> {
    if (!SCENE_ID_RE.test(sceneId)) throw new TabError(404, MESSAGES.noScene);
    let scene: Scene | null = null;
    try {
      scene = await deps.getScene(sceneId);
    } catch {
      scene = null;
    }
    if (!scene) throw new TabError(404, MESSAGES.noScene);
    return scene;
  }

  /**
   * Runs a change on the memory's tab. Whatever the change wrote into the tab is saved even when it throws halfway,
   * so a Nessie account made before a failed purchase is never made twice.
   */
  async function change<T>(sceneId: string, fn: (tab: TabFile, scene: Scene) => Promise<T>): Promise<T> {
    if (deps.readOnly) throw new TabError(503, MESSAGES.readOnly);
    const scene = await sceneOrThrow(sceneId);
    return locked(sceneId, async () => {
      const tab = (await readTab(sceneId)) ?? emptyTab(sceneId, iso());
      const before = JSON.stringify(tab);
      try {
        return await fn(tab, scene);
      } finally {
        if (JSON.stringify(tab) !== before) await writeTab(tab);
      }
    });
  }

  // ------------------------------------------------------------ friends and merchants in Nessie

  function addFriend(tab: TabFile, name: string): TabFriend {
    const id = friendId(name);
    const known = tab.friends.find((f) => f.id === id);
    if (known) return known;
    if (tab.friends.length >= MAX_FRIENDS) throw new TabError(409, MESSAGES.tooManyFriends);
    const f: TabFriend = { id, name };
    tab.friends.push(f);
    return f;
  }

  /** The friend's Nessie checking account, opened the first time it is needed (again after a demo bank restart). */
  async function accountOf(friend: TabFriend): Promise<string> {
    if (friend.bank === nessie.mode && friend.accountId) {
      // the demo bank lives in memory: a restart empties it, so its ids are checked
      if (nessie.mode === 'nessie' || (await nessie.getAccount(friend.accountId))) return friend.accountId;
      delete friend.customerId;
    }
    if (friend.bank !== nessie.mode || !friend.customerId) {
      const customer = await nessie.createCustomer({ firstName: friend.name, lastName: 'Déjà View', address: MOCK_ADDRESS });
      friend.bank = nessie.mode;
      friend.customerId = customer.id;
      delete friend.accountId;
    }
    const account = await nessie.createAccount(friend.customerId, { nickname: `${friend.name}'s tab`, balanceCents: opening });
    friend.accountId = account.id;
    return account.id;
  }

  async function merchantOf(tab: TabFile, name: string, category?: string): Promise<string> {
    const key = friendId(name);
    const cached = tab.merchants[key];
    if (cached && cached.bank === nessie.mode) {
      if (nessie.mode === 'nessie' || (await nessie.listMerchants()).some((m) => m.id === cached.id)) return cached.id;
    }
    const m = await nessie.createMerchant({ name, ...(category ? { category } : {}) });
    tab.merchants[key] = { id: m.id, bank: nessie.mode };
    return m.id;
  }

  /** Pays `amountCents` from one friend to another in Nessie, recording the payment before and after the call. */
  async function pay(tab: TabFile, p: Omit<TabPayment, 'status' | 'nessieId' | 'bank' | 'at' | 'id'>): Promise<TabPayment> {
    const from = tab.friends.find((f) => f.id === p.from)!;
    const to = tab.friends.find((f) => f.id === p.to)!;
    const fromAcc = await accountOf(from);
    const toAcc = await accountOf(to);
    const rec: TabPayment = { id: ref(p.kind === 'table' ? 't' : 's'), ...p, at: iso(), bank: nessie.mode, status: 'pending', nessieId: null };
    tab.payments.push(rec);
    // on disk before the money moves: a crash during the call can never make it pay twice
    await writeTab(tab);
    try {
      const t = await nessie.createTransfer(fromAcc, { payeeAccountId: toAcc, amountCents: p.amountCents, description: `${p.description} (${rec.id})`.slice(0, 160) });
      rec.status = 'paid';
      rec.nessieId = t.id;
      if (t.creditId !== undefined) rec.creditId = t.creditId;
      if (t.credited === false) rec.error = "The money left the payer's account; the deposit to the payee did not go through.";
    } catch (e) {
      const err = e as Error;
      if (e instanceof NessieError && e.unknownOutcome) {
        rec.status = 'unconfirmed';
        rec.error = 'Nessie did not confirm this transfer in time. It is counted as paid, so it is never sent twice.';
      } else {
        rec.status = 'failed';
        rec.error = (e instanceof NessieError ? err.message : 'The transfer could not be sent.').slice(0, 240);
      }
      log(`[tab] ${tab.sceneId}: transfer ${rec.id} ${rec.status}: ${err.message}`);
    }
    return rec;
  }

  // ------------------------------------------------------------ the operations

  async function view(sceneId: string): Promise<TabView> {
    const scene = await sceneOrThrow(sceneId);
    const tab = await readTab(sceneId);
    return show(tab ?? emptyTab(sceneId, iso()), scene, !!tab);
  }

  async function addPurchase(sceneId: string, input: PurchaseInput): Promise<{ purchase: TabPurchase; tab: TabView }> {
    const payer = parseName(input.payer, 'payer');
    if (!payer.ok) throw new TabError(400, payer.error);
    const merchant = parseText(input.merchant, 'merchant', 48);
    if (!merchant.ok) throw new TabError(400, merchant.error);
    const amount = parseAmount(input.amount);
    if (!amount.ok) throw new TabError(400, amount.error);
    let description = merchant.value;
    if (input.description !== undefined && input.description !== null && input.description !== '') {
      const d = parseText(input.description, 'description', 80);
      if (!d.ok) throw new TabError(400, d.error);
      description = d.value;
    }
    let split: string[] | null = null;
    if (input.split !== undefined && input.split !== null) {
      if (!Array.isArray(input.split) || !input.split.length || input.split.length > MAX_FRIENDS) {
        throw new TabError(400, `split must list 1 to ${MAX_FRIENDS} names.`);
      }
      split = [];
      for (const s of input.split) {
        const n = parseName(s, 'Every name in split');
        if (!n.ok) throw new TabError(400, n.error);
        split.push(n.value);
      }
    }
    if (input.table !== undefined && typeof input.table !== 'boolean') throw new TabError(400, 'table must be true or false.');
    let category: string | undefined;
    if (input.category !== undefined && input.category !== null && input.category !== '') {
      const c = parseText(input.category, 'category', 24);
      if (!c.ok) throw new TabError(400, c.error);
      category = c.value;
    }

    return change(sceneId, async (tab, scene) => {
      if (tab.purchases.length >= MAX_PURCHASES) throw new TabError(409, MESSAGES.full);
      // refused before anyone joins: a tab never keeps half of a split it could not take
      const joining = new Set([...(split ?? []), payer.value].map(friendId).filter((id) => !tab.friends.some((f) => f.id === id)));
      if (tab.friends.length + joining.size > MAX_FRIENDS) throw new TabError(409, MESSAGES.tooManyFriends);
      // the people sharing it join the tab in the order given, then the payer
      const named = split ? [...new Set(split.map((n) => addFriend(tab, n).id))] : null;
      const who = addFriend(tab, payer.value);
      const sharers = named ?? tab.friends.map((f) => f.id);
      const accountId = await accountOf(who);
      const merchantId = await merchantOf(tab, merchant.value, category);
      const id = ref('p');
      const booked = await nessie.createPurchase(accountId, {
        merchantId,
        amountCents: amount.value,
        description: `${description} · ${scene.name} (${id})`.slice(0, 140),
      });
      const purchase: TabPurchase = {
        id,
        payer: who.id,
        merchant: merchant.value,
        merchantId,
        amountCents: amount.value,
        description,
        split: sharers,
        table: input.table === true,
        at: iso(),
        bank: nessie.mode,
        nessieId: booked.id,
      };
      tab.purchases.push(purchase);
      tab.settledAt = null;
      // everyone who now owes gets their account too (settling opens any that are still missing)
      for (const f of tab.friends) {
        if (!sharers.includes(f.id) || (f.bank === nessie.mode && f.accountId)) continue;
        await accountOf(f).catch((e) => log(`[tab] ${sceneId}: no Nessie account for ${f.name} yet: ${(e as Error).message}`));
      }
      return { purchase, tab: show(tab, scene) };
    });
  }

  async function setRules(sceneId: string, input: { loserCoversTable: unknown; tableFee?: unknown }): Promise<TabView> {
    if (typeof input.loserCoversTable !== 'boolean') throw new TabError(400, 'loserCoversTable must be true or false.');
    let fee: number | null | undefined;
    if (input.tableFee === null) fee = null;
    else if (input.tableFee !== undefined && input.tableFee !== '') {
      const a = parseAmount(input.tableFee, 'tableFee');
      if (!a.ok) throw new TabError(400, a.error);
      fee = a.value;
    }
    return change(sceneId, async (tab, scene) => {
      tab.rules.loserCoversTable = input.loserCoversTable as boolean;
      if (fee !== undefined) tab.rules.tableFeeCents = fee;
      return show(tab, scene);
    });
  }

  async function settle(sceneId: string): Promise<SettleResult> {
    return change(sceneId, async (tab, scene) => {
      const names = new Map(tab.friends.map((f) => [f.id, f.name]));
      const todo = settlement(computeBalances(tab));
      if (!todo.length) return { already: true, made: [], tab: show(tab, scene) };
      const made: TabPayment[] = [];
      for (const t of todo) {
        const description = `${names.get(t.from)} pays ${names.get(t.to)} back · ${scene.name}`;
        made.push(await pay(tab, { kind: 'settle', from: t.from, to: t.to, amountCents: t.amountCents, description }));
        await writeTab(tab);
      }
      if (made.every((p) => p.status !== 'failed')) tab.settledAt = iso();
      return { already: false, made, tab: show(tab, scene) };
    });
  }

  // ------------------------------------------------------------ game results: their own queue

  const queue: { sceneId: string; event: TabEventIn; key: string }[] = [];
  const queued = new Set<string>();
  /** Rounds seen in this process, so a resend never charges twice even before it reaches the file. */
  const seen = new Set<string>();
  let draining: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Set by stop(): the result in hand finishes, the rest of the queue is dropped and new ones are ignored. */
  let stopped = false;

  const roundOf = (e: TabEventIn): string | null => {
    const r = e.round;
    if (typeof r === 'string' && r.trim()) return r.trim().slice(0, 80);
    if (typeof r === 'number' && Number.isFinite(r)) return String(r);
    return null;
  };

  function onGameEvent(sceneId: string, event: TabEventIn): void {
    if (stopped || deps.readOnly) return;
    if (!event || !RESULT_TYPES.has(event.type) || typeof sceneId !== 'string' || !SCENE_ID_RE.test(sceneId)) return;
    const round = roundOf(event);
    if (!round) return;
    const key = `${sceneId}|${round}`;
    if (queued.has(key) || seen.has(key)) return;
    if (queue.length >= MAX_QUEUE) {
      log(`[tab] game queue full; dropped ${key}`);
      return;
    }
    queued.add(key);
    queue.push({ sceneId, event: { ...event }, key });
    // never inside the event route's call: the queue runs on its own
    draining ??= Promise.resolve().then(drain);
  }

  async function drain(): Promise<void> {
    try {
      while (queue.length && !stopped) {
        const item = queue.shift()!;
        try {
          if (await handleGame(item.sceneId, item.event)) remember(item.key);
        } catch (e) {
          log(`[tab] ${item.key}: ${(e as Error).message}`);
        } finally {
          queued.delete(item.key);
        }
      }
      if (stopped && queue.length) {
        log(`[tab] stopped with ${queue.length} game result(s) still queued; they were not handled`);
        queue.length = 0;
        queued.clear();
      }
    } finally {
      draining = null;
    }
  }

  function remember(key: string): void {
    seen.add(key);
    if (seen.size > 2000) seen.delete(seen.values().next().value!);
  }

  /** The friend a game names: by Roblox id first, else by name. */
  function friendIn(tab: TabFile, robloxId: string | undefined, name: string | undefined): TabFriend | null {
    if (robloxId) {
      const byId = tab.friends.find((f) => f.robloxId === robloxId);
      if (byId) return byId;
    }
    if (name) {
      const byName = tab.friends.find((f) => f.id === friendId(name));
      if (byName) {
        // only a Roblox account is worth remembering ("bot" and per-visit ids are not)
        if (robloxId && /^rbx-\d{1,20}$/.test(robloxId) && !byName.robloxId) byName.robloxId = robloxId;
        return byName;
      }
    }
    return null;
  }

  const personRef = (v: unknown): string | undefined => {
    if (typeof v === 'number' && Number.isSafeInteger(v)) return `rbx-${v}`;
    const s = short(v);
    if (!s) return undefined;
    return /^\d{1,20}$/.test(s) ? `rbx-${s}` : s;
  };

  /** One game result. True when it was decided for good (recorded, or nothing to do for this tab). */
  async function handleGame(sceneId: string, e: TabEventIn): Promise<boolean> {
    const round = roundOf(e)!;
    let scene: Scene;
    try {
      scene = await sceneOrThrow(sceneId);
    } catch {
      return true;
    }
    return locked(sceneId, async () => {
      const tab = await readTab(sceneId);
      if (!tab || !tab.rules.loserCoversTable) return true;
      if (tab.games.some((g) => g.round === round)) return true;
      const before = JSON.stringify(tab);
      const game: TabGame = { round, game: short(e.game, 24) ?? 'game', at: iso(), status: 'skipped' };
      const winner = personRef(e.winner);
      const loser = personRef(e.loser);
      if (winner) game.winner = winner;
      if (loser) game.loser = loser;
      const winnerName = short(e.winnerName, 24);
      const loserName = short(e.loserName, 24);
      if (winnerName) game.winnerName = winnerName;
      if (loserName) game.loserName = loserName;
      const score = short(e.score, 16);
      if (score) game.score = score;
      if (typeof e.durationS === 'number' && Number.isFinite(e.durationS) && e.durationS >= 0) game.durationS = Math.round(e.durationS);
      tab.games.push(game);
      try {
        // contracts 6.5: a draw or a match against the game itself moves no money
        if (e.draw === true || score?.toLowerCase() === 'draw') {
          game.draw = true;
          game.note = 'A draw: nobody covers the table.';
          return true;
        }
        if (winner === 'bot' || loser === 'bot') {
          game.note = 'A match against the game itself: nobody covers the table.';
          return true;
        }
        friendIn(tab, winner, winnerName);
        const who = friendIn(tab, loser, loserName);
        if (!who) {
          game.note = `${loserName ?? 'The loser'} isn't on this tab.`;
          return true;
        }
        game.loserId = who.id;
        game.loserName ??= who.name;
        const tables = uncoveredTable(tab, scene.name);
        const open = tables.find((t) => t.leftCents > 0);
        if (!open) {
          game.note = tables.length ? 'The table is already covered.' : 'Nobody has paid for a table on this tab yet.';
          return true;
        }
        const charge = Math.min(tab.rules.tableFeeCents ?? open.leftCents, open.leftCents);
        game.purchaseId = open.purchase.id;
        game.payeeId = open.purchase.payer;
        game.chargeCents = charge;
        tab.settledAt = null;
        if (who.id === open.purchase.payer) {
          game.status = 'covered';
          game.note = `${who.name} paid for the table and lost, so it stays on ${who.name}.`;
          return true;
        }
        game.status = 'charged';
        const payeeName = tab.friends.find((f) => f.id === open.purchase.payer)?.name ?? open.purchase.payer;
        const p = await pay(tab, {
          kind: 'table',
          from: who.id,
          to: open.purchase.payer,
          amountCents: charge,
          description: `${who.name} lost at ${game.game} and covers the table for ${payeeName} · ${scene.name}`,
          round,
        });
        game.paymentId = p.id;
        log(`[tab] ${sceneId}: ${who.name} lost ${game.game} (${round}); table ${p.status} to ${payeeName} for $${(charge / 100).toFixed(2)}`);
        return true;
      } finally {
        // the oldest results that moved nothing make room; one that covered part of a table is part of the money
        while (tab.games.length > MAX_GAMES) {
          const i = tab.games.findIndex((g) => g !== game && !covering(g));
          if (i < 0) break;
          tab.games.splice(i, 1);
        }
        if (JSON.stringify(tab) !== before) await writeTab(tab);
      }
    });
  }

  async function idle(): Promise<void> {
    while (draining) await draining;
  }

  // ------------------------------------------------------------ routes

  function errorResponse(e: unknown, where: string): Response {
    if (e instanceof TabError) return fail(e.status, e.message);
    if (e instanceof NessieError) return fail(502, MESSAGES.bank(e.message));
    log(`[tab] ${where}: ${(e as Error)?.stack ?? e}`);
    return fail(500, MESSAGES.server);
  }

  const handler: TabHandler = async (req, server) => {
    if (req.method === 'OPTIONS') return preflight();
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // api, tab, <sceneId>, <action>?
    let sceneId = '';
    try {
      sceneId = decodeURIComponent(parts[2] ?? '');
    } catch {
      sceneId = '';
    }
    const action = parts[3] ?? '';
    if (!SCENE_ID_RE.test(sceneId) || parts.length > 4) return fail(404, MESSAGES.noScene);
    if (!action) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
      try {
        return json(await view(sceneId));
      } catch (e) {
        return errorResponse(e, `GET ${url.pathname}`);
      }
    }
    if (action !== 'purchase' && action !== 'settle' && action !== 'rules') return fail(404, MESSAGES.noScene);
    if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    if (deps.readOnly) return fail(503, MESSAGES.readOnly);
    if (deps.guard) {
      const why = mutationBlocked(req, deps.guard);
      if (why) {
        log(`[guard] refused POST ${url.pathname}: ${why}`);
        return fail(403, NOT_ALLOWED_MESSAGE);
      }
    }
    if (deps.authorize) {
      let denied: Response | null;
      try {
        denied = await deps.authorize(req, server);
      } catch (e) {
        return errorResponse(e, `sign-in check for POST ${url.pathname}`);
      }
      if (denied) return denied;
    }
    // settle takes no fields: any body (or none) is fine
    let body: Record<string, unknown> = {};
    if (action !== 'settle') {
      const r = await readJson(req, BODY_MAX);
      if (!r.ok) return fail(r.status, r.error);
      if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return fail(400, 'The body must be a JSON object.');
      body = r.value as Record<string, unknown>;
    }
    try {
      if (action === 'purchase') {
        const r = await addPurchase(sceneId, body as unknown as PurchaseInput);
        return json({ ok: true, purchase: r.purchase, tab: r.tab }, 201);
      }
      if (action === 'rules') {
        return json({ ok: true, tab: await setRules(sceneId, body as { loserCoversTable: unknown; tableFee?: unknown }) });
      }
      const r = await settle(sceneId);
      const failed = r.made.filter((p) => p.status === 'failed');
      if (failed.length && failed.length === r.made.length) {
        return json({ ok: false, error: MESSAGES.bank(failed[0]!.error ?? 'No transfer went through.'), already: false, made: r.made, tab: r.tab }, 502);
      }
      return json({
        ok: failed.length === 0,
        ...(failed.length ? { error: `${failed.length} of ${r.made.length} transfers didn't go through. Settle up again to retry them.` } : {}),
        already: r.already,
        made: r.made,
        tab: r.tab,
      });
    } catch (e) {
      return errorResponse(e, `POST ${url.pathname}`);
    }
  };

  return {
    routes: {
      '/api/tab/:sceneId': handler,
      '/api/tab/:sceneId/purchase': handler,
      '/api/tab/:sceneId/settle': handler,
      '/api/tab/:sceneId/rules': handler,
    },
    start() {
      stopped = false;
      if (unsubscribe || !deps.onEvent || deps.readOnly) return;
      unsubscribe = deps.onEvent((sceneId, event) => onGameEvent(sceneId, event));
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      await idle();
    },
    idle,
    view,
    addPurchase,
    setRules,
    settle,
    onGameEvent,
  };
}
