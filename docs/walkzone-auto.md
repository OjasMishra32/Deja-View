# Automatic walk zones

Brief: `team/shivin.md` Update 19, job 1. Code: `pipeline/walkzone_auto.py`. Tests:
`tests/pipeline/test_walkzone_auto.py`. GPU job: `hpg/walkzone.sbatch`.

Until now, a world's walkable area was hand-made. The kitchen was boxed into 0.85 m² until Ojasva opened it by hand
to 11.9 m², and the old house kitchen got a camera box. This finds the area from how good the world looks from each
place you could stand.

## How it works

1. **Spots.** It lays a 0.5 m grid over where the splats are (joined with `world.bounds`, but never limited to them,
   so the result can come out bigger or smaller than a hand-drawn box). It keeps the spots that have floor under them
   and nothing solid within the walker's 0.22 m radius. Solid means the 0.1 m occupancy columns that
   `pipeline/recon/frame.py` builds colliders from, starting at 0.4 m because glossy floors stack mirror splats up
   to about 0.35 m. Cells within 0.45 m of a capture camera are cleared first: someone stood there holding the
   phone.
2. **Views.** From each spot, at eye height (1.6 m), it renders 8 views: every 45°, 8° down, 80° wide. Each view
   gets three scores:
   - **coverage:** the share of the frame the splats fill. Holes and the void behind the capture are empty.
   - **near:** the share closer than 0.45 m. These are floaters in your face.
   - **sharpness:** the Laplacian variance against a render from the nearest real camera pose
     (`cameras.json`), the sharpest the splats ever look, capped at 1.
   
   It also measures the floater mass within 0.35 m of the eye. A view is good when coverage ≥ 0.9, near ≤ 3 % and
   sharpness ≥ 0.35. A spot passes when at least 5 of its 8 views are good and little floats at eye height. Every
   threshold is in `Thresholds` and is written to `walkzone.json`.

   A one-sided capture, such as listing photos, is judged only along the directions it photographed (within 45° of
   a real camera's facing), with 60 % of those needing to be good. Behind you is never photographed, and that
   shouldn't rule out every spot.
3. **Zone and fence.** Each passing spot covers its 0.5 m cell. It keeps the connected piece holding the best spot
   and grows it by the walker's radius, so the walker's centre can reach every good spot. The outline, simplified to
   4 cm, is the fence. Holes stay holes.
4. **Collider,** in the format of `data/scenes/kitchen/collider.glb`: one mesh, uint32 indices, in the splat file's
   frame (the viewer bakes the scene transform in). It has a floor at y = 0, the fence as walls from 0 to 2.7 m, a
   roof at 2.7 m, and 0.1 m furniture columns from 0 to 2.2 m inside the zone, cleared within 0.45 m of the spawn.
   The roof sits above 2.6 m and the columns stay on the 0.1 m grid, so `scripts/collider-clear-path.ts` keeps
   working on it.
5. **Spawn.** The passing spot with the best views and the most room around it, facing its best of 16 directions.
   The facing prefers a deep view over a close wall. It's written in the viewer frame (`floorY` added, yaw as in
   `app.ts`: forward = (−sin, 0, −cos)).

## Outputs

`<scene>/walkzone/` holds:
- `walkzone.json`: the fence loops, every spot with its 8 view scores and why it passed or failed, the rejected
  spots, the spawn, the thresholds, and the comparison with the hand-made limit. That's the scene's
  `collider.glb` when it has one (flood-filled from its spawn), otherwise `world.bounds`, the camera box.
- `collider.glb`
- `topdown.png`: spots green (pass) or red (fail) and sized by score, rejected spots grey, the fence in yellow, the
  spawn and its facing.

Nothing changes in the scene until `--install`. That copies the collider to `<scene>/collider.glb`, after archiving
the old one under `data/archive/colliders/<scene>-<sha1>.glb` the way `collider-clear-path.ts` does, and sets
`world.collider` and `world.spawn` in `scene.json`, the two fields the shared `WorldAsset` contract has for this.

## Running it

```bash
# one world, locally (the CPU point renderer is fast enough for a first look; gsplat on a GPU is sharper)
python pipeline/walkzone_auto.py --scene data/scenes/kitchen
# on the GPU (through Ojasva)
sbatch --account=$HPG_ACCOUNT --qos=$HPG_QOS --partition=$HPG_PARTITION hpg/walkzone.sbatch data/scenes/kitchen data/scenes/old-house-kitchen
# after looking at walkzone/topdown.png
python pipeline/walkzone_auto.py --scene data/scenes/kitchen --install
```

## Results

<!-- walkzone-results:begin -->
Run locally on the CPU point renderer (192×120 views) against the worlds on `https://deja-view.photo`, without
`--install`. A gsplat run on the GPU renders sharper and may move the edges a little.

| World | Capture | Spots scored / passing | Auto zone | Hand-made limit | Overlap (IoU) | Hand area covered | Auto inside hand | Spawn (viewer frame) |
|---|---|---|---|---|---|---|---|---|
| `kitchen` | 235 frames, all round (8/8 directions, 5 good views needed) | 102 / 55 | 17.3 m², one loop | `collider.glb`, flood-filled from its spawn: 18.1 m² | 0.52 | 67 % | 70 % | (2.70, 0, −1.69), yaw 45° |
| `old-house-kitchen` | 4 listing photos, one side (4/8 directions, 3 good needed) | 25 / 12 | 4.8 m², one loop | `world.bounds` camera box: 18.9 m² | 0.25 | 25 % | 100 % | (0.33, 0, −2.37), yaw 292° |

What the numbers mean:
- **Kitchen.** The automatic zone and the hand-made one agree on the middle of the strip. The automatic one leaves
  out the two far ends of the hand-made strip: past the counters, spots there either have something solid within
  reach or fail their views. It adds a little room on the left, where the views are good but the hand-made fence
  stops.
- **Old house kitchen.** Everything the automatic zone allows is inside the camera box (100 %), but it is a quarter
  of the box. The rest of the box is cabinets and the island (solid within reach), bare edges with no floor in the
  splats, or places whose views of the photographed side are incomplete. This is the cautious answer: you can only
  walk where the four photos hold up.

Fixes made after the first real runs:
- Glossy floors stack mirror splats up to about 0.35 m. The free-space check now starts at 0.4 m, and the floor
  band is ±0.3 m. Before this, the old house had 9 % floor and almost no free spots.
- A one-sided capture is judged only along the directions it photographed (±45° of a real camera). Before this,
  no spot in a listing world could pass, because nobody photographed behind you.
- The capture's camera path is cleared of solid cells, as `collider-clear-path.ts` does. This added 16 kitchen
  spots.
- A run where nothing passes still writes `walkzone.json` with every spot's scores.
<!-- walkzone-results:end -->

## Limits

- The views are scored against the splats themselves, so a place the capture saw badly reads as bad, and a smooth
  but wrong reconstruction can still pass. Sharpness against the real photos would catch that, but needs the photos
  next to the world. The scene folders carry only their camera poses.
- Furniture comes from opacity columns, as in the existing colliders. A dense floater cloud at body height becomes a
  column too, which keeps walkers away from it.
- The 0.5 m grid sets the zone's resolution. `--spacing 0.25` gives a finer fence and costs four times the renders.
