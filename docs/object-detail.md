# Object detail

Status: code, tests and PACE jobs are done. **The numbers in the table below are pending the first PACE run.**
Brief: `team/shivin-object-detail.md`. Nothing here uploads, approves or publishes. Nothing writes to
`<scene>/objects/`, so the approved fridge, its approval and the upload gate are untouched.

## 1. Why the current objects are soft

The object pass reuses the room baker at room settings: 512 px orbit views, a 1024 px atlas, room-scale cleanup
(minimum component and airborne removal sized for a room), and many small chunks. A 0.6 m stove at 512 px gets
about 2 px per cm in the views, and the atlas then resamples that again. Thin parts (knobs, handles, cabinet
pulls) fall under the minimum component and disappear. Posters become TSDF pillows.

## 2. What was built (`pipeline/objects/detail/`)

| File | What it does | Needs |
|---|---|---|
| `glb.py` | Reads and writes the room baker's GLB layout (studs relative to each chunk's node, JPEG atlas per chunk); reads OBJ / PLY from external methods | numpy, Pillow |
| `raster.py` | CPU z-buffer renderer for any pinhole camera in `views.json` convention (OpenGL c2w, `u = cx + fx x/z`, `v = cy - fy y/z`); perspective-correct UVs | numpy |
| `metrics.py` | Silhouette IoU, depth MAE, masked PSNR, SSIM, variance of the Laplacian, holes, boundary and non-manifold edges, watertightness, components | numpy (scipy optional) |
| `maps.py` | Bakes tangent-space normal, AO (shadow maps over 48 directions) and roughness per atlas, plus `detail-maps.json` | numpy, Pillow |
| `flat.py` | Classifies regular / small (< 0.2 m³) / flat, picks adaptive parameters, builds the bevelled slab for posters and signs | numpy |
| `reconstruct.py` | The high-detail rebuild, one object or all, into `<scene>/objects-detail/<id>/` | torch + gsplat (PACE) |
| `evaluate.py` | The eval harness: `detail.json` + `sheet.jpg` per object, `detail-summary.json` | numpy; `--orbit` uses splat_io |
| `export_dataset.py` | Object-centric Blender/3DGS dataset for SuGaR, 2DGS, GOF and Grouping | splat_io |
| `source_photos.py` | Task 1: photo vs 512 px splat-render sharpness | numpy; splat_io for posed renders |
| `report.py` | Builds the comparison table from the eval output | none |
| `jobs/` | `detail.sbatch` (rebuild + eval + table), `setup-alt.sh`, `alt-methods.sbatch` | PACE or HiPerGator |

Tests: `pytest tests/pipeline/test_object_detail.py` (21 tests, about 2 s, no GPU and no scene data). They use
synthetic meshes and cameras. They check the GLB round trip, the renderer against analytic projection and depth,
z-buffering, every metric, watertightness and hole counting, map baking (AO darkens the floor next to a box), the
flat slab and rectification, and the harness end to end: a sharp, correct mesh beats a blurry, oversized one with a
hole, occluders are excluded, and the current set is never written.

## 3. High-detail parameters (task 2 and 3)

`flat.params_for` sets these per object:

| | regular | small (< 0.2 m³) | flat (poster / sign) |
|---|---|---|---|
| Views | 16 per ring × 4 rings (−15°, 10°, 35°, 60°) + top, 1024 px | same, 1280 px, closer orbit | one frontal splat render, rectified |
| Voxel | max extent / 256, clamped 0.5 to 1 cm | max extent / 320, clamped 0.4 to 0.6 cm | no TSDF |
| Atlas | 2048 | 2048 | 2048 wide, aspect kept |
| Chunks | 1, or 2 above 1.2 m, ≤ 18k triangles each | 1 | 1 (about 28 triangles) |
| Minimum component | (2 % of extent)² m², 2e-5 to 1e-3 | (1 % of extent)², 5e-6 to 2e-4 | n/a |
| Airborne removal | off (keeps wall cabinets) | off | n/a |
| Ink pass | off | off | **on (1.2)** |

An object is classified flat when its splats' robust PCA thickness is under 8 cm and under 12 % of its middle
extent. The splats decide this, not the loose detector box, so a poster in a 30 cm box still counts. A flat
object's front faces into the room, and "up" is its more vertical in-plane axis.

Maps: `chunkNN_normal.png` (tangent space, OpenGL +Y, which is what `SurfaceAppearance.NormalMap` expects),
`chunkNN_roughness.png`, `chunkNN_ao.png` and `chunkNN_color.png` are listed with SHA-1s in `detail-maps.json`
beside `roblox.glb`. Roblox has no AO slot, so by default AO is multiplied into the colour at 50 % and the GLB
carries that colour (`--ao-into-colour 0` turns it off). The normal and roughness maps are **heuristics** derived
from the baked albedo, not measured materials. The eval scores what Roblox would show.

## 4. The eval harness (task 4)

```bash
python pipeline/objects/detail/evaluate.py --scene data/scenes/kitchen --orbit
```

References per object:
- **views**: the scene's own splat renders. A pixel is in the object's silhouette when its splat depth unprojects
  inside the object box (±3 cm). Mesh pixels hidden behind other furniture (scene depth more than 4 cm in front of
  the mesh) are dropped from every score.
- **orbit** (`--orbit`): the object's cropped splats rendered at 1024 px from 9 object-centric cameras (two rings and a top view).

Every mesh set (current, new, each `--method`) is rendered from exactly those cameras. Per mesh, `detail.json` has
IoU, depth MAE (m), PSNR, SSIM, Laplacian variance and sharpness against the splats (1.0 = as sharp as the splat
render), triangles, vertices, holes, boundary and non-manifold edges, watertightness, components, texture sizes,
which maps are present, per-view rows, and one score:

    score = 100 × (0.35 IoU + 0.25 SSIM + 0.15 PSNR(15→35 dB) + 0.15 min(1, sharpness) + 0.10 depth(0→5 cm))
            − min(10, 0.5 × holes)          grade A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, F

**The review card.** `detail.json` is also copied beside the new GLB (`objects-detail/<id>/detail.json`). Its
`card` block is `{score, grade, currentScore, delta, line}`, where `line` is a one-line summary such as
"Detail 78.2 (B) · was 61.0 · IoU 0.93 · SSIM 0.81 · 17890 tris, 0 holes". The brief forbids editing the review
site, so showing the score there is left to the site's owner: read `card.line` from `detail.json` when it exists.

## 5. Alternative methods (task 5)

Run on one object (the stove, or a cabinet) with `jobs/alt-methods.sbatch <scene> stove`, after `jobs/setup-alt.sh`.

| Method | Licence | What it gives | Install cost | Runtime | Quality |
|---|---|---|---|---|---|
| TSDF detail (this repo) | ours | textured mesh, our GLB | none (anysplat env) | pending | pending |
| [SuGaR](https://github.com/Anttwo/SuGaR) @ `7c10c4a` | Inria Gaussian-Splatting License: non-commercial research and evaluation only | mesh (OBJ) + its own texture | heavy: PyTorch3D, nvdiffrast, 2 CUDA extensions | pending | pending |
| [2DGS](https://github.com/hbb1/2d-gaussian-splatting) @ `f3e3b9f` | Inria Gaussian-Splatting License (non-commercial) | TSDF of surfel depth (PLY), sharp thin geometry | medium: 2 CUDA extensions | pending | pending |
| [Gaussian Opacity Fields](https://github.com/autonomousvision/gaussian-opacity-fields) @ `5245b20` | Inria Gaussian-Splatting License (non-commercial) | marching tetrahedra mesh (PLY), unbounded scenes | medium-heavy: CUDA extensions + CGAL tetra build | pending | pending |
| [Gaussian Grouping](https://github.com/lkeab/gaussian-grouping) @ `0ab60af` | Apache-2.0, but it builds Inria's `diff-gaussian-rasterization` (non-commercial) | object-segmented Gaussians, no mesh: we mesh them with our TSDF | medium: 2 CUDA extensions | pending | pending |

The licences were checked against each repo's LICENSE at those commits. Nothing is vendored: `setup-alt.sh`
clones into `$TW_SRC`, builds a separate env per method in `$TW_ENVS/detail-*`, copies each LICENSE into
`$TW_LOGS`, and logs install time and env size to `detail-setup.tsv`. Runtimes go to
`<scene>/detail-methods/runtime.tsv`. External meshes have no texture in our layout, so their scores rely on
IoU, depth and mesh quality. Their colour and SSIM terms render flat grey, so compare those columns only between
textured meshes.

## 6. Results

The full table, filled by `report.py`, is in `team/detail-report.md`. Pending the PACE run.

## 7. Recommendation

1. **Ship path: the TSDF detail path in this repo** for regular and small objects, and **the slab** for posters and
   signs. They need no new dependencies, keep a clean licence, and produce the same GLB the loader and upload gate
   already handle. Promote an object only when its new score beats its current score, and only through the
   existing review: preflight, look at the sheet, `review.py --approve` by a person.
2. **SuGaR, 2DGS and GOF are evaluation only.** Their licence is non-commercial research. Unless the team decides
   otherwise, their meshes should not go into the public Roblox game. If one clearly wins on thin parts, use it
   to tune our path (voxel, views) rather than shipping its output.
3. **Gaussian Grouping** is worth it if the eval shows wall and floor bleed (low IoU, high depth MAE at the
   object's base). It fixes separation, not surface quality.
4. Keep the fridge as it is. It is approved, and its SHA-1 approval would break if it were rebuilt.

## 8. Source photos (task 1)

No capture photos or poses were found in the repo (scene data is not committed). If the kitchen came from
AnySplat, its job folder has `cameras.json` + `input_camera.json`, and
`source_photos.py --photos <frames> --cameras <cameras.json> --scene data/scenes/kitchen` renders the splats from
each photo's pose at 512 px and reports the Laplacian-variance ratio photo / splat (overall and inside a mask).
Without poses it reports the photos at 512 px against the scene's 512 px views. That still bounds the gap, but
it is not a per-pixel match. If the ratio is large (more than about 3×), projecting texture from the photos
instead of the splats is the next big win. That is a follow-up, not part of this brief.

## 9. Running it on PACE

```bash
# once
srun --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION --gpus=1 --mem=32gb --time=01:30:00 \
  bash pipeline/objects/detail/jobs/setup-alt.sh
# the eight objects: rebuild, evaluate, table
sbatch --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION \
  pipeline/objects/detail/jobs/detail.sbatch data/scenes/kitchen
# task 5 on the stove
sbatch --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION \
  pipeline/objects/detail/jobs/alt-methods.sbatch data/scenes/kitchen stove
# fill the report
python pipeline/objects/detail/report.py --eval data/scenes/kitchen/detail-eval --write team/detail-report.md
```

Outputs stay under `data/` (gitignored). Do not commit GLBs, maps or eval images.
