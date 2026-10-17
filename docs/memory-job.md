# One command for a video memory

Brief: `team/shivin.md` Update 19, job 3. Code: `pipeline/memory_job.py`. Tests: `tests/pipeline/test_memory_job.py`.

The chess memory took many separate HiPerGator steps, and several pipeline problems were fixed by hand along the
way. Now it's one command:

```bash
# look first: prints the plan, writes and submits nothing
python pipeline/memory_job.py --clip IMG_9291.mov --start 168.5 --end 189.5 --world data/scenes/chess-room \
    --id chess-match --name "Giant chess match" --people 2 --dry-run
# then on HiPerGator: writes the job folder and submits the chain
python pipeline/memory_job.py ... --root $HPG_ROOT/jobs/memory-chess-match --submit
```

Inputs:
- **The clip.** It must be one the place was rebuilt from, because its camera poses come from that reconstruction
  (`<world>/<clip>-poses.json`).
- **The window,** in seconds of the clip. It is cut by presentation time, so 168.5 s in the 29.98 fps chess clip
  is source frame 5051, the same frame the hand cut used.
- **The world's scene folder:** `scene.json`, the world file it names, its collider and map. On HiPerGator that
  means a copy of the place's `data/scenes/<id>/` (rsync it first). The plan checks every file before anything runs.
- The memory's id and name, and how many people.

## The chain

| Step | Where | What | Waits for |
|---|---|---|---|
| cut | CPU | Source frames first to last, selected by number and scaled to the size the clip's camera was solved at (the 4K chess clip to 2560x1440). Re-encoded near-lossless with the clip's own colour tags (HDR stays HDR), the first audio track trimmed to the same span. The clip's poses are cut to the window and counted from its first frame. The step fails if the cut's frame count differs from the window's. | – |
| frames | CPU | `people.py frames` | cut |
| register | GPU | `people.py register`, against the world file `scene.json` names | frames |
| pack | CPU | `people.py pack`: the video layer, `camera-track.json`, the scene folder | register |
| poses | GPU | `avatar.run --steps hmr`, the pose step alone | register |
| body | CPU | `avatar.run` ground, refine, body, offsets, texture, fill (split into several jobs when long) | poses |
| photofit | GPU | `avatar.run` photofit, glb | body |
| install | CPU | The people into the memory's folder, the folder checked | pack, photofit |

- **One GPU at a time.** register, then poses, then photofit, each waiting for the one before. pack runs on a CPU
  beside poses.
- **Checks after every step.** Each step ends with `memory_job.py check`, which looks for what the next step
  reads: `frames.json` and the analysis frames, `register.json` and one render per frame, `hmr.npz`, each avatar
  step's files, one `avatar-<k>.glb` per person, a cut of the right length.
- **Failures stop the chain.** A step that exits 0 without its outputs fails there, and Slurm's
  `afterok` + `--kill-on-invalid-dep` cancels the rest.
- **The job folder** holds a code snapshot, `plan.json`, one sbatch script per step, logs, the work folders and
  `scene/<id>/`. `submitted.json` has the job ids.
- **Install** copies the people (`avatar-<k>.glb`, `avatar.json`) into `scene/<id>/` and checks that every file
  `scene.json` and `avatar.json` name is there. `scene.json` stays as pack wrote it: the viewer finds `avatar.json`
  in the memory's own folder, and the crossfade follows the memory's `camera-track.json` (the refined camera of
  every packed frame). The live chess-match memory is built the same way. Install prints the rsync to the server's
  `data/scenes/<id>/`.

## The hand fixes, built in

- **Camera size.** people.py needs the clip at exactly the size its camera was solved at. The chess clip is
  3840x2160 and its poses 2560x1440, so the cut scales it, as `recon_inputs/clip_window.py` did by hand. A clip of
  another shape than its camera is refused.
- **SDR clips.** The cut keeps the clip's colour tags, so `people.py` sees HDR (HLG or PQ) or standard colour from
  the file itself. No HDR gain is ever forced on a standard clip.
- **Pose-only runs.** The pose step is its own GPU job (`--steps hmr`), checked for `hmr.npz` alone. The CPU steps
  make the tracks in their own job.
- **Helper modules missing from job copies.** The job runs from a snapshot of the whole `pipeline/` folder. Before
  anything is submitted, the plan follows every step's imports recursively (people.py from `pipeline/recon`, the
  avatar package from the repo root) and refuses to submit if a local module is missing from the snapshot. The test
  deletes `avatar/util.py` from a snapshot and the check names it. `hpg/env.sh` comes from beside `pipeline/`, or
  from `$HPG_ROOT/repo` when the working copy has only `pipeline/`.
- **Tools on PATH.** Every step runs inside a pipeline env (flashworld or avatar), which has python, ffmpeg and
  ffprobe. A compute node has none of them by itself; the kitchen memory's first CPU job stopped on that.
- **The 29-minute limit.**
  - **Estimates.** Every step is estimated from the window, the camera size and the number of people, using the
    times the chess and kitchen memories took on HiPerGator (RTX PRO 6000; CPU steps on 16 cores).
  - **Caps.** A GPU step is planned under the 29-minute cap and a CPU step under 50, with 15 % headroom. Each job's
    time limit is one and a half times its estimate (at least 10 minutes, at most the cap).
  - **Over the cap:**
    - register refines every n-th pose (`--refine-every`) and interpolates between, with n the smallest that fits.
    - photofit runs one pass instead of two.
    - The avatar CPU steps are split into several jobs at step boundaries; they are cached, so that is safe.
    - Only when even one photofit pass can't fit (many people over a long window) is photofit turned off, with a
      warning in the plan.

## What the chess memory measured

| Step | Measured | Estimate now | The first plan |
|---|---|---|---|
| frames | 3.1 min | 3.4 | 4.1 |
| register | 17.7 min refining every 6th frame; every 3rd ran out of time | 17.8 for every 6th, 30.2 for every 3rd | 20.9 for every 2nd (really about 43: over the cap) |
| pack | 12.1 min | 12.3 | 8.2, with a 12-minute job limit |
| poses | 1.7 min | 2.0 | 2.8 |
| body | 28.6 min, refine 62 % of it | 28.6 | 28.2 |
| photofit | 17.7 min one pass; two passes ran out of time | 17.8 one pass, 31.1 two | 17.1 one pass |

## What the plan says for common windows (two people, a 2560x1440 camera)

| Window | register | body | photofit |
|---|---|---|---|
| 12 s | 24.5 min, every 2nd frame refined | one CPU job, 17 min | 18 min, two passes |
| 21 s (chess) | 24.0 min, every 4th frame refined | one CPU job, 29 min | 18 min, one pass |
| 30 s | 22.7 min, every 7th frame refined | one CPU job, 41 min | 20 min, one pass |
| 60 s | 24.6 min, every 21st frame refined | three CPU jobs (4, 50, 27 min); refine alone is over the cap, with a warning | off, with a warning |

With a 1920x1080 camera a refined frame costs a little over half as much, so 21 s refines every 3rd frame.

## Not done here

- It hasn't been submitted yet. The dry run has run on HiPerGator, and the cut has run on this laptop on the real
  chess clip (630 frames, 2560x1440, the first frame the source's frame 5051), but frames to install have only run
  as stand-ins in the tests.
- Submitting again starts the chain from the cut. The avatar steps skip what they have cached, but people.py
  redoes frames, register and pack.
- Install doesn't add the memory to the landing page lists.
- A memory filmed with a clip that was not part of the place's reconstruction has no camera poses. The command says
  so and stops.
- Splitting photofit's two passes into two GPU jobs would keep both passes on long windows. That needs photofit to
  resume pass 2 from pass 1's saved fit, a change to `pipeline/avatar/photofit.py` best made by its owner.
