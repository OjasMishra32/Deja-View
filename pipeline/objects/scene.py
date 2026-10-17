"""Load a scene's splat world in the placed room frame, and build a camera ring.

The room frame is the one `roblox-model.json` and `objects.json` use: metres after the
scene transform, floor at y = 0, Y up, -Z forward. `render_views.py` and `build.py`
share this so the rendered views and the lifted masks agree.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import splat_io as sio  # noqa: E402


def load_scene(scene_dir: str | Path) -> tuple[sio.Splats, dict]:
    """Read scene.json and the world file, apply the scene transform, and put the floor at y = 0."""
    scene_dir = Path(scene_dir)
    try:
        scene = json.loads((scene_dir / "scene.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        scene = {}
    world = scene.get("world") if isinstance(scene.get("world"), dict) else {}
    file = scene_dir / str(world.get("file") or "world.spz")
    if not file.exists():
        raise FileNotFoundError(f"{file} not found")
    splats = sio.read_splats(file)
    transform = world.get("transform") if isinstance(world.get("transform"), dict) else {}
    q = transform.get("quaternion") or [0, 0, 0, 1]
    pos = np.asarray(transform.get("position") or [0, 0, 0], np.float64)
    scale = float(transform.get("scale") or 1.0)
    floor = float(world.get("floorY") or 0.0)
    R = sio.quat_xyzw_to_matrix(q)
    t = pos + np.array([0.0, -floor, 0.0])
    if not np.allclose(R, np.eye(3)) or scale != 1.0 or np.any(t != 0):
        splats = sio.transform_splats(splats, R, t, scale)
    return splats, scene


def room_bounds(scene: dict, splats: sio.Splats) -> tuple[np.ndarray, np.ndarray]:
    """The scene's stored bounds, or robust splat percentiles when they are missing."""
    world = scene.get("world") if isinstance(scene.get("world"), dict) else {}
    b = world.get("bounds") if isinstance(world.get("bounds"), dict) else None
    if b and b.get("min") and b.get("max"):
        return np.asarray(b["min"], np.float64), np.asarray(b["max"], np.float64)
    p = np.asarray(splats.means, np.float64)
    return np.percentile(p, 1.0, axis=0), np.percentile(p, 99.0, axis=0)


def look_at(position: np.ndarray, target: np.ndarray) -> np.ndarray:
    """OpenGL camera-to-world: x right, y up, looking down -Z at `target`."""
    pos = np.asarray(position, np.float64)
    fwd = np.asarray(target, np.float64) - pos
    n = np.linalg.norm(fwd)
    if n < 1e-9:
        raise ValueError("camera position equals its target")
    fwd = fwd / n
    z = -fwd
    x = np.cross(np.array([0.0, 1.0, 0.0]), z)
    nx = np.linalg.norm(x)
    if nx < 1e-6:  # looking straight up or down: pick a stable right vector
        x = np.array([1.0, 0.0, 0.0])
    else:
        x = x / nx
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, 0] = x
    m[:3, 1] = y
    m[:3, 2] = z
    m[:3, 3] = pos
    return m


def intrinsics(width: int, height: int, fov_deg: float) -> tuple[float, float, float, float]:
    """Pinhole intrinsics from the long-side field of view."""
    fov = np.deg2rad(float(fov_deg))
    if width >= height:
        fx = (width / 2.0) / np.tan(fov / 2.0)
        fy = fx
    else:
        fy = (height / 2.0) / np.tan(fov / 2.0)
        fx = fy
    return float(fx), float(fy), width / 2.0, height / 2.0


def camera_ring(
    bounds_min: np.ndarray,
    bounds_max: np.ndarray,
    count: int = 12,
    radius_scale: float = 0.8,
    eye: float = 1.5,
    target_y: float = 1.0,
) -> list[dict]:
    """Views around the room centre, plus a closer inner ring, all looking at the centre."""
    lo = np.asarray(bounds_min, np.float64)
    hi = np.asarray(bounds_max, np.float64)
    centre = (lo + hi) / 2.0
    half = np.maximum((hi - lo) / 2.0, 0.1)
    target = centre + np.array([0.0, float(target_y) - centre[1], 0.0])
    out = []
    for ring, n in ((radius_scale, max(4, int(count))), (radius_scale * 0.55, max(4, int(count) // 3))):
        rx, rz = half[0] * ring, half[2] * ring
        for i in range(n):
            a = 2.0 * np.pi * i / n
            pos = np.array([centre[0] + rx * np.cos(a), float(eye), centre[2] + rz * np.sin(a)])
            out.append({
                "position": [round(float(v), 4) for v in pos],
                "target": [round(float(v), 4) for v in target],
                "c2w": [[round(float(v), 6) for v in row] for row in look_at(pos, target)],
            })
    return out
