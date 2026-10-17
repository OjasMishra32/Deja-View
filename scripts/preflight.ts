// Before the full run (team/contracts.md 13.4): one command that says whether everything is ready, and what to do if not.
//
//   bun scripts/preflight.ts [BASE]        default localhost:8787 (PORT), over http and then https
//
// Asks the server for GET /api/host/status (server/host.ts: GPU worker, guide, DeepSpace, public link, people), then
// checks this Mac itself:
//   - the HiPerGator SSH session: `ssh -O check` on the control socket. It asks the local master only; nothing runs
//     on the cluster
//   - cloudflared on PATH, for the public link
//   - the demo worlds: DEMO_SCENES=id,id,id must exist and be ready (unset: the ready worlds are listed)
//   - free disk in the data folder
// Prints a checklist with ✓ / ✗ and the fix for each ✗. Exits 1 when a blocker fails.
//
// Environment (all optional): DEMO_SCENES; DV_KEY (sent as x-dejaview-key, for a BASE on another machine);
// HPG_SOCKET, HPG_USER, HPG_HOST, HPG_SSH_BIN (as for the server); CLOUDFLARED_BIN; THIRDWHEEL_DATA.

import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Scene } from '../shared/types.ts';
import type { HostCheck, HostStatus } from '../server/host.ts';
import { hpgConfig, remoteTarget, type HpgConfig } from '../server/hpg.ts';
import { callJson, dataDir, normalizeBaseUrl, type Env, type FetchLike } from '../server/integrations/config.ts';
import { exec } from '../server/media.ts';
import { tunnelOptionsFromEnv } from './tunnel.ts';

export const DEFAULT_BASE = 'http://localhost:8787';
/** Below this the demo stops: uploads and jobs fail. */
export const DISK_BLOCKER_BYTES = 2 * 1024 ** 3;
/** Below this it still works, but one more video job may not fit. */
export const DISK_WARN_BYTES = 10 * 1024 ** 3;

export interface CheckItem {
  name: string;
  ok: boolean;
  /** A failing blocker makes the preflight exit 1. */
  blocker: boolean;
  detail: string;
  fix?: string;
  command?: string;
  where?: string;
}

export type StatusResult = { ok: true; value: HostStatus } | { ok: false; httpStatus: number; error: string };

export interface PreflightInput {
  base: string;
  status: StatusResult;
  /** GET /api/scenes, or null when it could not be read. */
  scenes: Scene[] | null;
  /** From DEMO_SCENES, in demo order. */
  demoScenes: string[];
  /** `ssh -O check` on the control socket. */
  hpgSession: { ok: boolean; detail: string };
  /** How to open the session again (shown when it is down). */
  hpgLogin: string;
  /** Path of cloudflared, or null when it is not installed. */
  cloudflared: string | null;
  freeBytes: number | null;
  dataDir: string;
}

const SERVER_FIRST = 'Fix the server first.';

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A row from one of the server's own checks. */
function fromCheck(name: string, c: HostCheck, ok: boolean, blocker: boolean): CheckItem {
  return {
    name,
    ok,
    blocker,
    detail: [c.text, c.detail].filter(Boolean).join(' · '),
    ...(ok ? {} : { fix: c.fix, command: c.command, where: c.where }),
  };
}

/** The checklist, in the order the host fixes things. Pure: everything it needs is in `input`. */
export function buildChecklist(input: PreflightInput): CheckItem[] {
  const items: CheckItem[] = [];
  const st = input.status.ok ? input.status.value : null;
  const down = (name: string, blocker = true): CheckItem => ({ name, ok: false, blocker, detail: 'the server did not answer', fix: SERVER_FIRST });

  if (input.status.ok) {
    items.push({ name: 'Server', ok: true, blocker: true, detail: `answers at ${input.base}${st!.version ? ` (${st!.version})` : ''}${st!.readOnly ? ', read-only copy' : ''}` });
  } else {
    const s = input.status;
    const fix =
      s.httpStatus === 401
        ? 'Set DV_KEY in this shell: the server wants the key from this address.'
        : s.httpStatus === 403
          ? 'Run the preflight from this Mac, or pass the server address it listens on.'
          : s.httpStatus === 404
            ? 'This server has no host status yet: restart it with the latest code.'
            : 'Start the server: bun run https (the Quest needs HTTPS), then run this again.';
    items.push({ name: 'Server', ok: false, blocker: true, detail: `${input.base}: ${s.error}`, fix });
  }

  if (st) {
    const c = st.checks;
    items.push(fromCheck('GPU worker', c.gpu, c.gpu.state === 'ok', true));
  } else items.push(down('GPU worker'));

  items.push(
    input.hpgSession.ok
      ? { name: 'HiPerGator session', ok: true, blocker: true, detail: input.hpgSession.detail }
      : {
          name: 'HiPerGator session',
          ok: false,
          blocker: true,
          detail: input.hpgSession.detail,
          fix: 'Log in to HiPerGator again on this Mac (password and Duo); jobs and the warm worker need it.',
          command: input.hpgLogin,
          where: 'on this Mac',
        },
  );

  if (st) {
    const c = st.checks;
    items.push(fromCheck('Guide', c.guide, c.guide.state === 'ok', c.guide.state === 'bad' || c.guide.state === 'off'));
    items.push(fromCheck('DeepSpace', c.deepspace, c.deepspace.state === 'ok' || c.deepspace.state === 'idle', c.deepspace.state === 'bad' || c.deepspace.state === 'off'));
    items.push(fromCheck('Public link', c.tunnel, c.tunnel.state === 'ok', true));
  } else {
    items.push(down('Guide'), down('DeepSpace'), down('Public link'));
  }

  items.push(
    input.cloudflared
      ? { name: 'cloudflared', ok: true, blocker: true, detail: input.cloudflared }
      : { name: 'cloudflared', ok: false, blocker: true, detail: 'not on PATH', fix: 'Install it, then start the tunnel.', command: 'brew install cloudflared', where: 'on this Mac' },
  );

  items.push(...demoItems(input));

  if (input.freeBytes === null) {
    items.push({ name: 'Free disk', ok: false, blocker: false, detail: `could not read ${input.dataDir}`, fix: 'Check that the data folder exists (THIRDWHEEL_DATA).' });
  } else {
    const where = relative(process.cwd(), input.dataDir) || input.dataDir;
    const ok = input.freeBytes >= DISK_WARN_BYTES;
    items.push({
      name: 'Free disk',
      ok,
      blocker: input.freeBytes < DISK_BLOCKER_BYTES,
      detail: `${gb(input.freeBytes)} free for ${where.startsWith('..') ? input.dataDir : where}`,
      ...(ok ? {} : { fix: 'Free some space: old job folders in data/jobs and worlds you will not show can go.' }),
    });
  }

  if (st) {
    items.push(fromCheck('Headset in a world', st.checks.people, st.presence.headset, false));
  } else items.push(down('Headset in a world', false));

  return items;
}

function demoItems(input: PreflightInput): CheckItem[] {
  if (!input.scenes) return [{ name: input.demoScenes.length ? 'Demo worlds' : 'Ready worlds', ok: false, blocker: true, detail: "couldn't read the scene list", fix: SERVER_FIRST }];
  const byId = new Map(input.scenes.map((s) => [s.id, s]));
  if (!input.demoScenes.length) {
    const ready = input.scenes.filter((s) => s.status === 'ready');
    if (!ready.length) return [{ name: 'Ready worlds', ok: false, blocker: true, detail: 'none', fix: 'Build the demo worlds (game night, Fortnite, backup photo world) before the run.' }];
    const shown = ready.slice(0, 8).map((s) => `${s.name} (${s.id})`);
    const more = ready.length > shown.length ? `, and ${ready.length - shown.length} more` : '';
    return [{ name: 'Ready worlds', ok: true, blocker: true, detail: `${ready.length} ready: ${shown.join(', ')}${more}. Set DEMO_SCENES=id,id,id to check the demo order` }];
  }
  return input.demoScenes.map((id, i) => {
    const name = `Demo world ${i + 1}`;
    const s = byId.get(id);
    if (!s) return { name, ok: false, blocker: true, detail: `${id} not found`, fix: 'Check the id in DEMO_SCENES against the gallery, or build that world again.' };
    if (s.status === 'ready' && s.world) return { name, ok: true, blocker: true, detail: `${s.name} (${id}) is ready` };
    if (s.status === 'failed') return { name, ok: false, blocker: true, detail: `${s.name} (${id}) failed${s.error ? `: ${s.error}` : ''}`, fix: 'Retry it from the gallery, or pin the backup world instead.' };
    const p = typeof s.progress === 'number' && s.progress > 0 ? ` (${Math.round(s.progress * 100)}%)` : '';
    return { name, ok: false, blocker: true, detail: `${s.name} (${id}) is ${s.status === 'ready' ? 'ready but has no world' : `still building${p}`}`, fix: 'Wait for it to finish, or pin the backup world instead.' };
  });
}

/** 1 when any blocker failed, else 0. */
export function exitCode(items: CheckItem[]): number {
  return items.some((i) => !i.ok && i.blocker) ? 1 : 0;
}

export function formatChecklist(items: CheckItem[], opts: { color?: boolean; base?: string } = {}): string {
  const c = opts.color ?? false;
  const paint = (code: string) => (s: string) => (c ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lime = paint('1;38;2;198;255;61');
  const red = paint('1;38;2;255;107;91');
  const dim = paint('2');
  const bold = paint('1');
  const width = Math.max(...items.map((i) => i.name.length)) + 2;
  const out = [`${bold('Déjà View preflight')}${opts.base ? dim(` · ${opts.base}`) : ''}`, ''];
  for (const i of items) {
    const mark = i.ok ? lime('✓') : red('✗');
    const tag = !i.ok && !i.blocker ? dim('  (can wait)') : '';
    out.push(`  ${mark} ${i.name.padEnd(width)}${i.detail}${tag}`);
    if (!i.ok && i.fix) {
      const cmd = i.command ? `  ${dim(i.where ? `${i.where}:` : 'run:')} ${lime(i.command)}` : '';
      out.push(`    ${' '.repeat(width)}→ ${i.fix}${cmd}`);
    }
  }
  const blockers = items.filter((i) => !i.ok && i.blocker).length;
  const later = items.filter((i) => !i.ok && !i.blocker).length;
  out.push('');
  if (blockers) out.push(red(`${blockers} blocker${blockers > 1 ? 's' : ''} to fix before the demo`) + (later ? dim(` (${later} more can wait)`) : ''));
  else if (later) out.push(lime('Ready to go.') + dim(` ${later} thing${later > 1 ? 's' : ''} can wait.`));
  else out.push(lime('Everything is ready. Break a leg.'));
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Gathering

export interface PreflightDeps {
  fetch: FetchLike;
  /** Runs one local command (only the ssh check). */
  exec: (argv: string[]) => Promise<{ code: number; stderr: string }>;
  /** Free bytes on the disk holding `dir`, or null. */
  freeBytes: (dir: string) => Promise<number | null>;
  hpg: HpgConfig;
  cloudflared: string | null;
}

export interface PreflightOptions {
  base: string;
  /** Tried in turn when nothing answers at `base`. No BASE given: the same port over the other scheme. */
  fallbacks: string[];
  demoScenes: string[];
  key: string | null;
  dataDir: string;
}

export function preflightOptions(argv: string[], env: Env = process.env): PreflightOptions {
  const raw = argv.find((a) => !a.startsWith('-'));
  const given = normalizeBaseUrl(raw);
  // `bun run https` (the demo) serves https only on the same port: plain http there just gets the line dropped
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8787;
  const local = [`http://localhost:${port}`, `https://localhost:${port}`];
  if (env.THIRDWHEEL_HTTPS === '1') local.reverse();
  return {
    base: given ?? local[0]!,
    fallbacks: given ? [] : local.slice(1),
    demoScenes: (env.DEMO_SCENES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    key: (env.DV_KEY ?? '').trim() || null,
    dataDir: dataDir(env),
  };
}

/** Exactly `ssh -O check -o ControlPath=<socket> <user>@<host>`: asks the local master, never the cluster. */
export function sessionCheckArgv(cfg: HpgConfig): string[] {
  return [cfg.ssh, '-O', 'check', '-o', `ControlPath=${cfg.socket}`, remoteTarget(cfg)];
}

function tilde(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function loginCommand(cfg: HpgConfig): string {
  return `ssh -o ControlMaster=auto -o ControlPath=${tilde(cfg.socket)} -o ControlPersist=24h ${remoteTarget(cfg)}`;
}

export async function gatherPreflight(opts: PreflightOptions, deps: PreflightDeps): Promise<PreflightInput> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.key ? { 'x-dejaview-key': opts.key } : {}) };
  // the main server's certificate is self-signed
  const init = { method: 'GET', headers, tls: { rejectUnauthorized: false } } as RequestInit;
  // the server's own answers: the status first, to find which address answers, then the scene list there
  const server = (async () => {
    let base = opts.base;
    let st = await callJson(deps.fetch, `${base}/api/host/status`, { ...init, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
    for (const next of opts.fallbacks) {
      if (st.kind !== 'offline') break;
      const again = await callJson(deps.fetch, `${next}/api/host/status`, { ...init, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
      if (again.kind === 'offline') continue;
      base = next;
      st = again;
    }
    const list = await callJson(deps.fetch, `${base}/api/scenes`, { ...init, timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
    return { base, st, list };
  })();
  const [{ base, st, list }, session, free] = await Promise.all([
    server,
    deps.hpg.enabled
      ? deps.exec(sessionCheckArgv(deps.hpg)).catch((e) => ({ code: -1, stderr: String((e as Error)?.message ?? e) }))
      : Promise.resolve({ code: -1, stderr: 'HiPerGator is turned off (THIRDWHEEL_HPG=off)' }),
    deps.freeBytes(opts.dataDir).catch(() => null),
  ]);

  let status: StatusResult;
  if (st.kind === 'ok' && st.body?.ok === true && st.body?.checks) status = { ok: true, value: st.body as HostStatus };
  else if (st.kind === 'ok' || st.kind === 'http') status = { ok: false, httpStatus: st.status, error: typeof st.body?.error === 'string' ? st.body.error : `HTTP ${st.status}` };
  else if (st.kind === 'bad-response') status = { ok: false, httpStatus: st.status, error: st.detail ?? 'not a JSON answer' };
  else status = { ok: false, httpStatus: 0, error: st.kind === 'timeout' ? 'no answer within 15 s' : 'nothing answers there' };

  const scenes = list.kind === 'ok' && Array.isArray(list.body) ? (list.body as Scene[]) : null;
  const sessionDetail =
    session.code === 0
      ? `open (${tilde(deps.hpg.socket)})`
      : session.stderr.trim().split(/\r?\n/).pop()?.replace(/\s+/g, ' ').slice(0, 160) || `ssh exited ${session.code}`;

  return {
    base,
    status,
    scenes,
    demoScenes: opts.demoScenes,
    hpgSession: { ok: session.code === 0, detail: sessionDetail },
    hpgLogin: loginCommand(deps.hpg),
    cloudflared: deps.cloudflared,
    freeBytes: free,
    dataDir: opts.dataDir,
  };
}

/** cloudflared as scripts/tunnel.ts would run it (CLOUDFLARED_BIN, else PATH), or null when that file is not there. */
export function findCloudflared(env: Env = process.env): string | null {
  const bin = tunnelOptionsFromEnv(env).bin;
  return bin && existsSync(bin) ? bin : null;
}

export async function diskFree(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function runPreflight(argv: string[] = process.argv.slice(2), env: Env = process.env): Promise<number> {
  const opts = preflightOptions(argv, env);
  const input = await gatherPreflight(opts, {
    fetch,
    exec: (a) => exec(a, { timeoutMs: 5000 }),
    freeBytes: diskFree,
    hpg: hpgConfig(env),
    cloudflared: findCloudflared(env),
  });
  const items = buildChecklist(input);
  console.log(formatChecklist(items, { color: !!process.stdout.isTTY, base: input.base }));
  return exitCode(items);
}

if (import.meta.main) {
  process.exit(await runPreflight());
}
