# Your old home from listing photos

Brief: `team/shivin.md` Update 19, job 2. Code: `pipeline/listing.py`, plus the `listing` option of the
reconstruct mode in `pipeline/run_job.py`. Tests: `tests/pipeline/test_listing.py`. It builds on job 1's automatic
walk zones (`pipeline/walkzone_auto.py`, branch `shivin/walkzone`, which this branch includes).

The old Pennsylvania house kitchen (`/view?scene=old-house-kitchen`) was built by hand from 4 listing photos:
- the watermark trimmed by hand
- the multi-photo rebuild
- the walk box and spawn set by hand

It's now one job:

```json
{"id": "old-house-kitchen", "mode": "reconstruct", "params": {"listing": true}}
```

## The steps

1. **Prepare.** The photos are normalised as in any reconstruct job.
2. **Remove watermarks and logos** (`listing.clean_photos`).
   - **Shared marks.** A listing's photos share their overlay, in the same place on every photo, while the room
     behind it changes. With 3 or more photos, a pixel is overlay where every photo has a crisp, high-contrast
     edge (the per-pixel minimum of the edge maps) and nearly the same brightness (low spread across the photos).
     This catches corner text and big translucent marks across the middle. Photos are compared only with photos of
     the same size, so a portrait photo among landscape ones doesn't hide the mark the landscape ones share.
   - **Corner marks.** For a lone photo, or a mark on only some photos, the corner check looks for a dense patch of
     fine strokes (letters, logo lines) in a corner band, far denser than the rest of the photo.
   - **Cleaning.** Stray pixels are dropped. Strokes are closed into marks. Anything covering more than a fifth of
     the photo is treated as scene, not overlay. A strip along the photo's edge, 1 % of the long side wide, never
     counts, so a thin frame drawn on every photo is not taken for a mark.
   - **Crop or inpaint.** A mark inside a border band (the bottom or top 20 %, or a short mark at a side edge) is
     cropped off with its band, which leaves every real pixel untouched for the rebuild. Anything else is inpainted.
   - **Records.** The originals stay in `work/listing-raw/`. Every decision goes to `work/listing.json`, and a
     magenta mask preview for each photo that had a mark to `work/listing-masks/`. Only the clean photos reach the
     rebuild. These are job files: the server doesn't copy them into the scene, and it deletes a local job's
     `work/` once the world is in.
   - **If the clean-up fails,** the rebuild gets the original photos and the caption says the watermarks may
     show. The job still ships.
3. **The rebuild,** the same multi-photo reconstruction as any reconstruct job. A listing has the photos it has, so
   the "8 or more" notice is not shown.
4. **The walk zone,** job 1's automatic zone, judged along the directions the listing photographed.
   - It writes `collider.glb`, `walkzone.json` and `walkzone-topdown.png` at the top of `out/`, because the server
     copies top-level files and the ones `scene.json` names.
   - It sets `world.collider` and `world.spawn`, the two `WorldAsset` fields for this. No new contract field.
   - **The spawn faces what the photos saw:** the best of 16 facings within 22.5° of a real photo's direction.
   - If no spot passes, or the step fails for any other reason, the job still ships with the rebuild's own spawn,
     plus a short notice in the caption.
5. **Caption:** "Rebuilt from N listing photos.", followed by any notices.

To preview just the clean-up on a folder: `python pipeline/listing.py clean --photos <dir> --out <dir>`. It writes
the clean photos, `listing.json` and `masks/`.

## How well it works

On synthetic listings (photo-like rooms with listing-style text and logos):

| Case | Result |
|---|---|
| Clean photos, 12 sets of 4 | 0 / 48 changed (no false alarms) |
| Marked photos: bottom-right and bottom-left agent text, a top-left credit, a translucent mark across the middle (12 sets of 4) | 48 / 48 found and removed. Corner text is cropped off with its band; the middle mark is inpainted |
| A lone photo with a corner logo | found by the corner check, cropped |
| The whole job, rebuild stubbed with a synthetic room | the watermark band is cropped from all 4 photos before the rebuild; walk zone, collider and a spawn facing the photographed wall; caption "Rebuilt from 4 listing photos." |

Still to check on the real thing: the four photos in `data/inputs/old-house-kitchen/` (Ojasva has them), through
the real rebuild on the GPU. Done means it looks like today's hand-made world with no hand steps. Ojasva runs it.

## Limits

- Shared-mark detection needs 3 or more photos of the same size, so a 2-photo listing, or a lone portrait photo
  among landscape ones, relies on the corner check alone. A mark across the middle of such a photo stays.
- One photo without the mark (a floor plan, say) in a group hides a mark across the middle on all of them; a
  corner mark is still caught by the corner check.
- A frame drawn on every photo is ignored when it is thin or wide, but one about 1 % of the long side wide can
  still cost a sliver along an edge. The edge of a letterbox bar that every photo has is taken for a mark and
  inpainted.
- A mark that is the same colour as the wall behind it in every photo has no edge to find. Real listing overlays
  are white or dark with an outline, which this targets.
- Inpainting fills from the surroundings. On a highly patterned surface (tile, a bookshelf) it can leave a soft
  patch, which the rebuild then blends across views.
