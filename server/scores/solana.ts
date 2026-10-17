// A small Solana client for the match scoreboard (server/scores/scoreboard.ts), DEVNET ONLY: Ed25519 keys through
// WebCrypto, base58, compact-u16, the legacy transaction format with one Memo program instruction, and JSON-RPC over
// fetch. No SDK: one signed memo per match is all the scoreboard ever sends.
//
// The fee payer is generated on first use and kept in data/solana/devnet-keypair.json (mode 600, the Solana CLI's
// format: 64 numbers, the seed then the public key, so `solana -k` can use it too). Devnet SOL is free and worthless;
// when the balance drops under 0.05 SOL the client asks the faucet for 1 SOL and backs off when it says no (rate
// limits are normal there).
//
// The RPC URL (SOLANA_RPC_URL, default https://api.devnet.solana.com) must name devnet or this machine; anything else
// is refused before a single request goes out. A host name proves nothing about the cluster behind it, so nothing is
// signed or asked of the faucet until the RPC's genesis hash is devnet's (a local test validator is exempt). A URL can
// carry a provider key, so errors and logs only show its host.

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
/** getGenesisHash on devnet; mainnet-beta and testnet answer something else. */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** The base fee of one signature (no priority fee is ever paid). */
export const FEE_LAMPORTS = 5000;
/** Under this the client asks the faucet for more. */
export const MIN_BALANCE_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
export const AIRDROP_LAMPORTS = 1 * LAMPORTS_PER_SOL;
/** Legacy transactions larger than this are refused by the cluster. */
export const MAX_TRANSACTION_BYTES = 1232;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- base58 (the Bitcoin alphabet)

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // base-58 digits, least significant first
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  // bytes, least significant first
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const d = DIGIT.get(text[i]!);
    if (d === undefined) throw new Error(`Not base58: unexpected "${text[i]}" at ${i}.`);
    let carry = d;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** A 32-byte public key (or blockhash) from its base58 text. */
export function decodeKey(text: string, what = 'key'): Uint8Array {
  const b = base58Decode(text);
  if (b.length !== 32) throw new Error(`The ${what} must be 32 bytes, not ${b.length}.`);
  return b;
}

// ---------------------------------------------------------------- compact-u16 ("shortvec": 7 bits per byte, 1 to 3 bytes)

export function encodeCompactU16(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`compact-u16 holds 0..65535, not ${n}.`);
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return Uint8Array.from(out);
    }
    out.push(low | 0x80);
  }
}

export function decodeCompactU16(bytes: Uint8Array, offset = 0): { value: number; size: number } {
  let value = 0;
  for (let size = 0; size < 3; size++) {
    const b = bytes[offset + size];
    if (b === undefined) throw new RangeError('compact-u16 runs past the end.');
    value |= (b & 0x7f) << (size * 7);
    if ((b & 0x80) === 0) {
      if (value > 0xffff) throw new RangeError('compact-u16 above 65535.');
      return { value, size: size + 1 };
    }
  }
  throw new RangeError('compact-u16 longer than 3 bytes.');
}

// ---------------------------------------------------------------- keys

export interface Keypair {
  readonly address: string;
  readonly publicKey: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** The DER header of an Ed25519 PKCS#8 private key; the 32-byte seed follows it. */
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const ED25519 = { name: 'Ed25519' } as const;

/**
 * A signing keypair from a Solana secret key: 64 bytes (seed, then public key; the public half must match the seed)
 * or the 32-byte seed alone. The private key lives in a non-extractable CryptoKey; nothing secret is kept around.
 */
export async function keypairFromSecret(secret: Uint8Array): Promise<Keypair> {
  if (secret.length !== 64 && secret.length !== 32) throw new Error(`A Solana secret key is 64 bytes, not ${secret.length}.`);
  const pkcs8 = concat([PKCS8_ED25519, secret.subarray(0, 32)]);
  const probe = await crypto.subtle.importKey('pkcs8', pkcs8, ED25519, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', probe);
  const publicKey = new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url'));
  if (publicKey.length !== 32) throw new Error('Could not derive the public key.');
  if (secret.length === 64 && !sameBytes(publicKey, secret.subarray(32))) throw new Error('The keypair does not match its own public key.');
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, ED25519, false, ['sign']);
  pkcs8.fill(0);
  const address = base58Encode(publicKey);
  return {
    address,
    publicKey,
    sign: async (data) => new Uint8Array(await crypto.subtle.sign(ED25519, key, data as Uint8Array<ArrayBuffer>)),
    // a keypair that ends up in a log line or a JSON body shows its address and nothing else
    toJSON: () => ({ address }),
  } as Keypair;
}

/** A fresh secret key in the 64-byte Solana layout. */
export async function generateSecret(): Promise<Uint8Array> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = concat([pkcs8.subarray(PKCS8_ED25519.length), pub]);
  pkcs8.fill(0);
  return secret;
}

function parseSecretFile(text: string, file: string): Uint8Array {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not a keypair file (not JSON).`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${file} is not a keypair file (expected 64 numbers).`);
  }
  return Uint8Array.from(raw as number[]);
}

/**
 * The keypair in `file`, made (and saved with mode 600) when there is none. A file that exists but does not parse is
 * an error, never overwritten: it may hold the account people already funded.
 */
export async function loadOrCreateKeypair(file: string): Promise<Keypair> {
  try {
    const text = await readFile(file, 'utf8');
    if (((await stat(file)).mode & 0o077) !== 0) await chmod(file, 0o600).catch(() => {});
    return await keypairFromSecret(parseSecretFile(text, file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const secret = await generateSecret();
  try {
    // wx: two servers starting at once never write two different keys
    await writeFile(file, JSON.stringify([...secret]) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    secret.fill(0);
    return loadOrCreateKeypair(file);
  }
  const kp = await keypairFromSecret(secret);
  secret.fill(0);
  return kp;
}

// ---------------------------------------------------------------- legacy transactions

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

export interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

export interface CompiledMessage {
  /** numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts. */
  header: [number, number, number];
  accountKeys: string[];
  recentBlockhash: string;
  instructions: CompiledInstruction[];
}

/** One Memo program instruction: `text` as UTF-8, with each signer listed (the program checks they signed). */
export function memoInstruction(text: string, signers: string[] = []): Instruction {
  return {
    programId: MEMO_PROGRAM_ID,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: new TextEncoder().encode(text),
  };
}

/**
 * The account table and compiled instructions of a legacy message. Each account appears once with its flags merged
 * (signer if any use signs, writable if any use writes); the fee payer comes first; then the four groups the runtime
 * reads from the header: writable signers, read-only signers, writable non-signers, read-only non-signers (program
 * ids end up here). Within a group, accounts keep the order they first appeared in.
 */
export function compileMessage(payer: string, instructions: Instruction[], recentBlockhash: string): CompiledMessage {
  decodeKey(payer, 'fee payer');
  decodeKey(recentBlockhash, 'blockhash');
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const use = (key: string, signer: boolean, writable: boolean) => {
    const m = metas.get(key);
    if (m) {
      m.signer ||= signer;
      m.writable ||= writable;
    } else {
      decodeKey(key, 'account');
      metas.set(key, { signer, writable });
    }
  };
  use(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) use(k.pubkey, k.isSigner, k.isWritable);
    use(ix.programId, false, false);
  }
  const all = [...metas];
  const group = (signer: boolean, writable: boolean) => all.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const accountKeys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  if (accountKeys.length > 64) throw new Error('A legacy transaction locks at most 64 accounts.');
  const index = new Map(accountKeys.map((k, i) => [k, i]));
  const signed = all.filter(([, m]) => m.signer).length;
  return {
    header: [signed, group(true, false).length, group(false, false).length],
    accountKeys,
    recentBlockhash,
    instructions: instructions.map((ix) => ({
      programIdIndex: index.get(ix.programId)!,
      accounts: ix.keys.map((k) => index.get(k.pubkey)!),
      data: ix.data,
    })),
  };
}

/** The exact bytes every signer signs. */
export function serializeMessage(m: CompiledMessage): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(m.header), encodeCompactU16(m.accountKeys.length)];
  for (const k of m.accountKeys) parts.push(decodeKey(k, 'account'));
  parts.push(decodeKey(m.recentBlockhash, 'blockhash'), encodeCompactU16(m.instructions.length));
  for (const ix of m.instructions) {
    parts.push(Uint8Array.of(ix.programIdIndex), encodeCompactU16(ix.accounts.length), Uint8Array.from(ix.accounts));
    parts.push(encodeCompactU16(ix.data.length), ix.data);
  }
  return concat(parts);
}

export interface SignedTransaction {
  message: Uint8Array;
  /** Wire bytes: compact-u16 signature count, the 64-byte signatures in account order, the message. */
  transaction: Uint8Array;
  /** The first signature in base58: the transaction's id on the explorer. */
  signature: string;
}

/** Signs a compiled message with every required signer (in account-key order) and lays out the transaction. */
export async function signTransaction(m: CompiledMessage, signers: Keypair[]): Promise<SignedTransaction> {
  const message = serializeMessage(m);
  const sigs: Uint8Array[] = [];
  for (const key of m.accountKeys.slice(0, m.header[0])) {
    const kp = signers.find((s) => s.address === key);
    if (!kp) throw new Error(`No keypair for the signer ${key}.`);
    sigs.push(await kp.sign(message));
  }
  const transaction = concat([encodeCompactU16(sigs.length), ...sigs, message]);
  if (transaction.length > MAX_TRANSACTION_BYTES) throw new Error(`The transaction is ${transaction.length} bytes; the cluster takes ${MAX_TRANSACTION_BYTES}.`);
  return { message, transaction, signature: base58Encode(sigs[0]!) };
}

/** A transaction with one memo, paid and signed by `payer`. */
export function buildMemoTransaction(payer: Keypair, memo: string, recentBlockhash: string): Promise<SignedTransaction> {
  return signTransaction(compileMessage(payer.address, [memoInstruction(memo, [payer.address])], recentBlockhash), [payer]);
}

// ---------------------------------------------------------------- the devnet guard

export class DevnetOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevnetOnlyError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The RPC URL to use: `raw` (SOLANA_RPC_URL) or the public devnet endpoint. Throws DevnetOnlyError unless its host
 * names devnet or is this machine (a local test validator). Mainnet is never an option.
 */
export function devnetRpcUrl(raw?: string | null): string {
  const text = raw?.trim() || DEFAULT_RPC_URL;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new DevnetOnlyError('SOLANA_RPC_URL is not a URL.');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DevnetOnlyError('SOLANA_RPC_URL must be an http(s) URL.');
  if (LOCAL_HOSTS.has(host)) return text;
  if (!host.includes('devnet') || host.includes('mainnet')) {
    throw new DevnetOnlyError(`Refusing the Solana RPC at ${host}: the scoreboard runs on devnet only.`);
  }
  return text;
}

/** The host of an RPC URL, for logs (the path and query may hold a provider key). */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the RPC';
  }
}

export function isLocalRpc(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function explorerQuery(rpcUrl?: string): string {
  if (rpcUrl && isLocalRpc(rpcUrl)) return `?cluster=custom&customUrl=${encodeURIComponent(new URL(rpcUrl).origin)}`;
  return '?cluster=devnet';
}

export function explorerTxUrl(signature: string, rpcUrl?: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerQuery(rpcUrl)}`;
}

export function explorerAddressUrl(address: string, rpcUrl?: string): string {
  return `https://explorer.solana.com/address/${address}${explorerQuery(rpcUrl)}`;
}

// ---------------------------------------------------------------- JSON-RPC

/**
 * JSON-RPC codes a node answers with before it acts on a request: malformed, preflight failed (-32002), signature
 * check (-32003), node behind (-32005), signature count (-32013), version (-32015), min context slot (-32016), rate
 * limited (429). Anything else (-32603, a gateway's 5xx) may come after the transaction was already forwarded.
 */
const REFUSAL_CODES: ReadonlySet<number> = new Set([-32600, -32601, -32602, -32002, -32003, -32005, -32013, -32015, -32016, 429]);

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    /** HTTP status when the RPC answered; undefined when it could not be reached (or timed out). */
    readonly status?: number,
    /** The JSON-RPC error code (-32002: the preflight simulation failed). */
    readonly code?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  get rateLimited(): boolean {
    return this.status === 429 || this.code === 429 || /too many requests|rate limit|airdrop limit|run dry/i.test(this.message);
  }

  /**
   * The RPC turned the request down before acting on it, so a transaction in it never went out and signing it again
   * cannot make a second copy. False when there was no answer, a gateway error or an internal error: it may have gone.
   */
  get refused(): boolean {
    if (this.status === undefined) return false;
    if (this.status >= 400 && this.status < 500) return true;
    return this.code !== undefined && REFUSAL_CODES.has(this.code);
  }
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface RpcOptions {
  url?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SolanaRpc {
  readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private id = 0;

  constructor(o: RpcOptions = {}) {
    this.url = devnetRpcUrl(o.url);
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  /** One JSON-RPC call. Throws RpcError (never with the URL in its message). */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const host = rpcHost(this.url);
    // any URL in an error keeps its host only: the user info, path or query may hold a provider key
    const scrub = (s: string) => s.replace(/\bhttps?:\/\/(?:[^/\s@]*@)?([^/\s)'"?#@]+)[^\s)'"]*/gi, '$1').split(this.url).join(host);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RpcError(`${method}: could not reach ${host} (${scrub((e as Error).message || String(e))})`, method);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    type Body = { result?: T; error?: { code?: number; message?: string } } | null;
    let body: Body = null;
    try {
      body = (await res.json()) as Body;
    } catch {
      body = null;
    }
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message.slice(0, 300) : 'error';
      throw new RpcError(`${method}: ${scrub(msg)}`, method, res.status, body.error.code, retryAfterMs);
    }
    if (!res.ok || !body || !('result' in body)) {
      throw new RpcError(`${method}: ${host} answered HTTP ${res.status}`, method, res.status, undefined, retryAfterMs);
    }
    return body.result as T;
  }

  getGenesisHash(): Promise<string> {
    return this.call<string>('getGenesisHash', []);
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value;
  }

  /** Finalized height: once it passes a blockhash's lastValidBlockHeight, a transaction on that blockhash can never land. */
  getBlockHeight(): Promise<number> {
    return this.call<number>('getBlockHeight', [{ commitment: 'finalized' }]);
  }

  async getBalance(address: string): Promise<number> {
    return (await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value;
  }

  requestAirdrop(address: string, lamports: number): Promise<string> {
    return this.call<string>('requestAirdrop', [address, lamports]);
  }

  /** Sends wire bytes (base64) with the preflight simulation on; resolves with the signature. */
  sendTransaction(transaction: Uint8Array): Promise<string> {
    return this.call<string>('sendTransaction', [
      Buffer.from(transaction).toString('base64'),
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]);
  }

  /** Statuses in the order asked (null: not seen); up to 256 per call, more are split. */
  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    const out: (SignatureStatus | null)[] = [];
    for (let i = 0; i < signatures.length; i += 256) {
      const r = await this.call<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [signatures.slice(i, i + 256), { searchTransactionHistory: true }]);
      out.push(...r.value);
    }
    return out;
  }
}

// ---------------------------------------------------------------- the fee payer's client

export interface SolanaClientOptions {
  rpcUrl?: string | null;
  /** data/solana/devnet-keypair.json */
  keypairFile: string;
  fetch?: FetchLike;
  log?: (msg: string) => void;
  now?: () => number;
  minLamports?: number;
  airdropLamports?: number;
}

export interface Funding {
  /** Enough for a few more memos (the faucet may still be asked for more). */
  ok: boolean;
  lamports: number | null;
  /** Not ok: when it is worth looking again. */
  retryInMs?: number;
}

export interface SignedMemo {
  signature: string;
  transaction: Uint8Array;
  lastValidBlockHeight: number;
}

const BALANCE_TTL_MS = 60_000;
const AIRDROP_WAIT_MIN_MS = 60_000;
const AIRDROP_WAIT_MAX_MS = 30 * 60_000;

/** The scoreboard's account on devnet: its keypair (lazy), balance and faucet top-ups, and memo transactions. */
export class SolanaClient {
  readonly rpc: SolanaRpc;
  private readonly o: SolanaClientOptions;
  private readonly now: () => number;
  private kp: Promise<Keypair> | null = null;
  private addr: string | null = null;
  private lamports: number | null = null;
  private checkedAt = -Infinity;
  /** No faucet request before this (ms), and how long the next refusal waits. */
  private airdropAt = 0;
  private airdropWait = AIRDROP_WAIT_MIN_MS;
  /** One balance check at a time: two callers never ask the faucet twice. */
  private funding: Promise<Funding> | null = null;
  /** The genesis check, once per client (asked again only after a network failure). */
  private devnet: Promise<void> | null = null;

  constructor(o: SolanaClientOptions) {
    this.o = o;
    this.rpc = new SolanaRpc({ url: o.rpcUrl, fetch: o.fetch });
    this.now = o.now ?? Date.now;
  }

  get rpcUrl(): string {
    return this.rpc.url;
  }

  /** The fee payer's address once the keypair is loaded. */
  get address(): string | null {
    return this.addr;
  }

  get balance(): number | null {
    return this.lamports;
  }

  keypair(): Promise<Keypair> {
    this.kp ??= loadOrCreateKeypair(this.o.keypairFile).then(
      (k) => {
        this.addr = k.address;
        return k;
      },
      (e) => {
        this.kp = null;
        throw e;
      },
    );
    return this.kp;
  }

  /**
   * Resolves once the RPC has shown it serves devnet (its genesis hash), at once for a local test validator. Throws
   * DevnetOnlyError for any other cluster (for good: the same client never asks again) and RpcError when it cannot
   * be reached (asked again next time).
   */
  ensureDevnet(): Promise<void> {
    if (isLocalRpc(this.rpc.url)) return Promise.resolve();
    this.devnet ??= this.rpc.getGenesisHash().then(
      (hash) => {
        if (hash !== DEVNET_GENESIS_HASH) {
          throw new DevnetOnlyError(`Refusing the Solana RPC at ${rpcHost(this.rpc.url)}: it serves another cluster, not devnet.`);
        }
      },
      (e) => {
        this.devnet = null;
        throw e;
      },
    );
    return this.devnet;
  }

  /**
   * Checks the balance (cached for a minute) and asks the faucet for AIRDROP_LAMPORTS when it is under the minimum.
   * A refused airdrop never throws: the next request waits 1, 2, 4 ... up to 30 minutes. Throws only when the balance
   * cannot be read at all (RpcError).
   */
  ensureFunded(): Promise<Funding> {
    this.funding ??= this.checkFunds().finally(() => (this.funding = null));
    return this.funding;
  }

  private async checkFunds(): Promise<Funding> {
    await this.ensureDevnet();
    const kp = await this.keypair();
    const now = this.now();
    if (this.lamports === null || now - this.checkedAt >= BALANCE_TTL_MS) {
      this.lamports = await this.rpc.getBalance(kp.address);
      this.checkedAt = now;
    }
    const min = this.o.minLamports ?? MIN_BALANCE_LAMPORTS;
    if (this.lamports >= min) return { ok: true, lamports: this.lamports };
    if (now >= this.airdropAt) {
      const amount = this.o.airdropLamports ?? AIRDROP_LAMPORTS;
      try {
        await this.rpc.requestAirdrop(kp.address, amount);
        this.airdropWait = AIRDROP_WAIT_MIN_MS;
        this.airdropAt = now + 30_000;
        // look again in a few seconds: the airdrop lands about as fast as a memo
        this.checkedAt = now - BALANCE_TTL_MS + 3000;
        this.log(`[scores] asked the devnet faucet for ${amount / LAMPORTS_PER_SOL} SOL for ${kp.address}`);
      } catch (e) {
        const wait = Math.max(this.airdropWait, e instanceof RpcError ? e.retryAfterMs ?? 0 : 0);
        this.airdropAt = now + wait;
        this.airdropWait = Math.min(this.airdropWait * 2, AIRDROP_WAIT_MAX_MS);
        this.log(
          `[scores] the devnet faucet said no (${(e as Error).message}); next try in ${Math.round(wait / 60_000)} min. ` +
            `Send devnet SOL to ${kp.address} (https://faucet.solana.com) to skip the wait.`,
        );
      }
    }
    if (this.lamports >= FEE_LAMPORTS * 2) return { ok: true, lamports: this.lamports };
    const recheck = this.checkedAt + BALANCE_TTL_MS - now;
    return { ok: false, lamports: this.lamports, retryInMs: Math.max(3000, Math.min(recheck, this.airdropAt - now)) };
  }

  /** The balance moved (a fee paid, or the cluster said it is short): adjust or read it again next time. */
  spent(lamports: number): void {
    if (this.lamports !== null) this.lamports -= lamports;
  }

  forgetBalance(): void {
    this.checkedAt = -Infinity;
  }

  /** A memo transaction signed on a fresh blockhash. Nothing is sent yet: the signature is known before it goes out. */
  async signMemo(memo: string): Promise<SignedMemo> {
    await this.ensureDevnet();
    const kp = await this.keypair();
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash();
    const signed = await buildMemoTransaction(kp, memo, blockhash);
    return { signature: signed.signature, transaction: signed.transaction, lastValidBlockHeight };
  }

  async send(transaction: Uint8Array): Promise<string> {
    await this.ensureDevnet();
    return this.rpc.sendTransaction(transaction);
  }

  statuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    return this.rpc.getSignatureStatuses(signatures);
  }

  blockHeight(): Promise<number> {
    return this.rpc.getBlockHeight();
  }

  private log(msg: string): void {
    (this.o.log ?? console.log)(msg);
  }
}
