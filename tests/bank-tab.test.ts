// The tab (server/bank): settlement math to the cent, the Nessie client against both server generations and the
// demo bank (one contract for all three), idempotent settle-ups, "loser covers the table" from game.result events,
// validation and the routes' JSON. No test reaches the real Nessie: every client here is the fake or a mock fetch.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../shared/types.ts';
import {
  createFakeNessie,
  createNessieClient,
  nessieFromEnv,
  NessieError,
  type FakeNessie,
  type NessieClient,
} from '../server/bank/nessie.ts';
import {
  computeBalances,
  createTab,
  emptyTab,
  friendId,
  parseAmount,
  parseName,
  settlement,
  splitCents,
  TAB_MUTATING_ROUTES,
  viewOf,
  type TabDeps,
  type TabFile,
  type TabService,
  type TabView,
} from '../server/bank/tab.ts';
import { PresenceStore } from '../server/social/presence.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dv-tab-'));
  dirs.push(d);
  return d;
}

const COURTS: Scene = {
  id: 'the-courts',
  name: 'Infinity Hall Game Lawn',
  mode: 'reconstruct',
  status: 'ready',
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  thumb: 'thumb.jpg',
};

interface Rig {
  tabs: TabService;
  bank: FakeNessie;
  dir: string;
  logs: string[];
  file: () => Promise<TabFile>;
}

function rig(extra: Partial<TabDeps> = {}, dir = tempDir(), bank: FakeNessie = createFakeNessie()): Rig {
  const logs: string[] = [];
  const tabs = createTab({
    getScene: async (id) => (id === COURTS.id ? COURTS : null),
    dataDir: dir,
    nessie: bank,
    log: (m) => logs.push(m),
    ...extra,
  });
  return { tabs, bank, dir, logs, file: async () => JSON.parse(await readFile(join(dir, 'tab', 'the-courts.json'), 'utf8')) as TabFile };
}

const FOUR = ['Ojasva', 'Seb', 'Shivin', 'Brianna'];

async function seedNight(r: Rig): Promise<TabView> {
  await r.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: 'Infinity Hall Game Lawn', amount: 12, description: 'Pool table', split: FOUR, table: true });
  await r.tabs.addPurchase('the-courts', { payer: 'Ojasva', merchant: 'Infinity Hall Game Lawn', amount: 9.75, description: 'Snacks', split: FOUR });
  return (await r.tabs.addPurchase('the-courts', { payer: 'Brianna', merchant: 'Lawnside Pizza Co.', amount: 31.4, description: 'Pizza', split: FOUR })).tab;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- the math

describe('settlement math', () => {
  test('a split adds up to the cent, leftover cents go to the first shares', () => {
    expect(splitCents(1000, 3)).toEqual([334, 333, 333]);
    expect(splitCents(1, 4)).toEqual([1, 0, 0, 0]);
    expect(splitCents(3140, 4)).toEqual([785, 785, 785, 785]);
    expect(splitCents(975, 4)).toEqual([244, 244, 244, 243]);
    for (let n = 1; n <= 12; n++) for (const total of [1, 99, 1000, 4999, 50000]) expect(sum(splitCents(total, n))).toBe(total);
  });

  test('$10.00 three ways: balances are whole cents and sum to zero', () => {
    const tab = emptyTab('x', '');
    tab.friends = ['a', 'b', 'c'].map((id) => ({ id, name: id }));
    tab.purchases = [{ id: 'p1', payer: 'a', merchant: 'm', merchantId: null, amountCents: 1000, description: 'd', split: ['a', 'b', 'c'], table: false, at: '', bank: 'demo', nessieId: null }];
    const b = computeBalances(tab);
    expect(b.map((x) => x.netCents)).toEqual([666, -333, -333]);
    expect(sum(b.map((x) => x.netCents))).toBe(0);
    expect(settlement(b)).toEqual([
      { from: 'b', to: 'a', amountCents: 333 },
      { from: 'c', to: 'a', amountCents: 333 },
    ]);
  });

  test('random nights: nets sum to zero, the transfers zero them, at most n-1 of them', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(rand() * 7);
      const ids = Array.from({ length: n }, (_, i) => `f${i}`);
      const tab = emptyTab('x', '');
      tab.friends = ids.map((id) => ({ id, name: id }));
      const k = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < k; i++) {
        const split = ids.filter(() => rand() < 0.7);
        tab.purchases.push({
          id: `p${i}`,
          payer: ids[Math.floor(rand() * n)]!,
          merchant: 'm',
          merchantId: null,
          amountCents: 1 + Math.floor(rand() * 50_000),
          description: 'd',
          split: split.length ? split : [ids[0]!],
          table: false,
          at: '',
          bank: 'demo',
          nessieId: null,
        });
      }
      const b = computeBalances(tab);
      expect(sum(b.map((x) => x.netCents))).toBe(0);
      expect(sum(b.map((x) => x.shareCents))).toBe(sum(tab.purchases.map((p) => p.amountCents)));
      const ts = settlement(b);
      expect(ts.length).toBeLessThanOrEqual(n - 1);
      const after = new Map(b.map((x) => [x.friend, x.netCents]));
      for (const t of ts) {
        expect(t.amountCents).toBeGreaterThan(0);
        expect(Number.isInteger(t.amountCents)).toBe(true);
        after.set(t.from, after.get(t.from)! + t.amountCents);
        after.set(t.to, after.get(t.to)! - t.amountCents);
      }
      for (const v of after.values()) expect(v).toBe(0);
    }
  });

  test('a debt that equals a credit settles in one transfer (minimal: 2 transfers, not 3)', () => {
    const ts = settlement([
      { friend: 'a', netCents: 700 },
      { friend: 'b', netCents: -500 },
      { friend: 'c', netCents: 500 },
      { friend: 'd', netCents: -700 },
    ]);
    expect(ts).toHaveLength(2);
    expect(ts).toContainEqual({ from: 'd', to: 'a', amountCents: 700 });
    expect(ts).toContainEqual({ from: 'b', to: 'c', amountCents: 500 });
  });

  test('one payer for everyone: everyone else pays them once', () => {
    const ts = settlement([
      { friend: 'seb', netCents: 900 },
      { friend: 'o', netCents: -300 },
      { friend: 's', netCents: -300 },
      { friend: 'b', netCents: -300 },
    ]);
    expect(ts).toEqual([
      { from: 'o', to: 'seb', amountCents: 300 },
      { from: 's', to: 'seb', amountCents: 300 },
      { from: 'b', to: 'seb', amountCents: 300 },
    ]);
  });

  test('payments made count: after them nothing is owed', () => {
    const tab = emptyTab('x', '');
    tab.friends = ['a', 'b'].map((id) => ({ id, name: id }));
    tab.purchases = [{ id: 'p1', payer: 'a', merchant: 'm', merchantId: null, amountCents: 1001, description: 'd', split: ['a', 'b'], table: false, at: '', bank: 'demo', nessieId: null }];
    expect(settlement(computeBalances(tab))).toEqual([{ from: 'b', to: 'a', amountCents: 500 }]);
    tab.payments = [{ id: 's1', kind: 'settle', from: 'b', to: 'a', amountCents: 500, description: '', at: '', bank: 'demo', status: 'paid', nessieId: 'x' }];
    expect(settlement(computeBalances(tab))).toEqual([]);
    // a failed payment moved nothing
    tab.payments[0]!.status = 'failed';
    expect(settlement(computeBalances(tab))).toEqual([{ from: 'b', to: 'a', amountCents: 500 }]);
  });
});

// ---------------------------------------------------------------- validation

describe('validation', () => {
  test('amounts: more than 0, at most $500, two decimals', () => {
    expect(parseAmount(12.5)).toEqual({ ok: true, value: 1250 });
    expect(parseAmount('12.50')).toEqual({ ok: true, value: 1250 });
    expect(parseAmount('$7')).toEqual({ ok: true, value: 700 });
    expect(parseAmount(19.99)).toEqual({ ok: true, value: 1999 });
    expect(parseAmount(0.01)).toEqual({ ok: true, value: 1 });
    expect(parseAmount(500)).toEqual({ ok: true, value: 50000 });
    for (const bad of [0, -1, 500.01, 12.345, 1e-9, 0.004, '0.00', 'abc', '1e3', NaN, Infinity, null, undefined, {}, [], '12.5.0', true]) {
      expect(parseAmount(bad).ok).toBe(false);
    }
  });

  test('names are short and plain', () => {
    expect(parseName(' Seb ')).toEqual({ ok: true, value: 'Seb' });
    expect(parseName('José')).toEqual({ ok: true, value: 'José' });
    expect(parseName("D'Angelo")).toEqual({ ok: true, value: "D'Angelo" });
    for (const bad of ['', '   ', 'x'.repeat(25), '<script>', 'a\u0000b', 42, null, '-dash']) expect(parseName(bad).ok).toBe(false);
    expect(friendId('  José  Núñez ')).toBe('jose nunez');
  });

  test('a bad purchase is refused before anything is booked', async () => {
    const r = rig();
    const bad = [
      { payer: 'Seb', merchant: 'Lawn', amount: 0 },
      { payer: 'Seb', merchant: 'Lawn', amount: 600 },
      { payer: 'Seb', merchant: 'Lawn', amount: 1.234 },
      { payer: 'x'.repeat(30), merchant: 'Lawn', amount: 5 },
      { payer: 'Seb', merchant: '', amount: 5 },
      { payer: 'Seb', merchant: 'Lawn', amount: 5, split: [] },
      { payer: 'Seb', merchant: 'Lawn', amount: 5, split: ['ok', '<b>'] },
      { payer: 'Seb', merchant: 'Lawn', amount: 5, table: 'yes' },
      { payer: 'Seb', merchant: 'Lawn', amount: 5, description: 'x'.repeat(81) },
    ];
    for (const b of bad) await expect(r.tabs.addPurchase('the-courts', b)).rejects.toMatchObject({ status: 400 });
    expect(r.bank.calls).toEqual([]);
    expect(await Bun.file(join(r.dir, 'tab', 'the-courts.json')).exists()).toBe(false);
  });

  test('an unknown memory is a 404', async () => {
    const r = rig();
    await expect(r.tabs.view('nope')).rejects.toMatchObject({ status: 404 });
    await expect(r.tabs.addPurchase('nope', { payer: 'Seb', merchant: 'Lawn', amount: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(r.tabs.view('../etc')).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------- the Nessie client contract

const KEY = 'test-key-5f2c9d1e';

/**
 * A Nessie server in memory, as each generation answers: the original (objectCreated, transfers name a payee), the
 * current one as its spec reads (creates answer a sentence) and the current one as it answered a probe on 2026-10-17
 * (objectCreated with uuid ids, lists with "id", transfers that refuse medium and payee_id and keep no payee).
 */
function mockNessie(flavor: 'classic' | 'current' | 'live') {
  type Row = Record<string, unknown> & { _id: string };
  const db = { customers: [] as Row[], accounts: [] as Row[], merchants: [] as Row[], purchases: [] as Row[], transfers: [] as Row[], deposits: [] as Row[] };
  const seen: string[] = [];
  let n = 0;
  const nextId = () => (flavor === 'live' ? `${(++n).toString(16).padStart(8, '0')}-9bee-42a9-b9ce-2701865d84ff` : (++n).toString(16).padStart(24, 'a'));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const created = (kind: string, obj: Row) =>
    flavor === 'current' ? reply(201, `${kind} created`) : reply(201, { code: 201, message: `${kind} created`, objectCreated: obj });
  const list = (rows: Row[]) => reply(200, flavor === 'live' ? rows.map(({ _id, ...r }) => ({ id: _id, ...r })) : rows);
  const strict = flavor !== 'classic';
  const acct = (id: string) => db.accounts.find((a) => a._id === id);

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    seen.push(`${method} ${u.pathname}`);
    if (u.searchParams.get('key') !== KEY) return reply(401, 'Invalid API key.');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const p = u.pathname;
    let m: RegExpMatchArray | null;
    if (p === '/customers' && method === 'POST') {
      const c: Row = { _id: nextId(), first_name: body.first_name, last_name: body.last_name, address: body.address };
      db.customers.push(c);
      return created('Customer', c);
    }
    if (p === '/customers' && method === 'GET') return list(db.customers);
    if ((m = p.match(/^\/customers\/([^/]+)\/accounts$/))) {
      if (method === 'GET') return list(db.accounts.filter((a) => a.customer_id === m![1]));
      if (!db.customers.some((c) => c._id === m![1])) return reply(404, { code: 404, message: 'No customer' });
      const a: Row = { _id: nextId(), type: body.type, nickname: body.nickname, rewards: body.rewards, balance: body.balance, account_number: '0000000000000000', customer_id: m[1] };
      db.accounts.push(a);
      return created('Account', a);
    }
    if ((m = p.match(/^\/accounts\/([^/]+)$/))) {
      const a = acct(m[1]!);
      return a ? reply(200, a) : reply(404, '');
    }
    if (p === '/merchants') {
      if (method === 'GET') return list(db.merchants);
      if (flavor === 'current' && typeof body.category === 'string') return reply(400, '1 validation error for MerchantCreate\ncategory\n  value is not a valid list');
      const x: Row = { _id: nextId(), name: body.name, category: body.category };
      db.merchants.push(x);
      return created('Merchant', x);
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/purchases$/))) {
      if (method === 'GET') return flavor === 'current' ? reply(400, 'validation errors for Purchase') : list(db.purchases.filter((x) => x.payer_id === m![1]));
      const a = acct(m[1]!);
      if (!a) return reply(404, 'No account');
      const x: Row = { _id: nextId(), type: 'merchant', payer_id: m[1], merchant_id: body.merchant_id, amount: body.amount, description: body.description, medium: body.medium, status: body.status };
      a.balance = (a.balance as number) - (body.amount as number);
      db.purchases.push(x);
      return created('Purchase', x);
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/transfers$/))) {
      if (method === 'GET') return list(db.transfers.filter((x) => x.payer_id === m![1]));
      const a = acct(m[1]!);
      if (!a) return reply(404, 'No account');
      if (strict) {
        const extra = ['medium', 'payee_id'].filter((k) => k in body);
        if (extra.length) return reply(400, `${extra.length} validation errors for TransferCreate\n${extra.map((k) => `${k}\n  extra fields not permitted (type=value_error.extra)`).join('\n')}`);
        const x: Row = { _id: nextId(), type: 'p2p', payer_id: m[1], amount: body.amount, description: body.description, status: body.status };
        a.balance = (a.balance as number) - (body.amount as number);
        db.transfers.push(x);
        return created('Transfer', x);
      }
      const to = acct(String(body.payee_id));
      if (!to) return reply(404, 'No payee');
      const x: Row = { _id: nextId(), type: 'p2p', payer_id: m[1], payee_id: body.payee_id, amount: body.amount, medium: body.medium, description: body.description };
      a.balance = (a.balance as number) - (body.amount as number);
      to.balance = (to.balance as number) + (body.amount as number);
      db.transfers.push(x);
      return created('Transfer', x);
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/deposits$/))) {
      if (method === 'GET') return list(db.deposits.filter((x) => x.account_id === m![1]));
      const a = acct(m[1]!);
      if (!a) return reply(404, 'No account');
      const x: Row = { _id: nextId(), account_id: m[1], amount: body.amount, description: body.description, medium: body.medium };
      a.balance = (a.balance as number) + (body.amount as number);
      db.deposits.push(x);
      return created('Deposit', x);
    }
    return reply(403, { message: 'Missing Authentication Token' });
  };
  return { fetch, db, seen };
}

const banks: [string, () => NessieClient][] = [
  ['the demo bank', () => createFakeNessie()],
  ['the original Nessie server', () => createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: mockNessie('classic').fetch })],
  ['the current Nessie server', () => createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: mockNessie('current').fetch })],
  ['the current Nessie server as it answers today', () => createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: mockNessie('live').fetch })],
];

describe.each(banks)('the Nessie contract: %s', (_name, make) => {
  test('customers, accounts, merchants, purchases and a P2P transfer that lands', async () => {
    const bank = make();
    const seb = await bank.createCustomer({ firstName: 'Seb', lastName: 'Déjà View' });
    const shivin = await bank.createCustomer({ firstName: 'Shivin', lastName: 'Déjà View' });
    expect(seb.id).toMatch(/^[A-Za-z0-9-]{12,}$/);
    expect(seb.id).not.toBe(shivin.id);
    const a = await bank.createAccount(seb.id, { nickname: "Seb's tab", balanceCents: 50_000 });
    const b = await bank.createAccount(shivin.id, { nickname: "Shivin's tab", balanceCents: 50_000 });
    expect(a.id).not.toBe(b.id);
    expect((await bank.getAccount(a.id))?.balanceCents).toBe(50_000);

    const lawn = await bank.createMerchant({ name: 'Infinity Hall Game Lawn', category: 'entertainment' });
    expect((await bank.listMerchants()).some((m) => m.id === lawn.id && m.name === 'Infinity Hall Game Lawn')).toBe(true);

    const p = await bank.createPurchase(a.id, { merchantId: lawn.id, amountCents: 1200, description: 'Pool table (p_1)' });
    expect(p.amountCents).toBe(1200);
    expect((await bank.getAccount(a.id))?.balanceCents).toBe(48_800);

    const t = await bank.createTransfer(b.id, { payeeAccountId: a.id, amountCents: 300, description: 'Shivin pays Seb back (s_1)' });
    expect(t.id).toBeTruthy();
    expect(t.payerId).toBe(b.id);
    expect(t.payeeId).toBe(a.id);
    expect(t.credited).not.toBe(false);
    expect((await bank.getAccount(b.id))?.balanceCents).toBe(49_700);
    expect((await bank.getAccount(a.id))?.balanceCents).toBe(49_100);
  });

  test('no such account is null; bad amounts and self-transfers are refused', async () => {
    const bank = make();
    expect(await bank.getAccount('ffffffffffffffffffffffff')).toBeNull();
    const c = await bank.createCustomer({ firstName: 'Ojasva', lastName: 'Déjà View' });
    const a = await bank.createAccount(c.id, { nickname: 'x', balanceCents: 100 });
    for (const amountCents of [0, -5, 12.5, NaN]) {
      await expect(bank.createTransfer(a.id, { payeeAccountId: 'ffffffffffffffffffffffff', amountCents, description: 'x' })).rejects.toBeInstanceOf(NessieError);
    }
    await expect(bank.createTransfer(a.id, { payeeAccountId: a.id, amountCents: 5, description: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('the Nessie client', () => {
  test('the original server: one call per transfer, ids from objectCreated', async () => {
    const mock = mockNessie('classic');
    const bank = createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: mock.fetch });
    const a = await bank.createAccount((await bank.createCustomer({ firstName: 'A', lastName: 'B' })).id, { nickname: 'a', balanceCents: 0 });
    const b = await bank.createAccount((await bank.createCustomer({ firstName: 'C', lastName: 'D' })).id, { nickname: 'b', balanceCents: 0 });
    mock.seen.length = 0;
    await bank.createTransfer(a.id, { payeeAccountId: b.id, amountCents: 100, description: 'x' });
    expect(mock.seen).toEqual([`POST /accounts/${a.id}/transfers`]);
    expect(mock.db.transfers[0]).toMatchObject({ medium: 'balance', payee_id: b.id, amount: 100 });
  });

  test('the current server: learns the transfer shape once, credits the payee with a deposit', async () => {
    const mock = mockNessie('current');
    const bank = createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: mock.fetch });
    const a = await bank.createAccount((await bank.createCustomer({ firstName: 'A', lastName: 'B' })).id, { nickname: 'a', balanceCents: 1000 });
    const b = await bank.createAccount((await bank.createCustomer({ firstName: 'C', lastName: 'D' })).id, { nickname: 'b', balanceCents: 1000 });
    const t1 = await bank.createTransfer(a.id, { payeeAccountId: b.id, amountCents: 250, description: 'first (s_1)' });
    expect(t1.creditId).toBeTruthy();
    mock.seen.length = 0;
    const t2 = await bank.createTransfer(a.id, { payeeAccountId: b.id, amountCents: 50, description: 'second (s_2)' });
    // no second refused attempt: straight to the shape that works
    expect(mock.seen.filter((s) => s.startsWith('POST'))).toEqual([`POST /accounts/${a.id}/transfers`, `POST /accounts/${b.id}/deposits`]);
    expect(t2.id).not.toBe(t1.id);
    expect((await bank.getAccount(a.id))?.balanceCents).toBe(700);
    expect((await bank.getAccount(b.id))?.balanceCents).toBe(1300);
    // a purchase whose list cannot be read is still booked, with no id
    const m = await bank.createMerchant({ name: 'Lawn', category: 'food' });
    const p = await bank.createPurchase(a.id, { merchantId: m.id, amountCents: 100, description: 'snacks' });
    expect(p.id).toBeNull();
    expect(mock.db.purchases).toHaveLength(1);
  });

  test('the key never shows up in an error, even when the server echoes it', async () => {
    const echo = async (url: string) => new Response(JSON.stringify({ message: `bad request for ${url}` }), { status: 400 });
    const bank = createNessieClient({ key: KEY, baseUrl: 'https://nessie.test', fetch: echo });
    const e = (await bank.createCustomer({ firstName: 'A', lastName: 'B' }).catch((x) => x)) as NessieError;
    expect(e).toBeInstanceOf(NessieError);
    expect(e.status).toBe(400);
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain('***');
    const down = async (url: string): Promise<Response> => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    };
    const offline = createNessieClient({ key: KEY, fetch: down });
    const e2 = (await offline.listMerchants().catch((x) => x)) as NessieError;
    expect(e2.message).not.toContain(KEY);
    expect(e2.status).toBe(0);
  });

  test('a key with URL characters is hidden however the server echoes it', async () => {
    const odd = 'k y+z/1=';
    const echo = async (url: string) => new Response(JSON.stringify({ message: `bad ${url} ${decodeURIComponent(new URL(url).search)}` }), { status: 400 });
    const bank = createNessieClient({ key: odd, baseUrl: 'https://nessie.test', fetch: echo });
    const e = (await bank.listMerchants().catch((x) => x)) as NessieError;
    expect(e.message).toContain('***');
    for (const form of [odd, encodeURIComponent(odd), new URLSearchParams({ key: odd }).toString().slice(4)]) expect(e.message).not.toContain(form);
  });

  test('a gateway giving up on a transfer (502, 504) says the outcome is unknown; a refusal does not', async () => {
    for (const [status, unknown] of [[504, true], [502, true], [500, false], [400, false]] as const) {
      const bank = createNessieClient({ key: KEY, fetch: async () => new Response('"upstream"', { status }) });
      const e = (await bank
        .createTransfer('aaaaaaaaaaaaaaaaaaaaaaaa', { payeeAccountId: 'bbbbbbbbbbbbbbbbbbbbbbbb', amountCents: 5, description: 'x' })
        .catch((x) => x)) as NessieError;
      expect(e).toBeInstanceOf(NessieError);
      expect(e.unknownOutcome).toBe(unknown);
    }
    const reads = createNessieClient({ key: KEY, fetch: async () => new Response('"upstream"', { status: 504 }) });
    expect(((await reads.listMerchants().catch((x) => x)) as NessieError).unknownOutcome).toBe(false);
  });

  test('a timeout on a transfer says the outcome is unknown', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('timeout', 'TimeoutError'))));
    const bank = createNessieClient({ key: KEY, fetch: hang, timeoutMs: 40 });
    const e = (await bank
      .createTransfer('aaaaaaaaaaaaaaaaaaaaaaaa', { payeeAccountId: 'bbbbbbbbbbbbbbbbbbbbbbbb', amountCents: 5, description: 'x' })
      .catch((x) => x)) as NessieError;
    expect(e).toBeInstanceOf(NessieError);
    expect(e.unknownOutcome).toBe(true);
    const g = (await bank.getAccount('aaaaaaaaaaaaaaaaaaaaaaaa').catch((x) => x)) as NessieError;
    expect(g.unknownOutcome).toBe(false);
  });

  test('the environment picks the bank; no key, the demo bank', () => {
    expect(nessieFromEnv({}).mode).toBe('demo');
    expect(nessieFromEnv({ NESSIE_API_KEY: '  ' }).mode).toBe('demo');
    expect(nessieFromEnv({ NESSIE_API_KEY: 'k' }).mode).toBe('nessie');
  });
});

// ---------------------------------------------------------------- the tab

describe('the tab', () => {
  test('purchases are booked in the bank on the payer and written to data/tab/<id>.json', async () => {
    const r = rig();
    const tab = await seedNight(r);
    expect(tab.mode).toBe('demo');
    expect(tab.friends.map((f) => f.name)).toEqual(FOUR);
    expect(tab.friends.every((f) => f.nessie?.accountId)).toBe(true);
    expect(tab.totalCents).toBe(5315);
    expect(tab.purchases.every((p) => p.nessieId)).toBe(true);
    const st = r.bank.state();
    expect(st.purchases.map((p) => p.amountCents)).toEqual([1200, 975, 3140]);
    expect(st.merchants.map((m) => m.name).sort()).toEqual(['Infinity Hall Game Lawn', 'Lawnside Pizza Co.']);
    const sebAccount = tab.friends.find((f) => f.name === 'Seb')!.nessie!.accountId;
    expect(st.purchases[0]!.from).toBe(sebAccount);
    const file = await r.file();
    expect(file.purchases).toHaveLength(3);
    expect(sum(tab.balances.map((b) => b.netCents))).toBe(0);
    expect(tab.transfers.length).toBeLessThanOrEqual(3);
  });

  test('settle up makes the suggested transfers once; a settled tab is not settled twice', async () => {
    const r = rig();
    const before = await seedNight(r);
    const suggested = before.transfers.map((t) => ({ from: t.from, to: t.to, amountCents: t.amountCents }));
    const [one, two] = await Promise.all([r.tabs.settle('the-courts'), r.tabs.settle('the-courts')]);
    const results = [one, two];
    const made = results.find((x) => !x.already)!;
    expect(results.filter((x) => x.already)).toHaveLength(1);
    expect(made.made.map((p) => ({ from: p.from, to: p.to, amountCents: p.amountCents }))).toEqual(suggested);
    expect(made.made.every((p) => p.status === 'paid' && p.nessieId)).toBe(true);
    expect(made.tab.square).toBe(true);
    expect(made.tab.transfers).toEqual([]);
    expect(r.bank.state().transfers).toHaveLength(suggested.length);
    const again = await r.tabs.settle('the-courts');
    expect(again.already).toBe(true);
    expect(r.bank.state().transfers).toHaveLength(suggested.length);
    // what the friends' accounts did in the bank matches the tab: everyone is down their share
    const st = r.bank.state();
    for (const b of made.tab.balances) {
      const acc = st.accounts.find((a) => a.id === made.tab.friends.find((f) => f.id === b.friend)!.nessie!.accountId)!;
      expect(acc.balanceCents).toBe(50_000 - b.shareCents);
    }
  });

  test('a refused transfer is retried by the next settle; an unconfirmed one is never sent twice', async () => {
    const r = rig();
    const before = await seedNight(r);
    const n = before.transfers.length;
    expect(n).toBeGreaterThanOrEqual(2);
    r.bank.failNext('createTransfer', new NessieError('Nessie refused the transfer (HTTP 500).', 500));
    const first = await r.tabs.settle('the-courts');
    expect(first.made[0]!.status).toBe('failed');
    expect(first.made.slice(1).every((p) => p.status === 'paid')).toBe(true);
    expect(first.tab.square).toBe(false);
    expect(first.tab.failed).toHaveLength(1);
    const second = await r.tabs.settle('the-courts');
    expect(second.made).toHaveLength(1);
    expect(second.made[0]!.status).toBe('paid');
    expect(second.tab.square).toBe(true);
    expect(r.bank.state().transfers).toHaveLength(n);

    const r2 = rig();
    await seedNight(r2);
    r2.bank.failNext('createTransfer', new NessieError('Nessie did not answer in time.', 0, true));
    const s = await r2.tabs.settle('the-courts');
    expect(s.made[0]!.status).toBe('unconfirmed');
    expect(s.tab.square).toBe(true);
    expect((await r2.tabs.settle('the-courts')).already).toBe(true);
  });

  test('a restarted demo bank: accounts are opened again and settling still works', async () => {
    const dir = tempDir();
    const r1 = rig({}, dir);
    await seedNight(r1);
    const r2 = rig({}, dir, createFakeNessie());
    const s = await r2.tabs.settle('the-courts');
    expect(s.made.every((p) => p.status === 'paid')).toBe(true);
    expect(r2.bank.state().accounts).toHaveLength(4);
  });

  test('a split that would pass the friend limit is refused before anyone joins', async () => {
    const r = rig();
    const eleven = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11'];
    await r.tabs.addPurchase('the-courts', { payer: 'A1', merchant: 'Lawn', amount: 11, split: eleven });
    const calls = r.bank.calls.length;
    await expect(r.tabs.addPurchase('the-courts', { payer: 'New3', merchant: 'Lawn', amount: 5, split: ['New1', 'New2'] })).rejects.toMatchObject({ status: 409 });
    expect((await r.file()).friends).toHaveLength(11);
    expect(r.bank.calls.length).toBe(calls);
    // one more still fits
    await r.tabs.addPurchase('the-courts', { payer: 'A12', merchant: 'Lawn', amount: 5, split: ['A12', 'A1'] });
    expect((await r.file()).friends).toHaveLength(12);
  });

  test('a read-only server shows the tab and changes nothing', async () => {
    const dir = tempDir();
    await seedNight(rig({}, dir));
    let subscribed = 0;
    const ro = rig({ readOnly: true, onEvent: () => (subscribed++, () => {}) }, dir);
    ro.tabs.start();
    expect(subscribed).toBe(0);
    expect((await ro.tabs.view('the-courts')).purchases).toHaveLength(3);
    await expect(ro.tabs.settle('the-courts')).rejects.toMatchObject({ status: 503 });
    await expect(ro.tabs.setRules('the-courts', { loserCoversTable: true })).rejects.toMatchObject({ status: 503 });
    await expect(ro.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: 'Lawn', amount: 5 })).rejects.toMatchObject({ status: 503 });
    ro.tabs.onGameEvent('the-courts', { type: 'game.result', round: 'ro-1', loserName: 'Shivin' });
    await ro.tabs.idle();
    expect(ro.bank.calls).toEqual([]);
    expect((await ro.file()).payments).toEqual([]);
  });

  test('a payment left pending by a restart shows as unconfirmed, a fresh one as pending', () => {
    const tab = emptyTab('the-courts', '');
    tab.friends = ['a', 'b'].map((id) => ({ id, name: id }));
    const at = (msAgo: number) => new Date(Date.parse('2026-10-17T03:00:00Z') - msAgo).toISOString();
    tab.payments = [
      { id: 's1', kind: 'settle', from: 'b', to: 'a', amountCents: 100, description: '', at: at(10 * 60_000), bank: 'demo', status: 'pending', nessieId: null },
      { id: 's2', kind: 'settle', from: 'b', to: 'a', amountCents: 100, description: '', at: at(5_000), bank: 'demo', status: 'pending', nessieId: null },
    ];
    const v = viewOf(tab, COURTS, 'demo', true, Date.parse('2026-10-17T03:00:00Z'));
    expect(v.settled.map((p) => p.status)).toEqual(['unconfirmed', 'pending']);
  });

  test('a merchant called __proto__ is cached like any other', async () => {
    const r = rig();
    await r.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: '__proto__', amount: 5 });
    await r.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: '__proto__', amount: 6 });
    expect(r.bank.state().merchants).toHaveLength(1);
    expect(Object.keys((await r.file()).merchants)).toEqual(['__proto__']);
  });

  test('a purchase that fails in the bank keeps the account it opened', async () => {
    const r = rig();
    r.bank.failNext('createPurchase');
    await expect(r.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: 'Lawn', amount: 5 })).rejects.toBeInstanceOf(NessieError);
    const file = await r.file();
    expect(file.purchases).toHaveLength(0);
    expect(file.friends[0]?.accountId).toBeTruthy();
    await r.tabs.addPurchase('the-courts', { payer: 'Seb', merchant: 'Lawn', amount: 5 });
    expect(r.bank.state().customers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- loser covers the table

const result = (round: string, loserName = 'Shivin', extra: Record<string, unknown> = {}) => ({
  type: 'game.result',
  game: 'pool',
  round,
  winner: 'rbx-123',
  winnerName: 'Seb',
  loser: 'rbx-456',
  loserName,
  score: '7-4',
  durationS: 312,
  ...extra,
});

describe('loser covers the table', () => {
  async function onRig(fee: number | null = null) {
    const presence = new PresenceStore({ log: () => {} });
    const r = rig({ onEvent: (fn) => presence.onEvent(fn) });
    r.tabs.start();
    await seedNight(r);
    await r.tabs.setRules('the-courts', { loserCoversTable: true, tableFee: fee });
    return { ...r, presence };
  }

  test('a game.result moves the table onto the loser with a Nessie transfer to whoever paid it', async () => {
    const r = await onRig();
    const callsBefore = r.bank.calls.length;
    r.presence.publishEvent('the-courts', result('match-1'));
    // the event route never waits: nothing has reached the bank when publishEvent returns
    expect(r.bank.calls.length).toBe(callsBefore);
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games).toHaveLength(1);
    expect(tab.games[0]).toMatchObject({ round: 'match-1', status: 'charged', loserName: 'Shivin', payeeName: 'Seb', chargeCents: 1200 });
    const table = tab.settled.find((p) => p.kind === 'table')!;
    expect(table).toMatchObject({ fromName: 'Shivin', toName: 'Seb', amountCents: 1200, status: 'paid' });
    expect(table.nessieId).toBeTruthy();
    const transfers = r.bank.state().transfers;
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.amountCents).toBe(1200);
    // the table is Shivin's alone now: nobody else owes Seb for it
    const share = (name: string) => tab.balances.find((b) => b.name === name)!.shareCents;
    expect(share('Shivin') - share('Ojasva')).toBe(1200);
    expect(tab.purchases[0]!.coveredCents).toBe(1200);
    expect(sum(tab.balances.map((b) => b.netCents))).toBe(0);
    expect(tab.friends.find((f) => f.name === 'Shivin')!.robloxId).toBe('rbx-456');
    await r.tabs.stop();
  });

  test('each round counts once: resends, a burst and a later duplicate are ignored', async () => {
    const r = await onRig(5);
    for (let i = 0; i < 4; i++) r.tabs.onGameEvent('the-courts', result('dup-1'));
    await r.tabs.idle();
    r.tabs.onGameEvent('the-courts', result('dup-1'));
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games).toHaveLength(1);
    expect(r.bank.state().transfers).toHaveLength(1);
    // a fresh process reads the round from the file
    const again = rig({}, r.dir, r.bank);
    again.tabs.onGameEvent('the-courts', result('dup-1'));
    await again.tabs.idle();
    expect((await again.tabs.view('the-courts')).games).toHaveLength(1);
    await r.tabs.stop();
  });

  test('other event types, a missing round, other memories and the rule off are ignored', async () => {
    const r = await onRig();
    r.presence.publishEvent('the-courts', { type: 'tag', by: 'quest-1', target: 'rbx-456' });
    r.presence.publishEvent('the-courts', { type: 'round', state: 'end', scores: {} });
    r.presence.publishEvent('the-courts', { type: 'game', game: 'pool', winner: 'rbx-123', round: 'x1', loserName: 'Shivin' });
    r.presence.publishEvent('the-courts', { ...result('x2'), round: undefined });
    r.presence.publishEvent('other-place', result('x3'));
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games).toEqual([]);
    await r.tabs.setRules('the-courts', { loserCoversTable: false });
    r.presence.publishEvent('the-courts', result('x4'));
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games).toEqual([]);
    expect(r.bank.state().transfers).toEqual([]);
    await r.tabs.stop();
    // after stop the subscription is gone
    await r.tabs.setRules('the-courts', { loserCoversTable: true });
    r.presence.publishEvent('the-courts', result('x5'));
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games).toEqual([]);
  });

  test('a fee per match covers the table a piece at a time, never more than the table', async () => {
    const r = await onRig(5);
    for (const round of ['m1', 'm2', 'm3', 'm4']) r.tabs.onGameEvent('the-courts', result(round));
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games.map((g) => [g.status, g.chargeCents ?? 0])).toEqual([
      ['charged', 500],
      ['charged', 500],
      ['charged', 200],
      ['skipped', 0],
    ]);
    expect(tab.games[3]!.note).toBe('The table is already covered.');
    expect(r.bank.state().transfers.map((t) => t.amountCents)).toEqual([500, 500, 200]);
    await r.tabs.stop();
  });

  test('the payer losing keeps the table; a stranger losing is noted and charged nothing', async () => {
    const r = await onRig();
    r.tabs.onGameEvent('the-courts', result('s1', 'Mystery Guest', { loser: 'rbx-999' }));
    r.tabs.onGameEvent('the-courts', result('s2', 'Seb', { loser: 'rbx-123', winnerName: 'Shivin', winner: 'rbx-456' }));
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games[0]).toMatchObject({ status: 'skipped', note: "Mystery Guest isn't on this tab." });
    expect(tab.games[1]).toMatchObject({ status: 'covered', chargeCents: 1200 });
    expect(r.bank.state().transfers).toEqual([]);
    const share = (name: string) => tab.balances.find((b) => b.name === name)!.shareCents;
    expect(share('Seb') - share('Ojasva')).toBe(1200);
    await r.tabs.stop();
  });

  test('a draw or a "bot" side moves no money (contracts 6.5)', async () => {
    const r = await onRig();
    r.tabs.onGameEvent('the-courts', result('d1', 'Shivin', { draw: true, score: 'draw' }));
    r.tabs.onGameEvent('the-courts', result('d2', 'Shivin', { score: 'Draw' }));
    r.tabs.onGameEvent('the-courts', result('b1', 'Shivin', { winner: 'bot', winnerName: 'The table' }));
    r.tabs.onGameEvent('the-courts', result('b2', 'Bot', { loser: 'bot' }));
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games.map((g) => [g.round, g.status, g.chargeCents ?? 0])).toEqual([
      ['d1', 'skipped', 0],
      ['d2', 'skipped', 0],
      ['b1', 'skipped', 0],
      ['b2', 'skipped', 0],
    ]);
    expect(tab.games[0]!.note).toBe('A draw: nobody covers the table.');
    expect(tab.games.map((g) => g.draw ?? false)).toEqual([true, true, false, false]);
    expect(tab.games[2]!.note).toBe('A match against the game itself: nobody covers the table.');
    expect(r.bank.state().transfers).toEqual([]);
    expect(tab.purchases[0]!.coveredCents).toBe(0);
    expect(tab.friends.every((f) => f.robloxId === undefined || /^rbx-\d+$/.test(f.robloxId))).toBe(true);
    await r.tabs.stop();
  });

  test('"game_result" (what the event route takes before it allows the dot) counts like game.result', async () => {
    const r = await onRig();
    r.presence.publishEvent('the-courts', { ...result('g1'), type: 'game_result' });
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games).toMatchObject([{ round: 'g1', status: 'charged', chargeCents: 1200 }]);
    await r.tabs.stop();
  });

  test('a full game list drops old results that moved nothing, never one that covered the table', async () => {
    const r = await onRig(5);
    r.tabs.onGameEvent('the-courts', result('first'));
    await r.tabs.idle();
    const file = await r.file();
    for (let i = 0; i < 300; i++) file.games.push({ round: `old-${i}`, game: 'pool', at: '', status: 'skipped' });
    await Bun.write(join(r.dir, 'tab', 'the-courts.json'), JSON.stringify(file));
    const before = await r.tabs.view('the-courts');
    r.tabs.onGameEvent('the-courts', result('last'));
    await r.tabs.idle();
    const after = await r.file();
    expect(after.games).toHaveLength(300);
    expect(after.games[0]!.round).toBe('first');
    expect(after.games.at(-1)).toMatchObject({ round: 'last', status: 'charged', chargeCents: 500 });
    expect(after.games.some((g) => g.round === 'old-0')).toBe(false);
    const view = await r.tabs.view('the-courts');
    expect(view.purchases[0]!.coveredCents).toBe(before.purchases[0]!.coveredCents + 500);
    await r.tabs.stop();
  });

  test('stop finishes the result in hand, drops the queue and ignores later results; start takes them again', async () => {
    const r = await onRig(5);
    for (const round of ['q1', 'q2', 'q3']) r.tabs.onGameEvent('the-courts', result(round));
    await r.tabs.stop();
    r.tabs.onGameEvent('the-courts', result('q4'));
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games).toEqual([]);
    expect(r.logs.some((l) => l.includes('still queued'))).toBe(true);
    r.tabs.start();
    r.presence.publishEvent('the-courts', result('q5'));
    await r.tabs.idle();
    expect((await r.tabs.view('the-courts')).games.map((g) => g.round)).toEqual(['q5']);
    await r.tabs.stop();
  });

  test('a bare UserId names the same friend as rbx-<UserId>', async () => {
    const r = await onRig(5);
    r.tabs.onGameEvent('the-courts', result('u1'));
    await r.tabs.idle();
    r.tabs.onGameEvent('the-courts', result('u2', 'renamed_in_roblox', { loser: 456 }));
    await r.tabs.idle();
    const tab = await r.tabs.view('the-courts');
    expect(tab.games.map((g) => g.loserId)).toEqual(['shivin', 'shivin']);
    await r.tabs.stop();
  });
});

// ---------------------------------------------------------------- routes

describe('routes', () => {
  const base = 'http://dv.test';
  const call = (r: Rig, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const route = path.replace(/^\/api\/tab\/[^/]+/, '/api/tab/:sceneId');
    const handler = r.tabs.routes[route];
    if (!handler) throw new Error(`no route for ${route}`);
    return handler(
      new Request(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  };

  test('the route table, and every mutating route is listed for sign-in', () => {
    const r = rig();
    expect(Object.keys(r.tabs.routes).sort()).toEqual(['/api/tab/:sceneId', '/api/tab/:sceneId/purchase', '/api/tab/:sceneId/rules', '/api/tab/:sceneId/settle']);
    for (const m of TAB_MUTATING_ROUTES) expect(r.tabs.routes[m]).toBeDefined();
  });

  test('GET, purchase, rules and settle answer JSON the page can draw', async () => {
    const r = rig();
    const empty = await call(r, 'GET', '/api/tab/the-courts');
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toContain('application/json');
    const e = (await empty.json()) as TabView;
    expect(e).toMatchObject({ sceneId: 'the-courts', mode: 'demo', currency: 'USD', friends: [], purchases: [], transfers: [], settled: [], square: false, updatedAt: null });
    expect(e.scene).toEqual({ name: 'Infinity Hall Game Lawn', thumb: '/data/scenes/the-courts/thumb.jpg' });

    const p = await call(r, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Infinity Hall Game Lawn', amount: '12.00', description: 'Pool table', split: FOUR, table: true });
    expect(p.status).toBe(201);
    const pj = (await p.json()) as { ok: boolean; purchase: { id: string; amountCents: number }; tab: TabView };
    expect(pj.ok).toBe(true);
    expect(pj.purchase.amountCents).toBe(1200);
    expect(pj.tab.transfers.map((t) => [t.fromName, t.toName, t.amount])).toEqual([
      ['Ojasva', 'Seb', 3],
      ['Shivin', 'Seb', 3],
      ['Brianna', 'Seb', 3],
    ]);

    const rules = await call(r, 'POST', '/api/tab/the-courts/rules', { loserCoversTable: true, tableFee: 12 });
    expect(rules.status).toBe(200);
    expect(((await rules.json()) as { tab: TabView }).tab.rules).toEqual({ loserCoversTable: true, tableFee: 12, tableFeeCents: 1200 });

    const s = await call(r, 'POST', '/api/tab/the-courts/settle');
    expect(s.status).toBe(200);
    const sj = (await s.json()) as { ok: boolean; already: boolean; made: { nessieId: string; status: string }[]; tab: TabView };
    expect(sj.ok).toBe(true);
    expect(sj.already).toBe(false);
    expect(sj.made).toHaveLength(3);
    expect(sj.made.every((m) => m.status === 'paid' && /^[0-9a-f]{24}$/.test(m.nessieId))).toBe(true);
    expect(sj.tab.square).toBe(true);
    expect(sj.tab.settled.map((x) => x.fromName)).toEqual(['Ojasva', 'Shivin', 'Brianna']);

    const again = (await (await call(r, 'POST', '/api/tab/the-courts/settle', {})).json()) as { already: boolean; made: unknown[] };
    expect(again).toMatchObject({ already: true, made: [] });

    const text = await (await call(r, 'GET', '/api/tab/the-courts')).text();
    // mock money only: no account number ever leaves the server
    expect(text).not.toContain('account_number');
    expect(text).not.toMatch(/\d{16}/);
  });

  test('errors are sentences with the right status', async () => {
    const r = rig();
    expect((await call(r, 'GET', '/api/tab/nope')).status).toBe(404);
    expect((await call(r, 'GET', '/api/tab/the-courts/purchase')).status).toBe(405);
    expect((await call(r, 'POST', '/api/tab/the-courts')).status).toBe(405);
    const bad = await call(r, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Lawn', amount: 1000 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('amount must be more than $0 and at most $500.');
    expect((await call(r, 'POST', '/api/tab/the-courts/purchase', '{nope')).status).toBe(400);
    expect((await call(r, 'POST', '/api/tab/the-courts/purchase', '[]')).status).toBe(400);
    expect((await call(r, 'POST', '/api/tab/the-courts/rules', { loserCoversTable: 'yes' })).status).toBe(400);
    expect((await call(r, 'POST', '/api/tab/the-courts/rules', { loserCoversTable: true, tableFee: 0 })).status).toBe(400);
    r.bank.failNext('createCustomer');
    const down = await call(r, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Lawn', amount: 5 });
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toStartWith("Capital One's Nessie sandbox didn't take that.");
  });

  test('a read-only server answers every change with 503 and still shows the tab', async () => {
    const r = rig({ readOnly: true });
    expect((await call(r, 'GET', '/api/tab/the-courts')).status).toBe(200);
    for (const path of ['/api/tab/the-courts/purchase', '/api/tab/the-courts/settle', '/api/tab/the-courts/rules']) {
      const res = await call(r, 'POST', path, { payer: 'Seb', merchant: 'Lawn', amount: 5, loserCoversTable: true });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain('can only show the tab');
    }
  });

  test('a sign-in check that throws is a 500 sentence, not a crash', async () => {
    const r = rig({
      authorize: async () => {
        throw new Error('jwks unreachable');
      },
    });
    const res = await call(r, 'POST', '/api/tab/the-courts/settle');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('Something went wrong on the server. Try again.');
    expect(r.bank.calls).toEqual([]);
  });

  test('a cross-site page cannot spend mock money; sign-in sits in front of every change', async () => {
    const r = rig({ guard: {} });
    const evil = await call(r, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Lawn', amount: 5 }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const ok = await call(r, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Lawn', amount: 5 }, { origin: base });
    expect(ok.status).toBe(201);

    const seen: string[] = [];
    const locked = rig({
      authorize: async (req) => {
        seen.push(new URL(req.url).pathname);
        return req.headers.get('authorization') === 'Bearer good' ? null : Response.json({ error: 'Sign in to do that.', signIn: true }, { status: 401 });
      },
    });
    for (const path of ['/api/tab/the-courts/purchase', '/api/tab/the-courts/settle', '/api/tab/the-courts/rules']) {
      expect((await call(locked, 'POST', path, { payer: 'Seb', merchant: 'Lawn', amount: 5, loserCoversTable: true })).status).toBe(401);
    }
    expect((await call(locked, 'GET', '/api/tab/the-courts')).status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(locked.bank.calls).toEqual([]);
    const signed = await call(locked, 'POST', '/api/tab/the-courts/purchase', { payer: 'Seb', merchant: 'Lawn', amount: 5 }, { authorization: 'Bearer good' });
    expect(signed.status).toBe(201);
  });
});
