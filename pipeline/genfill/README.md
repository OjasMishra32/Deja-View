# pipeline/genfill: generative fill for reconstructed worlds

A reconstruction only knows what the footage saw. Stand somewhere new or look up, and you find holes (the
ceiling past the top of every photo, the crowns of palm trees cut off by the frame) or smears (splats only one
or two cameras saw, at a grazing angle). genfill finds those places from where people will actually stand,
works out what belongs there, paints it, and lifts the painting into the 3D world as new Gaussians, without
changing what the footage saw.

```
world.spz + cameras.json ──► gaps ──► regions ──► per region: anchors ─► caption ─► generate ─► lift ─► optimise
                                                                                             └──► world-filled.spz
```

## Steps

1. **Find gaps** (`gaps.py`, gsplat). Standing spots on a 1.2 m grid inside `world.bounds`, within 3 m of a
   training camera and with a clear line to one (spots behind walls are dropped), at eye height 1.6 m; 8 yaws x
   pitches -30, 0, +40, +75 degrees. Per splat, from every training camera (one backward pass gives each splat's
   blending weight in the view, so occlusion and transparency count): how many cameras saw it well, and from which
   directions (189 direction bins). A view only counts when it shows the splat's shape: a flat splat not edge-on, a
   needle not end-on. Per probe pixel:
   - *hole*: alpha < 0.5;
   - *smear*: most of its opacity comes from splats seen well by fewer than 3 cameras or never within 40 degrees
     of this viewing direction;
   - *unseen direction*: the ray points higher than any training frame reached, or above 20 degrees with no
     training camera within 2.5 m that had that direction in its frame. Looking up from where people walk, this is
     the ceiling and the tree tops; the footage never looked there, whatever the splats claim.
   Bad pixels are lifted to 3D (rendered depth; a hole takes its rim's depth) and clustered in 0.6 m voxels into
   regions (reported in `gaps.json`).
2. **Anchors**. The footage itself is extended: an anchor stands exactly where a photo was taken, faces where it
   faced, and tilts up step by step (30, 55, 80 degrees). All first tilts are filled, then all second tilts, so
   every step continues from the sharp, photo-consistent lower part and from the fills below it. Up to 8 such
   sequences, chosen for the most missing content and spread out; views standing against a wall or trunk, with
   more than 75% to fill, or nothing to fill are skipped. Two level/downward views with holes come last.
3. **Understand** (`models.py`). Qwen2.5-VL-7B (the full model Qwen-Image-Edit-2511 ships as its text encoder, so
   it costs no extra memory) sees the anchor with the gap painted magenta, the viewing direction, a one-line
   context ("a covered patio at night ...") and the nearest real photo, and describes only what is hidden: what
   runs into the gap from its edges and how it continues (a trunk into a palm crown, a wall into the roof).
   Open sky alone is left to the viewer's sky.
4. **Generate**. Qwen-Image-Edit-2511 (bf16) fills the magenta area from that description, told to keep everything
   else; `--night` adds a black-night-sky line and daylight terms to the negative prompt. The output is
   colour-matched on a ring around the mask and composited inside it only. Masks under 1.2% go to LaMa.
5. **Lift**. Metric monocular depth (Depth Anything V2) of the filled view, aligned to the rendered depth around
   the mask (RANSAC + Cauchy-weighted least squares on the relative error), with the rim's residual blended inward
   so the fill meets the existing surfaces. Sky is not lifted (far depth; at night also smooth dark or bluish
   upward pixels and their fringe). One flat Gaussian per 2nd or 3rd pixel, oriented along the depth map's normal,
   sized from the pixel footprint. Old splats the fill covers are removed when they are in front of or at the new
   surface and were seen well by fewer than 3 cameras, or (`--replace-above`) in unseen directions whatever their
   count: the streaks a grazing view leaves on a ceiling.
6. **Optimise** (`optimize.py`). A short gsplat loop: generated splats (all parameters) and barely-seen old
   splats in the masks (opacity, colour) are trained against the filled anchors and against the original world's
   render from every training camera; everything else is frozen. Generated splats that would show in a training
   view in front of seen content fade out and are pruned.
7. **Accept or revert** (per anchor). After the lift and the short optimisation every training view is rendered
   again and compared with the original world's render: an anchor that pulls the mean below 45 dB or any view
   below 35 dB is undone (its splats removed, the removed old splats restored). The joint pass at the end is
   undone the same way. This is what keeps "what the footage saw does not change" true by construction.
8. **Output** (`run.py`). `world-filled.spz` (old splats first, generated after them; `genfill.json` says where
   they start), `genfill.json`, and evidence: the worst probe views before | after, and per anchor
   render | mask | generated | after.

Checks in `genfill.json`: PSNR of the filled world against the original world from every training camera (what
was seen must not change), PSNR against the real photos before and after, and the hole / smear share of every
probe view before and after.

## Running on HiPerGator

```bash
# inputs: a copy of the scene folder, the recon work folder's images (for context photos and the photo check)
J=$HPG_ROOT/jobs/genfill
rsync -a pipeline/genfill pipeline/splat_io.py pipeline/common  hpg:$J/code/pipeline/
rsync -a pipeline/recon/cams.py                                 hpg:$J/code/pipeline/recon/
rsync -a data/scenes/<id>/{scene.json,world.spz,cameras.json}   hpg:$J/<id>/in/
sbatch $J/code/pipeline/genfill/hpg/genfill.sbatch <id> --images <work>/images --scene-text "a covered patio at night ..." \
       [--night] [--replace-above] [--gaps-only]
```

The batch script starts the model worker (`python -m genfill.models serve`, avatar env: diffusers + transformers
new enough for Qwen-Image-Edit-2511) and the gsplat side (`python -m genfill.run`, flashworld env) on one GPU;
they talk through files in `out-<job>/queue/`. Half a minute for the gaps, about 50 s per anchor (the edit is
~40 s at 1024x768, 32 steps). `hold.sbatch` + `in-job.sh` keep the models loaded across several runs.

## Models

Qwen-Image-Edit-2511 (generation; its Qwen2.5-VL-7B text encoder also writes the captions; set
GENFILL_CAPTION_MODEL=Qwen/Qwen2.5-VL-3B-Instruct for the small captioner, which proved unreliable on these renders),
Depth Anything V2 Metric Indoor Base (depth), Big LaMa (small holes): the weights already in `HF_HOME` /
`TORCH_HOME`.

## Flags worth knowing

`--night` (no daylight skies; dark smooth sky is left to the viewer), `--ceiling auto|<m>` and `--ceiling-mode`
(repaint only the ceiling, every generated pixel placed on that one plane so all anchors agree), `--replace-above`
(also replace well-seen splats in directions the footage never looked: removes ceiling streaks but costs photo
PSNR), `--from-spots` (anchors at probe spots instead of at the cameras), `--sequences`, `--tilts`.

## What the first runs showed (the courts, the Brick House apartment)

- Detection works: level views from the walk path stay clean (about 1% flagged), the overhead the footage never
  looked at is flagged, spots behind walls and views pressed against a trunk are excluded.
- Generation works in 2D when the anchor stands at a photo and tilts up: palm trunks are completed into palm
  crowns against the night sky, the patio roof edge and lights continue. Captions from the 3B model were
  unusable ("concrete floor" for the sky); the 7B text encoder of the editor describes the gap properly.
- Lifting one generated view into 3D is the weak step: seen from other standing spots the lifted discs read as
  flat fragments or streaks, and generated content that lands where a photo looked lowers the photo PSNR. With
  the acceptance test on, only fills that leave the training views unchanged survive, and on these two worlds
  that was too little to make them clearly better, so neither scene was switched.

## Second approach: complete the surface or the object, not the view (`ceiling.py`, `palms.py`)

QA of the view-lifting fill above (real viewer, a grid of standing spots, looking up, around and down) confirmed it
made both worlds worse, so it is not used. What replaced it works in a space where "the same from every standing
spot" holds by construction:

- **Ceilings** (`python -m genfill.ceiling`). The ceiling is a plane over a wall-aligned rectangle. Its height comes
  from a plane sweep: the training images are projected onto candidate planes and the height where they agree best
  wins (`--height sweep:lo:hi:step`; at grazing angles a 10 cm error moves a light fitting by half a metre between
  views, so the minimum is sharp; it also splits into the fittings' height and the ceiling's own with
  `--fittings boxes`). Every texel takes its colour from the views that saw it least obliquely (weight = radial pixels
  per texel cubed, still photos x3, per-view exposure gains anchored to the photos), so what the footage saw is kept
  as it saw it. The open side's roof edge is found from the texture (beyond it the views see the night) or given
  (`--front`). Texels no view saw well are completed in the texture image: the light fittings found in the seen part
  are fitted with a lattice (rows, period, slope) and continued, on a base colour pushed in from the seen part and
  from grazing views (`--fill lattice`), or the edit model fills the texture with the gap painted magenta
  (`--fill edit`, `hpg/ceiling-edit.sbatch`). The old splats in the ceiling zone (the streaks) are removed (walls kept
  by an inset and by a head-height solid-column test) and one flat Gaussian per texel is added.
- **Palm crowns** (`python -m genfill.palms`). Trunks are found as tall solid columns of splats (pillars inside the
  patio footprint, far or white poles skipped); each is continued as bark from where the reconstruction stops, gets
  the criss-cross leaf bases of a cabbage palm, and a crown of ~30 costapalmate fan leaves (golden-angle spiral, young
  leaves upright, old ones drooping, the oldest dry), every leaf segment a chain of needle splats. Crown height
  (about 6.5 m) and colours come from the one night photo that shows the crowns (IMG_7363), where the trunk heights
  were checked by projecting them into it.
- **Check** (`python -m genfill.evaluate`, `hpg/evaluate.sbatch`): PSNR of every training view against its real image,
  whole frame and top third, original vs candidates, with photo | before | after panels of the views that changed most.

```bash
J=$HPG_ROOT/jobs/genfill; I=$HPG_ROOT/jobs/courts/work2/images
sbatch $J/code/pipeline/genfill/hpg/ceiling.sbatch the-courts ceil --images $I --angle 41 --rect=-7.95,2.5,-7.1,1.5 \
       --height 3.15 --front=-0.35 --inset=0.45,0.45,0.45,0.05          # or --height sweep:2.95:3.45:0.02
sbatch $J/code/pipeline/genfill/hpg/palms.sbatch the-courts palms --world $J/the-courts/ceil/world-filled.spz \
       --exclude-rect=41,-7.95,2.5,-7.1,-0.05
sbatch $J/code/pipeline/genfill/hpg/evaluate.sbatch the-courts eval --images $I --base $J/the-courts/in/world.spz \
       --cand filled=$J/the-courts/palms/world-filled.spz
```

Results on the courts (world.spz of 05:52, md5 acd536cc...): ceiling at 3.15 m from the sweep (the flat splats said
3.21; the light fittings hang lower and dominate the agreement), 2 rows x 5 fittings found and continued into the
part no view saw, 6,691 streak splats removed, 18,372 plane splats (113k texels merged where the colour is flat),
5 palms crowned (29,763 splats, crown 6.9 m, brightness scaled 0.59-0.81 by the photos that framed them).
Training views: 24.31 -> 24.20 dB mean over 305 views; 11 views lose more than 0.5 dB, worst IMG_7352 -2.8 dB
(whole frame) / -10.4 dB (top third): the photos that look at the ceiling from close up see painted fittings and a
smoothed ceiling instead of the trained ones; IMG_7363, the one photo that framed the crowns, gains 0.9 dB. In the
real viewer, from 9 grid spots, 6 spots around the palms and 7 photo poses, nothing at eye level or below changed
and the overhead went from streaks and voids to a ceiling and palm crowns, so the scene now loads
`world-filled.spz` (evidence and the exact scene.json change in data/evidence/genfill/qa/). The edit model, given
the same texture with the gap in magenta, redraws a clean ceiling with the right fittings but its composite leaves
a lighter wedge at the seam, so the lattice fill is used. The 3D-box fittings (`--fittings boxes`, fittings at
3.14 m, ceiling at 3.22 m) look more solid but cost more against the photos (IMG_7352 -5.2 dB), so they are off.
The apartment's current world (06:29) already has a continuous ceiling from every spot checked; nothing was changed.
