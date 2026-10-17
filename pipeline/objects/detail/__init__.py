"""High-detail object reconstruction and its evaluation (team/shivin-object-detail.md).

Pure-numpy pieces (GLB I/O, the CPU mesh renderer, metrics, maps, the flat-sign path) run anywhere and are what the
tests cover. `reconstruct.py` and `export_dataset.py` need the splat stack (torch + gsplat) and run on PACE.
Nothing here uploads, approves or publishes.
"""
