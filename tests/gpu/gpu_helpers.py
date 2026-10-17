"""Helpers shared by the world-generation tests (CPU only; GPU checks live in smoke_*.py).

Test modules import from here, never from conftest: tests/gpu and tests/pipeline each have a conftest.py, and
`from conftest import ...` resolves to whichever suite pytest loaded last when both run in one invocation.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "pipeline", ROOT / "hpg"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import splat_io as sio  # noqa: E402

SAMPLES = ROOT / "data" / "scenes"


def random_splats(n: int, degree: int, rng) -> sio.Splats:
    q = rng.normal(size=(n, 4)).astype(np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    rest = None if degree == 0 else rng.uniform(-0.9, 0.9, size=(n, sio.sh_dim(degree) - 1, 3)).astype(np.float32)
    return sio.Splats(
        rng.uniform(-20, 20, size=(n, 3)),
        np.exp(rng.uniform(-6, 0.5, size=(n, 3))),
        q,
        rng.uniform(0.01, 0.99, size=n),
        rng.uniform(-1.5, 1.5, size=(n, 3)),
        rest,
    )


def synthetic_room(
    rng,
    camera_height: float = 1.5,
    pitch_deg: float = 0.0,
    with_table: bool = True,
    n_floor: int = 30000,
    noise: float = 0.01,
) -> tuple[sio.Splats, np.ndarray]:
    """A 5 x 3 x 6 m box room (floor, ceiling, walls, optional table) seen from a camera at `camera_height`,
    returned in that camera's OpenGL frame (camera at origin, looking down -Z, pitched by pitch_deg).
    Returns (splats in camera frame, world-to-camera rotation used)."""
    def plane(n, fn):
        u = rng.uniform(0, 1, size=(n, 2))
        return fn(u)

    floor = plane(n_floor, lambda u: np.stack([-2.5 + 5 * u[:, 0], np.zeros(len(u)), 1.0 - 6 * u[:, 1]], 1))
    ceil = plane(n_floor // 2, lambda u: np.stack([-2.5 + 5 * u[:, 0], np.full(len(u), 3.0), 1.0 - 6 * u[:, 1]], 1))
    back = plane(n_floor // 2, lambda u: np.stack([-2.5 + 5 * u[:, 0], 3 * u[:, 1], np.full(len(u), -5.0)], 1))
    front = plane(n_floor // 3, lambda u: np.stack([-2.5 + 5 * u[:, 0], 3 * u[:, 1], np.full(len(u), 1.0)], 1))
    left = plane(n_floor // 2, lambda u: np.stack([np.full(len(u), -2.5), 3 * u[:, 0], 1.0 - 6 * u[:, 1]], 1))
    right = plane(n_floor // 2, lambda u: np.stack([np.full(len(u), 2.5), 3 * u[:, 0], 1.0 - 6 * u[:, 1]], 1))
    parts = [floor, ceil, back, front, left, right]
    if with_table:
        parts.append(plane(n_floor // 3, lambda u: np.stack([-1.0 + 2 * u[:, 0], np.full(len(u), 0.75), -3.0 + 1.2 * u[:, 1]], 1)))
    world = np.concatenate(parts) + rng.normal(scale=noise, size=(sum(len(p) for p in parts), 3))
    # World: y up, floor at 0, camera at (0, h, 0). Camera frame: rotate by pitch about X.
    R_wc = sio.rot_x(math.radians(pitch_deg))  # camera-to-world rotation
    cam = np.array([0.0, camera_height, 0.0])
    local = (world - cam) @ R_wc  # world -> camera: R^T (x - c)
    n = len(local)
    colours = rng.uniform(0.2, 0.8, size=(n, 3))
    s = sio.Splats.from_rgb(local, colours, 0.02, 0.9)
    return s, R_wc
