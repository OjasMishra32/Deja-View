"""Generative fill for reconstructed splat worlds: find what the footage never saw, understand it, paint it, lift it.

gaps.py      probe views on a grid in the walkable area, per-splat good-view counts from the training cameras,
             holes + low-confidence pixels per view, clustered in 3D into regions (ceiling patches, tree tops, ...)
models.py    the model worker (its own process and env): captions (Qwen2.5-VL), image edits (Qwen-Image-Edit-2511),
             metric depth (Depth Anything V2), small-hole inpainting (LaMa); a file queue between the two processes
fill.py      per region: anchor views, caption, generate, lift into new Gaussians, short optimisation, evidence
optimize.py  the optimisation loop (new Gaussians + low-confidence old ones; training views keep what was seen)
run.py       the command line: one world in, world-filled.spz + genfill.json + evidence out

geom.py and world.py are numpy only (tests run them on any machine); gpu.py, gaps.py, fill.py, optimize.py need
torch + gsplat; models.py needs diffusers + transformers. See README.md.
"""
