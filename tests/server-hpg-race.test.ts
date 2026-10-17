// Regression test (QA finding): the warm worker writes DONE inside running/<id>/ and only renames the dir into done/ afterwards
// (hpg/worker.py run_rentfree -> finish_ok, then handle() -> dirs.finish). If the server's poll lands in
// that window it rsyncs running/<id>/out, which has moved by the time rsync connects.
import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const { hpgWorkerDriver } = await import(join(REPO, 'server/backends/hpg.ts'));
const { hpgConfig, workerAlive } = await import(join(REPO, 'server/hpg.ts'));
const { JobRunner } = await import(join(REPO, 'server/jobs.ts'));
const { SceneStore } = await import(join(REPO, 'server/store.ts'));

const base = await mkdtemp(join(tmpdir(), 'qa-race-'));
let listener: ReturnType<typeof Bun.listen> | null = null;
afterAll(async () => {
  listener?.stop(true);
  await rm(base, { recursive: true, force: true });
});

test('a worker job that finishes while still in running/ is downloaded from done/ and ends ready', async () => {
  const bin = join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const sock = join(base, 'cm');
  listener = Bun.listen({ unix: sock, socket: { data() {} } });
  // ssh stand-in; the rsync server side gets 300 ms of latency (a real WAN round trip to HiPerGator).
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
[ -n "$op" ] && exit 0
case "$*" in *"rsync --server"*) sleep 0.6;; esac
exec /bin/sh -c "$*"
`,
  );
  await chmod(join(bin, 'ssh'), 0o755);
  const repo = join(base, 'repo');
  await mkdir(join(repo, 'pipeline'), { recursive: true });
  await mkdir(join(repo, 'hpg'), { recursive: true });
  await writeFile(join(repo, 'pipeline', 'run_job.py'), '#');
  const cfg = { ...hpgConfig({}), socket: sock, ssh: join(bin, 'ssh'), root: join(base, 'remote'), repoDir: repo, connectTimeout: 5 };
  const jobs = join(cfg.root, 'jobs');
  for (const d of ['queue', 'running', 'done']) await mkdir(join(jobs, d), { recursive: true });

  // Stand-in worker with the real worker's ordering: DONE first, rename into done/ ~0.4 s later
  // (run_job.py exits, the worker notices within its 0.5 s poll, then calls dirs.finish()).
  const beat = () => writeFile(join(jobs, 'worker.json'), JSON.stringify({ time: Date.now() / 1000, host: 'c1', gpu: 'GPU' }));
  await beat();
  const claimed = new Set<string>();
  const timer = setInterval(async () => {
    await beat();
    for (const name of await readdir(join(jobs, 'queue')).catch(() => [])) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      const dir = join(jobs, 'running', name);
      await rename(join(jobs, 'queue', name), dir);
      await mkdir(join(dir, 'out'), { recursive: true });
      await writeFile(join(dir, 'out', 'world.ply'), 'PLY');
      await writeFile(join(dir, 'out', 'scene.json'), JSON.stringify({ world: { file: 'world.ply', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, floorY: null, source: 'plate-depth' }, video: { file: 'world.ply' } }));
      await writeFile(join(dir, 'DONE'), '');
      setTimeout(() => void rename(dir, join(jobs, "done", name)), 250);
    }
  }, 50);

  const store = new SceneStore(join(base, 'scenes'));
  const id = 'race-aaaaa';
  await mkdir(join(store.sceneDir(id), 'input'), { recursive: true });
  await writeFile(join(store.sceneDir(id), 'input', 'video.mp4'), 'v');
  await store.save({ id, name: id, mode: 'thirdwheel', status: 'queued', createdAt: new Date().toISOString(), updatedAt: '', input: { files: ['input/video.mp4'] } });
  const probe = { online: async () => ({ online: true }), worker: () => workerAlive(cfg) };
  const runner = new JobRunner({ store, jobsDir: join(base, 'jobs'), drivers: [hpgWorkerDriver({ probe, cfg: () => cfg, pollMs: 100 })], emit: () => {} });
  runner.enqueue(id);
  await runner.idle();
  clearInterval(timer);
  const s = (await store.get(id))!;
  expect(s.error).toBeUndefined();
  expect(s.status).toBe('ready');
});
