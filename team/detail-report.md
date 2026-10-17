# Detail report: current vs new, kitchen objects

For the captain. Brief: `team/shivin-object-detail.md`. Method and recommendation: `docs/object-detail.md`.

**Status: waiting on the first PACE run.** Everything needed to fill this in is ready. Run `jobs/detail.sbatch`,
then `jobs/alt-methods.sbatch` on the stove, then:

    python pipeline/objects/detail/report.py --eval data/scenes/kitchen/detail-eval --write team/detail-report.md

That replaces the block below with one row per object: kind, the score for each mesh set, IoU, SSIM, sharpness and
holes (current → new), new triangle count, which maps are present (N/A/R) and the best method. Failing objects
(score under 60, errors, missing meshes) are listed after the table.

<!-- detail-table:begin -->
| Object | Kind | current score | new score | IoU cur→new | SSIM cur→new | Sharp cur→new | Holes cur→new | Tris new | Maps new | Best |
|---|---|---|---|---|---|---|---|---|---|---|
| (pending PACE run) | | | | | | | | | | |
<!-- detail-table:end -->

## What to check before anything is promoted

- The fridge stays as it is (approved; SHA-1 bound).
- An object is promoted only if `new score > current score` **and** a person has looked at `detail-eval/<id>/sheet.jpg`.
- Flat signs and posters come out inked. Still run `preflight.py --glb` on every candidate.
- Approval and upload stay manual (`review.py --approve`, then the upload script). This work does neither.

## Known limits

- Normal and roughness maps are derived from albedo (heuristic), not measured.
- External methods (SuGaR, 2DGS, GOF) are under the Inria non-commercial licence. They are for evaluation only.
- The source-photo comparison (task 1) needs the capture poses from the reconstruction job folder. None are in the repo.
