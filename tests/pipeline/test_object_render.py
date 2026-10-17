"""Object view renderer: bounds, camera ring, intrinsics, and a real CPU render of a tiny world."""
import json
from pathlib import Path

import numpy as np

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
import splat_io as sio
from objects import render_views, scene as obj_scene

ROOT = Path(__file__).resolve().parents[2]


def _tiny_scene(tmp_path: Path) -> Path:
    d = tmp_path / "tiny"
    d.mkdir()
    rng = np.random.default_rng(1)
    means = np.stack([rng.uniform(-1, 1, 200), rng.uniform(0.2, 1.8, 200), rng.uniform(-1, 1, 200)], axis=1)
    rgb = rng.uniform(0.2, 1.0, (200, 3))
    s = sio.Splats.from_rgb(means, rgb, 0.03)
    sio.write_spz(d / "world.spz", s, sh_degree=0)
    (d / "scene.json").write_text(json.dumps({
        "id": "tiny",
        "world": {"file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
                  "floorY": 0, "bounds": {"min": [-1, 0, -1], "max": [1, 2, 1]}},
    }))
    return d


def test_room_bounds_uses_the_scene_bounds():
    splats = sio.Splats.from_rgb(np.zeros((3, 3)), np.ones((3, 3)), 0.01)
    scene = {"world": {"bounds": {"min": [-2, 0, -3], "max": [2, 4, 3]}}}
    lo, hi = obj_scene.room_bounds(scene, splats)
    assert lo.tolist() == [-2, 0, -3]
    assert hi.tolist() == [2, 4, 3]


def test_intrinsics_from_long_side_fov():
    fx, fy, cx, cy = obj_scene.intrinsics(640, 480, 60)
    assert fx == fy
    assert cx == 320 and cy == 240
    assert abs(fx - (320 / np.tan(np.deg2rad(30)))) < 1e-6


def test_camera_ring_is_inside_the_room_and_looks_at_the_centre():
    lo, hi = np.array([-3.0, 0.0, -2.0]), np.array([3.0, 2.5, 2.0])
    ring = obj_scene.camera_ring(lo, hi, count=8)
    assert len(ring) == 8 + 4
    for cam in ring:
        p = np.array(cam["position"])
        assert lo[0] - 1e-6 <= p[0] <= hi[0] + 1e-6
        assert lo[2] - 1e-6 <= p[2] <= hi[2] + 1e-6
        m = np.array(cam["c2w"])
        fwd = -m[:3, 2]
        target = np.array(cam["target"]) - m[:3, 3]
        target /= np.linalg.norm(target)
        assert np.dot(fwd, target) > 0.999


def test_render_writes_views_and_pngs(tmp_path):
    d = _tiny_scene(tmp_path)
    out = tmp_path / "views"
    doc = render_views.render_scene(d, out, count=4, width=160, height=120, prefer_gpu=False, log=lambda *_: None)
    assert len(doc["views"]) == 4 + 4
    assert (out / "views.json").exists()
    assert (out / "view_00.png").exists()
    saved = json.loads((out / "views.json").read_text())
    assert saved["sceneId"] == "tiny"
    assert len(saved["views"]) == 8
    from PIL import Image
    im = Image.open(out / "view_00.png")
    assert im.size == (160, 120)
