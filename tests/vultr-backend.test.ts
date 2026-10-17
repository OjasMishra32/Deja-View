// The server driving the backup GPU box end to end, with a stand-in ssh that runs "remote" commands locally against
// a temporary /root/dejaview and records every argv, real rsync, and Slurm tools that only record being called.
// There is no ControlMaster socket anywhere: key login needs none.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hpgBatchDriver, hpgWorkerDriver } from '../server/backends/hpg.ts';
import { NOTHING_AVAILABLE } from '../server/copy.ts';
import { HealthMonitor } from '../server/health.ts';
import { hpgConfig, HpgOfflineError, run, socketAlive, workerAlive, type HpgConfig } from '../server/hpg.ts';
import { JobRunner } from '../server/jobs.ts';
import { SceneStore } from '../server/store.ts';

const SLURM = /\b(sbatch|squeue|sacct|scancel|srun|sinfo)\b/;

let base: string;
let vcfg: HpgConfig;
let jobs: string;

/** Every ssh invocation so far, as argv arrays. */
async function sshCalls(): Promise<string[][]> {
  const text = await Bun.file(join(base, 'ssh.log')).text().catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(0, -1));
}

/** user@host of an ssh argv (its first word after the options); rsync may pass the user as -l. */
function target(argv: string[]): string {
  let user = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-l') user = argv[++i]!;
    else if (['-o', '-i', '-p', '-S', '-e', '-F', '-J'].includes(a)) i++;
    else if (!a.startsWith('-')) return user ? `${user}@${a}` : a;
  }
  return '';
}

async function slurmCalled(): Promise<string> {
  return Bun.file(join(base, 'slurm-called')).text().catch(() => '');
}

/** worker.json the way hpg/worker.py's Heartbeat writes it on a box without Slurm. */
function beatJson(ageS = 0, status = 'idle'): string {
  const t = new Date(Date.now() - ageS * 1000).toISOString();
  return JSON.stringify({ time: t, host: 'dejaview-gpu', pid: 4321, startedAt: t, slurmJobId: null, gpu: 'NVIDIA A40 46068 MiB', status, jobsDone: 0, job: null, modelLoaded: true }, null, 2);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'dv-vultr-'));
  const bin = join(base, 'bin');
  const trap = join(base, 'trap');
  await mkdir(bin, { recursive: true });
  await mkdir(trap, { recursive: true });
  // ssh stand-in: records its argv (unit-separated), fails like a dead box when ssh-down exists, else runs the command.
  await writeFile(
    join(bin, 'ssh'),
    `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "${base}/ssh.log"
echo >> "${base}/ssh.log"
if [ -f "${base}/ssh-down" ]; then echo "ssh: connect to host 203.0.113.7 port 22: Operation timed out" >&2; exit 255; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-i|-p|-l|-S|-e|-F|-J) shift 2;;
    -O) echo "unexpected control command" >&2; exit 2;;
    -*) shift;;
    *) shift; break;;
  esac
done
PATH="${trap}:$PATH" exec /bin/sh -c "$*"
`,
  );
  await chmod(join(bin, 'ssh'), 0o755);
  for (const tool of ['sbatch', 'squeue', 'sacct', 'scancel', 'srun', 'sinfo']) {
    await writeFile(join(trap, tool), `#!/bin/sh\necho ${tool} >> "${base}/slurm-called"\nexit 1\n`);
    await chmod(join(trap, tool), 0o755);
  }
  const repo = join(base, 'local repo');
  await mkdir(join(repo, 'pipeline', '__pycache__'), { recursive: true });
  await mkdir(join(repo, 'hpg'), { recursive: true });
  await writeFile(join(repo, 'pipeline', 'run_job.py'), '# pipeline');
  await writeFile(join(repo, 'pipeline', '__pycache__', 'x.pyc'), 'junk');
  await writeFile(join(repo, 'hpg', 'worker.py'), '# worker');
  vcfg = {
    ...hpgConfig({ VULTR_HOST: '203.0.113.7', VULTR_SSH_KEY: join(base, 'id_ed25519') }),
    ssh: join(bin, 'ssh'),
    root: join(base, 'root', 'dejaview'),
    repoDir: repo,
    connectTimeout: 5,
  };
  jobs = join(vcfg.root, 'jobs');
  for (const d of ['queue', 'running', 'done']) await mkdir(join(jobs, d), { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('Vultr box: reachability and liveness', () => {
  test('online without any socket file; the worker is alive from worker.json alone', async () => {
    expect(await Bun.file(vcfg.socket).exists()).toBe(false);
    expect(await socketAlive(vcfg)).toBe(true);
    await rm(join(jobs, 'worker.json'), { force: true });
    expect(await workerAlive(vcfg)).toEqual({ alive: false });

    await writeFile(join(jobs, 'worker.json'), beatJson(5));
    const w = await workerAlive(vcfg);
    expect(w).toMatchObject({ alive: true, host: 'dejaview-gpu', gpu: 'NVIDIA A40 46068 MiB', status: 'idle' });
    expect(w.age!).toBeLessThan(30);

    // The server's own health monitor sees it exactly like the HiPerGator worker.
    const health = new HealthMonitor({ version: 't', https: false, port: 0, hpg: () => vcfg, space: async () => ({ available: false }), local: async () => false });
    const h = await health.info(true);
    expect(h.hpg.online).toBe(true);
    expect(h.hpg.user).toBe('root');
    expect(h.hpg.worker).toMatchObject({ alive: true, host: 'dejaview-gpu', gpu: 'NVIDIA A40 46068 MiB' });

    await writeFile(join(jobs, 'worker.json'), beatJson(300));
    expect((await workerAlive(vcfg)).alive).toBe(false);
    // worker.py removes worker.json when it exits (idle timeout, stop): not alive.
    await rm(join(jobs, 'worker.json'));
    expect((await workerAlive(vcfg)).alive).toBe(false);
  });

  test('a dead box is offline, and the error says Vultr', async () => {
    await writeFile(join(base, 'ssh-down'), '');
    try {
      expect(await socketAlive(vcfg)).toBe(false);
      expect(await workerAlive(vcfg)).toEqual({ alive: false });
      const e = await run('true', { cfg: vcfg }).catch((x) => x);
      expect(e).toBeInstanceOf(HpgOfflineError);
      expect(e.message).toBe('Vultr connection failed during ssh: ssh: connect to host 203.0.113.7 port 22: Operation timed out');
    } finally {
      await rm(join(base, 'ssh-down'));
    }
  });

  test('every ssh call so far: key login to root@203.0.113.7, no Slurm', async () => {
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(4);
    for (const argv of calls) {
      expect(argv).toContain('BatchMode=yes');
      expect(argv).toContain('ControlMaster=auto');
      expect(argv).toContain(`ControlPath=${vcfg.socket}`);
      expect(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2)).toEqual(['-i', join(base, 'id_ed25519')]);
      expect(argv).not.toContain('ProxyCommand=/usr/bin/false');
      expect(target(argv)).toBe('root@203.0.113.7');
      expect(argv.join(' ')).not.toMatch(SLURM);
    }
    expect(await slurmCalled()).toBe('');
  });
});

describe('Vultr box: jobs', () => {
  async function scene(store: SceneStore, id: string) {
    await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
    await writeFile(join(store.sceneDir(id), 'input', '00.jpg'), 'photo');
    await store.save({ id, name: id, mode: 'rentfree', status: 'queued', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/00.jpg'] } });
  }

  function runner(store: SceneStore, dir: string, stages: string[] = []) {
    // The probe index.ts builds, over the health checks, here on the Vultr config.
    const probe = { online: async () => ({ online: await socketAlive(vcfg) }), worker: () => workerAlive(vcfg) };
    return new JobRunner({
      store,
      jobsDir: join(base, dir),
      drivers: [hpgWorkerDriver({ probe, cfg: () => vcfg, pollMs: 100 }), hpgBatchDriver({ probe, cfg: () => vcfg, pollMs: 100 })],
      emit: (s) => s.stage && stages.push(`${s.status}:${s.stage}`),
      reportIntervalMs: 10,
    });
  }

  test('a photo goes up, the warm worker claims it, the world comes back', async () => {
    const before = (await sshCalls()).length;
    await writeFile(join(jobs, 'worker.json'), beatJson());
    const claimed = new Set<string>();
    // Stand-in for hpg/worker.py: heartbeat, claim by rename, progress, out/, DONE, then the move to done/.
    const timer = setInterval(async () => {
      await writeFile(join(jobs, 'worker.json'), beatJson(0, claimed.size ? 'busy' : 'idle'));
      for (const name of await readdir(join(jobs, 'queue')).catch(() => [])) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        const dir = join(jobs, 'running', name);
        await rename(join(jobs, 'queue', name), dir);
        await writeFile(join(dir, 'progress.json'), JSON.stringify({ stage: 'Generating the world', progress: 0.5 }));
        setTimeout(async () => {
          await mkdir(join(dir, 'out'), { recursive: true });
          await writeFile(join(dir, 'out', 'world.spz'), 'A40-SPZ');
          await writeFile(join(dir, 'out', 'scene.json'), JSON.stringify({ world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: 0, source: 'flashworld' } }));
          await writeFile(join(dir, 'DONE'), '');
          await rename(dir, join(jobs, 'done', name));
        }, 300);
      }
    }, 100);
    try {
      const store = new SceneStore(join(base, 'scenes'));
      const id = 'vultr-aaaaa';
      await scene(store, id);
      const stages: string[] = [];
      const r = runner(store, 'jobs-ok', stages);
      r.enqueue(id);
      await r.idle();
      const s = (await store.get(id))!;
      expect(s.error).toBeUndefined();
      expect(s.status).toBe('ready');
      expect(s.backend).toBe('hpg-worker');
      expect(await Bun.file(join(store.sceneDir(id), 'world.spz')).text()).toBe('A40-SPZ');
      expect(stages).toContain('running:Generating the world');
      const log = await Bun.file(join(store.sceneDir(id), 'log.txt')).text();
      expect(log).toContain('running on Vultr worker');
      expect(log).toContain(`queued for the Vultr worker as ${id}-a1`);
      expect(log).not.toContain('HiPerGator');
      expect(await readdir(join(jobs, 'done'))).toContain(`${id}-a1`);
      // The repo sync mirrored pipeline/ and hpg/ into /root/dejaview/repo, without the excluded files.
      expect(await Bun.file(join(vcfg.root, 'repo', 'pipeline', 'run_job.py')).text()).toBe('# pipeline');
      expect(await Bun.file(join(vcfg.root, 'repo', 'hpg', 'worker.py')).exists()).toBe(true);
      expect(await Bun.file(join(vcfg.root, 'repo', 'pipeline', '__pycache__', 'x.pyc')).exists()).toBe(false);
    } finally {
      clearInterval(timer);
    }
    const calls = (await sshCalls()).slice(before);
    // ssh for mkdir/enqueue/polls plus rsync's own ssh for the repo sync, the upload and the download.
    expect(calls.some((a) => a.includes('rsync') && a.includes('--server'))).toBe(true);
    for (const argv of calls) {
      expect(target(argv)).toBe('root@203.0.113.7');
      expect(argv).toContain('ControlMaster=auto');
      expect(argv.join(' ')).not.toMatch(SLURM);
    }
    expect(await slurmCalled()).toBe('');
  });

  test('with no worker running nothing is sent: the worker is not running and there is no Slurm', async () => {
    await rm(join(jobs, 'worker.json'), { force: true });
    const before = (await sshCalls()).length;
    const store = new SceneStore(join(base, 'scenes-none'));
    const id = 'vultr-bbbbb';
    await scene(store, id);
    const r = runner(store, 'jobs-none');
    r.enqueue(id);
    await r.idle();
    const s = (await store.get(id))!;
    expect(s.status).toBe('failed');
    expect(s.error).toBe(NOTHING_AVAILABLE);
    const log = await Bun.file(join(store.sceneDir(id), 'log.txt')).text();
    expect(log).toContain('Vultr worker: skipped (the GPU worker is not running)');
    expect(log).toContain('HiPerGator batch: skipped (there is no Slurm on Vultr; batch jobs only run on HiPerGator)');
    expect(await readdir(join(jobs, 'queue'))).toEqual([]);
    for (const argv of (await sshCalls()).slice(before)) {
      // Only the health checks: `true` and the heartbeat read.
      expect(argv.join(' ')).not.toMatch(SLURM);
      expect(argv.join(' ')).not.toContain('rsync');
    }
    expect(await slurmCalled()).toBe('');
  });
});
