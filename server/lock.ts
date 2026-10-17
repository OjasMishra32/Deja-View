// One server per data directory. Two servers on the same data/ both resume the same queued jobs on boot, run them
// twice in one job directory and wipe each other's work, so the second one refuses to start.
//
// The lock is data/server.lock: {pid, port, startedAt}. It is taken with an exclusive create and removed on exit.
// A lock left behind by a server that is no longer running (crash, kill -9) is taken over.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_NAME = 'server.lock';

export interface LockInfo {
  pid: number;
  port?: number;
  startedAt?: string;
}

export class DataDirLocked extends Error {
  constructor(
    readonly holder: LockInfo,
    readonly dataDir: string,
    readonly lockPath: string,
  ) {
    super(
      `Another Déjà View server (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ''}) is already using ${dataDir}.\n` +
        `  Two servers on one data folder run the same jobs twice and overwrite each other's work.\n` +
        `  Stop the other server first, or give this one its own folder: THIRDWHEEL_DATA=/path/to/other/data\n` +
        `  To only look at the scenes (no jobs, no uploads), start it with THIRDWHEEL_READONLY=1.\n` +
        `  If no other server is running, delete ${lockPath} and start again.`,
    );
    this.name = 'DataDirLocked';
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v.pid === 'number' ? (v as LockInfo) : null;
  } catch {
    return null;
  }
}

/** True when `pid` is a live process that looks like one of our servers (guards against pid reuse after a reboot). */
export function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: alive but another user's process, so not one of our servers.
    return false;
  }
  try {
    const r = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='], { stdout: 'pipe', stderr: 'ignore' });
    const comm = r.stdout.toString().trim();
    return !comm || /bun|node/i.test(comm);
  } catch {
    return true;
  }
}

export interface DataLock {
  path: string;
  release(): void;
}

/**
 * Takes the data directory lock or throws DataDirLocked naming the server that holds it. `isAlive` is injectable
 * for tests. Calling it again from the same process (bun --hot) is a no-op that returns the same lock.
 */
export function acquireDataLock(dataDir: string, port: number, isAlive: (pid: number) => boolean = holderAlive): DataLock {
  const path = join(dataDir, LOCK_NAME);
  const info: LockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(path, 'wx', 0o644);
      try {
        writeSync(fd, JSON.stringify(info) + '\n');
      } finally {
        closeSync(fd);
      }
      return lockHandle(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = readLock(path);
    if (held && held.pid === process.pid) return lockHandle(path);
    if (held && isAlive(held.pid)) throw new DataDirLocked(held, dataDir, path);
    // Stale (the holder is gone) or unreadable: take it over.
    try {
      unlinkSync(path);
    } catch {
      /* someone else removed it first */
    }
  }
  const held = readLock(path);
  throw new DataDirLocked(held ?? { pid: 0 }, dataDir, path);
}

function lockHandle(path: string): DataLock {
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      const held = readLock(path);
      if (held && held.pid !== process.pid) return;
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}
