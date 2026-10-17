"""Reality check split (pipeline/reality_split.py): SEEN vs IMAGINED splats on a synthetic room with a known answer."""
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
import reality_split as rs
import splat_io as sio

ROOT = Path(__file__).resolve().parents[2]
W, H, F = 320, 240, 240.0


def _rs_grid(x0, x1, y0, y1, z, step):
    xs = np.arange(x0, x1 + 1e-9, step)
    ys = np.arange(y0, y1 + 1e-9, step)
    xx, yy = np.meshgrid(xs, ys)
    return np.stack([xx.ravel(), yy.ravel(), np.full(xx.size, z)], axis=1)


def _rs_groups():
    """Viewer-frame points by group. The camera sits at the origin looking down -Z (W x H, f = 240 px)."""
    wall = _rs_grid(-3.0, 3.0, -1.2, 1.2, -3.0, 0.05)
    front = _rs_grid(-0.4, 0.4, -0.3, 0.3, -1.5, 0.025)
    back = _rs_grid(-0.4, 0.4, -0.3, 0.3, -1.9, 0.025)
    behind = _rs_grid(-1.0, 1.0, -0.5, 0.5, 2.0, 0.1)
    # the box at 1.5 m hides the wall at 3 m for |x| < 0.8, |y| < 0.6; margins keep the edge band out of both sets
    hidden = (np.abs(wall[:, 0]) < 0.7) & (np.abs(wall[:, 1]) < 0.5)
    clear = ~((np.abs(wall[:, 0]) < 0.9) & (np.abs(wall[:, 1]) < 0.7))
    in_view = (np.abs(wall[:, 0]) < 3.0 * (W / 2) / F - 0.1) & (np.abs(wall[:, 1]) < 3.0 * (H / 2) / F - 0.1)
    return {"wall": wall, "front": front, "back": back, "behind": behind, "wall_hidden": hidden, "wall_clear": clear, "wall_in_view": in_view}


def _rs_depth(dw=W, dh=H):
    """Analytic z-depth for the synthetic room at the input camera."""
    u = (np.arange(dw) + 0.5) * W / dw
    v = (np.arange(dh) + 0.5) * H / dh
    uu, vv = np.meshgrid(u, v)
    tx, ty = (uu - W / 2) / F, -(vv - H / 2) / F
    d = np.zeros((dh, dw), np.float32)
    on_wall = (np.abs(tx * 3.0) <= 3.0) & (np.abs(ty * 3.0) <= 1.2)
    d[on_wall] = 3.0
    on_box = (np.abs(tx * 1.5) <= 0.4) & (np.abs(ty * 1.5) <= 0.3)
    d[on_box] = 1.5
    return d


def _rs_write_scene(tmp: Path, camera: str = "input", transform_quat=(0, 0, 0, 1), crop=None, depth=True, sh=1) -> dict:
    g = _rs_groups()
    pts = np.concatenate([g["wall"], g["front"], g["back"], g["behind"]])
    n = len(pts)
    file_pts = pts.copy()
    if tuple(transform_quat) == (1, 0, 0, 0):
        file_pts[:, 1] *= -1  # half turn about X: the file is stored OpenCV style
        file_pts[:, 2] *= -1
    rng = np.random.default_rng(1)
    s = sio.Splats.from_rgb(file_pts, rng.uniform(0.2, 0.8, (n, 3)), 0.02, opacities=0.9)
    if sh:
        s = sio.Splats(s.means, s.scales, s.quats, s.opacities, s.sh_dc, rng.normal(0, 0.05, (n, 3, 3)).astype(np.float32))
    tmp.mkdir(parents=True, exist_ok=True)
    sio.write_spz(tmp / "world.spz", s)
    world = {"file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": list(transform_quat), "scale": 1}, "floorY": None}
    scene = {"id": "rs-test", "world": world}
    if camera == "input":
        cam = {"width": W, "height": H, "fx": F, "fy": F, "cx": W / 2, "cy": H / 2, "position": [0, 0, 0], "quaternion": [0, 0, 0, 1],
               "depthWidth": W // 2, "depthHeight": H // 2}
        if crop:
            cam["crop"] = crop
        (tmp / "input_camera.json").write_text(json.dumps(cam))
        if depth:
            np.save(tmp / "input_depth.npy", _rs_depth(W // 2, H // 2))
    elif camera == "video":
        scene["video"] = {"file": "tw.mp4", "width": W, "height": H, "intrinsics": {"fx": F, "fy": F, "cx": W / 2, "cy": H / 2},
                          "cameraPose": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}}
    (tmp / "scene.json").write_text(json.dumps(scene))
    sizes = {k: len(g[k]) for k in ("wall", "front", "back", "behind")}
    return {"groups": g, "sizes": sizes, "n": n}


def _rs_masks(tmp: Path, info: dict, **kw) -> dict:
    """Runs the classification the way split_scene does and returns per-group seen masks."""
    world, scene = rs.load_world(tmp)
    splats = sio.read_splats(tmp / world["file"])
    cam = rs.find_camera(tmp, scene, world)
    sv = rs.to_viewer(splats, world["transform"])
    depth, how = rs.reference_depth(sv, cam)
    seen = rs.classify_seen(sv.means, cam, depth, use_crop=kw.get("use_crop", True))
    out, i = {}, 0
    for k in ("wall", "front", "back", "behind"):
        out[k] = seen[i : i + info["sizes"][k]]
        i += info["sizes"][k]
    out["how"] = how
    out["source"] = cam.source
    return out


def _rs_check_room(m: dict, g: dict) -> None:
    wall = m["wall"]
    visible = g["wall_in_view"] & g["wall_clear"]
    assert wall[visible].mean() > 0.97, "visible wall should be seen"
    assert wall[g["wall_hidden"]].mean() < 0.03, "wall behind the box should be imagined"
    outside = (np.abs(g["wall"][:, 0]) > 3.0 * (W / 2) / F + 0.1)
    assert outside.any() and wall[outside].mean() == 0.0, "wall outside the frame should be imagined"
    assert m["front"].mean() > 0.97, "front face of the box should be seen"
    assert m["back"].mean() < 0.03, "back face of the box is hidden by its front"
    assert m["behind"].mean() == 0.0, "nothing behind the camera is seen"


def test_rs_input_camera_and_depth(tmp_path):
    info = _rs_write_scene(tmp_path / "a", camera="input")
    m = _rs_masks(tmp_path / "a", info)
    assert m["source"] == "input_camera" and m["how"] == "input_depth+zbuffer"
    _rs_check_room(m, info["groups"])


def test_rs_video_camera_uses_zbuffer(tmp_path):
    info = _rs_write_scene(tmp_path / "v", camera="video")
    m = _rs_masks(tmp_path / "v", info)
    assert m["source"] == "video" and m["how"] == "zbuffer"
    _rs_check_room(m, info["groups"])


def test_rs_input_camera_without_depth_file(tmp_path):
    info = _rs_write_scene(tmp_path / "nd", camera="input", depth=False)
    m = _rs_masks(tmp_path / "nd", info)
    assert m["how"] == "zbuffer"
    _rs_check_room(m, info["groups"])


def test_rs_assumed_camera_and_flipped_file_frame(tmp_path):
    # no camera stored and the file is in the OpenCV frame ([1,0,0,0] transform): the assumed camera at
    # the origin of the viewer frame looks down -Z, at the wall
    info = _rs_write_scene(tmp_path / "s", camera="none", transform_quat=(1, 0, 0, 0))
    m = _rs_masks(tmp_path / "s", info)
    assert m["source"] == "assumed"
    g = info["groups"]
    assert m["wall"][g["wall_clear"] & (np.abs(g["wall"][:, 0]) < 1.5)].mean() > 0.97
    assert m["wall"][g["wall_hidden"]].mean() < 0.03
    assert m["front"].mean() > 0.97 and m["back"].mean() < 0.03 and m["behind"].mean() == 0.0


def test_rs_crop_limits_what_was_seen(tmp_path):
    info = _rs_write_scene(tmp_path / "c", camera="input", crop={"x": 0, "y": 0, "w": W // 2, "h": H})
    m = _rs_masks(tmp_path / "c", info)
    wall = info["groups"]["wall"]
    right = wall[:, 0] > 0.1
    left = (wall[:, 0] < -0.8) & info["groups"]["wall_in_view"]
    assert m["wall"][right].mean() == 0.0
    assert m["wall"][left].mean() > 0.97
    m2 = _rs_masks(tmp_path / "c", info, use_crop=False)
    assert m2["wall"][right & info["groups"]["wall_in_view"] & info["groups"]["wall_clear"]].mean() > 0.97


def test_rs_split_scene_writes_parts_and_report(tmp_path):
    d = tmp_path / "w"
    info = _rs_write_scene(d, camera="input", sh=1)
    report = rs.split_scene(d, log=lambda *_: None)
    assert report["total"] == info["n"]
    assert report["seen"]["count"] + report["imagined"]["count"] == info["n"]
    assert 0.1 < report["seenFraction"] < 0.9
    seen = sio.read_splats(d / rs.SEEN_FILE)
    imag = sio.read_splats(d / rs.IMAGINED_FILE)
    assert len(seen) == report["seen"]["count"] and len(imag) == report["imagined"]["count"]
    assert seen.sh_degree == 1 and imag.sh_degree == 1
    # the parts stay in the world's own file frame: every splat comes back exactly (up to SPZ quantisation)
    orig = sio.read_splats(d / "world.spz")
    both = np.concatenate([seen.means, imag.means])
    key = lambda p: np.round(p * 1000).astype(np.int64)  # noqa: E731
    a = {tuple(r) for r in key(orig.means)}
    b = {tuple(r) for r in key(both)}
    assert a == b
    rep = json.loads((d / rs.REPORT_FILE).read_text())
    assert rep["version"] == 1 and rep["camera"]["source"] == "input_camera" and rep["world"] == "world.spz"


def test_rs_empty_part_is_still_a_valid_file(tmp_path):
    d = tmp_path / "e"
    d.mkdir()
    pts = _rs_grid(-0.5, 0.5, -0.3, 0.3, -2.0, 0.05)  # all in view, nothing hidden
    s = sio.Splats.from_rgb(pts, [0.5, 0.6, 0.7], 0.02, opacities=0.9)
    sio.write_spz(d / "world.spz", s)
    (d / "scene.json").write_text(json.dumps({"world": {"file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1}},
                                              "video": {"width": W, "height": H, "intrinsics": {"fx": F, "fy": F, "cx": W / 2, "cy": H / 2},
                                                        "cameraPose": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}}}))
    report = rs.split_scene(d, log=lambda *_: None)
    assert report["imagined"]["count"] == 0 and report["seen"]["count"] == len(pts)
    dummy = sio.read_splats(d / rs.IMAGINED_FILE)
    assert len(dummy) == 1 and float(dummy.opacities[0]) == 0.0


def test_rs_cli_out_dir(tmp_path):
    d = tmp_path / "cli"
    _rs_write_scene(d, camera="video", sh=0)
    out = tmp_path / "parts"
    assert rs.main([str(d), "--out", str(out)]) == 0
    assert (out / rs.SEEN_FILE).is_file() and (out / rs.IMAGINED_FILE).is_file() and (out / rs.REPORT_FILE).is_file()
    assert rs.main([str(tmp_path / "missing")]) == 2


@pytest.mark.skipif(not (ROOT / "data/scenes/test-tw-local/world.ply").is_file(), reason="test-tw-local scene not present")
def test_rs_real_plate_room(tmp_path):
    src = ROOT / "data/scenes/test-tw-local"
    d = tmp_path / "plate"
    d.mkdir()
    shutil.copy2(src / "scene.json", d / "scene.json")
    (d / "world.ply").symlink_to(src / "world.ply")
    report = rs.split_scene(d, log=lambda *_: None)
    assert report["camera"]["source"] == "video"
    # the lifted plate surface (most of the splats) is seen, the fitted shell around it is imagined
    assert 0.5 < report["seenFraction"] < 0.995
    assert report["imagined"]["count"] > 1000
