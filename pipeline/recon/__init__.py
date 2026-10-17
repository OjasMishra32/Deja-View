"""Photo/video capture -> faithful Gaussian splat reconstruction (Reconstruct mode, the long way).

prep.py (image set, masks) -> poses.py (COLMAP) -> frame.py pre (level, scale, spawn) -> train_gs.py (gsplat)
-> frame.py post (measure, crop, export). See README.md in this folder.
"""
