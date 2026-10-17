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
