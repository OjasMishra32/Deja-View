// The backup GPU box (VULTR_HOST, vultr/README.md) reuses server/hpg.ts. Two promises are checked here without any
// process: with no VULTR_HOST nothing about HiPerGator changes, byte for byte; with it, every command targets the box
// and none is a Slurm command.

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hpgBatchDriver, hpgWorkerDriver } from '../server/backends/hpg.ts';
import { ResumeImpossible } from '../server/backends/types.ts';
import { ROOT } from '../server/config.ts';
import {
  cancelBatch,
  checkArgv,
  enqueueWorkerCommand,
  hpgConfig,
  offlineReason,
  pollBatch,
  pollBatchCommand,
  rsyncDownArgv,
  rsyncShell,
  rsyncUpArgv,
  sbatchCommand,
  sshArgv,
  submitBatch,
  syncRepoArgvs,
  workerCommand,
  workerPollCommand,
  type HpgConfig,
} from '../server/hpg.ts';

const SLURM = /\b(sbatch|squeue|sacct|scancel|srun|sinfo)\b/;
/** The HPG lines of .env.example: a Mac set up for HiPerGator keeps them while VULTR_HOST is on. */
const DOTENV = {
  HPG_USER: 'sbernalorta',
  HPG_HOST: 'hpg.rc.ufl.edu',
  HPG_SOCKET: '~/.ssh/cm-hpg',
  HPG_ROOT: '/blue/phz3152/sbernalorta/thirdwheel',
  HPG_ACCOUNT: 'phz3152',
  HPG_QOS: 'phz3152',
  HPG_PARTITION: 'hpg-rtx6000',
};

describe('without VULTR_HOST: HiPerGator exactly as before', () => {
  test('the configuration', () => {
    const expected: HpgConfig = {
      enabled: true,
      socket: join(homedir(), '.ssh/cm-hpg'),
      user: 'sbernalorta',
      host: 'hpg.rc.ufl.edu',
      root: '/blue/phz3152/sbernalorta/thirdwheel',
      account: 'phz3152',
      qos: 'phz3152',
      partition: 'hpg-rtx6000',
      ssh: 'ssh',
      rsync: 'rsync',
      connectTimeout: 10,
      repoDir: ROOT,
      site: 'HiPerGator',
      slurm: true,
      login: 'socket',
      identity: '',
      sshExtra: [],
    };
    expect(hpgConfig({})).toEqual(expected);
    expect(hpgConfig(DOTENV)).toEqual(expected);
    // VULTR_* without VULTR_HOST does nothing, and neither does a blank VULTR_HOST.
    expect(hpgConfig({ ...DOTENV, VULTR_HOST: '  ', VULTR_USER: 'ubuntu', VULTR_ROOT: '/srv/x', VULTR_SSH_KEY: '~/.ssh/k' })).toEqual(expected);
  });

  // Every string below was printed by server/hpg.ts before the Vultr change, for the same inputs.
  const cfg: HpgConfig = { ...hpgConfig({}), socket: '/Users/me/.ssh/cm-hpg', repoDir: '/Users/me/Hack Week/ThirdWheel' };
  const RSH = 'ssh -S /Users/me/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false -o ConnectTimeout=10';
  const R = '/blue/phz3152/sbernalorta/thirdwheel';
  const report = (d: string) =>
    `echo "::tw:progress::"; cat ${d}/progress.json 2>/dev/null; echo; echo "::tw:markers::"; [ -f ${d}/DONE ] && echo DONE; ` +
    `[ -f ${d}/FAILED ] && echo FAILED; echo "::tw:failed::"; head -c 4000 ${d}/FAILED 2>/dev/null; echo; echo "::tw:log::"; ` +
    `tail -n 15 ${d}/log.txt 2>/dev/null; echo "::tw:end::"`;
  const worker =
    `echo "::tw:worker::"; cat ${R}/jobs/worker.json 2>/dev/null; echo; echo "::tw:now::"; date +%s; echo "::tw:mtime::"; ` +
    `stat -c %Y ${R}/jobs/worker.json 2>/dev/null; echo "::tw:end::"`;
  const EXCLUDES = ['--exclude=__pycache__', '--exclude=*.pyc', '--exclude=.DS_Store', '--exclude=.ipynb_checkpoints', '--exclude=jobs/'];

  test('ssh and rsync argv', () => {
    expect(sshArgv(cfg, 'hostname')).toEqual([
      'ssh', '-S', '/Users/me/.ssh/cm-hpg', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ProxyCommand=/usr/bin/false',
      '-o', 'ConnectTimeout=10', 'sbernalorta@hpg.rc.ufl.edu', 'hostname',
    ]);
    expect(checkArgv(cfg)).toEqual(['ssh', '-S', '/Users/me/.ssh/cm-hpg', '-O', 'check', 'sbernalorta@hpg.rc.ufl.edu']);
    expect(rsyncShell(cfg)).toBe(RSH);
    expect(rsyncShell({ ...cfg, socket: '/a b/sock' })).toBe(
      'ssh -S "/a b/sock" -o BatchMode=yes -o ControlMaster=no -o ProxyCommand=/usr/bin/false -o ConnectTimeout=10',
    );
    expect(rsyncUpArgv(cfg, '/local/job dir', `${R}/jobs/incoming/j1`, { exclude: ['out/', 'DONE'] })).toEqual([
      'rsync', '-a', '--partial', '--exclude=out/', '--exclude=DONE', '-e', RSH, '/local/job dir/', `sbernalorta@hpg.rc.ufl.edu:${R}/jobs/incoming/j1/`,
    ]);
    expect(rsyncDownArgv(cfg, `${R}/jobs/done/j1/out`, '/local/out')).toEqual([
      'rsync', '-a', '--partial', '-e', RSH, `sbernalorta@hpg.rc.ufl.edu:${R}/jobs/done/j1/out/`, '/local/out/',
    ]);
    expect(syncRepoArgvs(cfg)).toEqual(
      ['pipeline', 'hpg'].map((d) => [
        'rsync', '-a', '--partial', '--delete', ...EXCLUDES, '-e', RSH, `/Users/me/Hack Week/ThirdWheel/${d}/`, `sbernalorta@hpg.rc.ufl.edu:${R}/repo/${d}/`,
      ]),
    );
  });

  test('remote commands', () => {
    expect(sbatchCommand(cfg, `${R}/jobs/batch/j1`, 'tw-room')).toBe(
      `cd ${R}/repo && sbatch --parsable --job-name=tw-room --account=phz3152 --qos=phz3152 --partition=hpg-rtx6000 ` +
        `--output=${R}/jobs/batch/j1/slurm-%j.out hpg/job.sbatch ${R}/jobs/batch/j1`,
    );
    expect(pollBatchCommand(cfg, '4242', `${R}/jobs/batch/j1`)).toBe(
      `echo "::tw:squeue::"; squeue -h -j 4242 -o '%T|%r|%M' 2>/dev/null; echo "::tw:sacct::"; ` +
        `sacct -j 4242 -X -n -P -o State,ExitCode,Elapsed 2>/dev/null; ${report(`${R}/jobs/batch/j1`)}`,
    );
    expect(workerCommand(cfg)).toBe(worker);
    expect(workerPollCommand(cfg, 'room-aaaaa-a1')).toBe(
      `W=missing; for s in queue running done; do if [ -d ${R}/jobs/$s/room-aaaaa-a1 ]; then W=$s; break; fi; done; ` +
        `echo "::tw:where::$W"; D=${R}/jobs/$W/room-aaaaa-a1; ${report('"$D"')}; ${worker}`,
    );
    expect(enqueueWorkerCommand(cfg, 'room-aaaaa-a1')).toBe(
      `mkdir -p ${R}/jobs/queue && mv ${R}/jobs/incoming/room-aaaaa-a1 ${R}/jobs/queue/room-aaaaa-a1`,
    );
    expect(offlineReason(cfg)).toBe(
      'offline, no SSH session at /Users/me/.ssh/cm-hpg (log in once: ssh -o ControlMaster=auto -o ControlPath=/Users/me/.ssh/cm-hpg ' +
        '-o ControlPersist=24h sbernalorta@hpg.rc.ufl.edu)',
    );
  });
});

describe('with VULTR_HOST: the rented box, key login, no Slurm', () => {
  const env = { ...DOTENV, VULTR_HOST: ' 203.0.113.7 ', VULTR_SSH_KEY: '~/.ssh/dejaview_ed25519' };
  const v = hpgConfig(env);
  const KEY = join(homedir(), '.ssh/dejaview_ed25519');
  const SOCK = join(homedir(), '.ssh/cm-vultr-%C');
  const OPTS = [
    '-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', `ControlPath=${SOCK}`, '-o', 'ControlPersist=10m',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=10',
    '-i', KEY, '-o', 'IdentitiesOnly=yes',
  ];

  test('target, root and login replace the HiPerGator ones, whatever HPG_* says', () => {
    expect(v).toMatchObject({
      enabled: true,
      site: 'Vultr',
      host: '203.0.113.7',
      user: 'root',
      root: '/root/dejaview',
      socket: SOCK,
      slurm: false,
      login: 'key',
      identity: KEY,
      sshExtra: [],
      account: '',
      qos: '',
      partition: '',
    });
    const o = hpgConfig({ VULTR_HOST: 'gpu.example.net', VULTR_USER: 'ubuntu', VULTR_ROOT: '/data/dejaview/', VULTR_SOCKET: '/tmp/cm-v', VULTR_SSH_OPTS: ' -p 2222  -o Compression=yes ' });
    expect(o).toMatchObject({ host: 'gpu.example.net', user: 'ubuntu', root: '/data/dejaview', socket: '/tmp/cm-v', identity: '', sshExtra: ['-p', '2222', '-o', 'Compression=yes'] });
    expect(sshArgv(o, 'true').slice(-6)).toEqual(['-p', '2222', '-o', 'Compression=yes', 'ubuntu@gpu.example.net', 'true']);
    expect(hpgConfig({ ...env, THIRDWHEEL_HPG: 'off' }).enabled).toBe(false);
  });

  test('ssh logs in by itself (BatchMode, never through ProxyCommand=/usr/bin/false) and reuses its own master', () => {
    expect(sshArgv(v, 'hostname')).toEqual(['ssh', ...OPTS, 'root@203.0.113.7', 'hostname']);
    expect(sshArgv(v, 'x').join(' ')).not.toContain('ProxyCommand');
    expect(rsyncShell(v)).toBe(`ssh ${OPTS.join(' ')}`);
    // rsync splits -e on whitespace, so a key path with a space is quoted as one word.
    expect(rsyncShell({ ...v, identity: '/Users/me/My Keys/k' })).toContain('-i "/Users/me/My Keys/k" -o IdentitiesOnly=yes');
    expect(rsyncShell({ ...v, socket: '/a b/cm-%C' })).toContain('-o "ControlPath=/a b/cm-%C" -o ControlPersist=10m');
  });

  test('every path is under /root/dejaview on root@203.0.113.7', () => {
    expect(rsyncUpArgv(v, '/local/job', '/root/dejaview/jobs/incoming/j1', { exclude: ['out/'] }).slice(-2)).toEqual([
      '/local/job/', 'root@203.0.113.7:/root/dejaview/jobs/incoming/j1/',
    ]);
    expect(rsyncDownArgv(v, '/root/dejaview/jobs/done/j1/out', '/local/out').slice(-2)).toEqual([
      'root@203.0.113.7:/root/dejaview/jobs/done/j1/out/', '/local/out/',
    ]);
    const [a, b] = syncRepoArgvs(v);
    expect(a!.at(-1)).toBe('root@203.0.113.7:/root/dejaview/repo/pipeline/');
    expect(b!.at(-1)).toBe('root@203.0.113.7:/root/dejaview/repo/hpg/');
    expect(a).toContain('--delete');
    expect(a).toContain('--exclude=__pycache__');
    expect(workerCommand(v)).toContain('cat /root/dejaview/jobs/worker.json');
    expect(workerPollCommand(v, 'room-aaaaa-a1')).toContain('[ -d /root/dejaview/jobs/$s/room-aaaaa-a1 ]');
    expect(enqueueWorkerCommand(v, 'j1')).toBe('mkdir -p /root/dejaview/jobs/queue && mv /root/dejaview/jobs/incoming/j1 /root/dejaview/jobs/queue/j1');
  });

  test('no Slurm command is ever built, and the worker path never needed one', () => {
    for (const c of [workerCommand(v), workerPollCommand(v, 'j1'), enqueueWorkerCommand(v, 'j1'), ...syncRepoArgvs(v).flat(), ...sshArgv(v, 'true')]) {
      expect(c).not.toMatch(SLURM);
    }
    expect(() => sbatchCommand(v, '/root/dejaview/jobs/batch/j1', 'tw-x')).toThrow('there is no Slurm on Vultr; batch jobs only run on HiPerGator');
    expect(() => pollBatchCommand(v, '4242', '/root/dejaview/jobs/batch/j1')).toThrow(/no Slurm on Vultr/);
  });

  test('the Slurm entry points refuse before spawning anything', async () => {
    // A missing ssh binary would fail with "cannot run": reaching the Slurm check first proves nothing was spawned.
    const noSsh = { ...v, ssh: '/nonexistent/ssh', rsync: '/nonexistent/rsync' };
    await expect(submitBatch('/root/dejaview/jobs/batch/j1', 'x', noSsh)).rejects.toThrow(/no Slurm on Vultr/);
    await expect(pollBatch('4242', '/root/dejaview/jobs/batch/j1', noSsh)).rejects.toThrow(/no Slurm on Vultr/);
    await expect(cancelBatch('4242', noSsh)).resolves.toBeUndefined();
  });

  test('hpg-batch is unavailable without even asking the probe', async () => {
    let probed = 0;
    const probe = {
      online: async () => (probed++, { online: true }),
      worker: async () => (probed++, { alive: false }),
    };
    const d = hpgBatchDriver({ probe, cfg: () => v });
    expect(await d.available()).toEqual({ ok: false, reason: 'there is no Slurm on Vultr; batch jobs only run on HiPerGator' });
    expect(probed).toBe(0);
    // On HiPerGator the same driver still asks.
    expect((await hpgBatchDriver({ probe, cfg: () => hpgConfig({}) }).available()).ok).toBe(true);
    expect(probed).toBe(2);
  });

  test('the offline reason says how to check the login', () => {
    expect(offlineReason(v)).toBe(
      'offline, cannot log in to root@203.0.113.7 over SSH (check VULTR_HOST and the key: ssh -i ~/.ssh/dejaview_ed25519 root@203.0.113.7 true)',
    );
    expect(offlineReason(hpgConfig({ VULTR_HOST: '203.0.113.7' }))).toBe(
      'offline, cannot log in to root@203.0.113.7 over SSH (check VULTR_HOST and the key: ssh root@203.0.113.7 true)',
    );
    expect(offlineReason(hpgConfig({ VULTR_HOST: '203.0.113.7', VULTR_SSH_OPTS: '-p 2222' }))).toBe(
      'offline, cannot log in to root@203.0.113.7 over SSH (check VULTR_HOST and the key: ssh -p 2222 root@203.0.113.7 true)',
    );
  });

  test('a warm-worker job queued on the other GPU box starts over after a restart instead of failing', async () => {
    const probe = { online: async () => ({ online: true }), worker: async () => ({ alive: true }) };
    // Nothing is spawned before the check: a missing ssh would fail with "cannot run" instead.
    const noSsh = { ...v, ssh: '/nonexistent/ssh', rsync: '/nonexistent/rsync' };
    const resume = (cfg: HpgConfig, remoteDir: string) =>
      hpgWorkerDriver({ probe, cfg: () => cfg }).run({ resume: true, state: { jobId: 'room-aaaaa-a1', remoteDir } } as any);
    const onHpg = '/blue/phz3152/sbernalorta/thirdwheel/jobs/queue/room-aaaaa-a1';
    const e = await resume(noSsh, onHpg).catch((x) => x);
    expect(e).toBeInstanceOf(ResumeImpossible);
    expect(e.message).toBe(`the job was queued under ${onHpg}, not on Vultr`);
    // And back: a job left on the box does not confuse HiPerGator.
    const back = await resume({ ...hpgConfig({}), ssh: '/nonexistent/ssh' }, '/root/dejaview/jobs/running/room-aaaaa-a1').catch((x) => x);
    expect(back).toBeInstanceOf(ResumeImpossible);
  });
});
