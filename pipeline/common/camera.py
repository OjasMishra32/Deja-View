"""Pinhole intrinsics and frame conventions.

Pixel coordinates are continuous: pixel (i, j) covers [i, i+1) x [j, j+1), so its centre is
(i + 0.5, j + 0.5) and a texture coordinate uv maps to (u * width, v * height). The principal
point of an uncropped image is (width / 2, height / 2).

When a phone video carries no focal length, the long side of the frame is assumed to span
DEFAULT_LONG_FOV_DEG = 65 degrees. That matches the main (1x, ~26 mm equivalent) camera of
current phones once video stabilisation crops the sensor a little: 26 mm on a 36 mm wide frame
gives 69 degrees, the stabilisation crop takes it to roughly 62-66 degrees.
"""
from __future__ import annotations

import math

DEFAULT_LONG_FOV_DEG = 65.0


def fov_from_35mm(focal_35mm: float) -> float:
    """Long-side field of view (degrees) for a 35 mm equivalent focal length (36 mm wide frame)."""
    return math.degrees(2.0 * math.atan(18.0 / focal_35mm))


def intrinsics_for(
    width: int,
    height: int,
    src_width: int | None = None,
    src_height: int | None = None,
    long_fov_deg: float | None = None,
    focal_35mm: float | None = None,
) -> dict:
    """Intrinsics in pixels of a width x height image resized from src_width x src_height.

    The focal length is defined on the source frame (square pixels), then scaled per axis so a
    slightly anisotropic resize (rounding to multiples of 16) stays exact.
    """
    sw = src_width or width
    sh = src_height or height
    if long_fov_deg is None:
        long_fov_deg = fov_from_35mm(focal_35mm) if focal_35mm else DEFAULT_LONG_FOV_DEG
    long_fov_deg = min(max(float(long_fov_deg), 20.0), 150.0)
    f_src = (max(sw, sh) / 2.0) / math.tan(math.radians(long_fov_deg) / 2.0)
    return {
        "fx": f_src * width / sw,
        "fy": f_src * height / sh,
        "cx": width / 2.0,
        "cy": height / 2.0,
    }


def scale_intrinsics(K: dict, sx: float, sy: float | None = None) -> dict:
    sy = sx if sy is None else sy
    return {"fx": K["fx"] * sx, "fy": K["fy"] * sy, "cx": K["cx"] * sx, "cy": K["cy"] * sy}


def fov_deg(K: dict, width: int, height: int) -> tuple[float, float]:
    return (
        math.degrees(2 * math.atan(width / (2 * K["fx"]))),
        math.degrees(2 * math.atan(height / (2 * K["fy"]))),
    )


IDENTITY_POSE = {"position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0]}


def unproject_viewer(depth, K: dict):
    """Lift a z-depth map (H, W) into viewer-frame points (H, W, 3) for a camera at the origin
    looking down -Z with +Y up (OpenGL), i.e. the identity VideoLayer.cameraPose."""
    import numpy as np

    h, w = depth.shape
    u = (np.arange(w, dtype=np.float32) + 0.5 - K["cx"]) / K["fx"]
    v = (np.arange(h, dtype=np.float32) + 0.5 - K["cy"]) / K["fy"]
    uu, vv = np.meshgrid(u, v)
    d = depth.astype(np.float32)
    return np.stack([uu * d, -vv * d, -d], axis=-1)
