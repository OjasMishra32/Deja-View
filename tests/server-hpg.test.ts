import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchStage, hpgBatchDriver, hpgWorkerDriver } from '../server/backends/hpg.ts';
import {
  assertRemotePath,
  checkArgv,
  hpgConfig,
  HpgOfflineError,
  parseBatchPoll,
  parseSbatchOutput,
  parseWorker,
  parseWorkerPoll,
  pollBatchCommand,
  rsyncDownArgv,
  rsyncShell,
  rsyncUpArgv,
  run,
  sbatchCommand,
  shq,
  socketAlive,
  sshArgv,
  submitBatch,
  syncRepo,
  syncRepoArgvs,
  workerAlive,
  workerPollCommand,
  type HpgConfig,
} from '../server/hpg.ts';
import { JobRunner } from '../server/jobs.ts';
import { SceneStore } from '../server/store.ts';

const cfg: HpgConfig = {
  ...hpgConfig({}),
  socket: '/Users/me/.ssh/cm-hpg',
  repoDir: '/Users/me/Hack Week/ThirdWheel',
};

describe('configuration', () => {
  test('defaults match the architecture', () => {
    const c = hpgConfig({});
    expect(c.socket).toBe(join(homedir(), '.ssh/cm-hpg'));
    expect(c.user).toBe('sbernalorta');
    expect(c.host).toBe('hpg.rc.ufl.edu');
    expect(c.root).toBe('/blue/phz3152/sbernalorta/thirdwheel');
    expect(c.account).toBe('phz3152');
    expect(c.qos).toBe('phz3152');
    expect(c.partition).toBe('hpg-rtx6000');
  });
  test('environment overrides', () => {
    const c = hpgConfig({ HPG_SOCKET: '~/x/sock', HPG_USER: 'u', HPG_HOST: 'h', HPG_ROOT: '/r/', HPG_ACCOUNT: 'acc', HPG_PARTITION: 'hpg-b200' });
    expect(c.socket).toBe(join(homedir(), 'x/sock'));
    expect(c.root).toBe('/r');
    expect(c.qos).toBe('acc');
    expect(c.partition).toBe('hpg-b200');
  });
});

describe('command construction', () => {
  test('ssh only ever multiplexes over the socket', () => {
    const argv = sshArgv(cfg, 'hostname');
    expect(argv).toEqual([
      'ssh', '-S', '/Users/me/.ssh/cm-hpg', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no',
      '-o', 'ProxyCommand=/usr/bin/false', '-o', 'ConnectTimeout=10', 'sbernalorta@hpg.rc.ufl.edu', 'hostname',
    ]);
    expect(checkArgv(cfg)).toEqual(['ssh', '-S', '/Users/me/.ssh/cm-hpg', '-O', 'check', 'sbernalorta@hpg.rc.ufl.edu']);
  });

  test('rsync uses the same ssh options and trailing-slash directory semantics', () => {
    expect(rsyncShell(cfg)).toBe('ssh -S /Users/me/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false -o ConnectTimeout=10');
    expect(rsyncShell({ ...cfg, socket: '/a b/sock' })).toContain('-S "/a b/sock"');
    const up = rsyncUpArgv(cfg, '/local/job dir', '/blue/x/jobs/incoming/j1', { exclude: ['out/'] });
    expect(up).toEqual(['rsync', '-a', '--partial', '--exclude=out/', '-e', rsyncShell(cfg), '/local/job dir/', 'sbernalorta@hpg.rc.ufl.edu:/blue/x/jobs/incoming/j1/']);
    const down = rsyncDownArgv(cfg, '/blue/x/jobs/done/j1/out/', '/local/out');
    expect(down.slice(-2)).toEqual(['sbernalorta@hpg.rc.ufl.edu:/blue/x/jobs/done/j1/out/', '/local/out/']);
    expect(() => rsyncUpArgv(cfg, '/l', '/blue/x/../etc')).toThrow(/unsafe/);
    expect(() => rsyncUpArgv(cfg, '/l', '/blue/x; rm -rf ~')).toThrow(/unsafe/);
  });

  test('repo sync mirrors pipeline/ and hpg/ with --delete', () => {
    const [a, b] = syncRepoArgvs(cfg);
    expect(a).toContain('--delete');
    expect(a).toContain('/Users/me/Hack Week/ThirdWheel/pipeline/');
    expect(a!.at(-1)).toBe('sbernalorta@hpg.rc.ufl.edu:/blue/phz3152/sbernalorta/thirdwheel/repo/pipeline/');
    expect(b!.at(-1)).toBe('sbernalorta@hpg.rc.ufl.edu:/blue/phz3152/sbernalorta/thirdwheel/repo/hpg/');
    expect(a).toContain('--exclude=__pycache__');
  });

  test('sbatch command', () => {
    const cmd = sbatchCommand(cfg, '/blue/phz3152/sbernalorta/thirdwheel/jobs/batch/room-ab3k9-a1', 'tw-room ab3k9');
    expect(cmd).toBe(
      'cd /blue/phz3152/sbernalorta/thirdwheel/repo && sbatch --parsable --job-name=tw-room-ab3k9 --account=phz3152 --qos=phz3152 ' +
        '--partition=hpg-rtx6000 --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/batch/room-ab3k9-a1/slurm-%j.out hpg/job.sbatch ' +
        '/blue/phz3152/sbernalorta/thirdwheel/jobs/batch/room-ab3k9-a1',
    );
    expect(sbatchCommand({ ...cfg, partition: '' }, '/b/j', 'x')).not.toContain('--partition');
    expect(parseSbatchOutput('12345\n')).toBe('12345');
    expect(parseSbatchOutput('Submitted\n12345;hipergator\n')).toBe('12345');
    expect(() => parseSbatchOutput('sbatch: error: invalid account')).toThrow(/unexpected sbatch output/);
  });

  test('quoting and remote path checks', () => {
    expect(shq('/blue/a_b-c.d')).toBe('/blue/a_b-c.d');
    expect(shq("it's here")).toBe(`'it'\\''s here'`);
    expect(shq('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
    expect(() => assertRemotePath('relative/x')).toThrow();
    expect(assertRemotePath('/blue/x/y')).toBe('/blue/x/y');
    expect(() => pollBatchCommand(cfg, '12;rm', '/b/j')).toThrow(/invalid slurm job id/);
    expect(() => workerPollCommand(cfg, 'a b')).toThrow(/invalid job id/);
  });
});

describe('output parsing', () => {
  test('batch poll: pending, running, completed, failed', () => {
    const pending = parseBatchPoll('::tw:squeue::\nPENDING|Priority|0:00\n::tw:sacct::\nPENDING|0:0|00:00:00\n::tw:progress::\n\n::tw:markers::\n::tw:failed::\n\n::tw:log::\n::tw:end::\n');
    expect(pending).toMatchObject({ state: 'PENDING', reason: 'Priority', terminal: false, done: false, failed: false });
    expect(batchStage(pending)).toBe('Waiting for a GPU (other jobs first)');
    const running = parseBatchPoll('::tw:squeue::\nRUNNING|None|1:02\n::tw:sacct::\nRUNNING|0:0|00:01:02\n::tw:progress::\n{"stage":"Generating the world","progress":0.4}\n::tw:markers::\n::tw:end::');
    expect(running).toMatchObject({ state: 'RUNNING', terminal: false, progress: { stage: 'Generating the world', progress: 0.4 } });
    expect(running.reason).toBeUndefined();
    const done = parseBatchPoll('::tw:squeue::\n::tw:sacct::\nCOMPLETED|0:0|00:03:10\n::tw:progress::\n{"stage":"Done","progress":1,"done":true}\n::tw:markers::\nDONE\n::tw:failed::\n\n::tw:log::\nall good\n::tw:end::');
    expect(done).toMatchObject({ state: 'COMPLETED', terminal: true, done: true, failed: false, exitCode: '0:0', logTail: 'all good' });
    const failed = parseBatchPoll('::tw:squeue::\n::tw:sacct::\nCANCELLED by 123|0:15|00:00:09\n::tw:progress::\n::tw:markers::\nFAILED\n::tw:failed::\nCUDA out of memory\n::tw:end::');
    expect(failed).toMatchObject({ state: 'CANCELLED', terminal: true, failed: true, failText: 'CUDA out of memory' });
    expect(parseBatchPoll('')).toMatchObject({ state: 'UNKNOWN', terminal: false });
    expect(parseBatchPoll('::tw:progress::\n{"stage": "half wri').progress).toBeUndefined();
  });

  test('worker heartbeat freshness uses the remote clock', () => {
    const now = 1_760_000_000;
    const out = (beat: string, mtime = '') => `::tw:worker::\n${beat}\n::tw:now::\n${now}\n::tw:mtime::\n${mtime}\n::tw:end::\n`;
    expect(parseWorker(out(`{"time": ${now - 30}, "host": "c1103a-s17", "gpu": "RTX PRO 6000"}`))).toMatchObject({ alive: true, host: 'c1103a-s17', gpu: 'RTX PRO 6000', age: 30 });
    expect(parseWorker(out(`{"time": ${(now - 120) * 1000}}`)).alive).toBe(false);
    expect(parseWorker(out(`{"time": "${new Date((now - 10) * 1000).toISOString()}"}`))).toMatchObject({ alive: true, age: 10 });
    expect(parseWorker(out('{}', String(now - 5)))).toMatchObject({ alive: true, age: 5 });
    expect(parseWorker(out('not json', String(now - 500))).alive).toBe(false);
    expect(parseWorker(out('')).alive).toBe(false);
  });

  test('worker job poll', () => {
    const p = parseWorkerPoll('::tw:where::running\n::tw:progress::\n{"stage":"x","progress":0.2}\n::tw:markers::\n::tw:failed::\n\n::tw:log::\n::tw:end::\n::tw:worker::\n{"time": 100}\n::tw:now::\n110\n::tw:mtime::\n\n::tw:end::');
    expect(p.where).toBe('running');
    expect(p.progress?.progress).toBe(0.2);
    expect(p.worker.alive).toBe(true);
    expect(parseWorkerPoll('::tw:where::weird').where).toBe('missing');
  });
});

describe('without a socket everything fails fast and cleanly', () => {
  const offline: HpgConfig = { ...cfg, socket: join(tmpdir(), 'tw-no-such-socket') };
  test('socketAlive / workerAlive are false without spawning ssh', async () => {
    const t0 = performance.now();
    expect(await socketAlive(offline)).toBe(false);
    expect(await workerAlive(offline)).toEqual({ alive: false });
    expect(performance.now() - t0).toBeLessThan(200);
  });
  test('run, submitBatch and syncRepo reject with HpgOfflineError and the login hint', async () => {
    await expect(run('hostname', { cfg: offline })).rejects.toBeInstanceOf(HpgOfflineError);
    await expect(submitBatch('/b/j', 'x', offline)).rejects.toThrow(/log in once: ssh -o ControlMaster=auto/);
    await expect(syncRepo(offline)).rejects.toBeInstanceOf(HpgOfflineError);
  });
  test('THIRDWHEEL_HPG=off disables every live call even when a socket exists', async () => {
    const sockPath = join(tmpdir(), `tw-off-${process.pid}.sock`);
    const l = Bun.listen({ unix: sockPath, socket: { data() {} } });
    try {
      const off = { ...hpgConfig({ THIRDWHEEL_HPG: 'off' }), socket: sockPath, ssh: '/nonexistent/ssh' };
      expect(off.enabled).toBe(false);
      expect(await socketAlive(off)).toBe(false);
      await expect(run('true', { cfg: off })).rejects.toThrow('disabled (THIRDWHEEL_HPG=off)');
      expect(hpgConfig({}).enabled).toBe(true);
    } finally {
      l.stop(true);
      await rm(sockPath, { force: true });
    }
  });
  test('a regular file at the socket path is not a socket', async () => {
    const f = join(tmpdir(), `tw-not-socket-${process.pid}`);
    await writeFile(f, 'x');
    expect(await socketAlive({ ...cfg, socket: f })).toBe(false);
    await rm(f);
  });
});

// ------------------------------------------------------------------------------------------------
// End to end with a stand-in ssh that runs "remote" commands locally against a temporary HPG_ROOT.

describe('HPG backends end to end (stand-in ssh, real rsync)', () => {
  let base: string;
  let listener: ReturnType<typeof Bun.listen> | null = null;
  let lcfg: HpgConfig;
  let workerTimer: ReturnType<typeof setInterval> | null = null;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'twh-'));
    const bin = join(base, 'bin');
    await mkdir(bin, { recursive: true });
    const sock = join(base, 'cm');
    listener = Bun.listen({ unix: sock, socket: { data() {} } });
    // ssh stand-in: honours -O check, records the target, runs the command with fake Slurm tools on PATH.
    await writeFile(
      join(bin, 'ssh'),
      `#!/bin/sh
op=""
while [ $# -gt 0 ]; do
  case "$1" in
    -S|-o|-p|-l|-i|-e) shift 2;;
    -O) op="$2"; shift 2;;
    -*) shift;;
    *) target="$1"; shift; break;;
  esac
done
echo "$target" >> "${base}/ssh.log"
[ -n "$op" ] && exit 0
PATH="${bin}:$PATH" exec /bin/sh -c "$*"
`,
    );
    // Slurm stand-ins. sbatch "runs" the job in the background and records its state.
    await writeFile(
      join(bin, 'sbatch'),
      `#!/bin/sh
for a in "$@"; do JOB="$a"; done
ID=4242
echo PENDING > "${base}/slurm-$ID"
if [ -f "${base}/stay-pending" ]; then echo "$ID;hipergator"; exit 0; fi
( sleep 0.3; echo RUNNING > "${base}/slurm-$ID";
  echo '{"stage":"Generating the world","progress":0.5}' > "$JOB/progress.json"; sleep 0.3;
  mkdir -p "$JOB/out"; printf 'SPZ' > "$JOB/out/world.spz";
  echo '{"world":{"file":"world.spz","transform":{"position":[0,1.45,0],"quaternion":[0,0,0,1],"scale":1},"floorY":0,"source":"flashworld"},"caption":"from slurm"}' > "$JOB/out/scene.json";
  echo "job log line" > "$JOB/log.txt"; touch "$JOB/DONE"; echo COMPLETED > "${base}/slurm-$ID" ) > /dev/null 2>&1 &
echo "$ID;hipergator"
`,
    );
    await writeFile(join(bin, 'squeue'), `#!/bin/sh\nS=$(cat "${base}/slurm-4242" 2>/dev/null)\ncase "$S" in PENDING) echo "PENDING|Resources|0:00";; RUNNING) echo "RUNNING|None|0:01";; esac\n`);
    await writeFile(join(bin, 'sacct'), `#!/bin/sh\nS=$(cat "${base}/slurm-4242" 2>/dev/null)\n[ -n "$S" ] && echo "$S|0:0|00:00:01"\n`);
    await writeFile(join(bin, 'scancel'), `#!/bin/sh\necho CANCELLED > "${base}/slurm-$1"\n`);
    for (const f of ['ssh', 'sbatch', 'squeue', 'sacct', 'scancel']) await chmod(join(bin, f), 0o755);

    const repo = join(base, 'local repo');
    await mkdir(join(repo, 'pipeline'), { recursive: true });
    await mkdir(join(repo, 'hpg'), { recursive: true });
    await writeFile(join(repo, 'pipeline', 'run_job.py'), '# pipeline');
    await writeFile(join(repo, 'hpg', 'job.sbatch'), '#!/bin/bash');
    await mkdir(join(repo, 'pipeline', '__pycache__'), { recursive: true });
    await writeFile(join(repo, 'pipeline', '__pycache__', 'x.pyc'), 'junk');
    lcfg = { ...hpgConfig({}), socket: sock, ssh: join(bin, 'ssh'), root: join(base, 'remote'), repoDir: repo, connectTimeout: 5 };
    await mkdir(lcfg.root, { recursive: true });
  });

  afterAll(async () => {
    if (workerTimer) clearInterval(workerTimer);
    listener?.stop(true);
    await rm(base, { recursive: true, force: true });
  });

  test('socket, run and repo sync', async () => {
    expect(await socketAlive(lcfg)).toBe(true);
    const r = await run('echo hello-from-hpg', { cfg: lcfg });
    expect(r.stdout.trim()).toBe('hello-from-hpg');
    await syncRepo(lcfg);
    expect(await Bun.file(join(lcfg.root, 'repo', 'pipeline', 'run_job.py')).text()).toBe('# pipeline');
    expect(await Bun.file(join(lcfg.root, 'repo', 'hpg', 'job.sbatch')).exists()).toBe(true);
    expect(await Bun.file(join(lcfg.root, 'repo', 'pipeline', '__pycache__', 'x.pyc')).exists()).toBe(false);
    expect((await Bun.file(join(base, 'ssh.log')).text()).trim().split('\n').every((l) => l === 'sbernalorta@hpg.rc.ufl.edu')).toBe(true);
  });

  async function setup(driverName: 'hpg-worker' | 'hpg-batch', pendingTimeoutMs?: number) {
    const store = new SceneStore(join(base, `${driverName}-scenes`));
    const id = `${driverName}-aaaaa`;
    await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
    await writeFile(join(store.sceneDir(id), 'input', '00.jpg'), 'photo');
    await store.save({ id, name: id, mode: 'rentfree', status: 'queued', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/00.jpg'] } });
    const probe = { online: async () => ({ online: true }), worker: () => workerAlive(lcfg) };
    const driver =
      driverName === 'hpg-worker'
        ? hpgWorkerDriver({ probe, cfg: () => lcfg, pollMs: 100 })
        : hpgBatchDriver({ probe, cfg: () => lcfg, pollMs: 100, pendingTimeoutMs });
    const stages: string[] = [];
    const runner = new JobRunner({ store, jobsDir: join(base, `${driverName}-jobs`), drivers: [driver], emit: (s) => s.stage && stages.push(`${s.status}:${s.stage}`), reportIntervalMs: 10 });
    return { store, id, runner, driver, stages };
  }

  test('hpg-worker: upload, queue, claim, progress, download', async () => {
    const jobs = join(lcfg.root, 'jobs');
    await mkdir(join(jobs, 'running'), { recursive: true });
    await mkdir(join(jobs, 'done'), { recursive: true });
    const beat = () => writeFile(join(jobs, 'worker.json'), JSON.stringify({ time: Date.now() / 1000, host: 'c1103a-s17', gpu: 'NVIDIA RTX PRO 6000' }));
    await beat();
    const claimed = new Set<string>();
    workerTimer = setInterval(async () => {
      await beat();
      for (const name of await readdir(join(jobs, 'queue')).catch(() => [])) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        const dir = join(jobs, 'running', name);
        await rename(join(jobs, 'queue', name), dir);
        const job = await Bun.file(join(dir, 'job.json')).json();
        expect(job.params.backend).toBe('hpg-worker');
        expect(await Bun.file(join(dir, 'input', '00.jpg')).text()).toBe('photo');
        await writeFile(join(dir, 'progress.json'), JSON.stringify({ stage: 'Generating the world', progress: 0.6 }));
        setTimeout(async () => {
          await mkdir(join(dir, 'out'), { recursive: true });
          await writeFile(join(dir, 'out', 'world.spz'), 'WORKER-SPZ');
          await writeFile(join(dir, 'out', 'scene.json'), JSON.stringify({ world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'flashworld' } }));
          await writeFile(join(dir, 'DONE'), '');
          await rename(dir, join(jobs, 'done', name));
        }, 400);
      }
    }, 100);

    const { store, id, runner, driver, stages } = await setup('hpg-worker');
    expect(await driver.available()).toEqual({ ok: true });
    runner.enqueue(id);
    await runner.idle();
    clearInterval(workerTimer);
    workerTimer = null;
    const s = (await store.get(id))!;
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('ready');
    expect(s.backend).toBe('hpg-worker');
    expect(await Bun.file(join(store.sceneDir(id), 'world.spz')).text()).toBe('WORKER-SPZ');
    expect(stages).toContain('uploading:Sending to the GPU cluster');
    expect(stages).toContain('running:Generating the world');
    expect(stages.some((x) => x.startsWith('downloading:'))).toBe(true);
    expect(await readdir(join(jobs, 'done'))).toEqual([`${id}-a1`]);
  });

  test('hpg-worker: queue time while the worker is still loading its models does not count against the claim timeout', async () => {
    const jobs = join(lcfg.root, 'jobs');
    await mkdir(join(jobs, 'running'), { recursive: true });
    await mkdir(join(jobs, 'done'), { recursive: true });
    const t0 = Date.now();
    // Loading for 1.2 s, then idle: the claim timeout is 0.4 s, so only the warm-up allowance keeps the job.
    const status = () => (Date.now() - t0 < 1200 ? 'loading' : 'idle');
    const beat = () => writeFile(join(jobs, 'worker.json'), JSON.stringify({ time: Date.now() / 1000, host: 'c1', gpu: 'GPU', status: status() }));
    await beat();
    const claimed = new Set<string>();
    const timer = setInterval(async () => {
      await beat();
      if (status() === 'loading') return;
      for (const name of await readdir(join(jobs, 'queue')).catch(() => [])) {
        if (claimed.has(name)) continue;
        claimed.add(name);
        const dir = join(jobs, 'running', name);
        await rename(join(jobs, 'queue', name), dir);
        await mkdir(join(dir, 'out'), { recursive: true });
        await writeFile(join(dir, 'out', 'world.spz'), 'SPZ');
        await writeFile(join(dir, 'out', 'scene.json'), JSON.stringify({ world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'flashworld' } }));
        await writeFile(join(dir, 'DONE'), '');
        await rename(dir, join(jobs, 'done', name));
      }
    }, 100);
    try {
      const store = new SceneStore(join(base, 'warm-scenes'));
      const id = 'warm-aaaaa';
      await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
      await writeFile(join(store.sceneDir(id), 'input', '00.jpg'), 'photo');
      await store.save({ id, name: id, mode: 'rentfree', status: 'queued', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/00.jpg'] } });
      const probe = { online: async () => ({ online: true }), worker: () => workerAlive(lcfg) };
      const stages: string[] = [];
      const runner = new JobRunner({
        store,
        jobsDir: join(base, 'warm-jobs'),
        drivers: [hpgWorkerDriver({ probe, cfg: () => lcfg, pollMs: 100, claimTimeoutMs: 400, loadingTimeoutMs: 10_000 })],
        emit: (s) => s.stage && stages.push(s.stage),
        reportIntervalMs: 10,
      });
      runner.enqueue(id);
      await runner.idle();
      const s = (await store.get(id))!;
      expect(s.error).toBeUndefined();
      expect(s.status).toBe('ready');
      expect(stages).toContain('Waiting for the GPU to warm up');
    } finally {
      clearInterval(timer);
    }
  });

  test('hpg-worker is unavailable when the heartbeat is stale', async () => {
    await writeFile(join(lcfg.root, 'jobs', 'worker.json'), JSON.stringify({ time: Date.now() / 1000 - 600 }));
    const { driver } = await setup('hpg-worker');
    const a = await driver.available();
    expect(a.ok).toBe(false);
  });

  test('hpg-batch: sync, submit, pending -> running -> completed, download', async () => {
    const { store, id, runner, stages } = await setup('hpg-batch');
    runner.enqueue(id);
    await runner.idle();
    const s = (await store.get(id))!;
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('ready');
    expect(s.backend).toBe('hpg-batch');
    expect(s.caption).toBe('from slurm');
    expect(s.world?.floorY).toBe(0);
    expect(await Bun.file(join(store.sceneDir(id), 'world.spz')).text()).toBe('SPZ');
    expect(stages).toContain('queued:Waiting for a GPU (all busy)');
    expect(stages).toContain('running:Generating the world');
    const state = await Bun.file(join(base, 'hpg-batch-jobs', id, 'state.json')).json();
    expect(state.slurmId).toBe('4242');
    expect(state.remoteDir).toBe(join(lcfg.root, 'jobs', 'batch', `${id}-a1`));
    const log = await Bun.file(join(store.sceneDir(id), 'log.txt')).text();
    expect(log).toContain('submitted Slurm job 4242 (hpg-rtx6000)');
    expect(log).toContain('job log line');
  });

  test('hpg-batch: a job stuck in the queue is cancelled after the pending timeout', async () => {
    await writeFile(join(base, 'stay-pending'), '');
    try {
      const store = new SceneStore(join(base, 'pending-scenes'));
      const id = 'pending-aaaaa';
      await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
      await writeFile(join(store.sceneDir(id), 'input', '00.jpg'), 'photo');
      await store.save({ id, name: id, mode: 'rentfree', status: 'queued', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/00.jpg'] } });
      const probe = { online: async () => ({ online: true }), worker: async () => ({ alive: false }) };
      const runner = new JobRunner({
        store,
        jobsDir: join(base, 'pending-jobs'),
        drivers: [hpgBatchDriver({ probe, cfg: () => lcfg, pollMs: 100, pendingTimeoutMs: 400 })],
        emit: () => {},
      });
      runner.enqueue(id);
      await runner.idle();
      const s = (await store.get(id))!;
      expect(s.status).toBe('failed');
      expect(s.error).toBe('No GPU became free in time. Try again in a few minutes.');
      expect(await Bun.file(join(store.sceneDir(id), 'log.txt')).text()).toContain(
        'no HiPerGator GPU became free within 0 min (Slurm: Resources); the request was cancelled',
      );
      expect((await Bun.file(join(base, 'slurm-4242')).text()).trim()).toBe('CANCELLED');
    } finally {
      await rm(join(base, 'stay-pending'), { force: true });
    }
  });
});
