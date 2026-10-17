# The reconstruction loop and the mega evaluation

Brief: `team/shivin-reconstruction-loop.md`. Branch: `shivin/recon-loop`, based on `seb/object-layer`. My
`shivin/object-detail` branch is merged in for its CPU renderer, metrics and map baker.
Status: code, tests and PACE jobs done. **The kitchen numbers below are pending the firstmate's PACE run**: the scene
data isn't in the repo, so nothing here has run on the real stove yet. Nothing uploads, approves or publishes.
Nothing writes into `<scene>/objects/`. The approved fridge and every approval file are untouched.

## 1. The evaluator (`pipeline/objects/eval/`)

`evaluate.py --scene data/scenes/kitchen --object all` writes `objects/<id>/eval.json` and `eval-sheet.jpg` per object.

**Held-out views.** The object bakes render their own orbit around the cropped splats, so all 16 scene cameras in
`views/views.json` are held out from every bake. For each view that sees the object (at least 300 px), the mesh is
rendered from exactly that camera by the CPU rasteriser.

**Ground truth.** The splat render and depth of that view, and the object's mask from `masks-all/`: a detection
with the same label in that view that overlaps the object box's depth silhouette (IoU ≥ 0.15; the best one wins,
so a second stove elsewhere in the frame isn't used). If no mask fits, the box silhouette is used, and `maskSources`
says which. Mesh pixels hidden behind other furniture (scene depth more than 4 cm in front of the mesh) are dropped
from every metric.

**Metrics.** Each view metric gets a mean, median and worst over views, because one lucky angle is not a pass.

| Metric | How |
|---|---|
| Silhouette IoU | mesh coverage vs the object mask |
| Depth MAE and relative error | where both have depth, in metres and as a share of the distance |
| PSNR, SSIM | inside the mask, on luminance (SSIM, Gaussian window) |
| Normal consistency | mean \|cos\| between normals from the splat depth (central differences 2 px apart) and the mesh's normals; share within 30° |
| Chamfer distance | mesh → splat and splat → mesh. The splat surface is the unprojected depth inside the mask, and only mesh surface some held-out camera sees counts (no one filmed the stove's base). Both sides are point samples, so even a perfect mesh measures a little. `samplingFloor` estimates that, and the score only counts what's above it |
| Texture sharpness | variance of the Laplacian of the baked atlas (covered texels only), and its ratio to the splat renders |
| Holes | boundary edges per 1000 triangles, after welding seam vertices |
| Watertight, components, triangles, atlas size, GLB bytes | from the mesh and the file |

**Score (0–100):**
`25 IoU + 15 SSIM + 10 PSNR + 10 depth + 10 Chamfer + 10 normals + 10 sharpness + 10 holes`.
IoU and SSIM use the average of the mean and the worst view. PSNR maps 15–35 dB onto 0–1. Depth maps 0–5 cm onto
1–0. Chamfer above the sampling floor maps 0–3 cm onto 1–0. Holes map 0–20 per 1000 triangles onto 1–0.

**Hard gates.** Any failure blocks the object, whatever its score:

| Gate | Fails when |
|---|---|
| codes | `preflight.scan_codes` decodes a QR code or barcode with a payload. **Fails closed** when OpenCV is missing. Empty-payload pattern hits are listed for the human, not failed |
| texture | no base colour texture |
| silhouette | any held-out view has IoU < 0.5, or the median is < 0.7 |
| approval | `preflight/approval.json` exists but its SHA1 isn't this file's (changed after approval), or a person denied this exact file |

The evaluator only reads approvals. Its code scan goes to `eval-scan/`, never to the object's own `preflight/`.

**The scorecard.** `eval.json` → `card` has the score, the gate state, IoU, SSIM, PSNR, Chamfer, normals,
sharpness, triangles, holes, size and the approval state with the SHA1. It's marked `advisory: true`. The review site
isn't edited here (the brief forbids it); its owner can show `card.lines`.

## 2. The advisory judge (`eval/judge.py`, `eval/judge_rubric.md`)

`evaluate.py --judge` sends each contact sheet (mesh | splat | mask | difference) to Gemini (`GEMINI_API_KEY` from
the environment, never stored; `DEJAVIEW_JUDGE_MODEL`, default `gemini-2.5-flash`) with the rubric in the repo. It
gets back shape, texture, scale and artifacts on a 1–5 scale, a verdict (good, usable or redo), concrete problems
and one sentence. Replies are validated and clamped, and a broken reply is recorded, not fatal. Results are cached
by (image hash, prompt hash, model), so a re-run costs nothing. **It never approves**: every result carries
`approves: false`, and nothing in the loop or the evaluator reads the verdict as permission. The captain approves.

## 3. The loop (`pipeline/objects/loop/`)

`run.py --scene data/scenes/kitchen --object stove` runs one episode per object:

1. **Baseline.** Evaluate the current `objects/<id>/roblox.glb` as the "current" row.
2. **Rung 0 at 512 px with a 1024 atlas.** 8 configurations for a 14-trial budget. Trial 1 is always the point
   of the space nearest the current bake (`CURRENT_LIKE`). Trial 2 takes each knob's best value under the bandit
   prior. The rest are drawn from that prior.
3. **Rung 1 at 768 px.** The best four, ranked so trials with a broken silhouette or missing texture fall behind
   every working one. The weaker two each also move one knob (the evolutionary step).
4. **Rung 2 at 1024 px with a 2048 atlas.** The best two.
5. **Stop rule.** Stop when three trials in a row don't beat the best: after at least four rung-0 trials; per rung
   after that, since a higher resolution is a new baseline.
6. **Output.** `loop.json` has every trial's configuration, metrics, score, runtime, triangles, bytes and SHA1,
   the Pareto front (score up; triangles, bytes and runtime down), why it stopped, and a recommendation: which
   configuration won, which knobs changed from the current bake, the three score terms that gained most, and what
   still fails. The best mesh goes to `objects-loop/<id>/best/` with its `eval.json` and its **new SHA1, which needs
   a person's approval**.

**Configuration space** (the brief's): voxel 5 / 7.5 / 10 / 15 mm; 12 / 24 / 48 views; atlas 1024 / 2048;
minimum component 0.0005 / 0.001 / 0.005 m²; smoothing and decimation none / light / strong (20k / 14k / 8k
triangles with 0 / 2 / 6 Taubin iterations, seams welded and rims held); chunks "one atlas" or "one atlas plus the
floor fill"; normal and AO maps off / light / strong; ink off, always on for flat signs.

**The bandit.** The context is the object's class (regular, small or flat, from the splats' shape). Every knob value
keeps a count and a reward: the trial's score divided by the best score in its rung, so resolution isn't credited to
a knob. Proposals use upper confidence bounds. `prior.json` carries this from object to object, and objects running
in parallel (`--parallel 2`, one GPU) merge what they learned after each wave. No neural network, no training.

## 4. The room shell, no ceilings (`loop/room.py`, `run.py --room`)

The room baker splits an indoor lid into `ceiling_NN` chunks. The shell path bakes the room with a configuration
from `ROOM_SPACE` (the same knobs with 1–3 cm voxels), then removes the `ceiling_*` chunks and, in every other chunk,
each downward-facing triangle within 15 cm of the ceiling height, plus anything above it. The ceiling height comes
from the bake (`ceilingY`) or the voxel map. Wall-cabinet undersides face down too but sit well below, so they stay.
The GLB records `ceiling: removed`, and the bake raises an error if a single ceiling triangle survives.

The room is scored by the same evaluator, with the room box ending 15 cm under the ceiling as its silhouette, so
ceiling pixels never count. `room-shell.json` reports triangles, draw calls (one per MeshPart chunk) and texture
memory against working targets: Quest 100k triangles, 40 draws, 96 MB; mobile 150k, 60, 128 MB. Roblox publishes no
hard limits, so tune these on the devices.

## 5. Results

Filled in by `python pipeline/objects/loop/report.py --scene data/scenes/kitchen --write docs/object-reconstruction-loop.md`
after the PACE run.

<!-- loop-tables:begin -->
### Evaluator, every object

(pending the PACE run: `loop.sbatch <scene> eval`)

### Loop, current vs best

(pending the PACE run: `loop.sbatch <scene> stove`)
<!-- loop-tables:end -->

## 6. Running it on PACE

```bash
# the evaluator on all ten objects (add GEMINI_API_KEY to the job's environment for the judge)
sbatch --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION pipeline/objects/loop/jobs/loop.sbatch data/scenes/kitchen eval
# the loop on the stove: the acceptance run
sbatch --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION pipeline/objects/loop/jobs/loop.sbatch data/scenes/kitchen stove
# every object, then the room shell
sbatch ... loop.sbatch data/scenes/kitchen all
sbatch ... loop.sbatch data/scenes/kitchen room
# fill section 5
python pipeline/objects/loop/report.py --scene data/scenes/kitchen --write docs/object-reconstruction-loop.md
```

Outputs stay under `data/` (gitignored). Don't commit GLBs, maps, sheets or `prior.json`.

## 7. Known limits

- The splat views are the ground truth, so the loop can only get as close as the splats are. It can't recover
  detail the capture never had. The original photos would raise that ceiling, and the evaluator takes any view set
  in the same `views.json` format.
- Every trial is a full bake. At 1024 px and 5 mm, a stove trial will take minutes, and 14 trials fit a 4-hour job.
  Time the first run and lower `--budget` for big objects if needed.
- The normal and roughness maps are derived from albedo (heuristic). They help the look on Roblox but aren't
  measured.
- The codes gate needs OpenCV in the job's environment. Without it, every object is blocked on purpose.
