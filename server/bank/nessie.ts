// Capital One's Nessie sandbox (mock banking, https://api.nessieisreal.com): the calls the tab makes, typed and
// with timeouts, plus an in-memory bank of the same shape for when NESSIE_API_KEY is unset (and for the tests).
//
//   POST /customers                 {first_name, last_name, address}
//   POST /customers/{id}/accounts   {type: "Checking", nickname, rewards, balance}
//   GET  /accounts/{id}
//   GET  /merchants, POST /merchants {name, category}
//   POST /accounts/{id}/purchases   {merchant_id, medium: "balance", purchase_date, amount, status, description}
//   POST /accounts/{id}/transfers   {medium: "balance", payee_id, amount, transaction_date, status, description}
//   POST /accounts/{id}/deposits    {medium: "balance", transaction_date, status, amount, description}
//
// The key goes in ?key= and never into a log line or an error message. Nessie amounts are integers (its validator
// turns 12.5 into 12), so every amount here is in cents and goes to Nessie as an integer number of cents.
//
// Two generations of the server answer at that address. The original one takes a transfer's medium and payee_id;
// the current one refuses those two fields ("extra fields not permitted") and keeps no payee on a transfer. Both
// answer a create with {code, message, objectCreated}, though the current spec promises only a sentence. The client
// handles all of it: it reads a new object's id from the answer or, failing that, from the list the object was added
// to, and when a transfer cannot name its payee it puts the same amount into the payee's account as a deposit, so
// the money still lands. A 502 or 504 on a create means it may have gone through (unknownOutcome).

import { randomBytes } from 'node:crypto';

export type BankMode = 'nessie' | 'demo';

export const NESSIE_BASE_URL = 'https://api.nessieisreal.com';
const DEFAULT_TIMEOUT_MS = 8000;

export interface NessieAddress {
  street_number: string;
  street_name: string;
  city: string;
  state: string;
  zip: string;
}

/** Where the tab's mock customers live (Nessie requires an address on every customer). */
export const MOCK_ADDRESS: NessieAddress = { street_number: '1', street_name: 'Game Lawn Way', city: 'Gainesville', state: 'FL', zip: '32611' };

export interface BankCustomer {
  id: string;
  firstName: string;
  lastName: string;
}

export interface BankAccount {
  id: string;
  customerId: string;
  nickname: string;
  balanceCents: number;
}

export interface BankMerchant {
  id: string;
  name: string;
}

export interface BankPurchase {
  /** null when the server took it but its id could not be read back. */
  id: string | null;
  accountId: string;
  merchantId: string;
  amountCents: number;
  description: string;
  date: string;
}

export interface BankTransfer {
  id: string | null;
  payerId: string;
  payeeId: string;
  amountCents: number;
  description: string;
  date: string;
  /** The deposit that credited the payee, on a server whose transfers carry no payee. */
  creditId?: string | null;
  /** false when that deposit did not go through: the money left the payer but did not reach the payee. */
  credited?: boolean;
}

export interface NessieClient {
  readonly mode: BankMode;
  createCustomer(input: { firstName: string; lastName: string; address?: NessieAddress }): Promise<BankCustomer>;
  createAccount(customerId: string, input: { nickname: string; balanceCents: number }): Promise<BankAccount>;
  /** null when there is no such account. */
  getAccount(accountId: string): Promise<BankAccount | null>;
  listMerchants(): Promise<BankMerchant[]>;
  createMerchant(input: { name: string; category?: string }): Promise<BankMerchant>;
  createPurchase(accountId: string, input: { merchantId: string; amountCents: number; description: string }): Promise<BankPurchase>;
  createTransfer(payerAccountId: string, input: { payeeAccountId: string; amountCents: number; description: string }): Promise<BankTransfer>;
}

export class NessieError extends Error {
  constructor(
    message: string,
    /** The HTTP status Nessie answered with; 0 when no answer came. */
    readonly status: number,
    /** True when the request may have gone through anyway (it timed out after being sent, or a gateway gave up). */
    readonly unknownOutcome = false,
  ) {
    super(message);
    this.name = 'NessieError';
  }
}

/** A positive whole number of cents, or a NessieError (both banks refuse anything else before calling out). */
function checkCents(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new NessieError('The amount must be a positive whole number of cents.', 400);
  return amountCents;
}

function checkId(id: string, what: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new NessieError(`That isn't a valid ${what} id.`, 400);
  return id;
}

/** Today as Nessie's dates want it (YYYY-MM-DD, UTC). */
export function nessieDate(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- the real API

export interface NessieHttpOptions {
  key: string;
  /** Default https://api.nessieisreal.com (NESSIE_BASE_URL). */
  baseUrl?: string;
  /** Per request. Default 8 s. */
  timeoutMs?: number;
  /** Tests inject one. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The object a create answered with: {objectCreated: {...}} (the original server) or the object itself. */
function createdObject(data: unknown): Obj | null {
  if (!isObj(data)) return null;
  for (const inner of [data.objectCreated, data.object_created, data.data, data]) {
    if (isObj(inner) && (str(inner._id) || str(inner.id))) return inner;
  }
  return null;
}

const idOf = (o: Obj | null | undefined): string | null => (o ? (str(o._id) ?? str(o.id)) : null);

export function createNessieClient(o: NessieHttpOptions): NessieClient {
  const key = (o.key ?? '').trim();
  if (!key) throw new Error('createNessieClient needs a key');
  const base = (o.baseUrl?.trim() || NESSIE_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const now = o.now ?? Date.now;
  /** Ids this client already handed out, so a list lookup never picks the same object twice. */
  const known = new Set<string>();
  /** 'strict' once the server refused a transfer's medium and payee_id. */
  let transferShape: 'classic' | 'strict' = 'classic';

  // the key as sent and as a server may echo it back from the URL (form-encoded there, or percent-encoded)
  const secrets = [...new Set([key, new URLSearchParams({ key }).toString().slice(4), encodeURIComponent(key)])];
  const redact = (s: string) => secrets.reduce((t, k) => t.split(k).join('***'), s);

  interface Answer {
    method: string;
    status: number;
    data: unknown;
    /** The body as text, without the key. */
    text: string;
  }

  async function call(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<Answer> {
    const url = new URL(base + path);
    url.searchParams.set('key', key);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new NessieError(`Nessie did not answer ${method} ${path} within ${Math.round(timeoutMs / 100) / 10} s.`, 0, method !== 'GET');
      }
      throw new NessieError(`Nessie is not reachable right now (${method} ${path}).`, 0);
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* an empty answer */
    }
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* a plain sentence */
    }
    return { method, status: res.status, data, text: redact(text) };
  }

  const ok = (a: Answer) => a.status >= 200 && a.status < 300;

  /** The sentence Nessie answered with, shortened and without the key. */
  function said(a: Answer): string {
    const d = a.data;
    let msg = typeof d === 'string' ? d : isObj(d) ? (str(d.message) ?? str(d.error) ?? str(d.detail) ?? '') : '';
    if (!msg && isObj(d) && Array.isArray(d.detail)) msg = JSON.stringify(d.detail);
    msg = redact(msg || a.text).replace(/\s+/g, ' ').trim();
    return msg.length > 200 ? `${msg.slice(0, 199)}…` : msg;
  }

  function refused(a: Answer, what: string): NessieError {
    const why = said(a);
    // a gateway that gave up (502, 504) may have passed the create on before it did
    const unknown = a.method !== 'GET' && (a.status === 502 || a.status === 504);
    return new NessieError(`Nessie refused ${what} (HTTP ${a.status})${why ? `: ${why}` : '.'}`, a.status, unknown);
  }

  /** The newest object in a list that matches and was not handed out before; null when the list cannot be read. */
  async function findIn(path: string, match: (o: Obj) => boolean): Promise<Obj | null> {
    try {
      const a = await call('GET', path);
      if (!ok(a) || !Array.isArray(a.data)) return null;
      const hits = (a.data as unknown[]).filter((x): x is Obj => isObj(x) && !!idOf(x) && !known.has(idOf(x)!) && match(x));
      return hits.at(-1) ?? null;
    } catch {
      return null;
    }
  }

  function remember(id: string | null): string | null {
    if (id) known.add(id);
    return id;
  }

  const toAccount = (x: Obj, fallback: { customerId?: string; nickname?: string } = {}): BankAccount => ({
    id: idOf(x)!,
    customerId: str(x.customer_id) ?? fallback.customerId ?? '',
    nickname: str(x.nickname) ?? fallback.nickname ?? '',
    balanceCents: typeof x.balance === 'number' && Number.isFinite(x.balance) ? Math.round(x.balance) : 0,
  });

  return {
    mode: 'nessie',

    async createCustomer({ firstName, lastName, address = MOCK_ADDRESS }) {
      const body = { first_name: firstName, last_name: lastName, address };
      const a = await call('POST', '/customers', body);
      if (!ok(a)) throw refused(a, 'the new customer');
      const made = createdObject(a.data) ?? (await findIn('/customers', (c) => c.first_name === firstName && c.last_name === lastName));
      const id = remember(idOf(made));
      if (!id) throw new NessieError('Nessie created the customer but did not say its id.', 502);
      return { id, firstName, lastName };
    },

    async createAccount(customerId, { nickname, balanceCents }) {
      checkId(customerId, 'customer');
      if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) throw new NessieError('The opening balance must be whole cents.', 400);
      const path = `/customers/${encodeURIComponent(customerId)}/accounts`;
      const a = await call('POST', path, { type: 'Checking', nickname, rewards: 0, balance: balanceCents });
      if (!ok(a)) throw refused(a, 'the new account');
      const made = createdObject(a.data) ?? (await findIn(path, (x) => x.nickname === nickname));
      const id = remember(idOf(made));
      if (!id) throw new NessieError('Nessie opened the account but did not say its id.', 502);
      return toAccount(made!, { customerId, nickname });
    },

    async getAccount(accountId) {
      checkId(accountId, 'account');
      const a = await call('GET', `/accounts/${encodeURIComponent(accountId)}`);
      if (a.status === 404) return null;
      if (!ok(a)) throw refused(a, 'to show the account');
      const x = isObj(a.data) ? a.data : null;
      return x && idOf(x) ? toAccount(x) : null;
    },

    async listMerchants() {
      const a = await call('GET', '/merchants');
      if (!ok(a)) throw refused(a, 'the merchant list');
      if (!Array.isArray(a.data)) return [];
      return (a.data as unknown[]).filter(isObj).flatMap((m) => (idOf(m) && str(m.name) ? [{ id: idOf(m)!, name: str(m.name)! }] : []));
    },

    async createMerchant({ name, category }) {
      let a = await call('POST', '/merchants', category ? { name, category } : { name });
      // the two servers disagree on category (a string or a list): a merchant does not need one
      if (a.status === 400 && category) a = await call('POST', '/merchants', { name });
      if (!ok(a)) throw refused(a, 'the new merchant');
      const made = createdObject(a.data) ?? (await findIn('/merchants', (m) => m.name === name));
      const id = remember(idOf(made));
      if (!id) throw new NessieError('Nessie created the merchant but did not say its id.', 502);
      return { id, name };
    },

    async createPurchase(accountId, { merchantId, amountCents, description }) {
      checkId(accountId, 'account');
      checkId(merchantId, 'merchant');
      checkCents(amountCents);
      const date = nessieDate(now());
      const path = `/accounts/${encodeURIComponent(accountId)}/purchases`;
      const a = await call('POST', path, { merchant_id: merchantId, medium: 'balance', purchase_date: date, amount: amountCents, status: 'completed', description });
      if (!ok(a)) throw refused(a, 'the purchase');
      const made = createdObject(a.data) ?? (await findIn(path, (p) => p.description === description));
      return { id: remember(idOf(made)), accountId, merchantId, amountCents, description, date };
    },

    async createTransfer(payerAccountId, { payeeAccountId, amountCents, description }) {
      checkId(payerAccountId, 'account');
      checkId(payeeAccountId, 'account');
      checkCents(amountCents);
      if (payerAccountId === payeeAccountId) throw new NessieError('A transfer needs two different accounts.', 400);
      const date = nessieDate(now());
      const path = `/accounts/${encodeURIComponent(payerAccountId)}/transfers`;
      const result: BankTransfer = { id: null, payerId: payerAccountId, payeeId: payeeAccountId, amountCents, description, date };
      if (transferShape === 'classic') {
        const a = await call('POST', path, {
          medium: 'balance',
          payee_id: payeeAccountId,
          amount: amountCents,
          transaction_date: date,
          status: 'completed',
          description,
        });
        if (ok(a)) {
          const made = createdObject(a.data) ?? (await findIn(path, (t) => t.description === description));
          return { ...result, id: remember(idOf(made)) };
        }
        if (!(a.status === 400 && /extra fields not permitted/i.test(a.text))) throw refused(a, 'the transfer');
        transferShape = 'strict';
      }
      // this server takes no medium or payee_id in the body: the payee rides along in the query
      const a = await call('POST', path, { amount: amountCents, transaction_date: date, status: 'completed', description }, { payee_id: payeeAccountId });
      if (!ok(a)) throw refused(a, 'the transfer');
      const made = createdObject(a.data) ?? (await findIn(path, (t) => t.description === description));
      result.id = remember(idOf(made));
      if (made && made.payee_id === payeeAccountId) return result;
      // the transfer left the payer without naming the payee: the payee gets the same amount as a deposit
      const depositPath = `/accounts/${encodeURIComponent(payeeAccountId)}/deposits`;
      try {
        const d = await call('POST', depositPath, { medium: 'balance', transaction_date: date, status: 'completed', amount: amountCents, description });
        if (!ok(d)) return { ...result, creditId: null, credited: false };
        const credit = createdObject(d.data) ?? (await findIn(depositPath, (x) => x.description === description));
        return { ...result, creditId: remember(idOf(credit)), credited: true };
      } catch {
        return { ...result, creditId: null, credited: false };
      }
    },
  };
}

// ---------------------------------------------------------------- the demo bank

interface FakeTxn {
  id: string;
  kind: 'purchase' | 'transfer';
  from: string;
  to: string;
  amountCents: number;
  description: string;
  date: string;
}

export interface FakeNessieState {
  customers: BankCustomer[];
  accounts: BankAccount[];
  merchants: BankMerchant[];
  purchases: FakeTxn[];
  transfers: FakeTxn[];
}

export interface FakeNessie extends NessieClient {
  /** Copies of everything the demo bank holds. */
  state(): FakeNessieState;
  /** The next `op` call (e.g. "createTransfer") fails with this error. */
  failNext(op: keyof NessieClient, error?: NessieError): void;
  /** Every call so far, by name. */
  readonly calls: string[];
}

/** A 24-character hex id, the shape Nessie's own ids have. */
export function objectId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * The bank in memory: same calls, same checks, same answers as the real one. Purchases take money out of the
 * payer's account and transfers move it, so balances add up the way they would in Nessie.
 */
export function createFakeNessie(o: { now?: () => number } = {}): FakeNessie {
  const now = o.now ?? Date.now;
  const customers = new Map<string, BankCustomer>();
  const accounts = new Map<string, BankAccount>();
  const merchants = new Map<string, BankMerchant>();
  const purchases: FakeTxn[] = [];
  const transfers: FakeTxn[] = [];
  const failures = new Map<string, NessieError>();
  const calls: string[] = [];

  function enter(op: keyof NessieClient): void {
    calls.push(op);
    const f = failures.get(op);
    if (f) {
      failures.delete(op);
      throw f;
    }
  }

  function account(id: string): BankAccount {
    checkId(id, 'account');
    const a = accounts.get(id);
    if (!a) throw new NessieError(`Nessie refused that (HTTP 404): no account ${id}.`, 404);
    return a;
  }

  return {
    mode: 'demo',
    calls,

    async createCustomer({ firstName, lastName }) {
      enter('createCustomer');
      if (!firstName?.trim() || !lastName?.trim()) throw new NessieError('A customer needs a first and last name.', 400);
      const c = { id: objectId(), firstName, lastName };
      customers.set(c.id, c);
      return { ...c };
    },

    async createAccount(customerId, { nickname, balanceCents }) {
      enter('createAccount');
      checkId(customerId, 'customer');
      if (!customers.has(customerId)) throw new NessieError(`Nessie refused that (HTTP 404): no customer ${customerId}.`, 404);
      if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) throw new NessieError('The opening balance must be whole cents.', 400);
      const a = { id: objectId(), customerId, nickname, balanceCents };
      accounts.set(a.id, a);
      return { ...a };
    },

    async getAccount(accountId) {
      enter('getAccount');
      checkId(accountId, 'account');
      const a = accounts.get(accountId);
      return a ? { ...a } : null;
    },

    async listMerchants() {
      enter('listMerchants');
      return [...merchants.values()].map((m) => ({ ...m }));
    },

    async createMerchant({ name }) {
      enter('createMerchant');
      if (!name?.trim()) throw new NessieError('A merchant needs a name.', 400);
      const m = { id: objectId(), name };
      merchants.set(m.id, m);
      return { ...m };
    },

    async createPurchase(accountId, { merchantId, amountCents, description }) {
      enter('createPurchase');
      const a = account(accountId);
      checkId(merchantId, 'merchant');
      if (!merchants.has(merchantId)) throw new NessieError(`Nessie refused that (HTTP 404): no merchant ${merchantId}.`, 404);
      checkCents(amountCents);
      const t: FakeTxn = { id: objectId(), kind: 'purchase', from: accountId, to: merchantId, amountCents, description, date: nessieDate(now()) };
      a.balanceCents -= amountCents;
      purchases.push(t);
      return { id: t.id, accountId, merchantId, amountCents, description, date: t.date };
    },

    async createTransfer(payerAccountId, { payeeAccountId, amountCents, description }) {
      enter('createTransfer');
      const from = account(payerAccountId);
      const to = account(payeeAccountId);
      checkCents(amountCents);
      if (from === to) throw new NessieError('A transfer needs two different accounts.', 400);
      const t: FakeTxn = { id: objectId(), kind: 'transfer', from: payerAccountId, to: payeeAccountId, amountCents, description, date: nessieDate(now()) };
      from.balanceCents -= amountCents;
      to.balanceCents += amountCents;
      transfers.push(t);
      return { id: t.id, payerId: payerAccountId, payeeId: payeeAccountId, amountCents, description, date: t.date };
    },

    state() {
      return {
        customers: [...customers.values()].map((c) => ({ ...c })),
        accounts: [...accounts.values()].map((a) => ({ ...a })),
        merchants: [...merchants.values()].map((m) => ({ ...m })),
        purchases: purchases.map((p) => ({ ...p })),
        transfers: transfers.map((t) => ({ ...t })),
      };
    },

    failNext(op, error = new NessieError('Nessie refused that (HTTP 500).', 500)) {
      failures.set(op, error);
    },
  };
}

/** The real API when NESSIE_API_KEY is set (NESSIE_BASE_URL moves it), else the demo bank. */
export function nessieFromEnv(env: Record<string, string | undefined> = process.env): NessieClient {
  const key = env.NESSIE_API_KEY?.trim();
  if (!key) return createFakeNessie();
  return createNessieClient({ key, baseUrl: env.NESSIE_BASE_URL });
}
