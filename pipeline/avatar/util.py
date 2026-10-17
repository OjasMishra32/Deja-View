"""Small numpy helpers shared by the avatar steps: rigid transforms, quaternions, smoothing, json, logging.

Conventions used everywhere in pipeline/avatar:
  - 4x4 matrices act on column vectors (x' = M @ [x, 1]).
  - Quaternions are xyzw (glTF and three.js order).
  - "cv" camera: x right, y down, looks down +z (what the pose network predicts in).
  - "gl" camera: x right, y up, looks down -z (what <clip>-poses.json stores); gl = cv @ diag(1, -1, -1).
  - The viewer frame: y up, metres, floor at y = 0 (the world.spz frame).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
REPO = Path(__file__).resolve().parents[2]


def use_pipeline_common() -> None:
    """Make `import common.<x>` (pipeline/common) work. AVATAR_PYLIB, when set, names a directory holding a
    `common` package snapshot that wins over the repo's copy (HiPerGator's repo copy can lag behind)."""
    import os

    for p in [str(REPO / "pipeline"), os.environ.get("AVATAR_PYLIB", "")]:
        if p and p not in sys.path:
            sys.path.insert(0, p)


def log(step: str, msg: str) -> None:
    print(f"[avatar {time.strftime('%H:%M:%S')} {step}] {msg}", file=sys.stderr, flush=True)


def read_json(path: Path | str, default=None):
    p = Path(path)
    if not p.exists():
        return default
    return json.loads(p.read_text())


def write_json(path: Path | str, obj, indent: int | None = 1) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=indent, default=_json_default))
    tmp.replace(p)


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serialisable: {type(o)}")


# ------------------------------------------------------------------------------------------- rigid transforms


def rigid_inv(T: np.ndarray) -> np.ndarray:
    """Inverse of rigid 4x4 transforms (..., 4, 4) without a general matrix inverse."""
    T = np.asarray(T, np.float64)
    R = T[..., :3, :3]
    t = T[..., :3, 3]
    out = np.zeros_like(T)
    Rt = np.swapaxes(R, -1, -2)
    out[..., :3, :3] = Rt
    out[..., :3, 3] = -np.einsum("...ij,...j->...i", Rt, t)
    out[..., 3, 3] = 1.0
    return out


def make_T(R: np.ndarray | None = None, t: np.ndarray | None = None) -> np.ndarray:
    T = np.eye(4)
    if R is not None:
        T[:3, :3] = R
    if t is not None:
        T[:3, 3] = t
    return T


def orthonormalize(R: np.ndarray) -> np.ndarray:
    """Nearest rotation (SVD) for (..., 3, 3)."""
    U, _, Vt = np.linalg.svd(R)
    D = np.ones(R.shape[:-2] + (3,))
    D[..., 2] = np.sign(np.linalg.det(U @ Vt))
    return (U * D[..., None, :]) @ Vt


def mat_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrices (..., 3, 3) -> unit quaternions (..., 4) xyzw, w >= 0."""
    from scipy.spatial.transform import Rotation

    R = np.asarray(R, np.float64)
    shp = R.shape[:-2]
    q = Rotation.from_matrix(R.reshape(-1, 3, 3)).as_quat()
    q[q[:, 3] < 0] *= -1
    return q.reshape(shp + (4,))


def quat_to_mat(q: np.ndarray) -> np.ndarray:
    from scipy.spatial.transform import Rotation

    q = np.asarray(q, np.float64)
    shp = q.shape[:-1]
    return Rotation.from_quat(q.reshape(-1, 4)).as_matrix().reshape(shp + (3, 3))


def quat_continuous(q: np.ndarray) -> np.ndarray:
    """Flip signs along axis 0 so consecutive quaternions are in the same hemisphere (T, ..., 4)."""
    q = np.array(q, np.float64, copy=True)
    for t in range(1, len(q)):
        d = np.sum(q[t] * q[t - 1], axis=-1)
        q[t][d < 0] *= -1
    return q


def rot_angle_deg(Ra: np.ndarray, Rb: np.ndarray) -> np.ndarray:
    """Angle of Ra^T Rb in degrees, elementwise over leading axes."""
    M = np.swapaxes(Ra, -1, -2) @ Rb
    c = (np.trace(M, axis1=-2, axis2=-1) - 1.0) / 2.0
    return np.degrees(np.arccos(np.clip(c, -1.0, 1.0)))


# ------------------------------------------------------------------------------------------------ smoothing


def savgol(x: np.ndarray, window: int, order: int, axis: int = 0) -> np.ndarray:
    """Savitzky-Golay along `axis`, with the window shrunk (odd, > order) for short sequences."""
    from scipy.signal import savgol_filter

    n = x.shape[axis]
    w = min(window, n if n % 2 == 1 else n - 1)
    if w <= order:
        return np.array(x, copy=True)
    return savgol_filter(x, w, order, axis=axis, mode="interp")


def smooth_quats(q: np.ndarray, window: int, order: int = 2) -> np.ndarray:
    """(T, ..., 4) quaternions: sign-align over time, Savitzky-Golay per component, renormalise."""
    q = quat_continuous(q)
    s = savgol(q, window, order, axis=0)
    return s / np.linalg.norm(s, axis=-1, keepdims=True)


def interp_missing(values: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Linear interpolation over time (axis 0) of rows where valid is False; ends are held."""
    v = np.array(values, np.float64, copy=True)
    idx = np.nonzero(valid)[0]
    if len(idx) == 0:
        return v
    t = np.arange(len(v))
    flat = v.reshape(len(v), -1)
    for j in range(flat.shape[1]):
        flat[:, j] = np.interp(t, idx, flat[idx, j])
    return flat.reshape(v.shape)


# --------------------------------------------------------------------------------------------- projections


def project(K: np.ndarray, X_cv: np.ndarray) -> np.ndarray:
    """Pinhole projection of cv-camera points (..., 3) -> pixels (..., 2)."""
    z = np.maximum(X_cv[..., 2:3], 1e-6)
    uv = X_cv[..., :2] / z
    return np.stack([K[0, 0] * uv[..., 0] + K[0, 2], K[1, 1] * uv[..., 1] + K[1, 2]], axis=-1)


def apply_T(T: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Rigid/affine 4x4 (or (...,4,4) broadcast) applied to points (..., 3)."""
    return np.einsum("...ij,...j->...i", T[..., :3, :3], X) + T[..., :3, 3]
