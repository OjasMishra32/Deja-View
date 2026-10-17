// vultr/*.sh on this machine: syntax, push.sh against a stand-in box, and worker.sh running the real hpg/worker.py
// (no GPU, no preload) while the server's own workerAlive() watches its heartbeat.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hpgConfig, workerAlive, type HpgConfig, type WorkerStatus } from '../server/hpg.ts';

const REPO = join(import.meta.dir, '..');
const SCRIPTS = ['setup.sh', 'worker.sh', 'push.sh'].map((f) => join(REPO, 'vultr', f));
const PYTHON = Bun.which('python3');

let base: string;
let bin: string;

function sh(argv: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(argv, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) {
    await Bun.sleep(150);
    v = await fn();
  }
  return v;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'dv-vscripts-'));
  bin = join(base, 'bin');
  await mkdir(bin, { recursive: true });
  // ssh stand-in on PATH: records argv, runs the "remote" command here.
  await writeFile(
    join(bin, 'ssh'),
    `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "${base}/ssh.log"
echo >> "${base}/ssh.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-i|-p|-l|-S|-e|-F|-J) shift 2;;
    -*) shift;;
    *) shift; break;;
  esac
done
exec /bin/sh -c "$*"
`,
  );
  await chmod(join(bin, 'ssh'), 0o755);
});

afterAll(async () => {
  // Stop any worker this file started (its pid file is under the temporary root).
  const pid = Number(await Bun.file(join(base, 'box', 'state', 'worker.pid')).text().catch(() => ''));
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await rm(base, { recursive: true, force: true });
});

test('every script parses (bash -n), with the system bash too', () => {
  for (const shell of ['bash', '/bin/bash']) {
    for (const f of SCRIPTS) {
      const r = sh([shell, '-n', f]);
      expect({ f, shell, code: r.code, err: r.err }).toEqual({ f, shell, code: 0, err: '' });
    }
  }
});

describe('vultr/push.sh', () => {
  test('mirrors pipeline/, hpg/ and vultr/ with the server excludes and the server ssh options', async () => {
    const root = join(base, 'pushed', 'dejaview');
    await mkdir(join(root, 'repo', 'hpg'), { recursive: true });
    await writeFile(join(root, 'repo', 'hpg', 'stale.txt'), 'gone after the push');
    await writeFile(join(root, 'repo', 'keep.txt'), 'not ours to delete');
    const r = sh(['bash', join(REPO, 'vultr', 'push.sh'), '203.0.113.7'], { VULTR_ROOT: root, VULTR_SSH_KEY: '~/.ssh/dejaview_ed25519', VULTR_SSH_OPTS: '-p 22' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pushed pipeline/, hpg/ and vultr/ to root@203.0.113.7:${root}/repo/`);
    expect(r.out).toContain(`HPG_ROOT=${root} bash ${root}/repo/vultr/setup.sh`);
    for (const f of ['pipeline/run_job.py', 'pipeline/flashworld_run.py', 'hpg/worker.py', 'hpg/env.sh', 'hpg/setup.sh', 'vultr/setup.sh', 'vultr/worker.sh']) {
      expect(await Bun.file(join(root, 'repo', f)).exists()).toBe(true);
    }
    expect(await Bun.file(join(root, 'repo', 'hpg', 'stale.txt')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'repo', 'keep.txt')).text()).toBe('not ours to delete');
    const all = (await readdir(join(root, 'repo'), { recursive: true })) as string[];
    expect(all.filter((p) => /__pycache__|\.pyc$|\.DS_Store/.test(p))).toEqual([]);

    const calls = (await Bun.file(join(base, 'ssh.log')).text()).split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(0, -1));
    const server = hpgConfig({ VULTR_HOST: '203.0.113.7', VULTR_SSH_KEY: '~/.ssh/dejaview_ed25519', VULTR_SSH_OPTS: '-p 22' });
    const opts = [...(await import('../server/hpg.ts')).sshOptions(server)];
    // The mkdir and rsync's own ssh both carry exactly the options the server uses, so they share its master.
    // (rsync may name the user with -l instead of user@host.)
    expect(calls.length).toBe(2);
    for (const argv of calls) {
      expect(argv.slice(0, opts.length)).toEqual(opts);
      const rest = argv.slice(opts.length);
      expect(rest[0] === '-l' ? `${rest[1]}@${rest[2]}` : rest[0]).toBe('root@203.0.113.7');
    }
  });

  test('without a host it prints its usage', () => {
    const r = sh(['bash', join(REPO, 'vultr', 'push.sh')], { VULTR_HOST: '' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('vultr/push.sh <host>');
  });
});

describe.skipIf(!PYTHON)('vultr/worker.sh with the real hpg/worker.py', () => {
  let root: string;
  let cfg: HpgConfig;
  const alive = () => workerAlive(cfg);

  beforeAll(async () => {
    root = join(base, 'box');
    // The flashworld env's python, standing in for the GPU one: same worker.py, no models to load.
    await mkdir(join(root, 'envs', 'flashworld', 'bin'), { recursive: true });
    const py = join(root, 'envs', 'flashworld', 'bin', 'python');
    await writeFile(py, `#!/bin/sh\nexec "${PYTHON}" "$@" --no-preload --poll 0.2\n`);
    await chmod(py, 0o755);
    cfg = { ...hpgConfig({ VULTR_HOST: '203.0.113.7' }), ssh: join(bin, 'ssh'), root, connectTimeout: 5 };
  });

  const worker = (args: string[], env: Record<string, string> = {}) => sh(['bash', join(REPO, 'vultr', 'worker.sh'), ...args], { HPG_ROOT: root, ...env });

  test('start: the server sees it alive from the heartbeat; it exits by itself when idle', async () => {
    const r = worker(['start', '1'], { TW_WORKER_IDLE: '3' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('for up to 1h (idle exit after 3s)');
    const w = await until(alive, (x: WorkerStatus) => x.alive && x.status === 'idle', 15_000);
    expect(w).toMatchObject({ alive: true, status: 'idle', host: hostname() });
    const beat = await Bun.file(join(root, 'jobs', 'worker.json')).json();
    expect(beat.slurmJobId).toBeNull();
    const st = worker(['status']);
    expect(st.out).toMatch(/worker {4}alive \(\d+s ago\) host=\S+ gpu=\S.* status=idle/);
    expect(st.out).toMatch(/process {3}\d+/);
    expect(worker(['start']).out).toContain('the worker is already running');

    const gone = await until(alive, (x: WorkerStatus) => !x.alive, 15_000);
    expect(gone.alive).toBe(false);
    expect(await Bun.file(join(root, 'jobs', 'worker.json')).exists()).toBe(false);
    expect((await Bun.file(join(root, 'jobs', 'worker.last.json')).json()).status).toBe('stopped');
    expect(worker(['logs']).out).toContain('idle for 3s, exiting to free the GPU');
  }, 40_000);

  test('stop: the worker exits after its current job (none), and the server stops seeing it', async () => {
    expect(worker(['start', '1'], { TW_WORKER_IDLE: '600' }).code).toBe(0);
    expect((await until(alive, (x: WorkerStatus) => x.alive, 15_000)).alive).toBe(true);
    const r = worker(['stop']);
    expect(r.out).toContain('asked the worker to exit after its current job');
    expect((await until(alive, (x: WorkerStatus) => !x.alive, 15_000)).alive).toBe(false);
    // worker.json goes first; the process follows a moment later.
    expect(await until(async () => worker(['status']).out, (o) => o.includes('process   none'), 10_000)).toContain('process   none');
    expect(worker(['logs', '5']).out).toContain('worker exiting after 0 job(s)');
  }, 40_000);

  test('start refuses a bad HOURS', () => {
    const r = worker(['start', 'soon']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('HOURS is a number');
  });

  test('stop with nothing running says so and leaves no worker.stop behind', async () => {
    await rm(join(root, 'jobs', 'worker.json'), { force: true });
    await rm(join(root, 'jobs', 'worker.stop'), { force: true });
    const r = worker(['stop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no worker is running');
    expect(await Bun.file(join(root, 'jobs', 'worker.stop')).exists()).toBe(false);
  });

  test('start waits out the fresh heartbeat of a killed worker, and refuses next to a live one', async () => {
    const beat = (pid: number) => JSON.stringify({ time: new Date().toISOString(), host: hostname(), pid, status: 'idle' });
    // A worker killed with SIGKILL: its worker.json is fresh, its pid is gone.
    const dead = Bun.spawnSync(['sh', '-c', 'echo $$']).stdout.toString().trim();
    await writeFile(join(root, 'jobs', 'worker.json'), beat(Number(dead)));
    let r = worker(['start', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('start again in a minute');
    // A worker started some other way (worker.sh run in tmux): this process stands in for it.
    await writeFile(join(root, 'jobs', 'worker.json'), beat(process.pid));
    r = worker(['start', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('another worker is sending heartbeats');
    // stop reaches it through worker.stop even though worker.sh did not start it.
    expect(worker(['stop']).out).toContain('asked the worker to exit after its current job');
    expect(await Bun.file(join(root, 'jobs', 'worker.stop')).exists()).toBe(true);
    await rm(join(root, 'jobs', 'worker.json'));
    await rm(join(root, 'jobs', 'worker.stop'));
  });
});

describe('vultr/setup.sh system on a stand-in GPU box', () => {
  // A copy of setup.sh whose /etc/os-release, /proc/meminfo, /usr/local/cuda-* and disk minimum point into a sandbox;
  // uname, id, nvidia-smi, apt-get, apt-cache, dpkg, curl and ffmpeg are stubs. Nothing is installed or downloaded.
  let sim: string;
  let script: string;

  beforeAll(async () => {
    sim = join(base, 'sim');
    const sb = join(sim, 'bin');
    await mkdir(sb, { recursive: true });
    await mkdir(join(sim, 'etc'), { recursive: true });
    await mkdir(join(sim, 'proc'), { recursive: true });
    await mkdir(join(sim, 'repo', 'vultr'), { recursive: true });
    for (const d of ['hpg', 'pipeline']) {
      expect(Bun.spawnSync(['cp', '-R', join(REPO, d), join(sim, 'repo', d)]).exitCode).toBe(0);
    }
    const src = await Bun.file(join(REPO, 'vultr', 'setup.sh')).text();
    script = join(sim, 'repo', 'vultr', 'setup.sh');
    await writeFile(
      script,
      src
        .replaceAll('/etc/os-release', join(sim, 'etc', 'os-release'))
        .replaceAll('/proc/meminfo', join(sim, 'proc', 'meminfo'))
        .replaceAll('/usr/local/cuda-', join(sim, 'usr', 'local', 'cuda-'))
        .replace(/^MIN_FREE_GB=\d+/m, 'MIN_FREE_GB=0'),
    );
    await writeFile(join(sim, 'etc', 'os-release'), 'ID=ubuntu\nVERSION_ID="24.04"\n');
    await writeFile(join(sim, 'proc', 'meminfo'), 'MemTotal:       125829120 kB\n');
    const nvcc = join(sim, 'usr', 'local', 'cuda-12.8', 'bin');
    const stubs: Record<string, string> = {
      uname: 'case "$1" in -s) echo Linux;; -m) echo x86_64;; *) echo Linux;; esac',
      id: '[ "$1" = -u ] && { echo 0; exit 0; }; exec /usr/bin/id "$@"',
      // What Vultr's A40 reports through vGPU unless SIM_CUDA/SIM_DRV say otherwise.
      'nvidia-smi': [
        'case "$*" in',
        '  *compute_cap*) echo 8.6;;',
        '  *driver_version*) echo "NVIDIA A40-48Q, 49152, ${SIM_DRV:-550.90.07}";;',
        '  *) echo "| NVIDIA-SMI ${SIM_DRV:-550.90.07}  Driver Version: ${SIM_DRV:-550.90.07}  CUDA Version: ${SIM_CUDA:-12.4} |";;',
        'esac',
      ].join('\n'),
      'apt-get': `case "$*" in *cuda-toolkit-12-8*) mkdir -p "${nvcc}"; printf '#!/bin/sh\\necho "Build cuda_12.8.r12.8/compiler.0"\\n' > "${nvcc}/nvcc"; chmod +x "${nvcc}/nvcc";; esac`,
      'apt-cache': 'exit 1',
      dpkg: 'exit 0',
      'dpkg-query': 'echo "install ok installed"',
      curl: [
        'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
        `case "$out" in *miniforge.sh) printf '%s\\n' 'while [ $# -gt 0 ]; do [ "$1" = -p ] && p="$2"; shift; done' 'mkdir -p "$p/bin"; printf "#!/bin/sh\\necho conda 25.3.1\\n" > "$p/bin/conda"; chmod +x "$p/bin/conda"' > "$out";; *) : > "$out";; esac`,
      ].join('\n'),
      ffmpeg: 'echo "ffmpeg version 6.1.1-3ubuntu5"',
      nproc: 'echo 24',
    };
    for (const [name, body] of Object.entries(stubs)) {
      await writeFile(join(sb, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(sb, name), 0o755);
    }
  });

  const setup = (env: Record<string, string> = {}) =>
    sh(['bash', script, 'system'], { PATH: `${join(sim, 'bin')}:${process.env.PATH}`, HPG_ROOT: join(sim, 'root', 'dejaview'), ...env });

  test("Vultr's own vGPU driver (CUDA 12.4) is kept and the stage passes", async () => {
    const r = setup();
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out).toContain('GPU: NVIDIA A40-48Q, 49152 MiB, compute capability 8.6, driver 550.90.07 (CUDA 12.4)');
    expect(r.out).toContain('minor version compatibility');
    expect(r.out).toContain('stage system done');
    const conf = await Bun.file(join(sim, 'root', 'dejaview', 'config.env')).text();
    expect(conf).toContain('TW_CUDA_ARCHS="8.6"');
    expect(conf).toContain(`CUDA_HOME="${join(sim, 'usr', 'local', 'cuda-12.8')}"`);
    // A second run keeps what is there.
    const again = setup();
    expect(again.code).toBe(0);
    expect(again.out).toContain('CUDA toolkit 12.8 already at');
    expect(again.out).toContain('config.env keeps TW_CUDA_ARCHS="8.6"');
  });

  test('a CUDA 12.8 or 13 driver passes without a note; only a CUDA 11 driver stops, and never with a driver swap', () => {
    for (const [cuda, drv] of [['12.8', '570.172.08'], ['13.0', '580.65.06']]) {
      const r = setup({ SIM_CUDA: cuda!, SIM_DRV: drv! });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('minor version compatibility');
    }
    const old = setup({ SIM_CUDA: '11.8', SIM_DRV: '520.61.05' });
    // The stage's own messages go through its log (tee, stdout); the last line, on stderr, names the log.
    const said = old.out + old.err;
    expect(old.code).toBe(1);
    expect(said).toContain('the torch wheels need a CUDA 12 driver');
    expect(said).toContain('/opt/nvidia/update.sh');
    expect(said).not.toContain('ubuntu-drivers');
    expect(setup({ SIM_CUDA: '11.8', ALLOW_OLD_DRIVER: '1' }).code).toBe(0);
  });
});
