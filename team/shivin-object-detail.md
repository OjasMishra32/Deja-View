# Parallel brief: object detail and evaluation

Owner: Shivin.
Branch: `shivin/object-detail`, based on `seb/object-layer`.
Status: proposed. Nothing here uploads to Roblox.

## Why

The first kitchen object set is on the review site. The fridge is approved. The other
eight objects are too coarse: the room baker uses 512 px views, 1024 px atlases,
aggressive cleanup, and many small chunks. We need maximum detail and a real
evaluation before any asset is pushed.

## Scope

Work only in new files:

- `pipeline/objects/detail/` - the high-detail reconstruction and evaluation code.
- `tests/pipeline/test_object_detail.py` - pure tests.
- `docs/object-detail.md` - results and recommendations.
- `team/detail-report.md` - the current-versus-new table for the captain.

Do not edit `pipeline/objects/mesh.py`, `pipeline/roblox_mesh.py`,
`roblox/src/server/DejaView/ObjectLayer.luau`, `scripts/roblox-publish.sh`, or the
review site. Do not upload, approve, or publish anything. Do not commit scene data,
weights, or generated GLBs. The firstmate runs GPU jobs on PACE.

## Inputs

- `data/scenes/kitchen/world.spz`, `scene.json`, `views/`, `masks-all/`,
  `objects-all.json`, `objects/*/roblox.glb`, and each `preflight/`.
- The current object set and the approved fridge as the quality reference.
- `pipeline/roblox_mesh.py` for the existing TSDF, atlas, and GLB machinery.
- `docs/object-layer.md` for the contract and the review rules.

## Tasks

1. Source photos. Find the original capture photos and camera poses for the kitchen
   if they exist on the capture side. Compare a mask and texture from a source photo
   with the same from a 512 px splat render. Report the measured sharpness difference.
2. High-detail object reconstruction. Object-centric views at 1024 px or higher,
   0.5 to 1 cm voxels, 2048 px atlas, adaptive cleanup, and one or two chunks per
   object. Preserve thin parts. Bake normal, ambient occlusion, and roughness maps
   alongside base colour. Output the same `roblox.glb` plus a sidecar that lists the
   extra maps.
3. Small and flat objects. A separate path for objects under 0.2 m3 and for flat
   posters and signs. Flat signs become a quad or thin slab with a bevel, not a TSDF
   shell. Small objects get a smaller voxel and a scaled minimum component.
4. Evaluation harness. For each object, render the new mesh from the same cameras as
   the splats and measure: silhouette IoU, depth MAE, colour PSNR and SSIM, texture
   sharpness (variance of Laplacian), holes, watertightness, triangles, texture size,
   and whether normal and AO maps exist. Write `detail.json` per object and a contact
   sheet. Put the score on the review card.
5. Alternative meshes. Because this project is not commercial, try SuGaR, 2D
   Gaussian Splatting, Gaussian Opacity Fields, and Gaussian Grouping on one object
   (the stove or a cabinet). Compare against the TSDF baseline with the same metrics.
   Report licence, install cost, runtime, and quality. Do not vendor code with no
   licence.
6. Report. A table of current versus new for all eight objects, with the best method
   per object and the remaining failure cases.

## Acceptance

- `pytest tests/pipeline/test_object_detail.py` passes.
- The eval harness runs on the eight objects and writes one `detail.json` per object.
- `docs/object-detail.md` has the comparison table and the method recommendation.
- No change to the approved fridge, the upload gate, or the review site.
- No uploads.

## Claude prompt

```
You are working on the Deja-View object pipeline in a parallel branch, `shivin/object-detail`,
based on `seb/object-layer`. Read `team/shivin-object-detail.md` and `docs/object-layer.md`
first. Work only in new files under `pipeline/objects/detail/`, `tests/pipeline/`,
`docs/object-detail.md`, and `team/detail-report.md`. Do not edit the existing object mesh,
Roblox loader, upload script, or review site. Do not upload, approve, or publish anything.
Do not commit data, weights, or generated GLBs.

Goal: maximum detail and a rigorous evaluation for the eight kitchen objects. Build an
object-centric high-detail reconstruction path (1024 px views, 0.5 to 1 cm voxels, 2048 px
atlas, adaptive cleanup, one or two chunks, normal/AO/roughness maps, special handling for
flat signs and small objects). Build an evaluation harness that renders the new mesh from
the same cameras and reports silhouette IoU, depth MAE, colour PSNR/SSIM, texture sharpness,
holes, watertightness, triangle and texture budgets. Compare against the current meshes and
try SuGaR, 2DGS, Gaussian Opacity Fields, and Gaussian Grouping on one object now that the
project is non-commercial. Write `docs/object-detail.md` and `team/detail-report.md` with a
current-versus-new table and the best method per object. Keep the approved fridge as the
reference. The firstmate will run the GPU jobs on PACE; write the job scripts and tests.
```
