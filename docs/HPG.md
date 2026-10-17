# ThirdWheel on HiPerGator

World generation (FlashWorld for Rent Free and the Third Wheel room, AnySplat for Reconstruct) runs on the class's
HiPerGator GPUs. The Bun server on the Mac drives everything over one SSH ControlMaster socket. This page is for
the teammate who holds the login, and for anyone touching `hpg/`.

## Two cluster profiles

The default profile is Ojasva's HiPerGator allocation.
Brianna's PACE ICE allocation is opt-in and uses the same `hpg/` scripts.
Set `HPG_PROFILE=pace` with the `PACE_*` values in `.env.example` for that lane.
Do not change the default `HPG_*` values when Ojasva is using HiPerGator.

## Etiquette first

- This is a **class allocation** (account and QOS `phz3152`) with **two GPUs for the whole class**. Use **one GPU at a
  time**: either the warm worker or one batch job, never several.
- **Nothing heavy on the login node.** `hpg/setup.sh` sends every heavy step through `srun --account=phz3152 --qos=phz3152`.
  Only `mkdir` and `git clone` run on the login node.
- The worker **exits by itself** after 20 idle minutes (`TW_WORKER_IDLE`) and its Slurm limit is 4 hours. Still:
  **stop it when you are done** (`hpg/tw.sh stop`). If someone from the class needs the GPU, stop it.
- Check before you start: `hpg/tw.sh status` lists the group's GPU jobs.

## Layout

```
$HPG_ROOT = /blue/phz3152/sbernalorta/thirdwheel
  repo/            pipeline/ and hpg/ rsynced from the Mac (the server re-syncs before jobs; --delete, so keep nothing else here)
  config.env       optional KEY=value overrides that survive syncs (HPG_PARTITION, FLASHWORLD_TRAJECTORY, CUDA_MODULE, ...)
  envs/            flashworld/, anysplat/, video/   (Python 3.11, torch 2.8.0 + CUDA 12.8 wheels, gsplat built for sm_89/100/120)
  src/             FlashWorld/ and AnySplat/ checkouts at pinned commits
  models/          HF_HOME: all weights (about 71 GB)
  jobs/            incoming/ queue/ running/ done/ batch/ fw-requests/ worker.json worker.stop
  logs/            setup-<stage>-<time>.log, worker-<slurmid>.out
  state/           <stage>.ok fingerprints, env-<name>.ok
  smoke/<time>/    smoke-test outputs
  cache/           pip, triton, torch extensions, conda packages, tmp
```

## Step by step (first time: about 1.5 hours, mostly unattended)

### 1. Open the socket (on the Mac, once; password + Duo)

```bash
ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h sbernalorta@hpg.rc.ufl.edu
```

Keep it open (or let it persist for 24 h). Everything else, including the server, reuses it without prompting.

### 2. Put the code on HiPerGator (on the Mac, from the repo root)

```bash
S="ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no"
$S sbernalorta@hpg.rc.ufl.edu 'mkdir -p /blue/phz3152/sbernalorta/thirdwheel/repo'
rsync -a --delete --exclude __pycache__ --exclude '*.pyc' -e "$S" pipeline hpg sbernalorta@hpg.rc.ufl.edu:/blue/phz3152/sbernalorta/thirdwheel/repo/
```

The server repeats this sync before it submits work, so later changes arrive automatically.

### 3. Set up (on HiPerGator)

```bash
$S -t sbernalorta@hpg.rc.ufl.edu          # or any ssh session
tmux new -s tw                             # the srun steps are attached to this shell; tmux survives disconnects
bash /blue/phz3152/sbernalorta/thirdwheel/repo/hpg/setup.sh
```

| Stage | Where | What | Time |
| --- | --- | --- | --- |
| `dirs` | login node | the layout above | seconds |
| `src` | login node | clone FlashWorld `424db44` and AnySplat `5f5e208` into `src/` | under a minute |
| `envs` | `srun`, 8 CPUs, 32 GB | conda envs `flashworld`, `anysplat`, `video`; torch 2.8.0 (cu128); requirements; gsplat compiled with `module load cuda/12.8.x` and `TORCH_CUDA_ARCH_LIST="8.9;10.0;12.0+PTX"`; ffmpeg from conda-forge; an import check per env | 20-40 min |
| `weights` | `srun`, 8 CPUs | FlashWorld 20.9 GB, Wan2.2 base 34 GB, Qwen2.5-VL-3B captioner 7.5 GB, AnySplat 2.9 GB, VGGT-1B 5.0 GB into `models/`; then the video pipeline's own prefetch | 15-40 min |
| `smoke` | `srun`, 1 GPU, 80 GB, 1 h max | GPU basics, FlashWorld with every trajectory preset, text-to-world, a warm rerun, one job through the worker, AnySplat on its example photos | 10-15 min |

Re-running is safe: finished stages are skipped (their inputs are fingerprinted in `state/`), a failed stage tells
you its log, and `bash setup.sh <stage>` resumes there. `FORCE=1` redoes a stage. The video environment needs
`pipeline/requirements-video-gpu.txt` (from the video pipeline); if it was not synced yet, `envs` skips it with a
warning and builds it on the next run.

After `smoke`, look at `smoke/<time>/flashworld/summary.json` and the `*/sheet.jpg` contact sheets (12 views
turning on the spot at the spawn; `sheet_down.jpg` looks 45 degrees down). `rankedByCompleteness` orders the
trajectory presets by empty pixels around the spawn. If a preset other than `spin360` wins clearly and looks
right, put `FLASHWORLD_TRAJECTORY=<preset>` in `$HPG_ROOT/config.env`.

### 4. Run

```bash
hpg/tw.sh status          # heartbeat, our jobs, queue, the group's GPU jobs, setup stages
hpg/tw.sh start           # warm worker on $HPG_PARTITION for up to 4 h (hpg/tw.sh start 2 for 2 h)
hpg/tw.sh logs            # end of the newest worker log (model load takes 1-3 min; then "idle")
hpg/tw.sh queue           # waiting, running and finished jobs
hpg/tw.sh stop            # exit after the current job;  hpg/tw.sh stop --now  cancels it
hpg/tw.sh submit <jobdir> # one job as a batch GPU job (what the server's hpg-batch backend does)
hpg/tw.sh clean 3         # delete finished job folders older than 3 days
```

(`hpg/tw.sh` means `bash $HPG_ROOT/repo/hpg/tw.sh`.) The server's health check shows the worker as alive while
`jobs/worker.json` is fresher than 90 s. With no worker, the server falls back to `sbatch hpg/job.sbatch`
(cold start: 2-4 min of model loading per job), then to the FlashWorld Space, then to the Mac.

## How jobs flow

```
Mac: data/jobs/<id>/ --rsync--> jobs/incoming/<id>/ --mv--> jobs/queue/<id>/
worker: rename queue/<id> -> running/<id>   (atomic: two workers can never claim the same job)
        rentfree:            flashworld_run.generate() in the worker process (model already loaded: seconds)
        thirdwheel/reconstruct: <env>/bin/python pipeline/run_job.py running/<id>   (video or anysplat env)
           while it runs, the worker serves jobs/fw-requests/ so Third Wheel's room also uses the warm model
        progress.json is rewritten as it goes; DONE or FAILED (with the error text) is written last
        rename running/<id> -> done/<id>
Mac: polls queue|running|done/<id>, then rsyncs done/<id>/out/ back
```

| File | Meaning |
| --- | --- |
| `jobs/worker.json` | heartbeat every 30 s: `{time (ISO UTC), host, gpu, pid, slurmJobId, status (loading, idle, busy, error), job, jobsDone, modelLoaded, startedAt}`. Removed when the worker exits; the last state goes to `worker.last.json`. |
| `jobs/worker.stop` | touch it to make the worker exit after the current job (`hpg/tw.sh stop`) |
| `running/<id>/CANCEL` | the server's cancel: the worker kills the job's process group and writes FAILED "Cancelled" |
| `running/<id>/console.txt` | stdout and stderr of `run_job.py` (the pipeline's own `log.txt` is separate) |
| `jobs/fw-requests/<rid>/` | `request.json` `{image, prompt, out_dir, params}` from `flashworld_run.submit_to_worker()`; the worker writes `CLAIMED`, `progress.json`, then `DONE` + `result.json` or `FAILED` |

A job the worker is still running when it is stopped (SIGTERM, `scancel`, or the USR1 Slurm sends two minutes
before the time limit) goes back to `queue/` unfinished, so the next worker or the batch fallback picks it up.
If a worker was killed outright, the next one to start moves whatever it left in `running/` back to `queue/` (or to
`done/` when it had finished), unless another worker's heartbeat is still fresh. Jobs in `queue/` with no
`job.json`, or modified less than 2 s ago, are not claimed yet.

`job.json` params the GPU code reads (all optional): `trajectory` (`spin360`, `orbit360`, `pan180`, `forward`),
`seed` (default: `attempt`), `cameraHeight` (metres; 1.45 for a hand-held photo), `maxSplats` (1,000,000),
`shDegree` (2), `caption` (`auto`, `none` or a text), `orientation`, `hfov`, `intrinsics` (`{fx, fy, cx, cy}`
in input-image pixels), `offload`.

## Environments and what runs where

| Env | Python | Used by | Notes |
| --- | --- | --- | --- |
| `flashworld` | `$TW_PY_FLASHWORLD` | worker, rentfree batch jobs, `flashworld_run.py` | transformers 4.57.1, diffusers @ 447e832, gradio 5.49.1 (FlashWorld's app.py imports it), gsplat, no `spaces` |
| `anysplat` | `$TW_PY_ANYSPLAT` | reconstruct jobs, `anysplat_run.py` | numpy 1.26; xformers and torch_scatter if wheels exist, else in-process PyTorch stand-ins |
| `video` | `$TW_PY_VIDEO` | thirdwheel jobs (`pipeline/tw/`) | from `pipeline/requirements-video-gpu.txt`; asks the worker (or `$TW_PY_FLASHWORLD`) for the room |

`hpg/env.sh` exports these paths plus `FLASHWORLD_SRC`, `ANYSPLAT_SRC`, `HF_HOME=$HPG_ROOT/models` and the caches,
and turns on `HF_HUB_OFFLINE=1` for jobs once the weights stage is done (no network hangs on compute nodes;
`TW_ALLOW_DOWNLOADS=1` lifts it).

For a pipeline that needs a room from inside another environment (Third Wheel):

```python
import flashworld_run
result = flashworld_run.generate_room(plate_jpg, prompt, out_dir, progress=cb, cameraHeight=1.1,
                                      intrinsics={"fx": ..., "fy": ..., "cx": ..., "cy": ...})
```

It uses the warm worker when `TW_FW_REQUESTS` is set (the worker sets it for its children), otherwise this process
if it can load FlashWorld, otherwise `$TW_PY_FLASHWORLD` as a subprocess, and raises `RuntimeError` when there is
no GPU path so the caller can fall back to `plate_room.py`. The outputs are the ones in docs/FLASHWORLD.md section 5,
including `input_camera.json` and `input_depth.npy` for aligning the video's depth with the room.

## Partitions and GPUs

| Partition | GPU | Memory | Arch | FlashWorld settings |
| --- | --- | --- | --- | --- |
| `hpg-rtx6000` (default) | RTX PRO 6000 Blackwell | 96 GB | sm_120 | no offload, FP8 matmuls |
| `hpg-b200` | B200 | 180 GB | sm_100 | no offload, FP8 matmuls |
| `hpg-turin` | L4 | 24 GB | sm_89 | `--offload auto` turns on T5 and transformer offload; slow and tight |

Set `HPG_PARTITION` in `config.env` (and in the Mac's `.env` for the server's batch jobs) to change it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `envs`: "no CUDA module found" | `module spider cuda`, then `CUDA_MODULE=cuda/<12.8 or newer> bash setup.sh envs` (or put it in `config.env`) |
| gsplat build errors about the host compiler | `GCC_MODULE=gcc/12.2.0` (CUDA 12.8 accepts GCC 9 to 14); `MAX_JOBS=4` if the build runs out of memory |
| `srun` refuses a CPU job for the QOS | `SETUP_ON_GPU=1 bash setup.sh envs weights` (runs those on the GPU partition; slower to get, uses the GPU for nothing) |
| `srun: Invalid partition` | `sinfo -s` lists them; set `HPG_PARTITION` (GPU) or `HPG_CPU_PARTITION` |
| Weights downloads stall or hit rate limits | re-run `setup.sh weights` (it resumes); `export HF_TOKEN=...` before it helps |
| Worker log: "FlashWorld failed to load" | the error follows; `hpg/tw.sh status` shows it from `worker.last.json`. Check `setup.sh smoke` |
| Worker log: "native FP8 matmul unavailable" | harmless: FlashWorld runs its FP8 layers dequantised (a bit slower) |
| A job sits in `queue/` | no worker: `hpg/tw.sh start`, or `hpg/tw.sh status` to see whether the worker job is pending behind the class |
| CUDA out of memory | another process shares the GPU, or an L4: use `hpg-rtx6000`/`hpg-b200` |
| Quota | `blue_quota`, `home_quota`; everything big is under `/blue`, caches included |

## Tests

On the Mac (or anywhere with the repo `.venv`):

```bash
.venv/bin/python -m pytest tests/gpu -q                       # CPU tests: formats, transforms, floor, runners, worker
FLASHWORLD_SRC=/path/to/FlashWorld .venv/bin/python -m pytest tests/gpu -q   # + checks our cameras with FlashWorld's own utils.py
.venv/bin/python tests/gpu/spark_fixtures.py && bun tests/gpu/spark_check.ts # our SPZ/PLY files rendered by Spark in headless Chrome
```

`.venv/bin/python -m pytest tests -q` runs this suite together with `tests/pipeline`; pass `tests`, not the two
directories as separate arguments (docs/ARCHITECTURE.md, Tests, explains why).

On HiPerGator, `hpg/tw.sh smoke` (one GPU, about 15 minutes) runs `hpg/smoke/smoke_gpu.py`, `smoke_flashworld.py` and
`smoke_anysplat.py`; results land in `$HPG_ROOT/smoke/<time>/`.

## What has and has not been verified

Verified on the Mac without a GPU: Python compiles; `bash -n` and `shellcheck` are clean on every script; the
`dirs` and `src` stages run and are idempotent; `envs` fails cleanly with a clear message when no CUDA toolkit is
found; `job.sbatch` handles success, crash, unknown mode and missing env; `worker.sbatch` reports a load failure in
`worker.last.json` and exits; the worker's claiming, cancel, stop/requeue, heartbeat, room requests and
subprocess handling are unit-tested (`tests/gpu/test_worker.py`); both requirement sets resolve for Linux x86_64,
Python 3.11 with torch 2.8.0+cu128 (`uv pip compile`).

Not verifiable until the login is back: module names on HiPerGator, compiling gsplat for sm_120, FlashWorld and
AnySplat actually running on Blackwell (FP8 path, memory, timings), the captioner, the weight downloads, and
which trajectory preset gives the best worlds. `setup.sh smoke` checks all of these in one go.
