"""Put the Third Wheel video into a generated room.

flashworld_run.py writes, next to the world, input_camera.json ({width, height, fx, fy, cx, cy,
position, quaternion}: the input view in the viewer frame, intrinsics in pixels of width x height)
and input_depth.npy (z-depth of the world rendered from that camera at a coarser resolution of the
same aspect, viewer units, 0 = no data). The plate is that input image, so comparing the two depth
maps on background pixels gives the one scale that converts video depth into world units, and the
video camera becomes the world's input camera.

If the world camera's image has another aspect ratio than the plate, it is assumed to be a
centred crop of the plate, resized.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def crop_mapping(plate_w: int, plate_h: int, cam_w: int, cam_h: int) -> tuple[float, float, float, int, int]:
    """(k, ox, oy, crop_w, crop_h): world pixel = (plate pixel - (ox, oy)) * k for a centred crop."""
    ar_p = plate_w / plate_h
    ar_c = cam_w / cam_h
    if abs(ar_p - ar_c) < 1e-3:
        return cam_w / plate_w, 0.0, 0.0, plate_w, plate_h
    if ar_p > ar_c:  # plate wider: crop width
        cw, ch = plate_h * ar_c, float(plate_h)
    else:
        cw, ch = float(plate_w), plate_w / ar_c
    ox, oy = (plate_w - cw) / 2.0, (plate_h - ch) / 2.0
    return cam_w / cw, ox, oy, int(round(cw)), int(round(ch))


def solve_scale(world_depth: np.ndarray, plate_depth: np.ndarray, ok: np.ndarray) -> tuple[float, float, int]:
    """Median of world/plate depth ratios on usable pixels. Returns (scale, relative MAD, count)."""
    valid = ok & np.isfinite(world_depth) & np.isfinite(plate_depth) & (world_depth > 0) & (plate_depth > 0)
    n = int(valid.sum())
    if n < 500:
        raise ValueError(f"only {n} background pixels overlap between the world render and the plate")
    r = world_depth[valid] / plate_depth[valid]
    lo, hi = np.quantile(r, [0.05, 0.95])
    r = r[(r >= lo) & (r <= hi)]
    s = float(np.median(r))
    mad = float(np.median(np.abs(r - s)) / max(s, 1e-9))
    return s, mad, n


def align_video_to_world(video: dict, plate_depth: np.ndarray, background: np.ndarray, world_dir: Path | str, log=print) -> tuple[dict, dict]:
    """Returns (updated VideoLayer dict, info). plate_depth/background are at the video RGB size."""
    import cv2

    world_dir = Path(world_dir)
    cam = json.loads((world_dir / "input_camera.json").read_text())
    wd = np.load(world_dir / "input_depth.npy").astype(np.float32)
    if wd.ndim == 3:
        wd = wd[..., 0]
    cw_, ch_ = int(cam.get("width") or wd.shape[1]), int(cam.get("height") or wd.shape[0])
    H, W = plate_depth.shape
    k, ox, oy, crw, crh = crop_mapping(W, H, cw_, ch_)
    x0, y0 = int(round(ox)), int(round(oy))
    inv = 1.0 / np.maximum(plate_depth[y0 : y0 + crh, x0 : x0 + crw], 1e-6)
    inv_r = cv2.resize(inv.astype(np.float32), (wd.shape[1], wd.shape[0]), interpolation=cv2.INTER_AREA)
    pd = 1.0 / np.maximum(inv_r, 1e-9)
    bg = cv2.resize(background[y0 : y0 + crh, x0 : x0 + crw].astype(np.uint8), (wd.shape[1], wd.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    # Stay away from depth edges on either map: a one pixel misregistration there skews ratios.
    from .depthstab import depth_edges

    edges = depth_edges(1.0 / np.maximum(wd, 1e-6)) | depth_edges(inv_r)
    s, mad, n = solve_scale(wd, pd, bg & ~edges)
    log(f"room alignment: scale {s:.4f} (video metres -> world units), spread {mad:.1%}, {n} px")

    # input_camera.json intrinsics are in pixels of its width x height (the input image); the
    # depth map only samples that image more coarsely.
    fx, fy, cx, cy = (float(cam[k]) for k in ("fx", "fy", "cx", "cy"))
    out = json.loads(json.dumps(video))
    out["intrinsics"] = {"fx": fx / k, "fy": fy / k, "cx": cx / k + ox, "cy": cy / k + oy}
    out["depth"] = {"encoding": "inverse", "near": round(video["depth"]["near"] * s, 4), "far": round(video["depth"]["far"] * s, 4)}
    out["cameraPose"] = {"position": [float(v) for v in cam["position"]], "quaternion": [float(v) for v in cam["quaternion"]]}
    info = {"scale": s, "spread": mad, "pixels": n, "crop": [ox, oy, crw, crh]}
    return out, info
