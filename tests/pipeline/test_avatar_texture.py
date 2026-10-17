"""Avatar steps 6-7 (pipeline/avatar/texture.py, fill.py): texel map, robust colour, mirror map, hole filling."""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.avatar import body, fill, texture  # noqa: E402

FIXTURE = Path(os.environ.get("AVATAR_FIXTURE", ROOT / "data" / "tmp" / "avatars" / "fixture" / "anny-fixture.npz"))
needs_fixture = pytest.mark.skipif(not FIXTURE.exists(), reason=f"no body fixture at {FIXTURE}")


def test_robust_mean_ignores_a_misaligned_sample():
    c = np.array([[[100, 100, 100], [104, 98, 100], [250, 250, 250], [0, 0, 0], [0, 0, 0]]], np.float32)
    w = np.array([[1.0, 1.0, 1.2, 0, 0]], np.float32)
    np.testing.assert_allclose(texture.robust_mean(c, w)[0], [102, 99, 100], atol=1e-4)


def test_push_pull_fills_from_known_pixels():
    img = np.zeros((37, 50, 3), np.float32)
    known = np.zeros((37, 50), bool)
    img[:, :25] = (200, 10, 10)
    known[:, :25] = True
    out = fill.push_pull(img, known)
    np.testing.assert_allclose(out[known], img[known])
    assert np.all(np.abs(out[~known] - [200, 10, 10]).max(-1) < 1e-3)


def test_bilinear_matches_pixel_centres():
    img = np.arange(4 * 5 * 1, dtype=np.float32).reshape(4, 5, 1)
    np.testing.assert_allclose(texture.bilinear(img, np.array([2.5]), np.array([1.5]))[0], img[1, 2])
    np.testing.assert_allclose(texture.bilinear(img, np.array([3.0]), np.array([1.5]))[0], (img[1, 2] + img[1, 3]) / 2)


@needs_fixture
def test_texel_map_and_mirror():
    fx = dict(np.load(FIXTURE))
    a = body.build_asset(fx, fx["rest_vertices"], fx["rest_bone_poses"])
    tm = texture.texel_map(a, 512)
    assert 0.55 < len(tm.tid) / 512 ** 2 < 0.65
    # barycentric interpolation of the triangle's UVs lands on the texel centre
    uv = a.uv[a.tris[tm.tid]]
    p = (tm.bary[:, :, None] * uv).sum(1) * 512 - 0.5
    inside = (tm.bary > 0.02).all(1)
    err = np.abs(p[inside] - np.stack([tm.xs, tm.ys], 1)[inside])
    assert np.percentile(err, 99) < 0.05
    # the mirror of the mirror is (nearly) the texel itself on this symmetric body
    src = texture.texel_points(a.positions, a, tm)
    m = fill.mirror_sources(a, tm, max_dist=0.01)
    ok = m >= 0
    assert ok.mean() > 0.9
    back = m[m[ok]]
    d = np.linalg.norm(src[np.nonzero(ok)[0]] - src[np.where(back >= 0, back, 0)], axis=1)
    assert np.median(d) < 0.005
    # regions: every body region is present, and about a quarter of the texels face backwards
    reg, backf = texture.texel_regions(a, tm)
    assert set(np.unique(reg)) == set(range(len(texture.REGIONS)))
    assert 0.15 < backf.mean() < 0.4


def test_others_zone_marks_a_margin_around_other_bodies():
    from pipeline.avatar import texture

    K = np.array([[500.0, 0, 320], [0, 500.0, 240], [0, 0, 1]])
    # one square (two triangles) 2 m away, 0.4 m wide, centred on the optical axis
    V = np.array([[-0.2, -0.2, 2.0], [0.2, -0.2, 2.0], [0.2, 0.2, 2.0], [-0.2, 0.2, 2.0]])
    tris = np.array([[0, 1, 2], [0, 2, 3]])
    z = texture.others_zone([V], tris, K, (480, 640), margin_m=0.1)
    # the square spans 270..370 px; 0.1 m at 2 m is 25 px of margin
    assert z[240, 320] and z[240, 370 + 20] and not z[240, 370 + 35]
    assert not texture.others_zone([], tris, K, (480, 640)).any()


def test_furniture_depth_needs_opacity_and_skips_splats_on_bodies():
    from pipeline.avatar.world import Occluders

    K = np.array([[200.0, 0, 160], [0, 200.0, 120], [0, 0, 1]])
    T = np.eye(4)  # cv camera at the origin looking down +z
    g = np.stack(np.meshgrid(np.linspace(-0.3, 0.3, 61), np.linspace(-0.2, 0.2, 41)), -1).reshape(-1, 2)
    wall = np.c_[g, np.full(len(g), 2.0)]  # a dense, fairly opaque panel 2 m away
    haze = np.c_[g[::7], np.full(len(g[::7]), 1.0)]  # a faint veil 1 m away
    occ = object.__new__(Occluders)
    occ.points = np.concatenate([wall, haze])
    occ.alpha = np.r_[np.full(len(wall), 0.6), np.full(len(haze), 0.02)]
    D = occ.depth(T, K, (240, 320), [], scale=0.5)
    assert abs(D[60, 80] - 2.0) < 1e-6  # the panel, not the faint veil in front of it
    assert np.isinf(D[5, 5])
    # splats within 10 cm of a body do not count (the world's faint copies of the people)
    D2 = occ.depth(T, K, (240, 320), [wall + [0, 0, 0.05]], scale=0.5)
    assert np.isinf(D2[60, 80])
