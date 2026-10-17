// Paths and environment shared by the server modules.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export const DATA_DIR = resolve(expandHome(process.env.THIRDWHEEL_DATA || join(ROOT, 'data')));
export const SCENES_DIR = join(DATA_DIR, 'scenes');
export const JOBS_DIR = join(DATA_DIR, 'jobs');
export const CERTS_DIR = join(ROOT, 'certs');

export const PORT = Number(process.env.PORT || 8787);
export const HTTPS = process.env.THIRDWHEEL_HTTPS === '1';
export const PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * The plain-HTTP listener next to the https one (team/contracts.md 2.1, 2.3: `BASE` on the LAN and the tunnel's
 * target are http://<ip>:8788, same process and data as 8787). HTTP_PORT sets it; with https on and HTTP_PORT unset
 * it defaults to 8788. `HTTP_PORT=0` (or `off`) turns it off. A plain-HTTP main server needs no second listener.
 */
export function httpPortFrom(env: Record<string, string | undefined>, https: boolean, port: number): number | null {
  const raw = env.HTTP_PORT?.trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'no' || raw === 'false') return null;
  const n = raw ? Number(raw) : https ? 8788 : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 65535 || n === port) return null;
  return n;
}
export const HTTP_PORT = httpPortFrom(process.env, HTTPS, PORT);

/**
 * Hot module reload for the pages. Bun's HMR client reloads every open page whenever its socket to the server drops
 * (a restart, a Wi-Fi blip, a Quest that slept), which throws a headset out of VR. So it is off in production, off
 * for the https server the Quest uses, and off with THIRDWHEEL_HMR=0; THIRDWHEEL_HMR=1 forces it on.
 */
export function hmrFrom(env: Record<string, string | undefined>, production: boolean, https: boolean): boolean {
  if (production) return false;
  const v = env.THIRDWHEEL_HMR?.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return !https;
}
export const HMR = hmrFrom(process.env, PRODUCTION, HTTPS);

/** Largest accepted upload (request body). */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export const VERSION: string = (await Bun.file(join(ROOT, 'package.json')).json().catch(() => ({}))).version ?? '0.0.0';

export const LOCAL_PYTHON = resolve(ROOT, process.env.THIRDWHEEL_PYTHON || '.venv/bin/python');
export const RUN_JOB_PY = join(ROOT, 'pipeline', 'run_job.py');

/**
 * Gradio Space that runs FlashWorld. imlixinyang/FlashWorld-Demo-Spark is only the static web front end of this one.
 */
export const SPACE_ID = process.env.FLASHWORLD_SPACE || 'imlixinyang/FlashWorld-Demo';
export const FLASHWORLD_PY = join(ROOT, 'pipeline', 'flashworld_run.py');
