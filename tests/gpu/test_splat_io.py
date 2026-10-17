from __future__ import annotations

import gzip
import json
import math
import struct

import numpy as np
import pytest

import splat_io as sio
from gpu_helpers import SAMPLES, random_splats, synthetic_room


def _quat_close(a: np.ndarray, b: np.ndarray, tol: float) -> bool:
    d = np.minimum(np.abs(a - b).max(axis=1), np.abs(a + b).max(axis=1))
    return bool(d.max() < tol)


# ---------------------------------------------------------------------------------------------------- PLY


@pytest.mark.parametrize("degree", [0, 1, 2, 3])
def test_ply_round_trip(tmp_path, rng, degree):
    s = random_splats(2000, degree, rng)
    p = tmp_path / "w.ply"
    sio.write_ply(p, s)
    r = sio.read_ply(p)
    assert len(r) == len(s) and r.sh_degree == degree
    np.testing.assert_allclose(r.means, s.means, atol=1e-5)
    np.testing.assert_allclose(r.scales, s.scales, rtol=1e-4)
    np.testing.assert_allclose(r.opacities, s.opacities, atol=1e-5)
    np.testing.assert_allclose(r.sh_dc, s.sh_dc, atol=1e-6)
    if degree:
        np.testing.assert_allclose(r.sh_rest, s.sh_rest, atol=1e-6)
    assert _quat_close(r.quats, s.quats, 1e-5)


def test_ply_header_is_standard(tmp_path, rng):
    s = random_splats(10, 1, rng)
    p = tmp_path / "w.ply"
    sio.write_ply(p, s)
    head = p.read_bytes().split(b"end_header\n")[0].decode()
    props = [l.split()[-1] for l in head.splitlines() if l.startswith("property")]
    assert props[:6] == ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"]
    assert props[6:15] == [f"f_rest_{i}" for i in range(9)]
    assert props[15:] == ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    assert "binary_little_endian" in head


def test_ply_rest_is_channel_major(tmp_path, rng):
    """f_rest_{c*(K-1)+k} holds channel c of coefficient k (the INRIA layout)."""
    s = random_splats(5, 1, rng)
    p = tmp_path / "w.ply"
    sio.write_ply(p, s)
    v = sio._read_ply_vertices(p)
    for c in range(3):
        for k in range(3):
            np.testing.assert_allclose(v[f"f_rest_{c * 3 + k}"], s.sh_rest[:, k, c], atol=1e-7)


def test_read_upstream_flashworld_ply(tmp_path, rng):
    """Upstream FlashWorld writes all 27 SH values as f_dc_0..26 (coefficient-major)."""
    n = 50
    allc = rng.normal(size=(n, 9, 3)).astype(np.float32)
    names = ["x", "y", "z"] + [f"f_dc_{i}" for i in range(27)] + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    cols = [rng.normal(size=(n, 3)), allc.reshape(n, 27), np.zeros((n, 1)), np.full((n, 3), -3.0), np.tile([1, 0, 0, 0], (n, 1))]
    arr = np.concatenate(cols, 1).astype("<f4")
    hdr = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n + "".join(f"property float {x}\n" for x in names) + "end_header\n"
    p = tmp_path / "fw.ply"
    p.write_bytes(hdr.encode() + arr.tobytes())
    r = sio.read_ply(p)
    assert r.sh_degree == 2
    np.testing.assert_allclose(r.sh_dc, allc[:, 0], atol=1e-6)
    np.testing.assert_allclose(r.sh_rest, allc[:, 1:], atol=1e-6)
    np.testing.assert_allclose(r.opacities, 0.5, atol=1e-6)


# ---------------------------------------------------------------------------------------------------- SPZ


@pytest.mark.parametrize("version", [2, 3])
@pytest.mark.parametrize("degree", [0, 1, 2, 3])
def test_spz_round_trip(tmp_path, rng, version, degree):
    s = random_splats(3000, degree, rng)
    p = tmp_path / "w.spz"
    sio.write_spz(p, s, version=version)
    h = sio.read_spz_header(p)
    assert h == {"version": version, "numPoints": 3000, "shDegree": degree, "fractionalBits": 12, "antialiased": False}
    r = sio.read_spz(p)
    assert len(r) == 3000 and r.sh_degree == degree
    assert np.abs(r.means - s.means).max() <= 0.5 / 4096 + 1e-6
    assert np.abs(r.opacities - s.opacities).max() <= 0.5 / 255 + 1e-6
    assert np.abs(r.sh_dc - s.sh_dc).max() <= 0.5 / (0.15 * 255) + 1e-5
    ratio = np.abs(np.log(r.scales) - np.log(s.scales))
    assert ratio.max() <= 0.5 / 16 + 1e-5
    # v3 stores the smallest three components with 9 bits; v2 stores xyz with 8 bits and derives w, which is
    # coarse when w is small (a format limit, hence v3 by default).
    ang = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(r.quats * s.quats, axis=1)), 0, 1)))
    if version == 3:
        assert ang.max() < 0.3
    else:
        assert np.median(ang) < 1.0 and ang.max() < 15.0
    if degree:
        tol = 16 / 128 / 2 + 1 / 128
        assert np.abs(r.sh_rest - s.sh_rest).max() <= tol


def test_spz_layout_by_hand(tmp_path):
    """One splat, decoded with the spec directly (independent of read_spz)."""
    s = sio.Splats([[1.5, -2.25, 0.125]], [[0.1, 0.2, 0.3]], [[1, 0, 0, 0]], [0.5], [[0.0, 1.0, -1.0]])
    p = tmp_path / "one.spz"
    sio.write_spz(p, s, version=3)
    raw = gzip.decompress(p.read_bytes())
    magic, ver, n, deg, fb, flags, res = struct.unpack_from("<IIIBBBB", raw)
    assert (magic, ver, n, deg, fb, flags, res) == (0x5053474E, 3, 1, 0, 12, 0, 0)
    pos = raw[16:25]
    vals = [int.from_bytes(pos[i : i + 3], "little", signed=True) / 4096 for i in (0, 3, 6)]
    assert vals == [1.5, -2.25, 0.125]
    assert raw[25] == 128  # alpha 0.5 -> 127.5 rounds to 128
    assert list(raw[26:29]) == [128, round(0.15 * 255 + 127.5), round(-0.15 * 255 + 127.5)]
    assert list(raw[29:32]) == [round((math.log(v) + 10) * 16) for v in (0.1, 0.2, 0.3)]
    comp = int.from_bytes(raw[32:36], "little")
    assert comp >> 30 == 3  # w is the largest component of the identity quaternion
    assert comp & ((1 << 30) - 1) == 0
    assert len(raw) == 36


def test_spz_positions_clamp_to_24_bits(tmp_path):
    s = sio.Splats([[5000.0, -5000.0, 0.0]], [[0.1] * 3], [[1, 0, 0, 0]], [1.0], [[0, 0, 0]])
    p = tmp_path / "far.spz"
    sio.write_spz(p, s)
    r = sio.read_spz(p)
    assert r.means[0, 0] == pytest.approx((2**23 - 1) / 4096)
    assert r.means[0, 1] == pytest.approx(-(2**23) / 4096)


def test_read_splats_dispatch(tmp_path, rng):
    s = random_splats(100, 0, rng)
    sio.write_splats(tmp_path / "a.ply", s)
    sio.write_splats(tmp_path / "a.spz", s)
    assert len(sio.read_splats(tmp_path / "a.ply")) == 100
    assert len(sio.read_splats(tmp_path / "a.spz")) == 100
    (tmp_path / "bad.bin").write_bytes(b"nope")
    with pytest.raises(ValueError):
        sio.read_splats(tmp_path / "bad.bin")


@pytest.mark.skipif(not (SAMPLES / "sample-painted-bedroom" / "world.spz").exists(), reason="sample worlds not fetched")
def test_marble_sample_reads_and_has_a_floor():
    s = sio.read_spz(SAMPLES / "sample-painted-bedroom" / "world.spz")
    assert len(s) == 500_000 and s.sh_degree == 0
    world = sio.apply_transform(s.means, {"position": [0, 0, 0], "quaternion": [1, 0, 0, 0], "scale": 1})
    fit = sio.estimate_floor(world, s.opacities)
    assert fit.found and fit.tilt_deg < 3 and 0.8 < fit.camera_height < 2.0


# ---------------------------------------------------------------------------------------------------- math


def test_quaternion_matrix_round_trip(rng):
    for _ in range(200):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        R = sio.quat_xyzw_to_matrix(q)
        np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-9)
        q2 = np.array(sio.matrix_to_quat_xyzw(R))
        assert min(np.abs(q2 - q).max(), np.abs(q2 + q).max()) < 1e-6


def test_half_turn_about_x_is_opencv_to_opengl():
    R = sio.quat_xyzw_to_matrix([1, 0, 0, 0])
    np.testing.assert_allclose(R, np.diag([1, -1, -1]), atol=1e-12)


def test_rotation_between(rng):
    for _ in range(50):
        a, b = rng.normal(size=3), rng.normal(size=3)
        R = sio.rotation_between(a, b)
        np.testing.assert_allclose(R @ (a / np.linalg.norm(a)), b / np.linalg.norm(b), atol=1e-9)
        np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-9)
    R = sio.rotation_between([0, 1, 0], [0, -1, 0])
    np.testing.assert_allclose(R @ [0, 1, 0], [0, -1, 0], atol=1e-9)


def test_transform_splats_matches_transform_dict(rng):
    s = random_splats(100, 0, rng)
    R = sio.quat_xyzw_to_matrix([0.2, 0.3, -0.1, 0.9])
    t = [1.0, -2.0, 0.5]
    baked = sio.transform_splats(s, R, t, 2.0)
    via = sio.apply_transform(s.means, sio.transform_dict(R, t, 2.0))
    np.testing.assert_allclose(baked.means, via, atol=1e-4)
    # Orientation: the baked Gaussian's local x axis is R times the original one.
    for i in range(5):
        before = sio.quat_wxyz_to_matrix(s.quats[i])
        after = sio.quat_wxyz_to_matrix(baked.quats[i])
        np.testing.assert_allclose(after, R @ before, atol=1e-5)


def test_yaw_convention():
    assert sio.yaw_of_forward([0, 0, -1]) == pytest.approx(0)
    assert sio.yaw_of_forward([-1, 0, 0]) == pytest.approx(math.pi / 2)  # turned left
    R = sio.rot_y(0.7)
    assert sio.yaw_of_forward(R @ [0, 0, -1]) == pytest.approx(0.7)


# ---------------------------------------------------------------------------------------------------- floor and placement


@pytest.mark.parametrize("pitch", [0.0, -15.0, 12.0])
def test_floor_found_under_tilted_camera(rng, pitch):
    s, R_wc = synthetic_room(rng, camera_height=1.5, pitch_deg=pitch)
    fit = sio.estimate_floor(s.means, s.opacities)
    assert fit.found, fit.reason
    assert fit.camera_height == pytest.approx(1.5, abs=0.03)
    # The fitted normal is world-up expressed in the camera frame.
    np.testing.assert_allclose(fit.normal, R_wc.T @ [0, 1, 0], atol=0.02)


def test_floor_prefers_floor_over_table(rng):
    s, _ = synthetic_room(rng, camera_height=1.6, with_table=True)
    fit = sio.estimate_floor(s.means, s.opacities)
    assert fit.found and fit.camera_height == pytest.approx(1.6, abs=0.03)


def test_no_floor_in_a_sky(rng):
    d = rng.normal(size=(20000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    d[:, 1] = np.abs(d[:, 1])  # upper hemisphere only
    fit = sio.estimate_floor(d * 10, np.ones(len(d)))
    assert not fit.found


def test_place_world_levels_scales_and_spawns(rng):
    s, _ = synthetic_room(rng, camera_height=2.0, pitch_deg=-20.0)
    place = sio.place_world(s.means, s.opacities, np.eye(4), camera_height=1.45)
    assert place["floorY"] == 0.0
    assert place["scale"] == pytest.approx(1.45 / 2.0, rel=0.03)
    world = sio.apply_transform(s.means, place["transform"])
    # Floor points (the lowest layer) now sit at y = 0, the ceiling at 3 m * scale.
    assert np.percentile(world[:, 1], 2) == pytest.approx(0.0, abs=0.03)
    assert np.percentile(world[:, 1], 99.5) == pytest.approx(3.0 * place["scale"], abs=0.05)
    assert place["camera"]["position"][1] == pytest.approx(1.45, abs=1e-6)
    assert place["spawn"]["position"] == [0.0, 0.0, 0.0]
    assert place["spawn"]["yaw"] == pytest.approx(0.0, abs=0.02)
    # The camera's forward in the world is still pitched down 20 degrees.
    Rc = sio.quat_xyzw_to_matrix(place["camera"]["quaternion"])
    f = Rc @ [0, 0, -1]
    assert math.degrees(math.asin(f[1])) == pytest.approx(-20.0, abs=1.0)
    b = place["bounds"]
    assert b["min"][1] < 0.05 and b["max"][1] > 1.5


def test_place_world_with_camera_pose_in_file(rng):
    """Camera 0 not at the origin of the file (AnySplat-like): the result must not depend on the file frame."""
    s, _ = synthetic_room(rng, camera_height=1.5)
    R = sio.quat_xyzw_to_matrix([0.1, -0.4, 0.2, 0.88])
    t = np.array([3.0, -1.0, 2.0])
    moved = sio.transform_splats(s, R, t)
    pose = sio.pose_matrix(R, t)
    a = sio.place_world(s.means, s.opacities, np.eye(4))
    b = sio.place_world(moved.means, moved.opacities, pose)
    wa = sio.apply_transform(s.means[:2000], a["transform"])
    wb = sio.apply_transform(moved.means[:2000], b["transform"])
    np.testing.assert_allclose(wa, wb, atol=0.02)


def test_place_world_without_floor_uses_fallbacks(rng):
    d = rng.normal(size=(20000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    d[:, 1] = np.abs(d[:, 1])
    p1 = sio.place_world(d * 10, None, np.eye(4), fallback_scale=1.0)
    assert p1["floorY"] is None and p1["scale"] == 1.0
    assert p1["transform"]["position"] == [0.0, 1.45, 0.0]
    p2 = sio.place_world(d * 10, None, np.eye(4), fallback_scale=None, fallback_median_distance=2.5)
    assert p2["scale"] == pytest.approx(0.25, rel=1e-3)


# ---------------------------------------------------------------------------------------------------- pruning and rendering


def test_prune_respects_budget_and_drops_junk(rng):
    s = random_splats(5000, 0, rng)
    s.scales[:] = np.minimum(s.scales, 0.05)
    s.opacities[:100] = 0.001
    s.means[100:110] = np.nan
    s.scales[110:120] = 500.0  # huge splats near the camera
    keep = sio.prune_indices(s, max_count=3000)
    assert len(keep) == 3000
    assert not np.isin(np.arange(120), keep).any()
    assert np.all(np.diff(keep) > 0)
    keep_all = sio.prune_indices(s, max_count=None)
    assert len(keep_all) == 5000 - 120


def test_render_points_depth_of_a_wall(rng):
    xs, ys = np.meshgrid(np.linspace(-3, 3, 300), np.linspace(-2, 2, 200))
    m = np.stack([xs.ravel(), ys.ravel(), np.full(xs.size, -2.5)], 1)
    s = sio.Splats.from_rgb(m, [0.2, 0.6, 0.9], 0.02, 1.0)
    r = sio.render_points(s, np.eye(4), 200, 200, 160, 120, 320, 240)
    assert r.backend == "points"
    assert float(np.mean(r.alpha > 0.5)) > 0.95
    assert np.median(r.depth[r.alpha > 0.5]) == pytest.approx(2.5, abs=1e-3)
    c = r.rgb[120, 160].astype(float) / 255
    np.testing.assert_allclose(c, [0.2, 0.6, 0.9], atol=0.01)


def test_render_respects_camera_pose():
    m = np.array([[0.0, 0.0, 3.0]] * 50) + np.random.default_rng(0).normal(scale=0.01, size=(50, 3))
    s = sio.Splats.from_rgb(m, [1, 0, 0], 0.05, 1.0)
    front = sio.render_points(s, np.eye(4), 100, 100, 50, 50, 100, 100)
    assert front.alpha.sum() == 0  # the points are behind an identity camera
    back = sio.render_points(s, sio.pose_matrix(sio.rot_y(math.pi), [0, 0, 0]), 100, 100, 50, 50, 100, 100)
    assert back.alpha[50, 50] > 0 and back.depth[50, 50] == pytest.approx(3.0, abs=0.05)


def test_contact_sheet_shape():
    imgs = [np.zeros((10, 20, 3), np.uint8)] * 5
    sheet = sio.contact_sheet(imgs, cols=3, pad=2)
    assert sheet.shape == (2 * 12 + 2, 3 * 22 + 2, 3)


# ---------------------------------------------------------------------------------------------------- JSON and progress


def test_progress_file_is_monotonic_and_mapped(tmp_path):
    p = tmp_path / "progress.json"
    prog = sio.Progress(p)
    prog("Loading", 0.2)
    sub = prog.sub(0.5, 1.0)
    sub("Generating", 0.5)
    assert json.loads(p.read_text()) == {"stage": "Generating", "progress": 0.75}
    sub("Generating", 0.1)  # going backwards is ignored
    assert json.loads(p.read_text())["progress"] == 0.75
    prog.done()
    assert json.loads(p.read_text()) == {"stage": "Done", "progress": 1.0, "done": True}


def test_progress_callable_and_fail(tmp_path):
    seen = []
    prog = sio.Progress(lambda st, v: seen.append((st, v)), 0.0, 1.0)
    prog.sub(0.0, 0.5)("Half", 1.0)
    assert seen[-1] == ("Half", 0.5)
    p = tmp_path / "progress.json"
    pf = sio.Progress(p)
    pf("Working", 0.3)
    pf.fail("boom")
    d = json.loads(p.read_text())
    assert d["error"] == "boom" and d["done"] is True and d["progress"] == 0.3


def test_jsonable_handles_numpy():
    out = sio.jsonable({"a": np.float32(1.5), "b": np.arange(3), "c": np.bool_(True), "d": float("nan")})
    assert out == {"a": 1.5, "b": [0, 1, 2], "c": True, "d": None}
    json.dumps(out)
