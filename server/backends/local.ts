// local backend: runs `.venv/bin/python pipeline/run_job.py <jobdir>` on this Mac (MPS or CPU).
//
// The pipeline runs in its own process group with stdout/stderr going to <jobdir>/console.txt, so it keeps
// running if the server restarts; a restarted server re-attaches by pid and keeps mirroring progress.json.

import { spawn } from 'node:child_process';
import { access, constants as fsc, open, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { JobProgress, SceneMode } from '../../shared/types.ts';
import { exec, lastLines } from '../media.ts';
import {
  ProductError,
  ResumeImpossible,
  readProgress,
  sleep,
  type Availability,
  type BackendDriver,
  type RunContext,
} from './types.ts';

export interface LocalOptions {
  python: string;
  script: string;
  cwd: string;
  pollMs?: number;
  /** Modes handed to the local pipeline. */
  modes?: SceneMode[];
  env?: Record<string, string>;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function commandOf(pid: number): Promise<string> {
  const r = await exec(['ps', '-p', String(pid), '-o', 'command='], { timeoutMs: 5000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : '';
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

async function readTail(path: string, from: number): Promise<{ text: string; next: number }> {
  try {
    const st = await stat(path);
    if (st.size <= from) return { text: '', next: st.size < from ? 0 : from };
    const fh = await open(path, 'r');
    try {
      const len = Math.min(st.size - from, 1 << 20);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, from);
      return { text: buf.toString('utf8'), next: from + len };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: '', next: from };
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/**
 * Error text for a finished-but-failed pipeline run, best source first. The pipeline writes a product sentence
 * into progress.json `error` (and the technical cause into `detail` and its log); that sentence is what the UI shows.
 */
export async function failureText(jobDir: string, fallback: string): Promise<string> {
  return (await pipelineFailure(jobDir, fallback)).message;
}

/** The pipeline's failure as a ProductError: `user` from progress.json, the technical detail as the message. */
export async function pipelineFailure(jobDir: string, fallback: string): Promise<Error> {
  const failed = (await Bun.file(join(jobDir, 'FAILED')).text().catch(() => '')).trim();
  const prog = (await readProgress(join(jobDir, 'progress.json'))) as (JobProgress & { detail?: string }) | null;
  if (prog?.error) {
    const detail = typeof prog.detail === 'string' && prog.detail.trim() ? `${prog.error} (${prog.detail.trim()})` : prog.error;
    return new ProductError(prog.error, detail);
  }
  if (failed) return new Error(lastLines(failed, 6));
  const console = (await Bun.file(join(jobDir, 'console.txt')).text().catch(() => '')).trim();
  if (console) return new Error(`${fallback}: ${lastLines(console, 4)}`);
  return new Error(fallback);
}

export function localDriver(opts: LocalOptions): BackendDriver {
  const pollMs = opts.pollMs ?? 500;
  const modes = new Set<SceneMode>(opts.modes ?? ['rentfree', 'thirdwheel', 'reconstruct']);

  async function available(): Promise<Availability> {
    try {
      await access(opts.python, fsc.X_OK);
    } catch {
      return { ok: false, reason: `not installed (${relative(opts.cwd, opts.python) || opts.python} is missing; run scripts/setup-local.sh)` };
    }
    if (!(await exists(opts.script))) {
      return { ok: false, reason: `${relative(opts.cwd, opts.script)} is missing` };
    }
    return { ok: true };
  }

  async function run(ctx: RunContext): Promise<void> {
    const consolePath = join(ctx.jobDir, 'console.txt');
    let pid: number;
    let exitCode: number | null = null;
    let exited: Promise<void>;

    if (ctx.resume) {
      const old = ctx.state.pid;
      const cmd = old && pidAlive(old) ? await commandOf(old) : '';
      if (old && cmd.includes('run_job.py') && cmd.includes(ctx.jobDir)) {
        pid = old;
        exited = (async () => {
          while (pidAlive(pid)) await sleep(1000);
        })();
        ctx.log(`re-attached to local pipeline pid ${pid}`);
      } else if (await exists(join(ctx.jobDir, 'DONE'))) {
        return;
      } else if (await exists(join(ctx.jobDir, 'FAILED'))) {
        // It finished (and failed) while the server was down: report that instead of running it all again.
        throw await pipelineFailure(ctx.jobDir, 'the local pipeline failed while the server was stopped');
      } else {
        throw new ResumeImpossible('the local pipeline is no longer running');
      }
    } else {
      const fh = await open(consolePath, 'a');
      const child = spawn(opts.python, ['-u', opts.script, ctx.jobDir], {
        cwd: opts.cwd,
        detached: true,
        stdio: ['ignore', fh.fd, fh.fd],
        env: { ...process.env, PYTHONUNBUFFERED: '1', THIRDWHEEL_BACKEND: 'local', ...opts.env },
      });
      await fh.close();
      if (!child.pid) throw new Error(`could not start ${opts.python}`);
      pid = child.pid;
      exited = new Promise<void>((resolve) => {
        child.once('exit', (code, sig) => {
          exitCode = code ?? (sig ? 128 : 1);
          resolve();
        });
        child.once('error', () => {
          exitCode = 127;
          resolve();
        });
      });
      await ctx.saveState({ pid });
      ctx.log(`local pipeline started (pid ${pid})`);
    }

    let consoleOffset = ctx.resume ? (await stat(consolePath).catch(() => null))?.size ?? 0 : 0;
    let finished = false;
    void exited.then(() => (finished = true));
    const onAbort = () => {
      killGroup(pid, 'SIGTERM');
      setTimeout(() => pidAlive(pid) && killGroup(pid, 'SIGKILL'), 5000);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (!ctx.resume) ctx.report({ status: 'running', stage: 'Starting on this computer' });
      while (true) {
        const prog = await readProgress(join(ctx.jobDir, 'progress.json'));
        if (prog) ctx.reportProgress(prog);
        const tail = await readTail(consolePath, consoleOffset);
        consoleOffset = tail.next;
        if (tail.text) ctx.logRaw(tail.text);
        if (finished) break;
        await Promise.race([sleep(pollMs, ctx.signal), exited]);
      }
      const last = await readTail(consolePath, consoleOffset);
      if (last.text) ctx.logRaw(last.text);
      const prog = await readProgress(join(ctx.jobDir, 'progress.json'));
      if (prog) ctx.reportProgress(prog);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }

    const done = await exists(join(ctx.jobDir, 'DONE'));
    const failed = await exists(join(ctx.jobDir, 'FAILED'));
    if (done && !failed && (exitCode === null || exitCode === 0)) return;
    const code = exitCode === null ? '' : ` (exit ${exitCode})`;
    throw await pipelineFailure(ctx.jobDir, `the local pipeline stopped without finishing${code}`);
  }

  return {
    name: 'local',
    label: 'Local pipeline',
    place: 'this computer',
    lane: 'local',
    canResume: true,
    supports: (mode) => modes.has(mode),
    available,
    run,
  };
}
