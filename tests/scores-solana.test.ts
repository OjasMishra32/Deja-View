// The Solana scoreboard (server/scores): the wire format (base58, compact-u16, legacy messages signed with WebCrypto
// Ed25519), the devnet-only guard, the memo cap, and the scoreboard's queue, log and routes against a fake RPC.
// Nothing here touches the network.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base58Decode,
  base58Encode,
  buildMemoTransaction,
  compileMessage,
  decodeCompactU16,
  DEFAULT_RPC_URL,
  DEVNET_GENESIS_HASH,
  DevnetOnlyError,
  devnetRpcUrl,
  encodeCompactU16,
  explorerTxUrl,
  generateSecret,
  keypairFromSecret,
  LAMPORTS_PER_SOL,
  loadOrCreateKeypair,
  MAX_TRANSACTION_BYTES,
  MEMO_PROGRAM_ID,
  RpcError,
  serializeMessage,
  signTransaction,
  SolanaRpc,
  type FetchLike,
  type Keypair,
  type SignatureStatus,
} from '../server/scores/solana.ts';
import { buildMemo, createScoreboard, MEMO_MAX_BYTES, parseGameResult, type Scoreboard, type ScoreRecord } from '../server/scores/scoreboard.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
const DEVNET = 'https://api.devnet.solana.com';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dv-scores-'));
  dirs.push(d);
  return d;
}
const boards: Scoreboard[] = [];
afterEach(async () => {
  for (const b of boards.splice(0)) b.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function newKeypair(): Promise<Keypair> {
  return keypairFromSecret(await generateSecret());
}

async function verify(publicKey: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', publicKey as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, sig as Uint8Array<ArrayBuffer>, msg as Uint8Array<ArrayBuffer>);
}

/** An independent reader of the legacy wire format: what the cluster would see. */
function decodeTransaction(tx: Uint8Array) {
  let o = 0;
  const n = decodeCompactU16(tx, o);
  o += n.size;
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < n.value; i++, o += 64) sigs.push(tx.slice(o, o + 64));
  const message = tx.slice(o);
  let p = 3;
  const header = [...message.slice(0, 3)];
  const kc = decodeCompactU16(message, p);
  p += kc.size;
  const keys: string[] = [];
  for (let i = 0; i < kc.value; i++, p += 32) keys.push(base58Encode(message.slice(p, p + 32)));
  const blockhash = base58Encode(message.slice(p, p + 32));
  p += 32;
  const ic = decodeCompactU16(message, p);
  p += ic.size;
  const instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[] = [];
  for (let i = 0; i < ic.value; i++) {
    const programIdIndex = message[p++]!;
    const ac = decodeCompactU16(message, p);
    p += ac.size;
    const accounts = [...message.slice(p, p + ac.value)];
    p += ac.value;
    const dl = decodeCompactU16(message, p);
    p += dl.size;
    instructions.push({ programIdIndex, accounts, data: message.slice(p, p + dl.value) });
    p += dl.value;
  }
  if (p !== message.length) throw new Error(`trailing bytes: ${message.length - p}`);
  return { sigs, message, header, keys, blockhash, instructions };
}

// ---------------------------------------------------------------- base58, compact-u16, keys

describe('base58', () => {
  test('known vectors', () => {
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Encode(Uint8Array.of(0))).toBe('1');
    expect(base58Encode(Uint8Array.of(0, 0, 0, 1))).toBe('1112');
    expect(base58Encode(enc.encode('Hello World'))).toBe('JxF12TrwUP45BMd');
    expect(base58Encode(Buffer.from('00010966776006953D5567439E5E39F86A0D273BEED61967F6', 'hex'))).toBe('16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
    expect([...base58Decode('11111111111111111111111111111111')]).toEqual(new Array(32).fill(0));
  });

  test('round trip, leading zeros kept; the Memo program id is a 32-byte key', () => {
    for (let i = 0; i < 200; i++) {
      const b = crypto.getRandomValues(new Uint8Array(1 + (i % 64)));
      if (i % 3 === 0) b.fill(0, 0, Math.min(b.length, i % 5));
      expect([...base58Decode(base58Encode(b))]).toEqual([...b]);
    }
    const memo = base58Decode(MEMO_PROGRAM_ID);
    expect(memo.length).toBe(32);
    expect(base58Encode(memo)).toBe(MEMO_PROGRAM_ID);
  });

  test('characters outside the alphabet are refused', () => {
    for (const bad of ['0', 'O', 'I', 'l', 'abc+', ' 1']) expect(() => base58Decode(bad)).toThrow();
  });
});

describe('compact-u16', () => {
  test('known encodings', () => {
    const cases: [number, number[]][] = [
      [0, [0x00]],
      [1, [0x01]],
      [0x7f, [0x7f]],
      [0x80, [0x80, 0x01]],
      [0xff, [0xff, 0x01]],
      [0x100, [0x80, 0x02]],
      [0x3fff, [0xff, 0x7f]],
      [0x4000, [0x80, 0x80, 0x01]],
      [0xffff, [0xff, 0xff, 0x03]],
    ];
    for (const [n, bytes] of cases) {
      expect([...encodeCompactU16(n)]).toEqual(bytes);
      expect(decodeCompactU16(Uint8Array.from(bytes))).toEqual({ value: n, size: bytes.length });
    }
  });

  test('round trip over the whole range; out of range is refused', () => {
    for (let n = 0; n <= 0xffff; n += 97) expect(decodeCompactU16(encodeCompactU16(n)).value).toBe(n);
    for (const bad of [-1, 0x10000, 1.5, NaN]) expect(() => encodeCompactU16(bad)).toThrow(RangeError);
    expect(() => decodeCompactU16(Uint8Array.of(0x80))).toThrow(RangeError);
    expect(() => decodeCompactU16(Uint8Array.of(0xff, 0xff, 0x07))).toThrow(RangeError);
  });
});

describe('Ed25519 keys (WebCrypto)', () => {
  test('RFC 8032 test 1: the seed gives the published public key and signature', async () => {
    const kp = await keypairFromSecret(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
    expect(Buffer.from(kp.publicKey).toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(kp.address).toBe(base58Encode(kp.publicKey));
    expect(Buffer.from(await kp.sign(new Uint8Array())).toString('hex')).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    // nothing secret in a log line
    expect(JSON.stringify(kp)).toBe(JSON.stringify({ address: kp.address }));
  });

  test('a 64-byte secret whose public half does not match is refused', async () => {
    const secret = await generateSecret();
    secret[40]! ^= 1;
    await expect(keypairFromSecret(secret)).rejects.toThrow(/does not match/);
  });

  test('the keypair file: made once with mode 600 in the CLI layout, then reused; a broken one is never overwritten', async () => {
    const dir = await tempDir();
    const file = join(dir, 'solana', 'devnet-keypair.json');
    const a = await loadOrCreateKeypair(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await readFile(file, 'utf8')) as number[];
    expect(raw.length).toBe(64);
    expect(base58Encode(Uint8Array.from(raw.slice(32)))).toBe(a.address);
    const b = await loadOrCreateKeypair(file);
    expect(b.address).toBe(a.address);
    await chmod(file, 0o644);
    await loadOrCreateKeypair(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '[1,2,3]');
    await expect(loadOrCreateKeypair(file)).rejects.toThrow(/not a keypair file/);
    expect(await readFile(file, 'utf8')).toBe('[1,2,3]');
  });
});

// ---------------------------------------------------------------- legacy messages

describe('legacy message', () => {
  test('a memo transaction: exact bytes, and the signature verifies against them', async () => {
    const payer = await newKeypair();
    const memo = '{"app":"dejaview","v":1,"test":true}';
    const signed = await buildMemoTransaction(payer, memo, BLOCKHASH);
    const d = decodeTransaction(signed.transaction);
    expect(d.header).toEqual([1, 0, 1]);
    expect(d.keys).toEqual([payer.address, MEMO_PROGRAM_ID]);
    expect(d.blockhash).toBe(BLOCKHASH);
    expect(d.instructions).toHaveLength(1);
    expect(d.instructions[0]!.programIdIndex).toBe(1);
    expect(d.instructions[0]!.accounts).toEqual([0]);
    expect(dec.decode(d.instructions[0]!.data)).toBe(memo);
    // byte for byte: header, 2 keys, blockhash, 1 instruction (program 1, account 0, the memo)
    const data = enc.encode(memo);
    const expected = Buffer.concat([
      Uint8Array.of(1, 0, 1, 2),
      payer.publicKey,
      base58Decode(MEMO_PROGRAM_ID),
      base58Decode(BLOCKHASH),
      Uint8Array.of(1, 1, 1, 0),
      encodeCompactU16(data.length),
      data,
    ]);
    expect(Buffer.from(signed.message).equals(expected)).toBe(true);
    expect(Buffer.from(d.message).equals(expected)).toBe(true);
    expect([...signed.transaction.slice(0, 1)]).toEqual([1]);
    expect(base58Encode(d.sigs[0]!)).toBe(signed.signature);
    expect(await verify(payer.publicKey, d.sigs[0]!, d.message)).toBe(true);
    const tampered = d.message.slice();
    tampered[tampered.length - 2]! ^= 1;
    expect(await verify(payer.publicKey, d.sigs[0]!, tampered)).toBe(false);
  });

  test('account ordering: payer first, then writable signers, read-only signers, writable, read-only; flags merge', async () => {
    const [payer, c, d] = await Promise.all([newKeypair(), newKeypair(), newKeypair()]);
    const [A, B, PX, PY] = Array.from({ length: 4 }, () => base58Encode(crypto.getRandomValues(new Uint8Array(32))));
    const m = compileMessage(
      payer!.address,
      [
        {
          programId: PX!,
          keys: [
            { pubkey: A!, isSigner: false, isWritable: false },
            { pubkey: B!, isSigner: false, isWritable: true },
            { pubkey: c!.address, isSigner: true, isWritable: false },
          ],
          data: Uint8Array.of(1),
        },
        {
          programId: PY!,
          keys: [
            { pubkey: d!.address, isSigner: true, isWritable: true },
            { pubkey: A!, isSigner: false, isWritable: true },
            { pubkey: payer!.address, isSigner: false, isWritable: false },
          ],
          data: new Uint8Array(200),
        },
      ],
      BLOCKHASH,
    );
    expect(m.accountKeys).toEqual([payer!.address, d!.address, c!.address, A!, B!, PX!, PY!]);
    expect(m.header).toEqual([3, 1, 2]);
    expect(m.instructions[0]).toMatchObject({ programIdIndex: 5, accounts: [3, 4, 2] });
    expect(m.instructions[1]).toMatchObject({ programIdIndex: 6, accounts: [1, 3, 0] });
    const signed = await signTransaction(m, [c!, d!, payer!]);
    const t = decodeTransaction(signed.transaction);
    expect(t.keys).toEqual(m.accountKeys);
    expect(t.sigs).toHaveLength(3);
    // signatures in account order, each over the exact message bytes
    const order = [payer!, d!, c!];
    for (let i = 0; i < 3; i++) expect(await verify(order[i]!.publicKey, t.sigs[i]!, serializeMessage(m))).toBe(true);
    // the 200-byte data length is a two-byte compact-u16
    const msg = serializeMessage(m);
    const at = msg.length - 200 - 2;
    expect([...msg.slice(at, at + 2)]).toEqual([0xc8, 0x01]);
    await expect(signTransaction(m, [payer!])).rejects.toThrow(/No keypair/);
  });
});

// ---------------------------------------------------------------- devnet only

describe('devnet only', () => {
  test('devnet and this machine are accepted; the default is the public devnet', () => {
    expect(devnetRpcUrl()).toBe(DEFAULT_RPC_URL);
    expect(devnetRpcUrl('  ')).toBe(DEFAULT_RPC_URL);
    for (const ok of [DEVNET, 'https://devnet.helius-rpc.com/?api-key=x', 'https://solana-devnet.g.alchemy.com/v2/k', 'http://localhost:8899', 'http://127.0.0.1:8899']) {
      expect(devnetRpcUrl(ok)).toBe(ok);
    }
  });

  test('mainnet, testnet and look-alikes are refused, without echoing the URL', () => {
    for (const bad of [
      'https://api.mainnet-beta.solana.com',
      'https://api.testnet.solana.com',
      'https://rpc.example.com/devnet',
      'https://rpc.example.com/?cluster=devnet',
      'https://devnet.mainnet.example.com',
      'ftp://devnet.example.com',
      'not a url',
    ]) {
      expect(() => devnetRpcUrl(bad)).toThrow(DevnetOnlyError);
    }
    try {
      devnetRpcUrl('https://mainnet.helius-rpc.com/?api-key=SECRET123');
    } catch (e) {
      expect((e as Error).message).toContain('mainnet.helius-rpc.com');
      expect((e as Error).message).not.toContain('SECRET123');
    }
    expect(() => new SolanaRpc({ url: 'https://api.mainnet-beta.solana.com' })).toThrow(DevnetOnlyError);
  });

  test('a scoreboard pointed at mainnet stays off and never calls out', async () => {
    const fake = new FakeRpc();
    const bus = makeBus();
    const logs: string[] = [];
    const sb = createScoreboard({ onEvent: bus.on, dataDir: await tempDir(), rpcUrl: 'https://api.mainnet-beta.solana.com', enabled: true, fetch: fake.fetch, log: (m) => logs.push(m) });
    boards.push(sb);
    sb.start();
    bus.emit('kitchen', result('r1'));
    await sb.tick();
    expect(sb.enabled).toBe(false);
    expect(bus.size()).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/devnet only.*stays off/);
    const body = await (await sb.routes['/api/scores']!(new Request('http://x/api/scores'))).json();
    expect(body).toMatchObject({ enabled: false, scores: [], leaders: [] });
    expect(body.error).toMatch(/devnet only/);
  });
});

// ---------------------------------------------------------------- the memo

describe('memo', () => {
  const base = { scene: 'kitchen', game: 'pingpong', round: 'r-1', winnerName: 'Seb', loserName: 'Shivin', score: '7-4', t: 1_760_000_000 };

  test('the agreed fields in the agreed order', () => {
    const memo = buildMemo(base);
    expect(memo).toBe('{"app":"dejaview","v":1,"scene":"kitchen","game":"pingpong","round":"r-1","winner":"Seb","loser":"Shivin","score":"7-4","t":1760000000}');
  });

  test(`never more than ${MEMO_MAX_BYTES} bytes; names are trimmed, the rest stays valid JSON`, async () => {
    const huge = {
      ...base,
      scene: 'a'.repeat(96),
      round: 'r'.repeat(64),
      winnerName: '🏓'.repeat(200),
      loserName: '"\\\u0001'.repeat(100),
      score: '9'.repeat(40),
    };
    const memo = buildMemo(huge);
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(MEMO_MAX_BYTES);
    const o = JSON.parse(memo);
    expect(o).toMatchObject({ app: 'dejaview', v: 1, game: 'pingpong', t: 1_760_000_000 });
    expect(Array.from(o.winner as string).length).toBeLessThanOrEqual(24);
    expect(Array.from(o.loser as string).length).toBeLessThanOrEqual(24);
    expect(o.winner).toMatch(/^(🏓)+$/);
    // ASCII only: the Memo program pays several times more compute for multi-byte text (24 emoji names blow its budget)
    expect([...memo].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
    const emoji = buildMemo({ ...base, winnerName: '🏓'.repeat(40), loserName: 'Zoë 漢字' });
    expect(emoji).toContain('\\ud83c\\udfd3');
    expect(emoji.length).toBeLessThanOrEqual(MEMO_MAX_BYTES);
    expect(JSON.parse(emoji)).toMatchObject({ winner: expect.stringMatching(/^(🏓){10,24}$/), loser: 'Zoë 漢字' });
    expect(buildMemo({ ...base, draw: true })).toBe('{"app":"dejaview","v":1,"scene":"kitchen","game":"pingpong","round":"r-1","winner":"Seb","loser":"Shivin","score":"7-4","draw":true,"t":1760000000}');
    // and it fits in one transaction with room to spare
    const signed = await buildMemoTransaction(await newKeypair(), memo, BLOCKHASH);
    expect(signed.transaction.length).toBeLessThan(MAX_TRANSACTION_BYTES);
  });

  test('parsing a game.result: ids normalised, a missing round derived, junk refused', () => {
    const r = parseGameResult('kitchen', { type: 'game.result', game: 'Pool', round: 7, winner: 123, loser: '456', score: '3-1', durationS: 61.6, t: 1_760_000_123 }, 1)!;
    expect(r).toMatchObject({ game: 'pool', round: '7', winnerId: 'rbx-123', winnerName: 'rbx-123', loserId: 'rbx-456', score: '3-1', durationS: 62, t: 1_760_000_123 });
    expect(parseGameResult('kitchen', { type: 'game.result', game: 'pool' }, 1)).toBeNull();
    expect(parseGameResult('kitchen', { type: 'game.result', winner: 'rbx-1' }, 1)).toBeNull();
    expect(parseGameResult('kitchen', { type: 'game.result', game: 'no spaces!', winner: 'rbx-1' }, 1)).toBeNull();
    const a = parseGameResult('kitchen', { game: 'tag', winner: 'rbx-1', t: 1_760_000_040 }, 1)!;
    const b = parseGameResult('kitchen', { game: 'tag', winner: 'rbx-1', t: 1_760_000_099 }, 1)!;
    expect(a.round).toMatch(/^auto-[0-9a-f]{12}$/);
    expect(b.round).toBe(a.round);
  });
});

// ---------------------------------------------------------------- the scoreboard, against a fake RPC

function rpcError(code: number, message: string, status = 200): () => Response {
  return () => Response.json({ jsonrpc: '2.0', id: 0, error: { code, message } }, { status });
}

/** A devnet stand-in: checks every transaction it is sent (decodes it and verifies the signature), confirms on ask. */
class FakeRpc {
  calls: { method: string; params: unknown[] }[] = [];
  balance = 2 * LAMPORTS_PER_SOL;
  height = 100;
  airdrops: number[] = [];
  /** Signature -> memo, for every transaction accepted. */
  sent = new Map<string, string>();
  statuses = new Map<string, SignatureStatus>();
  autoConfirm = true;
  genesis = DEVNET_GENESIS_HASH;
  /** Per method: answers to give (in turn) instead of the normal one. */
  next: Record<string, (() => Response)[]> = {};

  fetch: FetchLike = async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    this.calls.push({ method: req.method, params: req.params });
    const queued = this.next[req.method]?.shift();
    if (queued) return queued();
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: req.id, result });
    switch (req.method) {
      case 'getGenesisHash':
        return ok(this.genesis);
      case 'getLatestBlockhash':
        // a new blockhash as the chain moves on (so a transaction signed again gets a new signature)
        return ok({ context: { slot: 1 }, value: { blockhash: base58Encode(new Uint8Array(32).fill(this.height % 251)), lastValidBlockHeight: this.height + 150 } });
      case 'getBlockHeight':
        return ok(this.height);
      case 'getBalance':
        return ok({ context: { slot: 1 }, value: this.balance });
      case 'requestAirdrop':
        this.airdrops.push(req.params[1] as number);
        this.balance += req.params[1] as number;
        return ok(base58Encode(new Uint8Array(64).fill(9)));
      case 'sendTransaction': {
        const [b64, cfg] = req.params as [string, Record<string, unknown>];
        if (cfg.encoding !== 'base64' || cfg.skipPreflight !== false) return rpcError(-32602, 'bad config')();
        const d = decodeTransaction(Buffer.from(b64, 'base64'));
        if (!(await verify(base58Decode(d.keys[0]!), d.sigs[0]!, d.message))) return rpcError(-32003, 'signature verification failure')();
        if (d.keys[d.instructions[0]!.programIdIndex] !== MEMO_PROGRAM_ID) return rpcError(-32002, 'not a memo')();
        const sig = base58Encode(d.sigs[0]!);
        this.sent.set(sig, dec.decode(d.instructions[0]!.data));
        if (this.autoConfirm) this.statuses.set(sig, { slot: 42, confirmations: 0, err: null, confirmationStatus: 'confirmed' });
        return ok(sig);
      }
      case 'getSignatureStatuses':
        return ok({ context: { slot: 1 }, value: (req.params[0] as string[]).map((s) => this.statuses.get(s) ?? null) });
    }
    return rpcError(-32601, 'Method not found')();
  };

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

type Ev = { type: string; [k: string]: unknown };
function makeBus() {
  const fns = new Set<(sceneId: string, ev: Ev) => void>();
  return {
    on: (fn: (sceneId: string, ev: Ev) => void) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit(sceneId: string, ev: Ev) {
      const e = { t: 1_760_000_000, ...ev };
      for (const fn of fns) fn(sceneId, e);
    },
    size: () => fns.size,
  };
}

function result(round: string, extra: Record<string, unknown> = {}): Ev {
  return { type: 'game.result', game: 'pingpong', round, winner: 'rbx-123', winnerName: 'Seb', loser: 'rbx-456', loserName: 'Shivin', score: '7-4', durationS: 312, ...extra };
}

async function board(o: { dataDir?: string; fake?: FakeRpc; enabled?: boolean } = {}) {
  const dataDir = o.dataDir ?? (await tempDir());
  const fake = o.fake ?? new FakeRpc();
  const bus = makeBus();
  const logs: string[] = [];
  const clock = { ms: 1_760_000_000_000 };
  const sb = createScoreboard({
    onEvent: bus.on,
    getScene: async (id) => (id === 'kitchen' ? { name: 'Kitchen' } : id === 'garage' ? { name: 'Garage' } : null),
    dataDir,
    rpcUrl: DEVNET,
    enabled: o.enabled ?? true,
    fetch: (url, init) => fake.fetch(url, init),
    log: (m) => logs.push(m),
    now: () => clock.ms,
    pollMs: 60_000,
  });
  boards.push(sb);
  /** Runs the queue until nothing is left to confirm (or it stops moving). */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await sb.tick();
      if (!sb.list().some((r) => r.status === 'pending')) return;
    }
  };
  return { sb, bus, fake, logs, clock, dataDir, settle };
}

async function readLog(dataDir: string): Promise<ScoreRecord[]> {
  const raw = await readFile(join(dataDir, 'solana', 'results.jsonl'), 'utf8');
  return raw.trim().split('\n').map((l) => JSON.parse(l));
}

const getJson = async (sb: Scoreboard, path: string) => {
  const route = path === '/api/scores' ? '/api/scores' : '/api/scores/:sceneId';
  const res = await sb.routes[route]!(new Request(`http://127.0.0.1${path}`));
  return { res, body: res.status === 200 ? await res.json() : await res.json().catch(() => null) };
};

describe('scoreboard', () => {
  test('a game.result becomes one signed memo, confirmed and logged; the subscriber itself never waits', async () => {
    const { sb, bus, fake, dataDir, settle } = await board();
    sb.start();
    expect(bus.size()).toBe(1);
    bus.emit('kitchen', result('m-1'));
    // the event handler only queued it
    expect(fake.count('sendTransaction')).toBe(0);
    expect(sb.list()[0]).toMatchObject({ status: 'pending', signature: null });
    await settle();
    expect(fake.count('sendTransaction')).toBe(1);
    const [rec] = sb.list();
    expect(rec).toMatchObject({ status: 'confirmed', scene: 'kitchen', game: 'pingpong', round: 'm-1', slot: 42 });
    expect(fake.sent.get(rec!.signature!)).toBe(rec!.memo);
    expect(JSON.parse(rec!.memo)).toEqual({ app: 'dejaview', v: 1, scene: 'kitchen', game: 'pingpong', round: 'm-1', winner: 'Seb', loser: 'Shivin', score: '7-4', t: 1_760_000_000 });
    const lines = await readLog(dataDir);
    expect(lines.map((l) => l.status)).toEqual(['pending', 'pending', 'confirmed']);
    expect(lines[0]!.signature).toBeNull();
    // the signature is on file before the transaction goes out
    expect(lines[1]!.signature).toBe(rec!.signature);
    expect((await stat(join(dataDir, 'solana', 'devnet-keypair.json'))).mode & 0o777).toBe(0o600);
  });

  test('other event types are ignored', async () => {
    const { sb, bus, fake, settle } = await board();
    sb.start();
    bus.emit('kitchen', { type: 'tag', by: 'quest-1', target: 'rbx-1' });
    bus.emit('kitchen', { type: 'round', state: 'end', scores: {} });
    bus.emit('kitchen', { type: 'chat', round: 'x', game: 'pool', winner: 'rbx-1' });
    await settle();
    expect(sb.list()).toHaveLength(0);
    expect(fake.count('sendTransaction')).toBe(0);
  });

  test('idempotent per (scene, round): retries, look-alikes and a restart write it once', async () => {
    const { sb, bus, fake, dataDir, settle } = await board();
    sb.start();
    bus.emit('kitchen', result('m-1'));
    bus.emit('kitchen', result('m-1'));
    bus.emit('kitchen', result('m-1', { winnerName: 'Someone else', score: '0-7' }));
    await settle();
    bus.emit('kitchen', result('m-1'));
    bus.emit('garage', result('m-1'));
    bus.emit('kitchen', { ...result('m-2'), type: 'game_result' });
    await settle();
    expect(fake.count('sendTransaction')).toBe(3);
    expect(sb.list().map((r) => `${r.scene}|${r.round}`).sort()).toEqual(['garage|m-1', 'kitchen|m-1', 'kitchen|m-2']);
    expect(sb.list().find((r) => r.key === 'kitchen|m-1')!.winnerName).toBe('Seb');
    sb.stop();
    expect(bus.size()).toBe(0);

    const again = await board({ dataDir, fake });
    again.sb.start();
    again.bus.emit('kitchen', result('m-1'));
    await again.settle();
    expect(fake.count('sendTransaction')).toBe(3);
    expect(again.sb.list()).toHaveLength(3);
  });

  test('a refused send (rate limit) stays pending, backs off, then goes through', async () => {
    const { sb, bus, fake, clock, logs, settle } = await board();
    fake.next.sendTransaction = [rpcError(429, 'Too many requests for a specific RPC call', 429)];
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await settle();
    expect(sb.list()[0]).toMatchObject({ status: 'pending', signature: null, rejections: 0 });
    expect(sb.list()[0]!.error).toMatch(/Too many requests/);
    expect(logs.join('\n')).toMatch(/trying again in 2 s/);
    // the backoff holds until the clock passes it
    await sb.tick();
    expect(fake.count('sendTransaction')).toBe(1);
    clock.ms += 2500;
    await settle();
    expect(fake.count('sendTransaction')).toBe(2);
    expect(sb.list()[0]!.status).toBe('confirmed');
  });

  test('no answer to a send: kept under its signature until its blockhash expires, then signed again', async () => {
    const { sb, bus, fake, clock, logs } = await board();
    const real = fake.fetch;
    let dropOne = true;
    fake.fetch = async (url, init) => {
      if (dropOne && String(init?.body).includes('"sendTransaction"')) {
        dropOne = false;
        fake.calls.push({ method: 'sendTransaction', params: [] });
        throw new TypeError(`Unable to connect to ${DEVNET}/?api-key=SECRET123`);
      }
      return real(url, init);
    };
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await sb.tick();
    const first = { ...sb.list()[0]! };
    expect(first.status).toBe('pending');
    expect(first.signature).not.toBeNull();
    expect(logs.join('\n')).not.toContain('SECRET123');
    clock.ms += 5000;
    await sb.tick();
    // not seen on chain and its blockhash is still valid: it may yet land, so it is not sent twice
    expect(fake.count('sendTransaction')).toBe(1);
    expect(sb.list()[0]!.signature).toBe(first.signature);
    fake.height += 1000;
    for (let i = 0; i < 4; i++) await sb.tick();
    expect(fake.count('sendTransaction')).toBe(2);
    expect(sb.list()[0]!.status).toBe('confirmed');
    expect(sb.list()[0]!.signature).not.toBe(first.signature);
  });

  test('a restart picks up pending matches: unsent ones are sent, sent ones are only confirmed', async () => {
    const dataDir = await tempDir();
    const fake = new FakeRpc();
    const memo = buildMemo({ scene: 'kitchen', game: 'chess', round: 'old-sent', winnerName: 'A', loserName: 'B', score: '1-0', t: 1_750_000_000 });
    const sentSig = base58Encode(new Uint8Array(64).fill(3));
    fake.statuses.set(sentSig, { slot: 9, confirmations: null, err: null, confirmationStatus: 'finalized' });
    const lines = [
      { key: 'kitchen|old-unsent', scene: 'kitchen', game: 'pool', round: 'old-unsent', winnerId: 'rbx-1', winnerName: 'A', loserId: null, loserName: '', score: '', t: 1_750_000_100, memo: buildMemo({ scene: 'kitchen', game: 'pool', round: 'old-unsent', winnerName: 'A', loserName: '', score: '', t: 1_750_000_100 }), status: 'pending', signature: null, rejections: 0, at: '' },
      { key: 'kitchen|old-sent', scene: 'kitchen', game: 'chess', round: 'old-sent', winnerId: null, winnerName: 'A', loserId: null, loserName: 'B', score: '1-0', t: 1_750_000_000, memo, status: 'pending', signature: sentSig, lastValidBlockHeight: 50, rejections: 0, at: '' },
    ];
    await Bun.write(join(dataDir, 'solana', 'results.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"key":"kitchen|cut sh');
    const { sb, settle, logs } = await board({ dataDir, fake });
    sb.start();
    await settle();
    expect(logs.join('\n')).toMatch(/2 match\(es\) on file, 2 still to confirm/);
    expect(fake.count('sendTransaction')).toBe(1);
    expect([...fake.sent.values()]).toEqual([lines[0]!.memo]);
    const byKey = new Map(sb.list().map((r) => [r.key, r]));
    expect(byKey.get('kitchen|old-sent')).toMatchObject({ status: 'confirmed', signature: sentSig, slot: 9 });
    expect(byKey.get('kitchen|old-unsent')!.status).toBe('confirmed');
    // the cut line is closed off first, so the lines written after it still read back
    const raw = (await readFile(join(dataDir, 'solana', 'results.jsonl'), 'utf8')).trim().split('\n');
    expect(raw[2]).toBe('{"key":"kitchen|cut sh');
    for (const line of raw.slice(3)) expect(() => JSON.parse(line)).not.toThrow();
    expect(raw.length).toBeGreaterThan(3);
  });

  test('a transaction that failed on chain is marked failed, not retried', async () => {
    const { sb, bus, fake, settle } = await board();
    fake.autoConfirm = false;
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await sb.tick();
    const sig = sb.list()[0]!.signature!;
    fake.statuses.set(sig, { slot: 7, confirmations: null, err: { InstructionError: [0, 'InvalidInstructionData'] }, confirmationStatus: 'confirmed' });
    await settle();
    expect(sb.list()[0]).toMatchObject({ status: 'failed', slot: 7 });
    expect(fake.count('sendTransaction')).toBe(1);
  });

  test('low balance: one airdrop of 1 SOL; a refusing faucet backs off and the match waits in the queue', async () => {
    const fake = new FakeRpc();
    fake.balance = 0;
    fake.next.requestAirdrop = [rpcError(429, "You've either reached your airdrop limit today or the airdrop faucet has run dry.", 429)];
    const { sb, bus, logs, clock, settle } = await board({ fake });
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await settle();
    await sb.tick();
    expect(fake.count('requestAirdrop')).toBe(1);
    expect(fake.count('sendTransaction')).toBe(0);
    expect(sb.list()[0]!.status).toBe('pending');
    expect(logs.join('\n')).toMatch(/faucet said no.*next try in 1 min/);
    // after the wait the faucet is asked again, pays out, and the memo goes out
    clock.ms += 61_000;
    await settle();
    expect(fake.airdrops).toEqual([LAMPORTS_PER_SOL]);
    expect(fake.count('requestAirdrop')).toBe(2);
    clock.ms += 61_000;
    await settle();
    expect(fake.count('sendTransaction')).toBe(1);
    expect(sb.list()[0]!.status).toBe('confirmed');
  });

  test('routes: the latest 50 with explorer links, per world, leaders; bad ids, methods and a disabled board', async () => {
    const { sb, bus, settle } = await board();
    sb.start();
    for (let i = 0; i < 55; i++) {
      bus.emit(i % 5 === 0 ? 'garage' : 'kitchen', result(`m-${i}`, { t: 1_760_000_000 + i, ...(i % 2 ? { winnerName: 'Shivin', winner: 'rbx-456', loserName: 'Seb', loser: 'rbx-123' } : {}) }));
    }
    await settle();
    const { res, body } = await getJson(sb, '/api/scores');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.enabled).toBe(true);
    expect(body.cluster).toBe('devnet');
    expect(body.account).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(body.accountExplorer).toBe(`https://explorer.solana.com/address/${body.account}?cluster=devnet`);
    expect(body.scores).toHaveLength(50);
    const row = body.scores[0];
    expect(Object.keys(row).sort()).toEqual(
      ['draw', 'durationS', 'explorer', 'game', 'loser', 'loserId', 'round', 'scene', 'sceneName', 'score', 'signature', 'status', 'time', 'winner', 'winnerId'].sort(),
    );
    expect(row).toMatchObject({ scene: 'kitchen', sceneName: 'Kitchen', round: 'm-54', game: 'pingpong', winner: 'Seb', loser: 'Shivin', score: '7-4', status: 'confirmed', durationS: 312, time: new Date((1_760_000_000 + 54) * 1000).toISOString() });
    expect(row.explorer).toBe(`https://explorer.solana.com/tx/${row.signature}?cluster=devnet`);
    expect(explorerTxUrl(row.signature)).toBe(row.explorer);
    // newest first
    expect(body.scores.map((r: { round: string }) => r.round).slice(0, 3)).toEqual(['m-54', 'm-53', 'm-52']);
    expect(body.leaders[0]).toEqual({ name: 'Seb', id: 'rbx-123', wins: 28, losses: 27 });
    expect(body.leaders[1]).toEqual({ name: 'Shivin', id: 'rbx-456', wins: 27, losses: 28 });

    const kitchen = await getJson(sb, '/api/scores/kitchen');
    expect(kitchen.body.scene).toBe('kitchen');
    expect(kitchen.body.sceneName).toBe('Kitchen');
    expect(kitchen.body.scores).toHaveLength(44);
    expect(kitchen.body.scores.every((r: { scene: string }) => r.scene === 'kitchen')).toBe(true);
    const nobody = await getJson(sb, '/api/scores/empty-world');
    expect(nobody.body).toMatchObject({ enabled: true, scene: 'empty-world', sceneName: null, scores: [], leaders: [] });
    expect((await getJson(sb, '/api/scores/Bad%20Id!')).res.status).toBe(404);

    const post = await sb.routes['/api/scores']!(new Request('http://127.0.0.1/api/scores', { method: 'POST', body: '{}' }));
    expect(post.status).toBe(405);
    const opt = await sb.routes['/api/scores']!(new Request('http://127.0.0.1/api/scores', { method: 'OPTIONS' }));
    expect(opt.status).toBe(204);
    const head = await sb.routes['/api/scores']!(new Request('http://127.0.0.1/api/scores', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const off = await board({ enabled: false });
    off.sb.start();
    off.bus.emit('kitchen', result('m-1'));
    await off.sb.tick();
    expect(off.bus.size()).toBe(0);
    expect(off.fake.calls).toHaveLength(0);
    expect((await getJson(off.sb, '/api/scores')).body).toEqual({ enabled: false, cluster: 'devnet', account: null, accountExplorer: null, scores: [], leaders: [] });
    expect((await getJson(off.sb, '/api/scores/kitchen')).body).toMatchObject({ enabled: false, scene: 'kitchen', scores: [] });
  });
});

describe('never two memos for one match', () => {
  test('the signature is on disk before the transaction reaches the RPC', async () => {
    const { sb, bus, fake, dataDir, settle } = await board();
    const real = fake.fetch;
    const onDisk: boolean[] = [];
    fake.fetch = async (url, init) => {
      const body = String(init?.body);
      if (body.includes('"sendTransaction"')) {
        const sig = base58Encode(decodeTransaction(Buffer.from(JSON.parse(body).params[0], 'base64')).sigs[0]!);
        onDisk.push(readFileSync(join(dataDir, 'solana', 'results.jsonl'), 'utf8').includes(`"signature":"${sig}"`));
      }
      return real(url, init);
    };
    sb.start();
    bus.emit('kitchen', result('m-1'));
    bus.emit('kitchen', result('m-2'));
    await settle();
    expect(onDisk).toEqual([true, true]);
    expect(sb.list().every((r) => r.status === 'confirmed')).toBe(true);
  });

  test('a gateway error after the send went through: kept under its signature, confirmed, never signed again', async () => {
    const { sb, bus, fake, clock, settle } = await board();
    const real = fake.fetch;
    let lose = 2;
    fake.fetch = async (url, init) => {
      const res = await real(url, init);
      // the cluster took it, the answer was lost on the way back: an HTML 504, then a JSON-RPC internal error
      if (lose > 0 && String(init?.body).includes('"sendTransaction"')) {
        lose--;
        return lose === 1 ? new Response('<html>504 Gateway Time-out</html>', { status: 504 }) : rpcError(-32603, 'Internal error')();
      }
      return res;
    };
    sb.start();
    bus.emit('kitchen', result('m-1'));
    bus.emit('kitchen', result('m-2'));
    await sb.tick();
    expect(sb.list().find((r) => r.round === 'm-1')).toMatchObject({ status: 'pending' });
    expect(sb.list().find((r) => r.round === 'm-1')!.signature).not.toBeNull();
    // past each backoff; the blockhashes stay valid the whole time, so nothing may be signed twice
    for (let i = 0; i < 8; i++) {
      clock.ms += 5000;
      await settle();
    }
    expect(fake.count('sendTransaction')).toBe(2);
    const memos = [...fake.sent.values()];
    expect(memos).toHaveLength(2);
    expect(new Set(memos).size).toBe(2);
    expect(sb.list().every((r) => r.status === 'confirmed')).toBe(true);
  });

  test('unseen when its blockhash runs out, seen on the second look: kept, not signed again', async () => {
    const { sb, bus, fake } = await board();
    fake.autoConfirm = false;
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await sb.tick();
    const sig = sb.list()[0]!.signature!;
    expect(fake.sent.has(sig)).toBe(true);
    expect(sb.list()[0]!.status).toBe('pending');
    // it landed just before its blockhash ran out, but the first status answer comes from a node that has not seen it
    fake.statuses.set(sig, { slot: 43, confirmations: 0, err: null, confirmationStatus: 'confirmed' });
    fake.next.getSignatureStatuses = [() => Response.json({ jsonrpc: '2.0', id: 0, result: { context: { slot: 1 }, value: [null] } })];
    fake.height += 1000;
    await sb.tick();
    expect(sb.list()[0]!.signature).toBe(sig);
    await sb.tick();
    expect(sb.list()[0]).toMatchObject({ status: 'confirmed', signature: sig });
    expect(fake.count('sendTransaction')).toBe(1);
  });

  test('a flood of results is capped while they wait', async () => {
    const fake = new FakeRpc();
    const { sb, bus, logs } = await board({ fake });
    sb.start();
    for (let i = 0; i < 510; i++) bus.emit('kitchen', result(`m-${i}`));
    expect(sb.list()).toHaveLength(500);
    expect(logs.join('\n')).toMatch(/500 matches are still waiting/);
  });
});

describe('the cluster itself', () => {
  test('an RPC whose genesis is not devnet: nothing signed, sent or airdropped, and the board says why', async () => {
    const fake = new FakeRpc();
    fake.genesis = MAINNET_GENESIS_HASH;
    fake.balance = 0;
    const { sb, bus, logs, settle } = await board({ fake });
    sb.start();
    bus.emit('kitchen', result('m-1'));
    await settle();
    expect(fake.count('sendTransaction')).toBe(0);
    expect(fake.count('requestAirdrop')).toBe(0);
    expect(fake.count('getLatestBlockhash')).toBe(0);
    expect(sb.enabled).toBe(false);
    expect(logs.join('\n')).toMatch(/serves another cluster.*stays off/);
    const { body } = await getJson(sb, '/api/scores');
    expect(body).toMatchObject({ enabled: false, scores: [], leaders: [] });
    expect(body.error).toMatch(/devnet only/);
    // later results are not even queued
    bus.emit('kitchen', result('m-2'));
    expect(sb.list().map((r) => r.round)).toEqual(['m-1']);
  });

  test('a local test validator skips the genesis check and links the explorer to it', async () => {
    const fake = new FakeRpc();
    const sb = createScoreboard({ onEvent: makeBus().on, dataDir: await tempDir(), rpcUrl: 'http://127.0.0.1:8899', enabled: true, fetch: fake.fetch, log: () => {} });
    boards.push(sb);
    const bus = makeBus();
    const sb2 = createScoreboard({ onEvent: bus.on, dataDir: await tempDir(), rpcUrl: 'http://127.0.0.1:8899', enabled: true, fetch: fake.fetch, log: () => {}, pollMs: 60_000 });
    boards.push(sb2);
    sb2.start();
    bus.emit('kitchen', result('m-1'));
    for (let i = 0; i < 4; i++) await sb2.tick();
    expect(fake.count('getGenesisHash')).toBe(0);
    expect(sb2.list()[0]!.status).toBe('confirmed');
    const { body } = await getJson(sb2, '/api/scores');
    expect(body.cluster).toBe('localnet');
    expect(body.scores[0].explorer).toContain('?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899');
    expect(sb.enabled).toBe(true);
  });

  test('errors never carry the URL: user info, path and query are all cut to the host', async () => {
    const url = 'https://user:SECRET1@devnet.example-rpc.com/v2/SECRET2?api-key=SECRET3';
    const rpc = new SolanaRpc({
      url,
      fetch: async () => {
        throw new TypeError(`fetch failed for ${url} (also https://user:SECRET1@devnet.example-rpc.com/v2/SECRET2)`);
      },
    });
    const e = (await rpc.getGenesisHash().catch((x) => x)) as RpcError;
    expect(e).toBeInstanceOf(RpcError);
    expect(e.message).toContain('devnet.example-rpc.com');
    expect(e.message).not.toMatch(/SECRET|user/);
    expect(e.refused).toBe(false);
  });
});

describe('draws and bots (contracts 6.5)', () => {
  test('a draw is shown as one and counts for nobody; a bot never leads', async () => {
    const { sb, bus, fake, settle } = await board();
    sb.start();
    bus.emit('kitchen', result('d-1', { game: 'chess', draw: true, score: 'draw' }));
    bus.emit('kitchen', result('b-1', { loser: 'bot', loserName: 'Bot', t: 1_760_000_001 }));
    bus.emit('kitchen', result('b-2', { winner: 'bot', winnerName: 'Bot', loser: 'rbx-456', loserName: 'Shivin', t: 1_760_000_002 }));
    bus.emit('kitchen', result('b-3', { winner: 'bot', winnerName: 'Bot', loser: 'rbx-123', loserName: 'Seb', t: 1_760_000_003 }));
    await settle();
    const draw = sb.list().find((r) => r.round === 'd-1')!;
    expect(JSON.parse(fake.sent.get(draw.signature!)!)).toMatchObject({ draw: true, score: 'draw' });
    const { body } = await getJson(sb, '/api/scores');
    expect(body.scores.find((r: { round: string }) => r.round === 'd-1').draw).toBe(true);
    expect(body.scores.find((r: { round: string }) => r.round === 'b-1').draw).toBe(false);
    expect(body.leaders).toEqual([{ name: 'Seb', id: 'rbx-123', wins: 1, losses: 1 }]);
  });
});
