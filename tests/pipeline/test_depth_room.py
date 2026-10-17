import json
import math

import numpy as np
import pytest

from common.camera import DEFAULT_LONG_FOV_DEG, fov_deg, intrinsics_for, unproject_viewer
from common.splat_ply import quat_from_matrix, quat_to_matrix, read_splat_ply, write_splat_ply
from plate_room import build_plate_room, discontinuities, rotation_between, snap_depth_edges
from tw import depthstab as D
from tw.align import align_video_to_world, crop_mapping, solve_scale


# ---- depth stabilisation ---------------------------------------------------------------

def test_fit_inverse_affine_recovers_params_with_outliers():
    rng = np.random.default_rng(0)
    x = rng.uniform(0.2, 1.5, 5000)
    y = 0.8 * x + 0.12 + rng.normal(0, 0.002, x.size)
    y[:600] = rng.uniform(0.1, 3.0, 600)  # 12% outliers (a person in the "background")
    a, b, rms = D.fit_inverse_affine(x, y)
    assert a == pytest.approx(0.8, abs=0.01) and b == pytest.approx(0.12, abs=0.01)
    assert rms < 0.02


def test_smooth_series_fills_gaps():
    v = np.array([1.0, 1.0, np.nan, 1.0, 1.0, 5.0, 1.0, 1.0])
    valid = np.array([1, 1, 0, 1, 1, 1, 1, 1], bool)
    s = D.smooth_series(v, valid, median_win=3, mean_win=1)
    assert np.isfinite(s).all()
    assert s[2] == pytest.approx(1.0)  # the gap is interpolated
    assert s[5] == pytest.approx(1.0)  # the spike is removed by the median


def test_snap_boundary_uses_foreground_depth():
    inv = np.full((20, 20), 0.4, np.float32)  # wall at 2.5 m
    inv[5:15, 5:15] = 1.0  # person at 1 m
    inv[5:15, 4] = 0.7  # blurred ramp at the silhouette
    alpha = np.zeros((20, 20), np.uint8)
    alpha[5:15, 5:15] = 255
    alpha[5:15, 4] = 90  # feathered outer ring
    out = D.snap_boundary(inv, alpha, band_px=2)
    assert out[10, 4] == pytest.approx(1.0)
    assert out[0, 0] == pytest.approx(0.4)


def test_temporal_bilateral_smooths_static_keeps_motion():
    rgb_static = [np.full((4, 4, 3), 100, np.uint8)] * 3
    inv = [np.full((4, 4), v, np.float32) for v in (1.0, 1.2, 1.0)]
    out = D.temporal_bilateral(inv, rgb_static, 1)
    assert out[0, 0] == pytest.approx(1.0667, abs=1e-3)
    moved = [np.full((4, 4, 3), 0, np.uint8), np.full((4, 4, 3), 255, np.uint8), np.full((4, 4, 3), 0, np.uint8)]
    out = D.temporal_bilateral(inv, moved, 1)
    assert out[0, 0] == pytest.approx(1.2, abs=1e-3)


def test_choose_near_far_brackets_samples():
    inv = 1.0 / np.linspace(0.8, 4.0, 1000)
    near, far = D.choose_near_far(inv)
    assert near < 0.8 and far > 4.0 and far / near < 7


# ---- camera ----------------------------------------------------------------------------

def test_default_intrinsics_and_resize():
    K = intrinsics_for(1280, 720)
    assert fov_deg(K, 1280, 720)[0] == pytest.approx(DEFAULT_LONG_FOV_DEG, abs=1e-6)
    assert K["cx"] == 640 and K["cy"] == 360
    # portrait: the long side is vertical
    Kp = intrinsics_for(720, 1280)
    assert fov_deg(Kp, 720, 1280)[1] == pytest.approx(DEFAULT_LONG_FOV_DEG, abs=1e-6)
    # anisotropic resize from 1920x1088 to 1280x720 keeps each axis exact
    Ka = intrinsics_for(1280, 720, 1920, 1088)
    assert Ka["fx"] / Ka["fy"] == pytest.approx((1280 / 1920) / (720 / 1088))
    # 26 mm equivalent focal length
    K26 = intrinsics_for(1280, 720, focal_35mm=26)
    assert fov_deg(K26, 1280, 720)[0] == pytest.approx(math.degrees(2 * math.atan(18 / 26)))


def test_unproject_viewer_frame():
    K = {"fx": 100.0, "fy": 100.0, "cx": 50.0, "cy": 50.0}
    d = np.full((100, 100), 2.0, np.float32)
    P = unproject_viewer(d, K)
    assert P[0, 0, 0] < 0 and P[0, 0, 1] > 0  # top-left pixel: left and up
    assert np.allclose(P[..., 2], -2.0)  # in front of the camera = -Z


# ---- splat PLY -------------------------------------------------------------------------

def test_quaternion_roundtrip():
    rng = np.random.default_rng(0)
    q = rng.normal(size=(50, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    R = quat_to_matrix(q)
    q2 = quat_from_matrix(R)
    assert np.allclose(np.abs((q * q2).sum(1)), 1.0, atol=1e-5)


def test_ply_roundtrip(tmp_path):
    rng = np.random.default_rng(0)
    n = 100
    xyz = rng.normal(size=(n, 3)).astype(np.float32)
    rgb = rng.uniform(0, 1, (n, 3)).astype(np.float32)
    alpha = rng.uniform(0.1, 0.9, n).astype(np.float32)
    sig = rng.uniform(0.001, 0.1, (n, 3)).astype(np.float32)
    q = quat_from_matrix(np.repeat(np.eye(3)[None], n, 0))
    write_splat_ply(tmp_path / "a.ply", xyz, rgb, alpha, sig, q)
    head = (tmp_path / "a.ply").read_bytes()[:400].decode("ascii", "ignore")
    for f in ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]:
        assert f"property float {f}\n" in head
    r = read_splat_ply(tmp_path / "a.ply")
    assert np.allclose(r["xyz"], xyz) and np.allclose(r["rgb"], rgb, atol=1e-5)
    assert np.allclose(r["alpha"], alpha, atol=1e-5) and np.allclose(r["sigma"], sig, rtol=1e-5)


# ---- plate room ------------------------------------------------------------------------

def _floor_wall_depth(W=320, H=180, cam_h=1.0, wall=4.0, pitch_deg=0.0):
    K = intrinsics_for(W, H)
    u = (np.arange(W) + 0.5 - K["cx"]) / K["fx"]
    v = (np.arange(H) + 0.5 - K["cy"]) / K["fy"]
    uu, vv = np.meshgrid(u, v)
    # ray in camera frame (OpenGL): (u, -v, -1); pitch the camera down by pitch_deg
    p = math.radians(pitch_deg)
    ry = -vv * math.cos(p) - 1.0 * math.sin(p)
    rz = -1.0 * math.cos(p) + vv * math.sin(p)
    t_floor = np.where(ry < -1e-6, -cam_h / np.minimum(ry, -1e-6), np.inf)
    t_wall = np.where(rz < -1e-6, wall / -np.minimum(rz, -1e-6), np.inf)
    t = np.minimum(t_floor, t_wall)
    depth = t  # z-depth in the camera frame: the ray's camera z component is -1
    rgb = np.full((H, W, 3), 128, np.uint8)
    rgb[t_floor < t_wall] = (90, 80, 70)
    return rgb, depth.astype(np.float32), K


def test_discontinuities_ignore_slopes_find_steps():
    yy, xx = np.mgrid[0:60, 0:80].astype(np.float32)
    slope = 0.3 + 0.02 * yy  # steep but planar
    assert not discontinuities(slope).any()
    step = np.where(xx < 40, 1.0, 0.4).astype(np.float32)
    ramp = snap_depth_edges(np.where(xx < 38, 1.0, np.where(xx > 42, 0.4, 1.0 - (xx - 38) * 0.15)).astype(np.float32))
    assert discontinuities(step)[:, 39:41].all()
    vals = np.unique(np.round(ramp[30, 36:45], 3))
    assert len(vals) <= 3  # the 5-pixel ramp became (nearly) a step


def test_plate_room_floor_and_shell(tmp_path):
    rgb, depth, K = _floor_wall_depth()
    res = build_plate_room(rgb, depth, K, tmp_path / "world.ply", max_splats=60_000, log=lambda m: None)
    w = res["world"]
    assert w["floorY"] == pytest.approx(-1.0, abs=0.05)
    assert w["source"] == "plate-depth" and w["file"] == "world.ply"
    assert w["transform"]["quaternion"] == [0.0, 0.0, 0.0, 1.0]
    assert w["spawn"]["position"][1] == w["floorY"]
    lo, hi = np.array(w["bounds"]["min"]), np.array(w["bounds"]["max"])
    assert lo[2] < -4.0 and hi[2] > 1.0 and lo[1] == pytest.approx(w["floorY"])
    r = read_splat_ply(tmp_path / "world.ply")
    assert len(r["xyz"]) == w["splatCount"]
    assert r["xyz"][:, 1].min() >= w["floorY"] - 1e-3  # nothing under the floor
    # the shell surrounds the camera: there are splats behind the viewer (+Z)
    assert (r["xyz"][:, 2] > 1.0).sum() > 100


def test_plate_room_levels_a_pitched_camera(tmp_path):
    rgb, depth, K = _floor_wall_depth(pitch_deg=12.0, wall=6.0)
    res = build_plate_room(rgb, depth, K, tmp_path / "world.ply", max_splats=60_000, log=lambda m: None)
    q = res["levelQuaternion"]  # x, y, z, w: the camera's orientation in the levelled frame
    angle = math.degrees(2 * math.acos(min(1.0, abs(q[3]))))
    assert angle == pytest.approx(12.0, abs=2.0)
    R = quat_to_matrix(np.array([q[3], q[0], q[1], q[2]]))
    fwd = R @ np.array([0.0, 0.0, -1.0])
    assert fwd[1] < -0.15  # the camera looks down in the levelled room
    assert res["world"]["floorY"] == pytest.approx(-1.0, abs=0.08)


def test_rotation_between():
    R = rotation_between(np.array([0.0, 0.9, 0.3]), np.array([0.0, 1.0, 0.0]))
    assert np.allclose(R @ (np.array([0.0, 0.9, 0.3]) / np.linalg.norm([0.0, 0.9, 0.3])), [0, 1, 0], atol=1e-6)
    assert np.linalg.det(R) == pytest.approx(1.0)


# ---- alignment with a generated world --------------------------------------------------

def test_crop_mapping():
    assert crop_mapping(1280, 720, 640, 360) == (0.5, 0.0, 0.0, 1280, 720)
    k, ox, oy, cw, ch = crop_mapping(1280, 720, 512, 512)
    assert (cw, ch) == (720, 720) and ox == pytest.approx(280) and oy == 0 and k == pytest.approx(512 / 720)


def test_solve_scale_and_align(tmp_path):
    H, W = 72, 128
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    plate_depth = (1.5 + 1.5 * xx / W + 0.8 * yy / H).astype(np.float32)  # smooth room-like depth
    ok = np.ones((H, W), bool)
    s, mad, n = solve_scale(plate_depth * 1.7, plate_depth, ok)
    assert s == pytest.approx(1.7) and mad < 1e-6
    cam = {"width": W, "height": H, "fx": 100.0, "fy": 100.0, "cx": W / 2, "cy": H / 2, "position": [0.1, 1.2, 0.3], "quaternion": [0, 0, 0, 1]}
    (tmp_path / "input_camera.json").write_text(json.dumps(cam))
    # coarser depth map of the same aspect; each pixel covers a 2x2 block of the image
    inv_blocks = (1.0 / (plate_depth * 2.0)).reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
    world_depth = (1.0 / inv_blocks).astype(np.float32)
    world_depth[:3] = 0.0  # 0 = no data
    np.save(tmp_path / "input_depth.npy", world_depth)
    video = {"intrinsics": {"fx": 90.0, "fy": 90.0, "cx": 64.0, "cy": 36.0}, "depth": {"encoding": "inverse", "near": 0.5, "far": 5.0},
             "cameraPose": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1]}}
    out, info = align_video_to_world(video, plate_depth, ok, tmp_path, log=lambda m: None)
    assert info["scale"] == pytest.approx(2.0, rel=1e-3)
    assert out["depth"]["near"] == pytest.approx(1.0) and out["depth"]["far"] == pytest.approx(10.0)
    assert out["intrinsics"]["fx"] == pytest.approx(100.0)
    assert out["cameraPose"]["position"] == [0.1, 1.2, 0.3]
