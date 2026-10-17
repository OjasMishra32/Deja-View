"""Standard 3D Gaussian Splatting PLY (binary little endian), SH degree 0.

Fields: x y z  f_dc_0..2  opacity  scale_0..2  rot_0..3
  f_dc     = (rgb - 0.5) / SH_C0          (rgb in 0..1)
  opacity  = logit(alpha)
  scale_i  = log(sigma_i)                 (sigma in scene units)
  rot      = quaternion (w, x, y, z), normalised
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814
FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def rgb_to_dc(rgb01: np.ndarray) -> np.ndarray:
    return (np.asarray(rgb01, np.float32) - 0.5) / SH_C0


def dc_to_rgb(dc: np.ndarray) -> np.ndarray:
    return np.asarray(dc, np.float32) * SH_C0 + 0.5


def logit(a: np.ndarray, eps: float = 1e-4) -> np.ndarray:
    a = np.clip(np.asarray(a, np.float32), eps, 1 - eps)
    return np.log(a / (1 - a))


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.asarray(x, np.float32)))


def write_splat_ply(
    path: Path | str,
    xyz: np.ndarray,
    rgb01: np.ndarray,
    alpha: np.ndarray,
    sigma: np.ndarray,
    quat_wxyz: np.ndarray,
) -> int:
    """Write N splats. sigma: (N, 3) standard deviations; quat_wxyz: (N, 4). Returns N."""
    xyz = np.asarray(xyz, np.float32).reshape(-1, 3)
    n = xyz.shape[0]
    rgb01 = np.asarray(rgb01, np.float32).reshape(n, 3)
    alpha = np.asarray(alpha, np.float32).reshape(n)
    sigma = np.asarray(sigma, np.float32).reshape(n, 3)
    q = np.asarray(quat_wxyz, np.float32).reshape(n, 4)
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    data = np.empty(n, dtype=[(f, "<f4") for f in FIELDS])
    data["x"], data["y"], data["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    dc = rgb_to_dc(np.clip(rgb01, 0, 1))
    data["f_dc_0"], data["f_dc_1"], data["f_dc_2"] = dc[:, 0], dc[:, 1], dc[:, 2]
    data["opacity"] = logit(alpha)
    ls = np.log(np.maximum(sigma, 1e-7))
    data["scale_0"], data["scale_1"], data["scale_2"] = ls[:, 0], ls[:, 1], ls[:, 2]
    data["rot_0"], data["rot_1"], data["rot_2"], data["rot_3"] = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    header = "ply\nformat binary_little_endian 1.0\n"
    header += f"element vertex {n}\n"
    header += "".join(f"property float {f}\n" for f in FIELDS)
    header += "end_header\n"
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())
    tmp.replace(path)
    return n


def read_splat_ply(path: Path | str) -> dict:
    """Read a PLY written by write_splat_ply (or any 3DGS PLY) into arrays."""
    from plyfile import PlyData

    v = PlyData.read(str(path))["vertex"]
    out = {
        "xyz": np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32),
        "rgb": dc_to_rgb(np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)),
        "alpha": sigmoid(v["opacity"]),
        "sigma": np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)),
        "quat": np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], 1).astype(np.float32),
    }
    return out


def quat_from_matrix(R: np.ndarray) -> np.ndarray:
    """Rotation matrices (N, 3, 3) -> quaternions (N, 4) as (w, x, y, z)."""
    R = np.asarray(R, np.float64)
    n = R.shape[0]
    q = np.empty((n, 4), np.float64)
    tr = R[:, 0, 0] + R[:, 1, 1] + R[:, 2, 2]
    c0 = tr > 0
    c1 = (~c0) & (R[:, 0, 0] > R[:, 1, 1]) & (R[:, 0, 0] > R[:, 2, 2])
    c2 = (~c0) & (~c1) & (R[:, 1, 1] > R[:, 2, 2])
    c3 = ~(c0 | c1 | c2)
    if c0.any():
        s = np.sqrt(tr[c0] + 1.0) * 2
        r = R[c0]
        q[c0] = np.stack([0.25 * s, (r[:, 2, 1] - r[:, 1, 2]) / s, (r[:, 0, 2] - r[:, 2, 0]) / s, (r[:, 1, 0] - r[:, 0, 1]) / s], 1)
    if c1.any():
        r = R[c1]
        s = np.sqrt(1.0 + r[:, 0, 0] - r[:, 1, 1] - r[:, 2, 2]) * 2
        q[c1] = np.stack([(r[:, 2, 1] - r[:, 1, 2]) / s, 0.25 * s, (r[:, 0, 1] + r[:, 1, 0]) / s, (r[:, 0, 2] + r[:, 2, 0]) / s], 1)
    if c2.any():
        r = R[c2]
        s = np.sqrt(1.0 + r[:, 1, 1] - r[:, 0, 0] - r[:, 2, 2]) * 2
        q[c2] = np.stack([(r[:, 0, 2] - r[:, 2, 0]) / s, (r[:, 0, 1] + r[:, 1, 0]) / s, 0.25 * s, (r[:, 1, 2] + r[:, 2, 1]) / s], 1)
    if c3.any():
        r = R[c3]
        s = np.sqrt(1.0 + r[:, 2, 2] - r[:, 0, 0] - r[:, 1, 1]) * 2
        q[c3] = np.stack([(r[:, 1, 0] - r[:, 0, 1]) / s, (r[:, 0, 2] + r[:, 2, 0]) / s, (r[:, 1, 2] + r[:, 2, 1]) / s, 0.25 * s], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q.astype(np.float32)


def quat_to_matrix(q_wxyz: np.ndarray) -> np.ndarray:
    q = np.asarray(q_wxyz, np.float64)
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    R = np.stack(
        [
            1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
            2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
            2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
        ],
        -1,
    )
    return R.reshape(q.shape[:-1] + (3, 3))
