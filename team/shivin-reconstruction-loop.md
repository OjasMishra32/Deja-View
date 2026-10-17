# Shivin: the reconstruction accuracy loop and the mega evaluation

Owner: Shivin.
Branch: `shivin/recon-loop`, based on `seb/object-layer`.
Status: proposed. No uploads, no approvals, no publishing.

## Why

The current kitchen objects are high detail for a splat bake: 1024 px views, 2048 px
atlases, 1 cm voxels, one object atlas. They are still not maxed. We want the meshes to
get more accurate from the **current captures** without new photographs and without
expensive training.

The method is a cheap closed-loop reconstruction optimizer. Each object is one episode.
A configuration is chosen, baked, rendered from held-out views, scored, and the next
configuration is chosen from the score. A contextual bandit or a small evolutionary
search is enough. No neural network training is required.

The second deliverable is the mega evaluation and judgement system. It must tell us,
with evidence, how accurate and how robust each object is before the captain approves it.

## Current inputs

Use the existing scene, not new captures:

- `data/scenes/kitchen/views/` and `views.json`: the 16 scene cameras and splat renders.
- `data/scenes/kitchen/masks-all/`: the masks for the held-out comparison.
- `data/scenes/kitchen/objects-all.json` and `objects.json`: the object set in studs.
- `data/scenes/kitchen/objects/<id>/roblox.glb`: the current high-detail meshes.
- `pipeline/objects/mesh.py`: the object bake entry point.
- `pipeline/roblox_mesh.py`: the TSDF, decimation, atlas, and GLB machinery.
- `pipeline/objects/preflight.py`: the texture sheet and moderation scan.
- `docs/object-layer.md`: the contract.

The original 36 photos are not required for this loop. If they become available, the
same evaluator can compare against them later.

## Deliverable 1: the evaluator

Add `pipeline/objects/eval/` with a CLI and tests.

For each object and each held-out scene view:

1. Render the current mesh from the same camera as the splat view.
2. Render or load the splat ground truth for the same view and mask.
3. Compare the two.

Metrics:

- Silhouette IoU against the object mask.
- Depth MAE and relative error where both have depth.
- Colour PSNR and SSIM inside the object mask.
- Texture sharpness: variance of Laplacian on the baked texture.
- Holes: boundary edges per 1000 triangles.
- Watertightness and connected components.
- Chamfer distance from the mesh to the splat surface.
- Normal consistency between mesh and splat normals.
- Triangle count, atlas size, and GLB bytes.
- Robustness: mean, median, and worst held-out view. One lucky angle is not a pass.

Write `objects/<id>/eval.json` and a contact sheet showing the mesh render, the splat,
the mask, and the difference. Return a single weighted score and the hard-gate result.
Hard gates: decodable QR or link, missing texture, broken silhouette, or a changed file
without a new approval.

## Deliverable 2: the loop

Add `pipeline/objects/loop/` with a CLI and tests.

Configuration space:

- Voxel size: 0.005, 0.0075, 0.01, 0.015
- View count: 12, 24, 48
- View resolution: 512, 768, 1024
- Atlas: 1024, 2048
- Cleanup minimum: 0.0005, 0.001, 0.005 m2
- Smoothing and decimation: none, light, strong
- Chunk policy: one atlas, or one atlas plus a separate floor fill
- Normal and AO strength: off, light, strong
- Ink: off, or on for signs and posters

Each trial runs the existing bake with one configuration, then the evaluator. The
search budget is 10 to 15 trials per object. Use successive halving first: all configs
at 512, then the best four at 768, then the best two at 1024 and 2048. Run independent
objects in parallel on one GPU. Record every trial in `objects/<id>/loop.json` with its
configuration, metrics, score, and runtime. Keep the Pareto front, not only the winner.

The loop stops when the best score has not improved for three trials, or when the
budget is spent. The output is the best GLB, its `eval.json`, the trial table, and a
short recommendation.

## Deliverable 3: the judgement

Automated metrics are necessary but not sufficient. Add an advisory judge:

- A VLM judge compares the mesh render and the splat side by side.
- It returns a structured score for shape, texture, scale, and obvious artifacts.
- It never approves. The captain approves.
- A human-readable scorecard goes on the review card.

The judge can use Gemini or another available VLM. Keep the prompt and the rubric in
the repo. Cache results by image hash so a re-run is cheap.

## Deliverable 4: the room shell, no ceilings

The environment needs the same treatment as the objects, minus ceilings.

- No ceiling geometry, no ceiling texture, no ceiling triangles.
- High-detail walls, floor, and fixtures.
- The evaluator and the loop apply to the room shell too.
- Measure the room with the same silhouette, depth, colour, and sharpness metrics.
- Report triangle budget and draw calls for Quest and mobile.

## Boundaries

- Work in new files under `pipeline/objects/eval/`, `pipeline/objects/loop/`,
  `tests/pipeline/`, and `docs/object-reconstruction-loop.md`.
- Do not edit the upload script, the review site, `ObjectLayer`, or the approval files.
- Do not upload, approve, publish, or change the approved fridge.
- Do not commit scene data, weights, or generated GLBs.
- The firstmate runs the PACE GPU jobs. Write the job scripts and the tests.
- Any change to a GLB invalidates its approval. The loop must report the new SHA1.

## Acceptance

- `pytest tests/pipeline/test_object_eval.py tests/pipeline/test_object_loop.py` passes.
- The evaluator runs on all 10 kitchen objects and writes one `eval.json` each.
- The loop runs on the stove end to end and writes `loop.json` and the best mesh.
- `docs/object-reconstruction-loop.md` has the current-versus-best table for the stove.
- No ceilings in the room bake path.
- No uploads and no approval changes.
- The report states which configuration won, why, and where the metric still fails.

## Agent prompt

```
You are working in the Deja-View repo on a parallel branch, `shivin/recon-loop`, based on
`seb/object-layer`. Read `team/shivin-reconstruction-loop.md`, `docs/object-layer.md`, and
`docs/vision.md` first.

Build a cheap closed-loop reconstruction optimizer and a rigorous evaluator for the
current kitchen object meshes. The inputs are the existing splat views, masks, object
boxes, and high-detail GLBs. Do not use new captures. Do not train a neural network. Use a
contextual bandit or a small evolutionary search over the bake configuration.

Deliver `pipeline/objects/eval/` with held-out render comparisons and metrics: silhouette
IoU, depth MAE, colour PSNR and SSIM, texture sharpness, holes, watertightness, Chamfer
distance, normal consistency, triangle and atlas budgets, and robustness across views.
Deliver `pipeline/objects/loop/` with a 10 to 15 trial search, successive halving, a
Pareto front, and `eval.json` and `loop.json` per object. Add the room shell evaluation
with no ceilings. Add an advisory VLM judgement with a structured rubric, but never
auto-approve; the captain approves.

Work only in new files. Do not edit the upload script, review site, ObjectLayer, or
approval files. Do not upload, publish, or commit data or generated GLBs. Write the PACE
job scripts and tests; the firstmate runs the GPU. Report the current-versus-best table
and the remaining failure cases.
```
