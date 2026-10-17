// The public https link (team/contracts.md 2.1): a Cloudflare tunnel from cloudflared to the local server.
//
//   bun scripts/tunnel.ts                                              a quick tunnel (new address every run)
//   TUNNEL_TOKEN_FILE=~/.dejaview-tunnel-token TUNNEL_HOSTNAME=<domain> bun scripts/tunnel.ts
//                                                                      the domain's tunnel (team/seb.md: made in the
//                                                                      Zero Trust dashboard, public hostname -> HTTP
//                                                                      localhost:8788), with the token Seb sends
//
// Quick tunnel: starts `cloudflared tunnel --url <local server>`, reads the https://<random>.trycloudflare.com address
// it prints. Token: starts `cloudflared tunnel run` with the token in cloudflared's own TUNNEL_TOKEN variable (never
// on the command line, where `ps` would show it); the dashboard routes the hostname. Either way the address is
// written to data/public-url.txt (the /host page reads it), printed big, and checked. If cloudflared exits, it is
// started again with backoff (a quick tunnel gets a NEW address every run: post the new one in the team chat). A
// watchdog restarts it when the public link has stopped answering for about 2 minutes while the local server is fine.
//
// Environment (all optional):
//   HTTP_PORT              local plain-HTTP port to expose (default 8788)
//   PORT                   the main server port, tried when nothing answers on HTTP_PORT (default 8787, http then https)
//   TUNNEL_TARGET          the exact origin to expose, e.g. http://localhost:8788 (skips the port guessing)
//   TUNNEL_TOKEN           the token of a tunnel made in the Cloudflare dashboard (remotely managed)...
//   TUNNEL_TOKEN_FILE      ...or a file holding it (better: it stays out of the shell history)
//   TUNNEL_NAME            a named tunnel made locally (`cloudflared tunnel login` + `tunnel create`)...
//   TUNNEL_HOSTNAME        ...the hostname routed to the token's or the named tunnel, e.g. dejaview.example.com
//   TUNNEL_URL_FILE        where the address is written (default <data dir>/public-url.txt; THIRDWHEEL_DATA moves it)
//   CLOUDFLARED_BIN        path to cloudflared (default: found on PATH)
//   TUNNEL_PROBE=0         do not check the public link after it starts
//   TUNNEL_WATCHDOG=0      never restart a running tunnel because the link stopped answering
//   TUNNEL_MIN_RESTART_MS  first restart delay (default 1000; doubles up to 30 s)

import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { integrationsConfigFromEnv, normalizeBaseUrl, type Env } from '../server/integrations/config.ts';

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
}

const QUICK_URL = /https:\/\/([a-z0-9][a-z0-9-]*[a-z0-9])\.trycloudflare\.com\b/gi;

/** The quick-tunnel address in one line of cloudflared output, or null. Ignores the service's own api host. */
export function parseTunnelUrl(line: string): string | null {
  for (const m of line.matchAll(QUICK_URL)) {
    const sub = m[1]!.toLowerCase();
    if (sub === 'api' || sub === 'www') continue;
    return `https://${sub}.trycloudflare.com`;
  }
  return null;
}

export interface TunnelOptions {
  bin: string | null;
  target: string | null;
  urlFile: string;
  name: string | null;
  /** A dashboard tunnel's token (TUNNEL_TOKEN, or the contents of TUNNEL_TOKEN_FILE). */
  token: string | null;
  /** Why TUNNEL_TOKEN_FILE could not be read, when it was set. */
  tokenError?: string;
  hostname: string | null;
  probe: boolean;
  watchdog: boolean;
  minRestartMs: number;
  maxRestartMs: number;
}

export function tunnelOptionsFromEnv(env: Env = process.env): TunnelOptions {
  const raw = (env.CLOUDFLARED_BIN ?? '').trim();
  const bin = raw ? (raw.includes('/') ? raw : Bun.which(raw, { PATH: env.PATH ?? '' })) : Bun.which('cloudflared', { PATH: env.PATH ?? '' });
  const hostname = (env.TUNNEL_HOSTNAME ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  let token = (env.TUNNEL_TOKEN ?? '').trim() || null;
  let tokenError: string | undefined;
  const tokenFile = (env.TUNNEL_TOKEN_FILE ?? '').trim();
  if (!token && tokenFile) {
    try {
      token = readFileSync(expandHome(tokenFile), 'utf8').trim() || null;
      if (!token) tokenError = `${tokenFile} is empty`;
    } catch (e) {
      tokenError = `could not read ${tokenFile} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
    }
  }
  return {
    bin: bin || null,
    target: normalizeBaseUrl(env.TUNNEL_TARGET),
    urlFile: integrationsConfigFromEnv(env).publicUrlFile,
    name: (env.TUNNEL_NAME ?? '').trim() || null,
    token,
    ...(tokenError ? { tokenError } : {}),
    hostname,
    probe: env.TUNNEL_PROBE !== '0',
    watchdog: env.TUNNEL_WATCHDOG !== '0',
    minRestartMs: Math.max(100, Number(env.TUNNEL_MIN_RESTART_MS) || 1000),
    maxRestartMs: 30_000,
  };
}

/**
 * cloudflared arguments for a quick tunnel (or a named one) to `target`. With `token` the tunnel is remotely managed:
 * the dashboard holds its ingress (the hostname -> HTTP localhost:8788), so only `tunnel run` is needed, and the token
 * itself goes in the TUNNEL_TOKEN environment variable (see tunnelEnv), not in these arguments.
 */
export function cloudflaredArgs(target: string, name: string | null, token = false): string[] {
  if (token) return ['tunnel', '--no-autoupdate', 'run'];
  const tls = target.startsWith('https:') ? ['--no-tls-verify'] : [];
  return name ? ['tunnel', '--no-autoupdate', ...tls, 'run', '--url', target, name] : ['tunnel', '--no-autoupdate', ...tls, '--url', target];
}

/** The environment cloudflared runs with: the token (when there is one) in its own TUNNEL_TOKEN variable. */
export function tunnelEnv(base: Env, token: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && k !== 'TUNNEL_TOKEN' && k !== 'TUNNEL_TOKEN_FILE') out[k] = v;
  if (token) out.TUNNEL_TOKEN = token;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const tty = process.stdout.isTTY;
const LIME = (s: string) => (tty ? `\x1b[1;38;2;198;255;61m${s}\x1b[0m` : s);
const BOLD = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const DIM = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = '') => console.log(s);
const stamp = () => new Date().toTimeString().slice(0, 8);
const note = (s: string) => console.log(`${DIM(stamp())}  ${s}`);

function banner(url: string, file: string) {
  const lines = ['DÉJÀ VIEW IS PUBLIC', '', url, '', `walk in   ${url}/view?scene=<id>`];
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  const rel = relative(process.cwd(), file);
  const shown = rel && !rel.startsWith('..') ? rel : file;
  const bar = '━'.repeat(w);
  say();
  say(LIME(`  ┏${bar}┓`));
  for (const [i, l] of lines.entries()) {
    const text = i === 0 || i === 2 ? LIME(l) : l;
    say(`${LIME('  ┃')}  ${text}${' '.repeat(w - l.length - 2)}${LIME('┃')}`);
  }
  say(LIME(`  ┗${bar}┛`));
  say(`  Saved to ${shown}`);
  say(`  Post this link in the team chat (it is not a secret); every piece that uses the public BASE`);
  say(`  updates its setting at runtime, no redeploy. Browser pages on it that change things need:`);
  say(`  ${BOLD(`THIRDWHEEL_ALLOWED_ORIGINS=${url}`)} on the server.`);
  say();
}

async function answers(base: string, timeoutMs = 1500): Promise<{ ok: boolean; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      // the main server's certificate is self-signed
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    await res.arrayBuffer().catch(() => {});
    return { ok: res.ok, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
}

async function pickTarget(env: Env, explicit: string | null): Promise<{ target: string; answered: boolean }> {
  if (explicit) return { target: explicit, answered: (await answers(explicit)).ok };
  const http = Number(env.HTTP_PORT || 8788);
  const main = Number(env.PORT || 8787);
  const candidates = [`http://localhost:${http}`, `http://localhost:${main}`, `https://localhost:${main}`];
  for (const c of [...new Set(candidates)]) if ((await answers(c)).ok) return { target: c, answered: true };
  return { target: candidates[0]!, answered: false };
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  let buf = '';
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

export async function runTunnel(env: Env = process.env): Promise<number> {
  const o = tunnelOptionsFromEnv(env);
  if (!o.bin || !existsSync(o.bin)) {
    console.error('cloudflared is not installed. Install it with:\n\n  brew install cloudflared\n\nthen run this again.');
    return 1;
  }
  if (o.tokenError) {
    console.error(`TUNNEL_TOKEN_FILE: ${o.tokenError}.`);
    return 1;
  }
  if ((o.name || o.token) && !o.hostname) {
    console.error(`${o.token ? 'A tunnel token' : 'TUNNEL_NAME'} is set but TUNNEL_HOSTNAME is not: give the public hostname routed to that tunnel (e.g. dejaview.example.com).`);
    return 1;
  }
  const fixed = !!(o.token || o.name);

  const { target, answered } = await pickTarget(env, o.target);
  if (o.token) {
    // the dashboard decides where the hostname goes (team/seb.md: service HTTP, URL localhost:8788); this only checks it
    note(`running the domain's tunnel for ${BOLD(`https://${o.hostname}`)} (its dashboard route: HTTP localhost:8788)`);
    if (!target.endsWith(':8788') && !o.target) note('nothing answers on :8788 yet: the dashboard route needs the server\'s plain-HTTP listener (bun run https starts it)');
  } else {
    note(`exposing ${BOLD(target)}${o.name ? ` through the named tunnel ${o.name}` : ' through a quick tunnel'}`);
  }
  if (!answered) note(`nothing answers on ${target} yet; start the server (the link works as soon as it is up)`);

  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let current: string | null = null;
  let generation = 0;
  let backoff = o.minRestartMs;

  const clearFile = (url: string | null) => {
    try {
      if (url && existsSync(o.urlFile) && readFileSync(o.urlFile, 'utf8').trim() === url) unlinkSync(o.urlFile);
    } catch {
      /* already gone */
    }
  };

  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    note('closing the public link');
    try {
      child?.kill('SIGTERM');
    } catch {
      /* gone */
    }
    clearFile(current);
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* gone */
    }
    clearFile(current);
  });

  async function publish(url: string, gen: number) {
    current = url;
    await mkdir(dirname(o.urlFile), { recursive: true });
    await writeFile(o.urlFile, `${url}\n`);
    banner(url, o.urlFile);
    if (o.probe) void probe(url, gen);
  }

  async function probe(url: string, gen: number) {
    const deadline = Date.now() + 90_000;
    while (!stopping && gen === generation && Date.now() < deadline) {
      const r = await answers(url, 5000);
      if (r.ok) {
        note(`${LIME('LIVE')}  the public link answers (${r.ms} ms)`);
        if (o.watchdog) void watch(url, gen);
        return;
      }
      await Bun.sleep(2000);
    }
    if (!stopping && gen === generation) note('the public link does not answer yet; check that the server is running on the target port');
  }

  async function watch(url: string, gen: number) {
    let misses = 0;
    while (!stopping && gen === generation) {
      await Bun.sleep(30_000);
      if (stopping || gen !== generation) return;
      if ((await answers(url, 8000)).ok) {
        misses = 0;
        continue;
      }
      if (!(await answers(target)).ok) continue; // the server itself is down: a new tunnel would not help
      if (++misses >= 4) {
        note('the public link stopped answering for about 2 minutes; restarting the tunnel (the address will change)');
        try {
          child?.kill('SIGTERM');
        } catch {
          /* gone */
        }
        return;
      }
    }
  }

  while (!stopping) {
    const gen = ++generation;
    const startedAt = Date.now();
    const errors: string[] = [];
    let connected = false;
    child = Bun.spawn([o.bin, ...cloudflaredArgs(target, o.name, !!o.token)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: tunnelEnv(env, o.token),
    });
    if (fixed && o.hostname) await publish(`https://${o.hostname}`, gen);
    const read = async (s: ReadableStream<Uint8Array>) => {
      for await (const line of lines(s)) {
        if (!fixed) {
          const url = parseTunnelUrl(line);
          if (url && url !== current) await publish(url, gen);
        }
        if (!connected && /Registered tunnel connection/i.test(line)) {
          connected = true;
          note('tunnel connected');
        }
        if (/\b(ERR|error|failed)\b/i.test(line)) {
          errors.push(line.replace(/^\S+\s+ERR\s+/, '').trim());
          if (errors.length > 4) errors.shift();
        }
      }
    };
    await Promise.all([read(child.stdout as ReadableStream<Uint8Array>), read(child.stderr as ReadableStream<Uint8Array>), child.exited]);
    const code = child.exitCode;
    if (stopping) break;
    if (Date.now() - startedAt > 60_000) backoff = o.minRestartMs;
    note(`the tunnel stopped (exit code ${code ?? 'signal'}); restarting in ${(backoff / 1000).toFixed(1)} s`);
    for (const e of errors) note(DIM(`  ${e.slice(0, 200)}`));
    clearFile(current);
    current = null;
    await Bun.sleep(backoff);
    backoff = Math.min(o.maxRestartMs, backoff * 2);
  }
  return 0;
}

if (import.meta.main) {
  const code = await runTunnel();
  if (code !== 0) process.exit(code);
}
