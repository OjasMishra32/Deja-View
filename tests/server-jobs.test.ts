import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, JobResult, Scene, SceneMode } from '../shared/types.ts';
import { localDriver, pidAlive } from '../server/backends/local.ts';
import { sleep, type BackendDriver, type RunContext } from '../server/backends/types.ts';
import { composeError, JobRunner, parseBackendOrder } from '../server/jobs.ts';
import { SceneStore } from '../server/store.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

interface Harness {
  root: string;
  store: SceneStore;
  events: Scene[];
  runner: JobRunner;
}

async function harness(drivers: BackendDriver[], order?: Backend[]): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tw-jobs-'));
  roots.push(root);
  const store = new SceneStore(join(root, 'scenes'));
  const events: Scene[] = [];
  const runner = new JobRunner({ store, jobsDir: join(root, 'jobs'), drivers, emit: (s) => events.push(s), order, reportIntervalMs: 10 });
  return { root, store, events, runner };
}

async function addScene(store: SceneStore, id: string, mode: SceneMode = 'rentfree', extra: Partial<Scene> = {}): Promise<Scene> {
  const dir = store.sceneDir(id);
  await mkdir(join(dir, 'input'), { recursive: true });
  await writeFile(join(dir, 'input', '00.jpg'), 'jpeg-bytes');
  return store.save({
    id,
    name: id,
    mode,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: '',
    input: { files: ['input/00.jpg'] },
    thumb: 'thumb.jpg',
    ...extra,
  });
}

const WORLD_RESULT: JobResult = {
  world: { file: 'world.spz', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'flashworld' },
  thumb: 'thumb.jpg',
  caption: 'made by a fake',
};

interface FakeOpts {
  name: Backend;
  lane?: string;
  available?: boolean | string;
  fail?: string;
  delayMs?: number;
  result?: JobResult;
  files?: Record<string, string>;
  modes?: SceneMode[];
  canResume?: boolean;
  onRun?: (ctx: RunContext) => void | Promise<void>;
  /** Counts jobs running across several fakes. */
  shared?: { running: number; max: number };
}

function fake(o: FakeOpts): BackendDriver & { runs: string[]; maxConcurrent: number } {
  let running = 0;
  const d = {
    name: o.name,
    label: `Fake ${o.name}`,
    lane: o.lane ?? o.name,
    canResume: o.canResume ?? false,
    runs: [] as string[],
    maxConcurrent: 0,
    supports: (m: SceneMode) => (o.modes ?? ['rentfree', 'thirdwheel', 'reconstruct']).includes(m),
    available: async () =>
      o.available === undefined || o.available === true ? { ok: true as const } : { ok: false as const, reason: typeof o.available === 'string' ? o.available : 'off' },
    run: async (ctx: RunContext) => {
      running++;
      d.maxConcurrent = Math.max(d.maxConcurrent, running);
      if (o.shared) {
        o.shared.running++;
        o.shared.max = Math.max(o.shared.max, o.shared.running);
      }
      d.runs.push(ctx.scene.id);
      try {
        await o.onRun?.(ctx);
        // The job dir must hold the job description and the inputs.
        const job = await Bun.file(join(ctx.jobDir, 'job.json')).json();
        expect(job.mode).toBe(ctx.scene.mode);
        expect(job.params.backend).toBe(o.name);
        expect(await Bun.file(join(ctx.jobDir, 'input', '00.jpg')).text()).toBe('jpeg-bytes');
        ctx.report({ status: 'running', stage: 'Halfway', progress: 0.5 });
        ctx.reportProgress({ stage: 'Almost', progress: 0.9 });
        if (o.delayMs) await sleep(o.delayMs, ctx.signal);
        if (o.fail) throw new Error(o.fail);
        for (const [name, body] of Object.entries(o.files ?? { 'world.spz': 'SPZDATA', 'thumb.jpg': 'THUMB' })) {
          await writeFile(join(ctx.outDir, name), body);
        }
        await Bun.write(join(ctx.outDir, 'scene.json'), JSON.stringify(o.result ?? WORLD_RESULT));
      } finally {
        running--;
        if (o.shared) o.shared.running--;
      }
    },
  };
  return d;
}

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

describe('job state machine', () => {
  test('success: queued -> running -> downloading -> ready, outputs copied and merged', async () => {
    const d = fake({ name: 'local' });
    const h = await harness([d]);
    await addScene(h.store, 'ok-aaaaa');
    h.runner.enqueue('ok-aaaaa');
    expect(h.runner.isActive('ok-aaaaa')).toBe(true);
    await h.runner.idle();
    const s = (await h.store.get('ok-aaaaa'))!;
    expect(s.status).toBe('ready');
    expect(s.progress).toBe(1);
    expect(s.backend).toBe('local');
    expect(s.world?.file).toBe('world.spz');
    expect(s.caption).toBe('made by a fake');
    expect(s.error).toBeUndefined();
    const dir = h.store.sceneDir('ok-aaaaa');
    expect(await Bun.file(join(dir, 'world.spz')).text()).toBe('SPZDATA');
    expect(await Bun.file(join(dir, 'thumb.jpg')).text()).toBe('THUMB');
    const statuses = h.events.map((e) => e.status).filter((v, i, a) => i === 0 || a[i - 1] !== v);
    expect(statuses).toEqual(['running', 'downloading', 'ready']);
    expect(h.events.some((e) => e.stage === 'Almost' || e.stage === 'Halfway')).toBe(true);
    const log = await Bun.file(join(dir, 'log.txt')).text();
    expect(log).toContain('running on Fake local');
    expect(log).toContain('ready (Fake local)');
    expect((await readdir(dir)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  test('falls back to the next backend after a failure and skips unavailable ones', async () => {
    const worker = fake({ name: 'hpg-worker', lane: 'hpg', available: 'offline, no SSH session' });
    const batch = fake({ name: 'hpg-batch', lane: 'hpg', available: 'offline, no SSH session' });
    const space = fake({ name: 'hf-space', fail: 'quota used up' });
    const local = fake({ name: 'local' });
    const h = await harness([worker, batch, space, local]);
    await addScene(h.store, 'fb-aaaaa');
    h.runner.enqueue('fb-aaaaa');
    await h.runner.idle();
    const s = (await h.store.get('fb-aaaaa'))!;
    expect(s.status).toBe('ready');
    expect(s.backend).toBe('local');
    expect(space.runs).toEqual(['fb-aaaaa']);
    expect(worker.runs).toEqual([]);
    const log = await Bun.file(join(h.store.sceneDir('fb-aaaaa'), 'log.txt')).text();
    expect(log).toContain('Fake hf-space failed: quota used up');
    expect(log).toContain('Fake hpg-worker: skipped (offline, no SSH session)');
  });

  test('all backends unavailable or failing: one clear error, then retry succeeds', async () => {
    let spaceFails = true;
    const space = fake({ name: 'hf-space', onRun: () => { if (spaceFails) throw new Error('GPU crashed'); } });
    const local = fake({ name: 'local', available: 'not installed (run scripts/setup-local.sh)' });
    const hpg = fake({ name: 'hpg-worker', available: 'offline' });
    const h = await harness([hpg, space, local]);
    await addScene(h.store, 'err-aaaaa');
    h.runner.enqueue('err-aaaaa');
    await h.runner.idle();
    let s = (await h.store.get('err-aaaaa'))!;
    expect(s.status).toBe('failed');
    expect(s.error).toBe('Fake hf-space failed: GPU crashed. Not available: Fake hpg-worker: offline. Fake local: not installed (run scripts/setup-local.sh).');

    spaceFails = false;
    const r = await h.runner.retry('err-aaaaa');
    expect(r?.status).toBe('queued');
    expect(r?.error).toBeUndefined();
    await h.runner.idle();
    s = (await h.store.get('err-aaaaa'))!;
    expect(s.status).toBe('ready');
    expect(s.error).toBeUndefined();
    const state = await Bun.file(join(h.root, 'jobs', 'err-aaaaa', 'state.json')).json();
    expect(state.attempt).toBe(2);
    expect(state.jobId).toBe('err-aaaaa-a2');
  });

  test('a mode no backend supports fails immediately', async () => {
    const h = await harness([fake({ name: 'hf-space', modes: ['rentfree'] })]);
    await addScene(h.store, 'tw-aaaaa', 'thirdwheel');
    h.runner.enqueue('tw-aaaaa');
    await h.runner.idle();
    expect((await h.store.get('tw-aaaaa'))?.error).toContain('No backend is configured for thirdwheel');
  });

  test('bad results are rejected with a precise message', async () => {
    const missing = fake({ name: 'local', files: { 'thumb.jpg': 'T' } });
    const h = await harness([missing]);
    await addScene(h.store, 'bad-aaaaa');
    h.runner.enqueue('bad-aaaaa');
    await h.runner.idle();
    expect((await h.store.get('bad-aaaaa'))?.error).toBe('Fake local failed: the job did not produce world.spz.');

    const unsafe = fake({ name: 'local', result: { ...WORLD_RESULT, world: { ...WORLD_RESULT.world!, file: '../../escape.spz' } } });
    const h2 = await harness([unsafe]);
    await addScene(h2.store, 'bad-bbbbb');
    h2.runner.enqueue('bad-bbbbb');
    await h2.runner.idle();
    expect((await h2.store.get('bad-bbbbb'))?.error).toContain('unsafe path');

    const noVideo = fake({ name: 'local' });
    const h3 = await harness([noVideo]);
    await addScene(h3.store, 'bad-ccccc', 'thirdwheel');
    h3.runner.enqueue('bad-ccccc');
    await h3.runner.idle();
    expect((await h3.store.get('bad-ccccc'))?.error).toContain('no video layer');
  });

  test('one job at a time per lane, other lanes in parallel, FIFO with queue stage', async () => {
    const shared = { running: 0, max: 0 };
    const local = fake({ name: 'local', delayMs: 150, shared });
    const space = fake({ name: 'hf-space', delayMs: 300, modes: ['rentfree'], shared });
    const h = await harness([space, local], ['hf-space', 'local']);
    for (const id of ['q1-aaaaa', 'q2-aaaaa', 'q3-aaaaa']) await addScene(h.store, id, 'reconstruct');
    await addScene(h.store, 'q4-aaaaa', 'rentfree');
    for (const id of ['q1-aaaaa', 'q2-aaaaa', 'q3-aaaaa', 'q4-aaaaa']) h.runner.enqueue(id);
    // Whichever reconstruct job reached the lane last waits behind the others.
    let waiting: Scene | undefined;
    await waitFor(async () => {
      const all = await Promise.all(['q1-aaaaa', 'q2-aaaaa', 'q3-aaaaa'].map((id) => h.store.get(id)));
      waiting = all.find((s) => s?.stage?.startsWith('Waiting for Fake local (2 ahead)')) ?? undefined;
      return !!waiting;
    });
    expect(waiting?.status).toBe('queued');
    await h.runner.idle();
    expect(local.maxConcurrent).toBe(1);
    expect([...local.runs].sort()).toEqual(['q1-aaaaa', 'q2-aaaaa', 'q3-aaaaa']);
    expect(space.runs).toEqual(['q4-aaaaa']);
    // The space job ran while a local job was running.
    expect(shared.max).toBe(2);
    for (const id of ['q1-aaaaa', 'q2-aaaaa', 'q3-aaaaa', 'q4-aaaaa']) expect((await h.store.get(id))?.status).toBe('ready');
  });

  test('cancel stops a running job and a queued one without marking them failed', async () => {
    const local = fake({ name: 'local', delayMs: 5000 });
    const h = await harness([local]);
    await addScene(h.store, 'c1-aaaaa');
    await addScene(h.store, 'c2-aaaaa');
    h.runner.enqueue('c1-aaaaa');
    await waitFor(() => local.runs.length === 1);
    h.runner.enqueue('c2-aaaaa');
    await waitFor(async () => (await h.store.get('c2-aaaaa'))?.stage?.startsWith('Waiting') ?? false);
    const t0 = Date.now();
    await h.runner.cancel('c2-aaaaa');
    await h.runner.cancel('c1-aaaaa');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.runner.activeIds()).toEqual([]);
    expect(local.runs).toEqual(['c1-aaaaa']);
    expect((await h.store.get('c1-aaaaa'))?.status).toBe('running');
    expect((await h.store.get('c2-aaaaa'))?.status).toBe('queued');
  });

  test('recover(): resumable backends re-attach, others start over', async () => {
    const seen: Record<string, boolean> = {};
    const local = fake({ name: 'local', canResume: true, onRun: (ctx) => void (seen[ctx.scene.id] = ctx.resume) });
    const h = await harness([local]);
    await addScene(h.store, 'r1-aaaaa', 'rentfree', { status: 'running', backend: 'local' });
    const jobDir = join(h.root, 'jobs', 'r1-aaaaa');
    await mkdir(join(jobDir, 'out'), { recursive: true });
    await Bun.write(join(jobDir, 'job.json'), JSON.stringify({ id: 'r1-aaaaa-a1', mode: 'rentfree', params: { backend: 'local' } }));
    await Bun.write(join(jobDir, 'state.json'), JSON.stringify({ sceneId: 'r1-aaaaa', jobId: 'r1-aaaaa-a1', attempt: 1, backend: 'local', pid: 999999 }));
    await mkdir(join(jobDir, 'input'), { recursive: true });
    await writeFile(join(jobDir, 'input', '00.jpg'), 'jpeg-bytes');
    await addScene(h.store, 'r2-aaaaa', 'rentfree', { status: 'queued' });
    await addScene(h.store, 'r3-aaaaa', 'rentfree', { status: 'ready' });
    const resumed = await h.runner.recover();
    expect(resumed.sort()).toEqual(['r1-aaaaa', 'r2-aaaaa']);
    await h.runner.idle();
    expect(seen).toEqual({ 'r1-aaaaa': true, 'r2-aaaaa': false });
    expect((await h.store.get('r1-aaaaa'))?.status).toBe('ready');
    expect((await h.store.get('r2-aaaaa'))?.status).toBe('ready');
    const log = await Bun.file(join(h.store.sceneDir('r1-aaaaa'), 'log.txt')).text();
    expect(log).toContain('re-attaching to the Fake local job');
  });
});

describe('helpers', () => {
  test('composeError groups identical reasons', () => {
    expect(composeError([], [{ label: 'A', reason: 'offline' }, { label: 'B', reason: 'offline' }, { label: 'C', reason: 'missing' }])).toBe(
      'No backend could run this job. A and B: offline. C: missing.',
    );
    expect(composeError([{ label: 'S', reason: 'boom.' }], [])).toBe('S failed: boom.');
  });
  test('parseBackendOrder', () => {
    expect(parseBackendOrder('local, hf-space')).toEqual(['local', 'hf-space']);
    expect(parseBackendOrder('nonsense')).toEqual(['hpg-worker', 'hpg-batch', 'hf-space', 'local']);
    expect(parseBackendOrder(undefined)).toEqual(['hpg-worker', 'hpg-batch', 'hf-space', 'local']);
  });
});

describe('local backend with a stand-in pipeline', () => {
  let bin: string;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), 'tw-py-'));
    roots.push(bin);
  });

  /** A shell script that behaves like `.venv/bin/python -u pipeline/run_job.py <jobdir>`. */
  async function fakePython(body: string): Promise<{ python: string; script: string }> {
    const python = join(bin, 'python');
    await writeFile(python, `#!/bin/sh\n# args: -u <script> <jobdir>\nJOB="$3"\n${body}\n`);
    await chmod(python, 0o755);
    const script = join(bin, 'run_job.py');
    await writeFile(script, '# stand-in');
    return { python, script };
  }

  test('availability explains what is missing', async () => {
    const d = localDriver({ python: join(bin, 'nope'), script: join(bin, 'run_job.py'), cwd: bin });
    expect(await d.available()).toEqual({ ok: false, reason: 'not installed (nope is missing; run scripts/setup-local.sh)' });
    const p = await fakePython('true');
    await rm(p.script);
    expect(await localDriver({ ...p, cwd: bin }).available()).toEqual({ ok: false, reason: 'run_job.py is missing' });
  });

  test('progress.json is mirrored, output streamed to the log, result ingested', async () => {
    const p = await fakePython(`
echo "loading models"
echo '{"stage":"Estimating depth","progress":0.4}' > "$JOB/progress.json.tmp" && mv "$JOB/progress.json.tmp" "$JOB/progress.json"
sleep 0.4
echo '{"stage":"Packing video","progress":0.8}' > "$JOB/progress.json"
sleep 0.4
printf 'SPZ' > "$JOB/out/world.spz"
printf 'MP4' > "$JOB/out/tw.mp4"
cat > "$JOB/out/scene.json" <<'EOF'
{"world":{"file":"world.spz","transform":{"position":[0,0,0],"quaternion":[1,0,0,0],"scale":1},"floorY":null,"source":"plate-depth"},
 "video":{"file":"tw.mp4","layout":"tw-pack-v1","width":4,"height":4,"fps":30,"duration":1,"hasAudio":true,
  "intrinsics":{"fx":1,"fy":1,"cx":2,"cy":2},"depth":{"encoding":"inverse","near":0.3,"far":8},
  "cameraPose":{"position":[0,1.4,0],"quaternion":[0,0,0,1]}}}
EOF
echo '{"stage":"Done","progress":1,"done":true}' > "$JOB/progress.json"
touch "$JOB/DONE"
echo "finished"`);
    const h = await harness([localDriver({ ...p, cwd: bin, pollMs: 50 })]);
    await addScene(h.store, 'loc-aaaaa', 'thirdwheel');
    h.runner.enqueue('loc-aaaaa');
    await h.runner.idle();
    const s = (await h.store.get('loc-aaaaa'))!;
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('ready');
    expect(s.video?.file).toBe('tw.mp4');
    expect(s.world?.source).toBe('plate-depth');
    expect(h.events.map((e) => e.stage)).toContain('Estimating depth');
    expect(h.events.map((e) => e.stage)).toContain('Packing video');
    const log = await Bun.file(join(h.store.sceneDir('loc-aaaaa'), 'log.txt')).text();
    expect(log).toContain('loading models');
    expect(log).toContain('finished');
    expect(await Bun.file(join(h.store.sceneDir('loc-aaaaa'), 'tw.mp4')).text()).toBe('MP4');
  });

  test('a failing pipeline surfaces its own error text', async () => {
    const p = await fakePython(`
echo '{"stage":"Estimating depth","progress":0.2,"error":"Video Depth Anything weights are missing: run scripts/setup-local.sh"}' > "$JOB/progress.json"
echo "Traceback: boom" >&2
touch "$JOB/FAILED"
exit 3`);
    const h = await harness([localDriver({ ...p, cwd: bin, pollMs: 50 })]);
    await addScene(h.store, 'lf-aaaaa', 'thirdwheel');
    h.runner.enqueue('lf-aaaaa');
    await h.runner.idle();
    const s = (await h.store.get('lf-aaaaa'))!;
    expect(s.status).toBe('failed');
    expect(s.error).toBe('Local pipeline failed: Video Depth Anything weights are missing: run scripts/setup-local.sh.');
    expect(await Bun.file(join(h.store.sceneDir('lf-aaaaa'), 'log.txt')).text()).toContain('Traceback: boom');
  });

  test('a crash without markers reports the exit code and the last output', async () => {
    const p = await fakePython('echo "Segmentation fault" >&2; exit 139');
    const h = await harness([localDriver({ ...p, cwd: bin, pollMs: 50 })]);
    await addScene(h.store, 'lc-aaaaa', 'thirdwheel');
    h.runner.enqueue('lc-aaaaa');
    await h.runner.idle();
    expect((await h.store.get('lc-aaaaa'))?.error).toBe(
      'Local pipeline failed: the local pipeline stopped without finishing (exit 139): Segmentation fault.',
    );
  });

  test('cancel kills the whole process group', async () => {
    const p = await fakePython(`sleep 30 & echo $! > "$JOB/child.pid"; wait`);
    const h = await harness([localDriver({ ...p, cwd: bin, pollMs: 50 })]);
    await addScene(h.store, 'lk-aaaaa', 'thirdwheel');
    h.runner.enqueue('lk-aaaaa');
    const jobDir = join(h.root, 'jobs', 'lk-aaaaa');
    await waitFor(async () => Bun.file(join(jobDir, 'child.pid')).exists());
    await Bun.sleep(50);
    const child = Number((await Bun.file(join(jobDir, 'child.pid')).text()).trim());
    const state = await Bun.file(join(jobDir, 'state.json')).json();
    expect(pidAlive(state.pid)).toBe(true);
    expect(pidAlive(child)).toBe(true);
    await h.runner.cancel('lk-aaaaa');
    await waitFor(() => !pidAlive(state.pid) && !pidAlive(child), 3000);
  });

  test('after a restart the runner re-attaches to a pipeline that is still running', async () => {
    const p = await fakePython(`
echo '{"stage":"Long step","progress":0.3}' > "$JOB/progress.json"
sleep 1.2
printf 'SPZ' > "$JOB/out/world.spz"
echo '{"world":{"file":"world.spz","transform":{"position":[0,0,0],"quaternion":[0,0,0,1],"scale":1},"floorY":null,"source":"flashworld"}}' > "$JOB/out/scene.json"
touch "$JOB/DONE"`);
    const first = await harness([localDriver({ ...p, cwd: bin, pollMs: 50 })]);
    await addScene(first.store, 'rs-aaaaa');
    first.runner.enqueue('rs-aaaaa');
    const jobDir = join(first.root, 'jobs', 'rs-aaaaa');
    await waitFor(async () => (await Bun.file(join(jobDir, 'state.json')).json().catch(() => ({}))).pid > 0);
    const pid = (await Bun.file(join(jobDir, 'state.json')).json()).pid;
    // Simulate the server dying: a second runner over the same directories takes over.
    const second = new JobRunner({
      store: new SceneStore(first.store.dir),
      jobsDir: join(first.root, 'jobs'),
      drivers: [localDriver({ ...p, cwd: bin, pollMs: 50 })],
      emit: () => {},
      reportIntervalMs: 10,
    });
    await waitFor(async () => (await first.store.get('rs-aaaaa'))?.status === 'running');
    expect(await second.recover()).toEqual(['rs-aaaaa']);
    await second.idle();
    await first.runner.idle();
    expect(pidAlive(pid)).toBe(false);
    const s = (await second.store.get('rs-aaaaa'))!;
    expect(s.status).toBe('ready');
    const log = await Bun.file(join(first.store.sceneDir('rs-aaaaa'), 'log.txt')).text();
    expect(log).toContain(`re-attached to local pipeline pid ${pid}`);
  });
});
