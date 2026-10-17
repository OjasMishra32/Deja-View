"""genfill geometry: cameras, probe grid, depth alignment, Gaussians from pixels, clustering, masks (numpy only)."""
import math

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
from genfill import geom as G


def test_yaw_pitch_convention_matches_viewer():
    f = lambda m: -m[:3, 2]  # noqa: E731
    np.testing.assert_allclose(f(G.yaw_pitch_c2w([0, 1.6, 0], 0, 0)), [0, 0, -1], atol=1e-9)
    np.testing.assert_allclose(f(G.yaw_pitch_c2w([0, 1.6, 0], 90, 0)), [-1, 0, 0], atol=1e-9)
    np.testing.assert_allclose(f(G.yaw_pitch_c2w([0, 1.6, 0], 0, 90)), [0, 1, 0], atol=1e-9)
    for yaw, pitch in [(0, 0), (45, 40), (-120, -30), (170, 75)]:
        y, p = G.yaw_pitch_of(G.yaw_pitch_c2w([1, 2, 3], yaw, pitch))
        assert abs(((y - yaw + 180) % 360) - 180) < 1e-6 and abs(p - pitch) < 1e-6


def test_look_at_and_straight_up():
    m = G.look_at_c2w([0, 1.6, 0], [2, 1.6, -2])
    np.testing.assert_allclose(-m[:3, 2], np.array([1, 0, -1]) / math.sqrt(2), atol=1e-9)
    assert abs(m[1, 0]) < 1e-9  # no roll: the image's x axis stays horizontal
    up = G.look_at_c2w([0, 1.6, 0], [0, 5, 0])
    assert np.isfinite(up).all()
    np.testing.assert_allclose(-up[:3, 2], [0, 1, 0], atol=1e-9)
    np.testing.assert_allclose(up[:3, :3] @ up[:3, :3].T, np.eye(3), atol=1e-9)


def test_project_backproject_roundtrip():
    rng = np.random.default_rng(0)
    c2w = G.look_at_c2w([0.3, 1.6, 0.2], [1.0, 2.5, -4.0])
    k = G.intrinsics(320, 240, 90)
    pts_cam = np.stack([rng.uniform(-1, 1, 50), rng.uniform(-1, 1, 50), rng.uniform(1, 6, 50)], 1)
    c2w_cv = np.linalg.inv(G.w2c_cv(c2w))
    pts = pts_cam @ c2w_cv[:3, :3].T + c2w_cv[:3, 3]
    u, v, z = G.project(pts, c2w, k)
    np.testing.assert_allclose(z, pts_cam[:, 2], atol=1e-9)
    back = G.backproject(u, v, z, c2w, k)
    np.testing.assert_allclose(back, pts, atol=1e-9)
    # the image centre looks along the camera's forward axis
    centre = G.backproject(np.array([k.cx]), np.array([k.cy]), np.array([2.0]), c2w, k)[0]
    np.testing.assert_allclose(centre, c2w[:3, 3] + 2.0 * (-c2w[:3, 2]), atol=1e-9)


def test_probe_positions_stay_in_bounds_and_near_cameras():
    cams = np.array([[0.0, 0.0], [3.0, -3.0]])
    pts = G.probe_positions([-5, 0, -8], [5, 4, 2], cams, spacing=1.2, coverage=2.5, inset=0.3)
    assert len(pts) > 4
    assert (pts[:, 0] > -5 + 0.29).all() and (pts[:, 0] < 5 - 0.29).all()
    assert (pts[:, 1] > -8 + 0.29).all() and (pts[:, 1] < 2 - 0.29).all()
    d = np.sqrt(((pts[:, None] - cams[None]) ** 2).sum(-1)).min(1)
    assert (d <= 2.5 + 1e-9).all()
    views = G.probe_views(pts[:2], 1.6, 8, (-30, 0, 40, 75))
    assert len(views) == 2 * 8 * 4
    assert {v["pitch"] for v in views} == {-30, 0, 40, 75}


def test_align_depth_recovers_scale_and_shift_despite_outliers():
    rng = np.random.default_rng(1)
    ref = rng.uniform(1, 8, 4000)
    pred = (ref - 0.4) / 1.7
    pred[:300] = rng.uniform(0, 20, 300)  # 7.5% garbage
    a, b, info = G.align_depth(pred, ref)
    assert info["ok"]
    assert abs(a - 1.7) < 0.03 and abs(b - 0.4) < 0.05
    assert info["medianRelErr"] < 0.01


def test_depth_normals_of_a_tilted_plane():
    k = G.intrinsics(160, 120, 90)
    j, i = np.mgrid[0:120, 0:160]
    x, y = (i + 0.5 - k.cx) / k.fx, (j + 0.5 - k.cy) / k.fy
    n = np.array([0.0, 0.6, -0.8])  # plane n . X = -2 (faces the camera)
    z = -2.0 / (n[0] * x + n[1] * y + n[2] * 1.0)
    nn = G.depth_normals(z, k)
    np.testing.assert_allclose(nn[5:-5, 5:-5].reshape(-1, 3).mean(0), n, atol=1e-3)


def test_rotmat_quat_roundtrip():
    rng = np.random.default_rng(2)
    q = rng.normal(size=(100, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    R = G.quats_wxyz_to_rotmats(q)
    np.testing.assert_allclose(G.rotmats_to_quats_wxyz(R), q, atol=1e-9)


def test_lift_pixels_puts_flat_gaussians_on_the_surface():
    k = G.intrinsics(200, 150, 90)
    c2w = G.yaw_pitch_c2w([0, 1.6, 0], 0, 90)  # looking straight up at a ceiling 1.4 m above the eye
    depth = np.full((150, 200), 1.4)
    rgb = np.full((150, 200, 3), 200, np.uint8)
    sel = np.zeros((150, 200), bool)
    sel[40:110, 50:150] = True
    L = G.lift_pixels(rgb, depth, sel, c2w, k, stride=2)
    assert len(L) == 35 * 50
    np.testing.assert_allclose(L.means[:, 1], 3.0, atol=1e-5)
    R = G.quats_wxyz_to_rotmats(L.quats)
    np.testing.assert_allclose(np.abs(R[:, 1, 2]), 1.0, atol=1e-3)  # the thin axis is vertical
    assert (L.scales[:, 2] < L.scales[:, 0]).all() and (L.scales > 0).all()
    np.testing.assert_allclose(L.rgb, 200 / 255.0, atol=1e-6)


def test_voxel_regions_and_voxelset():
    rng = np.random.default_rng(3)
    a = rng.normal([0, 3, 0], 0.2, (500, 3))
    b = rng.normal([6, 1, -4], 0.2, (200, 3))
    c = rng.normal([-6, 1, 4], 0.05, (5, 3))
    labels, regions = G.voxel_regions(np.concatenate([a, b, c]), voxel=0.5, min_mass=20)
    assert len(regions) == 2
    assert regions[0]["points"] == 500 and regions[1]["points"] == 200
    assert (labels[:500] == 0).all() and (labels[500:700] == 1).all() and (labels[700:] == -1).all()
    vs = G.VoxelSet(a, 0.5, dilate=1)
    assert vs.contains(np.array([[0, 3, 0]])).all()
    assert not vs.contains(np.array([[6, 1, -4]])).any()


def test_masks_and_compositing():
    m = np.zeros((60, 80), bool)
    m[20:40, 30:50] = True
    m[2, 2] = True  # a speck
    c = G.clean_mask(m, close=1, min_frac=0.01, grow=2)
    assert not c[2, 2] and c[18, 30] and c[30, 40]
    f = G.feather(m, 4)
    assert f[30, 40] == 1 and 0 < f[30, 52] < 1 and f[30, 60] == 0
    r = G.ring(m, 2, 6)
    assert not r[m].any() and r[30, 54] and not r[30, 51]
    base = np.full((60, 80, 3), 100, np.uint8)
    gen = np.full((60, 80, 3), 150, np.uint8)
    out = G.composite(base, G.colour_match(gen, base, r), f)
    assert np.abs(out.astype(int) - 100).max() <= 1  # matched to the surroundings: no seam
    mag = base.copy()
    mag[m] = (255, 0, 255)
    assert G.magenta_fraction(mag, m) == 1.0 and G.magenta_fraction(base, m) == 0.0


def test_fill_depth_from_neighbours():
    d = np.zeros((10, 10))
    d[:, :5] = 2.0
    d[:, 5:] = 7.0
    valid = np.ones((10, 10), bool)
    valid[3:7, 3:7] = False
    out = G.fill_depth_from_neighbours(d, valid, cap=5.0)
    assert out[5, 3] == 2.0 and out[5, 6] == 5.0


def test_ceiling_height_and_snap():
    rng = np.random.default_rng(6)
    ceil = np.stack([rng.uniform(-3, 3, 3000), np.full(3000, 3.2) + rng.normal(0, 0.01, 3000), rng.uniform(-3, 3, 3000)], 1)
    wall = np.stack([np.full(2000, 3.0), rng.uniform(0, 3.2, 2000), rng.uniform(-3, 3, 2000)], 1)
    means = np.concatenate([ceil, wall])
    normals = np.concatenate([np.tile([0, -1.0, 0], (3000, 1)), np.tile([-1.0, 0, 0], (2000, 1))])
    h = G.ceiling_height(means, normals, np.full(5000, 0.8), np.ones(5000, bool), (-4, -4), (4, 4), 2.1)
    assert h is not None and abs(h - 3.2) < 0.05
    k = G.intrinsics(80, 60, 90)
    c2w = G.yaw_pitch_c2w([0, 1.6, 0], 0, 60)
    depth = np.full((60, 80), 1.0)  # a fill placed too close; its points land ~0.6-1 m below the ceiling
    sel = np.ones((60, 80), bool)
    out, moved = G.snap_to_ceiling(depth, sel, c2w, k, 3.2, tol=2.0)
    assert moved > 0
    j, i = np.nonzero(out != depth)
    pts = G.backproject(i + 0.5, j + 0.5, out[j, i], c2w, k)
    np.testing.assert_allclose(pts[:, 1], 3.2, atol=1e-6)
