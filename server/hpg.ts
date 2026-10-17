// HiPerGator access through an existing SSH ControlMaster socket only.
//
// Every ssh/rsync call multiplexes over $HPG_SOCKET (opened once by a teammate with password + Duo).
// ProxyCommand=/usr/bin/false makes ssh fail instead of opening a fresh connection when the master is gone,
// so nothing here can ever prompt for a password or reach the host directly.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobProgress } from '../shared/types.ts';
import { expandHome, ROOT } from './config.ts';
import { exec, lastLines, type ExecResult } from './media.ts';

export interface HpgConfig {
  /** False when THIRDWHEEL_HPG is 0/off/false/no: nothing here spawns ssh or rsync. */
  enabled: boolean;
  socket: string;
  user: string;
  host: string;
  root: string;
  account: string;
  qos: string;
  partition: string;
  ssh: string;
  rsync: string;
  connectTimeout: number;
  /** Local repository root (source of pipeline/ and hpg/). */
  repoDir: string;
}

export function hpgConfig(env: Record<string, string | undefined> = process.env): HpgConfig {
  return {
    enabled: !/^(0|off|false|no)$/i.test((env.THIRDWHEEL_HPG ?? '').trim()),
    socket: expandHome(env.HPG_SOCKET || '~/.ssh/cm-hpg'),
    user: env.HPG_USER || 'sbernalorta',
    host: env.HPG_HOST || 'hpg.rc.ufl.edu',
    root: (env.HPG_ROOT || '/blue/phz3152/sbernalorta/thirdwheel').replace(/\/+$/, ''),
    account: env.HPG_ACCOUNT || 'phz3152',
    qos: env.HPG_QOS || env.HPG_ACCOUNT || 'phz3152',
    partition: env.HPG_PARTITION ?? 'hpg-rtx6000',
    ssh: env.HPG_SSH_BIN || 'ssh',
    rsync: env.HPG_RSYNC_BIN || 'rsync',
    connectTimeout: Number(env.HPG_CONNECT_TIMEOUT || 10),
    repoDir: ROOT,
  };
}

export class HpgOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HpgOfflineError';
  }
}

/** POSIX single-quote for the remote shell. */
export function shq(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SAFE_REMOTE = /^\/[A-Za-z0-9_.\/-]+$/;

/** Remote paths go through the remote shell (and rsync's remote arg parsing): keep them to safe characters. */
export function assertRemotePath(p: string): string {
  if (!SAFE_REMOTE.test(p) || p.split('/').includes('..')) throw new Error(`unsafe remote path: ${p}`);
  return p;
}

export function remoteTarget(cfg: HpgConfig): string {
  return `${cfg.user}@${cfg.host}`;
}

export function sshOptions(cfg: HpgConfig): string[] {
  return [
    '-S', cfg.socket,
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ProxyCommand=/usr/bin/false',
    '-o', `ConnectTimeout=${cfg.connectTimeout}`,
  ];
}

export function sshArgv(cfg: HpgConfig, remoteCmd: string): string[] {
  return [cfg.ssh, ...sshOptions(cfg), remoteTarget(cfg), remoteCmd];
}

export function checkArgv(cfg: HpgConfig): string[] {
  return [cfg.ssh, '-S', cfg.socket, '-O', 'check', remoteTarget(cfg)];
}

/** The -e value for rsync. rsync splits it on whitespace, so the socket path is quoted when needed. */
export function rsyncShell(cfg: HpgConfig): string {
  const sock = /\s/.test(cfg.socket) ? `"${cfg.socket}"` : cfg.socket;
  return `${cfg.ssh} -S ${sock} -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false -o ConnectTimeout=${cfg.connectTimeout}`;
}

export interface RsyncOptions {
  delete?: boolean;
  exclude?: string[];
}

function rsyncFlags(opts: RsyncOptions): string[] {
  const f = ['-a', '--partial'];
  if (opts.delete) f.push('--delete');
  for (const x of opts.exclude ?? []) f.push(`--exclude=${x}`);
  return f;
}

/** rsync a local directory's contents into a remote directory (both treated as directories). */
export function rsyncUpArgv(cfg: HpgConfig, localDir: string, remoteDir: string, opts: RsyncOptions = {}): string[] {
  assertRemotePath(remoteDir);
  return [cfg.rsync, ...rsyncFlags(opts), '-e', rsyncShell(cfg), localDir.replace(/\/*$/, '/'), `${remoteTarget(cfg)}:${remoteDir.replace(/\/*$/, '/')}`];
}

export function rsyncDownArgv(cfg: HpgConfig, remoteDir: string, localDir: string, opts: RsyncOptions = {}): string[] {
  assertRemotePath(remoteDir);
  return [cfg.rsync, ...rsyncFlags(opts), '-e', rsyncShell(cfg), `${remoteTarget(cfg)}:${remoteDir.replace(/\/*$/, '/')}`, localDir.replace(/\/*$/, '/')];
}

const REPO_EXCLUDES = ['__pycache__', '*.pyc', '.DS_Store', '.ipynb_checkpoints', 'jobs/'];

/** rsync invocations that mirror pipeline/ and hpg/ into $HPG_ROOT/repo/. */
export function syncRepoArgvs(cfg: HpgConfig): string[][] {
  const repo = `${cfg.root}/repo`;
  return ['pipeline', 'hpg'].map((d) =>
    rsyncUpArgv(cfg, join(cfg.repoDir, d), `${repo}/${d}`, { delete: true, exclude: REPO_EXCLUDES }),
  );
}

export function jobsRoot(cfg: HpgConfig): string {
  return `${cfg.root}/jobs`;
}

export function batchJobDir(cfg: HpgConfig, jobId: string): string {
  return assertRemotePath(`${jobsRoot(cfg)}/batch/${jobId}`);
}

export function sbatchCommand(cfg: HpgConfig, remoteJobDir: string, jobName: string): string {
  assertRemotePath(remoteJobDir);
  const name = jobName.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
  const args = [
    'sbatch', '--parsable',
    `--job-name=${name}`,
    `--account=${cfg.account}`,
    `--qos=${cfg.qos}`,
    ...(cfg.partition ? [`--partition=${cfg.partition}`] : []),
    `--output=${remoteJobDir}/slurm-%j.out`,
    'hpg/job.sbatch',
    remoteJobDir,
  ];
  return `cd ${shq(`${cfg.root}/repo`)} && ${args.map(shq).join(' ')}`;
}

/** sbatch --parsable prints "<id>" or "<id>;<cluster>". */
export function parseSbatchOutput(stdout: string): string {
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  const m = /^(\d+)(?:;\S+)?$/.exec(line.trim());
  if (!m) throw new Error(`unexpected sbatch output: ${lastLines(stdout, 2) || '(empty)'}`);
  return m[1]!;
}

const MARK = '::tw:';

/** Shell fragment printing progress.json, the DONE/FAILED markers and the FAILED text of a job dir. */
function jobDirReport(dirExpr: string): string {
  return [
    `echo "${MARK}progress::"`,
    `cat ${dirExpr}/progress.json 2>/dev/null`,
    'echo',
    `echo "${MARK}markers::"`,
    `[ -f ${dirExpr}/DONE ] && echo DONE`,
    `[ -f ${dirExpr}/FAILED ] && echo FAILED`,
    `echo "${MARK}failed::"`,
    `head -c 4000 ${dirExpr}/FAILED 2>/dev/null`,
    'echo',
    `echo "${MARK}log::"`,
    `tail -n 15 ${dirExpr}/log.txt 2>/dev/null`,
    `echo "${MARK}end::"`,
  ].join('; ');
}

export function pollBatchCommand(cfg: HpgConfig, slurmId: string, remoteJobDir: string): string {
  if (!/^\d+$/.test(slurmId)) throw new Error(`invalid slurm job id: ${slurmId}`);
  assertRemotePath(remoteJobDir);
  return [
    `echo "${MARK}squeue::"`,
    `squeue -h -j ${slurmId} -o '%T|%r|%M' 2>/dev/null`,
    `echo "${MARK}sacct::"`,
    `sacct -j ${slurmId} -X -n -P -o State,ExitCode,Elapsed 2>/dev/null`,
    jobDirReport(shq(remoteJobDir)),
  ].join('; ');
}

function sections(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^::tw:([a-z]+)::(.*)$/.exec(line);
    if (m) {
      if (cur) out.set(cur, buf.join('\n').trim());
      cur = m[1]!;
      buf = m[2] ? [m[2]] : [];
    } else if (cur) {
      buf.push(line);
    }
  }
  if (cur) out.set(cur, buf.join('\n').trim());
  return out;
}

export interface JobDirReport {
  progress?: JobProgress;
  done: boolean;
  failed: boolean;
  failText?: string;
  logTail?: string;
}

function parseJobDirReport(sec: Map<string, string>): JobDirReport {
  let progress: JobProgress | undefined;
  const p = sec.get('progress');
  if (p) {
    try {
      const j = JSON.parse(p);
      if (j && typeof j === 'object' && typeof j.stage === 'string') progress = j as JobProgress;
    } catch {
      /* partially written; ignore this round */
    }
  }
  const markers = (sec.get('markers') ?? '').split(/\s+/);
  return {
    progress,
    done: markers.includes('DONE'),
    failed: markers.includes('FAILED'),
    failText: sec.get('failed') || undefined,
    logTail: sec.get('log') || undefined,
  };
}

export const SLURM_TERMINAL = new Set([
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED',
]);

export interface BatchPoll extends JobDirReport {
  /** Slurm state, e.g. PENDING, RUNNING, COMPLETED; UNKNOWN when neither squeue nor sacct knows the job yet. */
  state: string;
  reason?: string;
  exitCode?: string;
  elapsed?: string;
  terminal: boolean;
}

export function parseBatchPoll(stdout: string): BatchPoll {
  const sec = sections(stdout);
  let state = 'UNKNOWN';
  let reason: string | undefined;
  let exitCode: string | undefined;
  let elapsed: string | undefined;
  const sq = (sec.get('squeue') ?? '').split(/\r?\n/).find((l) => l.trim());
  if (sq) {
    const [st, rs, el] = sq.split('|');
    state = (st ?? '').trim() || state;
    reason = rs && rs.trim() !== 'None' ? rs.trim() : undefined;
    elapsed = el?.trim();
  }
  const sa = (sec.get('sacct') ?? '').split(/\r?\n/).find((l) => l.trim());
  if (sa) {
    const [st, ec, el] = sa.split('|');
    const s = (st ?? '').trim().split(/\s+/)[0]!;
    // squeue knows live jobs best; sacct is authoritative once the job left the queue.
    if (!sq || SLURM_TERMINAL.has(s)) state = s || state;
    exitCode = ec?.trim();
    elapsed = elapsed ?? el?.trim();
  }
  return { state, reason, exitCode, elapsed, terminal: SLURM_TERMINAL.has(state), ...parseJobDirReport(sec) };
}

export function workerCommand(cfg: HpgConfig): string {
  const wj = shq(`${jobsRoot(cfg)}/worker.json`);
  return [
    `echo "${MARK}worker::"`,
    `cat ${wj} 2>/dev/null`,
    'echo',
    `echo "${MARK}now::"`,
    'date +%s',
    `echo "${MARK}mtime::"`,
    `stat -c %Y ${wj} 2>/dev/null`,
    `echo "${MARK}end::"`,
  ].join('; ');
}

export interface WorkerStatus {
  alive: boolean;
  host?: string;
  gpu?: string;
  lastBeat?: string;
  /** Seconds since the last heartbeat, measured on the remote clock. */
  age?: number;
  /** Heartbeat status: starting, loading, idle, busy, error, stopped. */
  status?: string;
}

export const WORKER_STALE_S = 90;

function parseBeatTime(t: unknown): number | null {
  if (typeof t === 'number' && Number.isFinite(t)) return t > 1e11 ? t / 1000 : t;
  if (typeof t === 'string' && t.trim()) {
    if (/^\d+(\.\d+)?$/.test(t.trim())) return parseBeatTime(Number(t));
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

export function parseWorker(stdout: string, staleS = WORKER_STALE_S): WorkerStatus {
  const sec = sections(stdout);
  const raw = sec.get('worker') ?? '';
  const now = Number(sec.get('now'));
  const mtime = Number(sec.get('mtime'));
  if (!raw) return { alive: false };
  let beat: any = {};
  try {
    beat = JSON.parse(raw);
  } catch {
    beat = {};
  }
  const t = parseBeatTime(beat?.time);
  const ref = t ?? (Number.isFinite(mtime) && mtime > 0 ? mtime : null);
  const age = ref !== null && Number.isFinite(now) && now > 0 ? Math.max(0, now - ref) : undefined;
  return {
    alive: age !== undefined && age <= staleS,
    host: typeof beat?.host === 'string' ? beat.host : undefined,
    gpu: typeof beat?.gpu === 'string' ? beat.gpu : undefined,
    lastBeat: ref !== null ? new Date(ref * 1000).toISOString() : undefined,
    age,
    ...(typeof beat?.status === 'string' ? { status: beat.status } : {}),
  };
}

export type WorkerJobLocation = 'queue' | 'running' | 'done' | 'missing';

export interface WorkerPoll extends JobDirReport {
  where: WorkerJobLocation;
  worker: WorkerStatus;
}

/** Locates a job handed to the warm worker and reports its state plus the worker heartbeat, in one round trip. */
export function workerPollCommand(cfg: HpgConfig, jobId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) throw new Error(`invalid job id: ${jobId}`);
  const jr = jobsRoot(cfg);
  return [
    `W=missing; for s in queue running done; do if [ -d ${shq(jr)}/$s/${jobId} ]; then W=$s; break; fi; done`,
    `echo "${MARK}where::$W"`,
    `D=${shq(jr)}/$W/${jobId}`,
    jobDirReport('"$D"'),
    workerCommand(cfg),
  ].join('; ');
}

export function parseWorkerPoll(stdout: string): WorkerPoll {
  const sec = sections(stdout);
  const w = (sec.get('where') ?? 'missing').trim() as WorkerJobLocation;
  const where: WorkerJobLocation = ['queue', 'running', 'done'].includes(w) ? w : 'missing';
  return { where, worker: parseWorker(stdout), ...parseJobDirReport(sec) };
}

/** Moves a fully uploaded job dir into the worker queue atomically (same filesystem rename). */
export function enqueueWorkerCommand(cfg: HpgConfig, jobId: string): string {
  const jr = jobsRoot(cfg);
  return `mkdir -p ${shq(`${jr}/queue`)} && mv ${shq(`${jr}/incoming/${jobId}`)} ${shq(`${jr}/queue/${jobId}`)}`;
}

// ---------------------------------------------------------------------------------------------
// Live operations. Every one fails fast with HpgOfflineError when the socket is absent.

async function socketPresent(cfg: HpgConfig): Promise<boolean> {
  if (!cfg.enabled) return false;
  try {
    const st = await lstat(cfg.socket);
    return st.isSocket();
  } catch {
    return false;
  }
}

function tildePath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p;
}

export function offlineReason(cfg: HpgConfig): string {
  if (!cfg.enabled) return 'disabled (THIRDWHEEL_HPG=off)';
  const sock = tildePath(cfg.socket);
  return `offline, no SSH session at ${sock} (log in once: ssh -o ControlMaster=auto -o ControlPath=${sock} -o ControlPersist=24h ${remoteTarget(cfg)})`;
}

/** True when the ControlMaster socket exists and its master answers `ssh -O check`. */
export async function socketAlive(cfg: HpgConfig = hpgConfig()): Promise<boolean> {
  if (!(await socketPresent(cfg))) return false;
  try {
    const r = await exec(checkArgv(cfg), { timeoutMs: 5000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function requireSocket(cfg: HpgConfig): Promise<void> {
  if (!(await socketPresent(cfg))) throw new HpgOfflineError(offlineReason(cfg));
}

function sshFailure(what: string, r: ExecResult): Error {
  const text = lastLines(r.stderr || r.stdout, 3);
  if (r.code === 255 || /Control socket|mux_client|ProxyCommand|Connection refused|closed by remote/i.test(text)) {
    return new HpgOfflineError(`HiPerGator connection failed during ${what}: ${text || `ssh exit ${r.code}`}`);
  }
  return new Error(`${what} failed (exit ${r.code})${text ? `: ${text}` : ''}`);
}

/** Runs a command on the login node through the socket. Resolves with the result; rejects only if offline. */
export async function run(cmd: string, opts: { timeoutMs?: number; cfg?: HpgConfig } = {}): Promise<ExecResult> {
  const cfg = opts.cfg ?? hpgConfig();
  await requireSocket(cfg);
  const r = await exec(sshArgv(cfg, cmd), { timeoutMs: opts.timeoutMs ?? 60_000 });
  if (r.code === 255) throw sshFailure('ssh', r);
  return r;
}

/** Like run() but rejects on a non-zero exit. */
export async function runOk(cmd: string, what: string, opts: { timeoutMs?: number; cfg?: HpgConfig } = {}): Promise<string> {
  const r = await run(cmd, opts);
  if (r.code !== 0) throw sshFailure(what, r);
  return r.stdout;
}

export async function rsyncUp(localDir: string, remoteDir: string, opts: RsyncOptions & { cfg?: HpgConfig; timeoutMs?: number } = {}): Promise<void> {
  const cfg = opts.cfg ?? hpgConfig();
  await requireSocket(cfg);
  const r = await exec(rsyncUpArgv(cfg, localDir, remoteDir, opts), { timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  if (r.code !== 0) throw sshFailure(`upload to ${remoteDir}`, r);
}

export async function rsyncDown(remoteDir: string, localDir: string, opts: RsyncOptions & { cfg?: HpgConfig; timeoutMs?: number } = {}): Promise<void> {
  const cfg = opts.cfg ?? hpgConfig();
  await requireSocket(cfg);
  const r = await exec(rsyncDownArgv(cfg, remoteDir, localDir, opts), { timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  if (r.code !== 0) throw sshFailure(`download from ${remoteDir}`, r);
}

/** Mirrors pipeline/ and hpg/ into $HPG_ROOT/repo. */
export async function syncRepo(cfg: HpgConfig = hpgConfig()): Promise<void> {
  await requireSocket(cfg);
  await runOk(`mkdir -p ${shq(`${cfg.root}/repo`)} ${shq(`${jobsRoot(cfg)}/incoming`)} ${shq(`${jobsRoot(cfg)}/batch`)}`, 'mkdir', { cfg });
  for (const argv of syncRepoArgvs(cfg)) {
    const r = await exec(argv, { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw sshFailure('repo sync', r);
  }
}

export async function workerAlive(cfg: HpgConfig = hpgConfig()): Promise<WorkerStatus> {
  if (!(await socketPresent(cfg))) return { alive: false };
  try {
    const r = await run(workerCommand(cfg), { cfg, timeoutMs: 15_000 });
    return parseWorker(r.stdout);
  } catch {
    return { alive: false };
  }
}

/** Submits hpg/job.sbatch for a job dir that is already on HPG. Returns the Slurm job id. */
export async function submitBatch(remoteJobDir: string, jobName = 'thirdwheel', cfg: HpgConfig = hpgConfig()): Promise<string> {
  const out = await runOk(sbatchCommand(cfg, remoteJobDir, jobName), 'sbatch', { cfg, timeoutMs: 60_000 });
  return parseSbatchOutput(out);
}

export async function pollBatch(slurmId: string, remoteJobDir: string, cfg: HpgConfig = hpgConfig()): Promise<BatchPoll> {
  const r = await run(pollBatchCommand(cfg, slurmId, remoteJobDir), { cfg, timeoutMs: 30_000 });
  return parseBatchPoll(r.stdout);
}

export async function cancelBatch(slurmId: string, cfg: HpgConfig = hpgConfig()): Promise<void> {
  if (!/^\d+$/.test(slurmId)) return;
  await run(`scancel ${slurmId}`, { cfg, timeoutMs: 20_000 }).catch(() => {});
}

export async function pollWorkerJob(jobId: string, cfg: HpgConfig = hpgConfig()): Promise<WorkerPoll> {
  const r = await run(workerPollCommand(cfg, jobId), { cfg, timeoutMs: 30_000 });
  return parseWorkerPoll(r.stdout);
}
