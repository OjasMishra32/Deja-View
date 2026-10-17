# pipeline/recon: photos and clips of a real place -> a walkable splat scene

The long, faithful path of Reconstruct mode: COLMAP poses, our own gsplat training loop, a metric room frame,
then a ready `data/scenes/<id>/`. Every step reads and writes one work folder (layout in `util.py`).

```
prep.py          photos + videos -> images/, masks/ (people), frames.json, <clip>-times.npy     (Mac or HPG, CPU)
poses.py solve   COLMAP: SIFT, all pairs, mapper -> poses.json, points.npz                       (HPG, GPU for SIFT)
frame.py pre     floor plane, metric scale, spawn -> frame.json                                   (anywhere, numpy)
train_gs.py      gsplat + MCMC densification in the room frame -> train/splats.ply, metrics.json  (HPG GPU)
frame.py post    floor/table re-measured on the splats, crop, world.spz, scene.json, thumb.jpg,
                 cameras.json, <clip>-poses.json, photo-vs-render comparisons                     (HPG GPU)
```

## Running it

```bash
# 1. image set (EXIF orientation, 1920 px, sharpest frame per window, HDR clips exposed for texture, person masks)
#    about 10 frames per second of walking worked better than 5
python pipeline/recon/prep.py --work WORK --photos shots/*.jpg --photo-people \
    --video walk=walk.mov:160:people --video play=play.mov:120:people

# 2. poses (on HiPerGator COLMAP 3.11 is a container; keep the SQLite database on node-local disk)
export COLMAP_CMD="apptainer exec --nv --bind /blue --bind $TMPDIR /apps/colmap/3.11/container.sif colmap"
python pipeline/recon/poses.py solve --work WORK --db $TMPDIR/database.db --seq-window 16
#    the same features and matches, mapped again with other settings:
python pipeline/recon/poses.py solve --work WORK --db $TMPDIR/database.db --reuse --seq-window 8 --tag w8

# 3. room frame (y up, metres, floor y = 0, spawn at the origin facing -Z)
python pipeline/recon/frame.py pre --work WORK [--spawn-image photo/IMG_0001.jpg] --evidence EVID

# 4. training (about 12 min for 30k steps on one RTX PRO 6000; the defaults are the recipe that worked best:
#    SH degree 1, per-clip colour, clip-frame pose refinement, photos drawn 30% of the time, depth and needle terms)
python pipeline/recon/train_gs.py --work WORK --steps 30000 --cap 1300000

# 5. the scene
python pipeline/recon/frame.py post --work WORK --scene-dir data/scenes/<id> --id <id> --name "Name" --evidence EVID
```

`hpg/poses.sbatch` and `hpg/train.sbatch` (in this folder) run steps 2 and 4-5 on HiPerGator with the env's python
(`$HPG_ROOT/envs/flashworld/bin/python` has gsplat 1.5.2, torch 2.8 cu128, transformers, scipy, opencv). They expect a
job folder holding `code/pipeline/` (recon/, common/, splat_io.py) and `work/`. Set `HF_HUB_OFFLINE=1` on compute nodes
(the depth model is read from the HF cache).

## Things that matter

- **Symmetric objects break video SfM.** A table-tennis table and a foosball table look the same from either end.
  With every pair matched, COLMAP placed whole stretches of both clips on a mirrored copy of the room (the camera
  path jumped 4 m between neighbouring frames). `--seq-window` keeps only matches between frames of one clip at
  most that many samples apart (8 at ~5 samples/s, 16 at ~10; photos and the other clip still link everything);
  `poses.json` -> `stats.continuity` lists any remaining jump (a step more than 6x the clip's median speed).
  Check it after every solve.
- **People.** `:people` masks are a person segmentation (threshold 0.15) dilated by 6% of the short side, each blob
  filled to its convex hull; COLMAP extracts no features there and the training loss ignores those pixels, so the
  room behind the players comes from the other views. A tighter mask (3%, no hull) left the players' backpacks
  out and they came back as dark floaters around the foosball table. `prep.py --redo-masks` redoes only the masks.
- **HDR clips.** iPhone night video sits above reference white; the display tone mapping flattens walls and
  floor into the highlight roll-off. `prep.py` decodes the HLG signal itself with a per-clip exposure gain (0.25
  here) so the floor texture survives.
- **Colour.** The clips are tone-mapped differently from the photos. `--appearance` learns one 3x3 colour matrix
  per clip, a per-frame gain per channel and an offset (applied to the render, then clipped). Photos keep the
  identity, so the exported colours are the photos' colours (a free per-image matrix let the colours drift to the
  clips' look: held-out PSNR 15.1 against 18.8).
- **Depth term.** Held-out photo PSNR hardly moves with it, but walking away from the cameras is where it shows:
  without it the ceiling and the white walls smear along the viewing rays and a blue floater hung in front of the
  folded table at the spawn. `--depth-reg 0.1` (rendered inverse depth correlated tile by tile with a monocular
  estimate) removed both.
- **SH degree.** SPZ keeps SH degrees 2-3 at 4 bits; a degree-3 model showed pink and green mottling on white walls
  in the viewer, a degree-1 model does not. Train and export degree 1.
- **Export crop.** Only drop dead splats (opacity < 0.005, invisible anyway), things beyond 150 m and absurdly
  large splats. Dropping the mirror images under the glossy floor cost 2.3 dB on the photos, an isolated-splat
  filter 1.3 dB; both are off by default (`--below-inner`, `--floater-mass`).
- **Scale.** `frame.py` looks for a blue table-tennis top (2.74 x 1.525 m at 0.76 m). Sparse points cover a plain
  tabletop poorly, so `pre` accepts it only if its aspect and height look right and otherwise uses the cameras'
  height (`--eye`, 1.45 m); `post` measures the table on the dense splats and rescales about the origin (a uniform
  scale and a floor shift keep spherical harmonics valid, so the splats never need rotating after training).
- **Clip poses for later stages.** `<clip>-poses.json` in the scene folder has the solved camera of every sampled
  frame (`frameIndex` = frame number in the file, `time` = presentation time) in the viewer frame, OpenGL camera
  convention, plus `track`: one interpolated pose per source frame.

## Stage 2: the people of a handheld clip (`people.py`)

The Video mode (`pipeline/tw`) assumes a still camera. A clip filmed walking round the people gets a pose per frame
from stage 1 and the room itself as its background instead:

```bash
# 1. output frames at 30 fps (the source frame nearest each tick), HLG decoded with the clip's exposure gain,
#    undistorted; half-size analysis copies and the stage-1 track's pose for each              (Mac, ~2 min)
python pipeline/recon/people.py frames --work W --clip play.mov --poses data/scenes/<room>/<clip>-poses.json --gain 0.2289
# 2. segmentation, monocular depth, each pose refined photometrically against world.spz (people masked out),
#    the room's colour / depth / coverage rendered from it                                    (HPG GPU, ~24 min)
sbatch pipeline/recon/hpg/people.sbatch <job dir>        # job dir: code/pipeline/, work/ (step 1), world.spz
# 3. masks, depth scaled to the room, colour matched, tw-pack-v1 + audio + camera-track.json + the scene (Mac, ~4 min)
python pipeline/recon/people.py pack --work W --clip play.mov --world-scene data/scenes/<room> \
    --scene-dir data/scenes/<id> --id <id> --name "Name" --caption "..." --evidence EVID
```

What the scene gets: `people.mp4` (tw-pack-v1, 30 fps, the clip's AAC audio), `camera-track.json` (`track[k]`: the
camera of packed frame k in the room frame, OpenGL convention, plus the frame-code layout), the room's `world.spz`,
collider and map, and `video.cameraTrack = "camera-track.json"`. The viewer (`web/src/viewer/tw-track.ts`) reads the
frame number each packed frame carries in the last 4 rows of its depth band, so the pose always belongs to the
picture on screen; the still-camera path is untouched.

Things that matter:

- **Floor depth.** gsplat's expected depth comes out up to ~12% short on a floor seen at a slant (floor points float
  10-20 cm). Floor pixels take the exact ray-plane depth (y = 0); with it the network depth fits the room to 1.4% (first
  96 frames) instead of 2.5%, and visible feet land at 0 +- 3 cm before any per-person correction.
- **Per-person scale.** Scaling the network's depth on the background is not enough for people: a player whose feet
  are hidden behind the table came out a metre too far. Each person (followed by mask overlap) gets one depth scale per
  frame from a small least-squares problem: feet on the floor where visible, a place in the room that moves smoothly
  and stays near the table, a weak prior. The camera walking round them pins the rest down like two eyes.
- **Masks.** The person class scores backpacks at 0.03-0.4; weak regions that hang on a person and are not far behind
  them are kept (also where the depth says something stands in front of the room). Blobs are split at a real depth
  step (two players overlapping, a passer-by behind), people far from where the players stand are dropped, and the
  room caught in an outline (the table's corner, matching the render in depth and colour) is cut.
- **Colour.** One linear-light 3x4 transform from the clip to the room render plus a smoothed per-frame gain (PSNR of
  the frames against the room 25.6 -> 27.4 dB), so the people sit in the photos' colours.
- **Limits.** A single-view relief: from the recording camera and up to ~30 degrees round it, people look right;
  further round (and for a player the camera was within a metre of) the relief tears, so handheld layers fade per
  fragment by the angle round the vertical (45 -> 110 degrees). The full-3D people of the room's scene can take over
  there (`video.avatars = {"scene": "<room>"}`; the viewer then uses `camera-track.json` for the crossfade).
