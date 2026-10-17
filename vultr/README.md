# Backup GPU on Vultr

If HiPerGator is not available for the finale, Déjà View sends its jobs to a rented Vultr Cloud GPU (NVIDIA A40,
48 GB) instead. The box runs the same warm worker as HiPerGator (`hpg/worker.py`, same job folders, same
`jobs/worker.json` heartbeat), and the server drives it over SSH with your key. There is no Slurm on the box, so
the batch backend is off while `VULTR_HOST` is set; the order is warm worker, then the FlashWorld Space, then the Mac.

**Cost: about $1.71 to $1.86 an hour (plan `vcg-a40-24c-120g-48vram`; the deploy page shows the current price). A
stopped instance bills exactly like a running one: only Destroy (step 7) stops the charges.**

## 1. Create the instance (Vultr console, 5 min)

1. Account → SSH Keys → Add SSH Key: paste this Mac's public key (`cat ~/.ssh/id_ed25519.pub`; no key yet:
   `ssh-keygen -t ed25519`).
2. Products → Compute → Deploy → **Cloud GPU** → location **New Jersey** (`ewr`), or **Los Angeles** (`lax`) if the
   A40 is out of stock there → GPU **NVIDIA A40**, the whole card: `vcg-a40-24c-120g-48vram` (48 GB GPU, 24 vCPU,
   120 GB RAM, 1.4 TB disk). Fractional A40 plans and the A16 are too small.
3. Image **Ubuntu 24.04** (22.04 works too; the GPU images come with the NVIDIA driver), tick your SSH key, hostname
   `dejaview-gpu`, Deploy.
4. When it says Running, copy the IPv4 address. Check from the Mac: `ssh root@<ip> nvidia-smi` lists the A40 (as
   `NVIDIA A40-48Q`: the whole card through Vultr's vGPU, often with a CUDA 12.4 driver). Leave that driver as it
   is: it has to match Vultr's host, and the CUDA 12.8 wheels run on it.

## 2. Push the code (Mac, repo root, seconds)

```bash
vultr/push.sh <ip>
```

It copies `pipeline/`, `hpg/` and `vultr/` to `/root/dejaview/repo/` (the same excludes as the server's own sync,
which repeats it for `pipeline/` and `hpg/` before jobs).

## 3. Set up (on the box, about an hour, mostly unattended)

```bash
ssh root@<ip>
tmux new -s dv                              # keeps going if ssh drops: tmux attach -t dv (no tmux: apt-get install -y tmux)
bash /root/dejaview/repo/vultr/setup.sh
```

| Stage | What | Time |
| --- | --- | --- |
| `system` | checks the GPU, the driver (any CUDA 12 driver; it is never changed) and disk; apt: ffmpeg, build tools, rsync; the CUDA 12.8 toolkit (nvcc and libraries, to build gsplat); Miniforge; writes `/root/dejaview/config.env` (`TW_CUDA_ARCHS="8.6"`, `CUDA_HOME`, `CONDA_EXE`, `MAX_JOBS`) | 5-10 min |
| `dirs`, `src` | the HiPerGator layout; FlashWorld and AnySplat at their pinned commits | 1 min |
| `envs` | the three HiPerGator environments: Python 3.11, torch 2.8.0 (cu128), the requirements, gsplat built for 8.6 | 15-30 min |
| `weights` | `hpg/fetch_weights.py`, about 71 GB into `/root/dejaview/models` | 10-30 min |
| `smoke` | `hpg/smoke/*` on the A40 (FlashWorld runs with T5 offload on 48 GB) | 10-15 min |

Every stage after `system` is `hpg/setup.sh`'s own, run directly instead of through `srun`. It stops at the first
failure with what to do; fix it and run the same command again (environments, clones and weights already there are
kept), or one stage: `bash /root/dejaview/repo/vultr/setup.sh envs`. Re-run stages with `vultr/setup.sh`, not
`hpg/setup.sh`: the latter wants Slurm, even when its own error line names it.

## 4. Start the worker (on the box)

```bash
TW_WORKER_IDLE=21600 bash /root/dejaview/repo/vultr/worker.sh start 8   # up to 8 h; exits after 6 h without work
bash /root/dejaview/repo/vultr/worker.sh status                          # ready when it says status=idle (1-3 min)
```

Without `TW_WORKER_IDLE` it exits after 20 idle minutes, as on HiPerGator; here that saves nothing (the box bills
anyway), so keep it long for the demo window. `worker.sh logs` shows the end of its log; `worker.sh stop` makes it
exit after the current job (`stop --now`: at once, the job goes back to the queue).

## 5. Point the Déjà View server at it (Mac)

Add to `.env` in the repo root (the `HPG_*` lines can stay: `VULTR_HOST` takes over from them):

```bash
VULTR_HOST=<ip>
VULTR_SSH_KEY=~/.ssh/id_ed25519
```

Restart the server (`bun run https`, or `bun run dev`). `VULTR_SSH_KEY` is optional (without it ssh uses its usual
keys and agent). Rarely needed: `VULTR_USER` (default `root`), `VULTR_ROOT` (`/root/dejaview`), `VULTR_SSH_OPTS`
(extra ssh arguments, e.g. `-p 2222`), `VULTR_SOCKET` (the ssh master, `~/.ssh/cm-vultr-%C`). `THIRDWHEEL_HPG=off`
still turns every GPU-box call off.

Check: the startup "Backends:" line says `online (worker on dejaview-gpu)`, and
`curl -sk https://localhost:8787/api/health` shows `"hpg":{"online":true,"user":"root","worker":{"alive":true,...`.

Back to HiPerGator: delete the `VULTR_HOST` line and restart.

Two places still say HiPerGator while `VULTR_HOST` is set: the `/host` page's worker commands (on the box they are
`worker.sh start`, `status` and `logs`), and `bun scripts/preflight.ts`, whose "HiPerGator session" row then checks
the box's ssh master (the command it prints opens one).

## 6. Test with one photo (Mac)

```bash
curl -sk -F mode=photo -F name="Vultr test" -F backend=hpg-worker -F files=@room.jpg https://localhost:8787/api/scenes
```

`backend=hpg-worker` keeps it on the box (no fallback). The card in the gallery goes from building to ready in a
minute or two (the A40 has no FP8, so FlashWorld takes its slower dequantised path); `data/scenes/<id>/log.txt` says
`running on Vultr worker`, and on the box `worker.sh status` shows `jobsDone=1`. With `bun run dev`, use
`http://localhost:8787` here and in step 5.

## 7. Destroy the instance after the demo

Vultr console → Products → the `dejaview-gpu` server → **Destroy** (trash icon) → confirm. Stopping it is not enough:
a stopped GPU instance still bills. Then remove `VULTR_HOST` from `.env`.

## When something goes wrong

| Symptom | Do this |
| --- | --- |
| `push.sh`: could not log in | the key was not ticked at deploy: the server page has the root password, `ssh-copy-id root@<ip>` with it, push again |
| `Host key verification failed` | a new box on a reused IP: `ssh-keygen -R <ip>`, then again |
| `setup.sh`: the driver supports CUDA 11.x | do not install a driver over Vultr's vGPU one: `/opt/nvidia/update.sh` (Vultr's), or redeploy from a current GPU image |
| `setup.sh smoke` fails with `CUDA driver version is insufficient` | the CUDA 12 driver is too old for these wheels after all: `/opt/nvidia/update.sh`, then the smoke stage again |
| `setup.sh envs` fails building gsplat | the log is named in the error; `MAX_JOBS=4` in `/root/dejaview/config.env` if it ran out of memory |
| server log: `Vultr worker: skipped (the GPU worker is not running)` | `worker.sh status`; `worker.sh start` |
| server log: `offline, cannot log in to root@<ip>` | `ssh root@<ip> true` from the Mac; check `VULTR_HOST` and `VULTR_SSH_KEY` |
| CUDA out of memory | the smoke test and the worker at the same time do not fit: `worker.sh stop` first |
