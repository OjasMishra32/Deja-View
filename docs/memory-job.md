# One command for a video memory

Brief: `team/shivin.md` Update 19, job 3. Code: `pipeline/memory_job.py`. Tests: `tests/pipeline/test_memory_job.py`.

Tonight's chess memory took many separate HiPerGator steps, and four pipeline bugs were fixed by hand along the
way. Now it's one command:

```bash
# look first: prints the plan, writes and submits nothing
python pipeline/memory_job.py --clip IMG_7398.mov --start 41.5 --end 56 --world data/scenes/chess-room \
    --id chess-match --name "Giant chess" --people 2 --dry-run
# then on HiPerGator: writes the job folder and submits the chain
python pipeline/memory_job.py ... --root $HPG_ROOT/jobs/memory-chess-match --submit
```

Inputs:
- **The clip.** It must be one the place was rebuilt from, because its camera poses come from that reconstruction
  (`<world>/<clip>-poses.json`).
- **The window,** in seconds.
- **The world's scene folder,** the memory's id and name, and how many people.

## The chain

| Step | Where | What | Waits for |
|---|---|---|---|
| cut | CPU | Source frames first to last, selected by number. Re-encoded near-lossless with the clip's own colour tags (HDR stays HDR), audio trimmed to the same span. The clip's poses are cut to the window and counted from its first frame. | – |
| frames | CPU | `people.py frames` | cut |
| register | GPU | `people.py register` | frames |
| pack | CPU | `people.py pack`: the video layer, `camera-track.json`, the scene folder | register |
| poses | GPU | `avatar.run --steps hmr`, the pose step alone | register |
| body | CPU | `avatar.run` ground, refine, body, offsets, texture, fill (split into several jobs when long) | poses |
| photofit | GPU | `avatar.run` photofit, glb | body |
| install | CPU | The people into the memory's folder, `video.avatars` pointing at them and at the window's camera track, the folder checked | pack, photofit |

- **One GPU at a time.** register, then poses, then photofit, each waiting for the one before. pack runs on a CPU
  beside poses.
- **Checks after every step.** Each step ends with `memory_job.py check`, which looks for what the next step
  reads. The pose step needs `hmr.npz`, photofit needs one `avatar-<k>.glb` per person, the cut needs the right
  length, and so on.
- **Failures stop the chain.** A step that exits 0 without its outputs fails there, and Slurm's
  `afterok` + `--kill-on-invalid-dep` cancels the rest.
- **The job folder** holds a code snapshot, `plan.json`, one sbatch script per step, logs, the work folders and
  `scene/<id>/`. `submitted.json` has the job ids.
- **Install** leaves the finished memory in `scene/<id>/`, checks that every file `scene.json` names is there, and
  prints the rsync to the server's `data/scenes/<id>/`.

## The four hand fixes, built in

- **SDR clips.** The cut keeps the clip's colour tags, so `people.py` sees HDR (HLG or PQ) or standard colour from
  the file itself. No HDR gain is ever forced on a standard clip.
- **Pose-only runs.** The pose step is its own GPU job (`--steps hmr`), checked for `hmr.npz` alone. The CPU steps
  make the tracks in their own job.
- **Helper modules missing from job copies.** The job runs from a snapshot of the whole `pipeline/` folder. Before
  anything is submitted, the plan follows every step's imports recursively (people.py from `pipeline/recon`, the
  avatar package from the repo root) and refuses to submit if a local module is missing from the snapshot. The test
  deletes `avatar/util.py` from a snapshot and the check names it.
- **The 29-minute limit.**
  - **Estimates.** Every step is estimated from the window length and the number of people, using the timings the
    scripts document. Photofit uses its own step formula and per-pass time budgets.
  - **Caps.** A GPU step is planned under the 29-minute cap and a CPU step under 50, with 15 % headroom.
  - **Over the cap:**
    - The avatar CPU steps are split into several jobs at step boundaries; they are cached, so that is safe.
    - register refines every n-th frame's pose (`--refine-every`, the option people.py has for long clips).
    - photofit runs one pass instead of two.
    - Only when even one pass can't fit (many people over a long window) is photofit turned off, with a warning in
      the plan.

## What the plan says for common windows (two people)

| Window | register | body | photofit |
|---|---|---|---|
| 12 s | 24 min, every frame refined | one CPU job, 17 min | 17 min, two passes |
| 30 s | 20 min, every 3rd frame refined | one CPU job, 40 min | 18 min, one pass |
| 60 s | 24 min, every 5th frame refined | three CPU jobs (31, 39, 8 min) | 21 min, one pass |

The estimates are the scripts' own documented timings. The first real run will show how close they are; tune
`RATES` and `PF_STEP_MIN` from its logs.

## Not done here

- It hasn't run on HiPerGator. This laptop has no ffmpeg, GPU or Slurm, so the tests stand in for ffprobe, ffmpeg
  and sbatch, and check the commands, the plan and the files. Ojasva runs the real one.
- A memory filmed with a clip that was not part of the place's reconstruction has no camera poses. The command says
  so and stops.
- Splitting photofit's two passes into two GPU jobs would keep both passes on long windows. That needs photofit to
  resume pass 2 from pass 1's saved fit, a change to `pipeline/avatar/photofit.py` best made by its owner.
