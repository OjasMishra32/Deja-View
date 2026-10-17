"""Avatar steps 3b, 7 and 9 (pipeline/avatar/refine.py, fill.py, photofit.py) and the silhouette helper: colour
gains, pixel and frame weights, offset bounds, garment fill, hands, recolouring, nudge smoothing, rasterising."""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.avatar import body, fill, photofit, raster, refine, texture  # noqa: E402

FIXTURE = Path(os.environ.get("AVATAR_FIXTURE", ROOT / "data" / "tmp" / "avatars" / "fixture" / "anny-fixture.npz"))
needs_fixture = pytest.mark.skipif(not FIXTURE.exists(), reason=f"no body fixture at {FIXTURE}")
torch = pytest.importorskip("torch")


@pytest.fixture(scope="module")
def fx():
    if not FIXTURE.exists():
        pytest.skip(f"no body fixture at {FIXTURE}")
    d = dict(np.load(FIXTURE))
    return d, body.build_asset(d, d["rest_vertices"], d["rest_bone_poses"])


# ------------------------------------------------------------------------------------------- silhouettes


def test_silhouette_is_the_union_of_overlapping_triangles():
    import cv2

    K = np.array([[100.0, 0, 32], [0, 100.0, 32], [0, 0, 1]])
    # a front and a back triangle that overlap in the image (opposite windings), as a body's front and back do
    V = np.array([[-0.2, -0.2, 1.0], [0.2, -0.2, 1.0], [0.0, 0.2, 1.0], [-0.2, 0.2, 1.5], [0.0, -0.3, 1.5], [0.2, 0.2, 1.5]])
    tris = np.array([[0, 1, 2], [3, 4, 5]])
    S = raster.silhouette(V, tris, K, (64, 64))
    uv = raster.project(K, V)
    one = [raster.coverage(uv[t][None], (64, 64)) for t in tris]
    np.testing.assert_array_equal(S, one[0] | one[1])
    for t, m in zip(tris, one):  # each triangle covers about its area in pixels
        e1, e2 = uv[t[1]] - uv[t[0]], uv[t[2]] - uv[t[0]]
        a = 0.5 * abs(e1[0] * e2[1] - e1[1] * e2[0])
        assert abs(m.sum() - a) < 0.1 * a
    assert S[32, 32]  # where both triangles overlap
    # one polygon fill over both leaves a hole where they overlap: the bug this replaces
    old = np.zeros((64, 64), np.uint8)
    cv2.fillPoly(old, list(np.rint(uv[tris] * 16).astype(np.int32)), 1, lineType=cv2.LINE_8, shift=4)
    assert not old[32, 32]


def test_silhouette_skips_points_behind_the_camera_and_empty_meshes():
    K = np.array([[100.0, 0, 32], [0, 100.0, 32], [0, 0, 1]])
    V = np.array([[-0.2, -0.2, -1.0], [0.2, -0.2, 1.0], [0.0, 0.2, 1.0]])
    assert not raster.silhouette(V, np.array([[0, 1, 2]]), K, (64, 64)).any()
    assert not raster.silhouette(V, np.zeros((0, 3), np.int64), K, (64, 64)).any()


@needs_fixture
def test_silhouette_covers_the_whole_body(fx):
    import cv2

    d, _ = fx
    V = d["frame_v3d"].astype(np.float64)
    tris = body.triangulate(d["faces"], d["face_uv"])[0]
    K = np.array([[880.0, 0, 960], [0, 880.0, 540], [0, 0, 1]])
    S = raster.silhouette(V, tris, K, (1080, 1920))
    ref = np.zeros((1080, 1920), np.uint8)
    uv = raster.project(K, V)
    for t in tris:
        cv2.fillConvexPoly(ref, np.rint(uv[t] * 16).astype(np.int32), 1, lineType=cv2.LINE_8, shift=4)
    assert raster.iou(S, ref > 0) > 0.97


def test_torch_rasteriser_agrees_with_the_silhouette():
    rng = np.random.default_rng(3)
    P = rng.uniform(4, 60, (40, 3, 2))
    z = rng.uniform(1.0, 3.0, (40, 3))
    xy = torch.tensor(P.reshape(-1, 2), dtype=torch.float64)
    zz = torch.tensor(z.reshape(-1), dtype=torch.float64)
    F = torch.arange(120).view(40, 3)
    tri = photofit.rasterize(xy, zz, F, 64, 64).numpy()
    cov = raster.coverage(P, (64, 64))
    assert raster.iou(tri >= 0, cov) > 0.995


# ---------------------------------------------------------------------------------------------- photofit


def test_colour_gains_stay_bounded():
    g = photofit.colour_gains(torch.tensor([[0.0, 50.0, -50.0]]), 0.3)[0].numpy()
    np.testing.assert_allclose(g, [1.0, np.exp(0.3), np.exp(-0.3)], rtol=1e-5)
    x = torch.zeros(4, 3, requires_grad=True)
    photofit.colour_gains(x, 0.3).sum().backward()
    np.testing.assert_allclose(x.grad.numpy(), 0.3, rtol=1e-5)  # d/dx exp(0.3 tanh x) at 0


def test_clipped_pixels_count_less():
    real = torch.tensor([[0.5, 0.5, 0.5], [1.0, 0.9, 0.9], [0.99, 0.2, 0.1], [0.97, 0.97, 0.97]])
    np.testing.assert_allclose(photofit.pixel_weights(real).numpy(), [1.0, 0.2, 0.2, 1.0])
    np.testing.assert_allclose(photofit.pixel_weights(real, w_clipped=1.0).numpy(), 1.0)


def test_frame_weight_falls_with_contested_mask():
    assert photofit.frame_weight(0.0, 0.0) == 1.0
    w = [photofit.frame_weight(c, 0.0) for c in (0.05, 0.2, 0.4, 0.9)]
    assert all(a > b for a, b in zip(w[:-2], w[1:-1]))
    assert w[-1] == 0.25  # never below the floor
    assert photofit.frame_weight(0.1, 0.1) == photofit.frame_weight(0.2, 0.0)


def test_back_cap_tapers_to_the_waist():
    z = np.array([-0.1, 0.05, 0.10, 0.15, 0.20, 0.5])
    c = photofit.back_cap(z, z_lo=0.05, z_hi=0.20)
    np.testing.assert_allclose(c[[0, 1]], 0.03)
    np.testing.assert_allclose(c[[4, 5]], 0.22)
    assert np.all(np.diff(c) >= 0)


def test_auto_steps_scale_with_the_clip():
    assert photofit.auto_steps(333, 8) == 2997  # about 72 visits per frame
    assert photofit.auto_steps(40, 8) == 1500
    assert photofit.auto_steps(1490, 8) == 6000


def test_pack_evidence():
    upper = np.array([True] * 20 + [False] * 4)
    bag = np.r_[np.full(3, 0.15), np.full(17, 0.03), np.zeros(4)]  # a bag on part of the upper back
    assert photofit.pack_evidence(bag, upper) == (True, 0.15)
    assert not photofit.pack_evidence(np.r_[np.full(20, 0.06), np.zeros(4)], upper)[0]  # clothes at the torso bound
    assert not photofit.pack_evidence(bag, np.zeros(24, bool))[0]


@needs_fixture
def test_offset_bounds_by_region(fx):
    from pipeline.avatar.body import PART_NAMES

    d, a = fx
    rv = d["rest_vertices"].astype(np.float64)
    st = a.src_vertex[a.tris]
    n0 = body.vertex_normals(rv, st)
    lo, hi, u, info = photofit.offset_bounds(a, rv, n0, st, pack=True)
    used = np.unique(st)
    part = np.full(len(rv), -1)
    part[a.src_vertex] = a.vert_part
    hands = np.isin(part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R")])
    assert hi[hands].max() <= 0.0101 and lo[hands].min() >= -0.0041
    assert np.all(lo < hi)
    np.testing.assert_allclose(np.linalg.norm(u[used], axis=1), 1.0, atol=1e-6)
    up = info["upper"]
    assert up.sum() > 100 and hi[up].max() > 0.2  # the backpack allowance
    # the allowance ends at the waist: near the seat the back is bounded like the rest of the torso
    labels = [str(b) for b in a.bone_labels]
    z05 = a.rest_bone_poses[labels.index("spine05"), 2, 3]
    seat = (rv[:, 2] < z05) & (np.abs(n0[:, 1]) > 0.5) & (part >= 0)
    assert hi[seat].max() < 0.08
    # the upper back moves backwards (the body faces -y in the fixture's model space)
    assert np.median(u[up, 1] * texture.front_sign(a)) < -0.8
    assert not (info["spill"] & up).any()
    _, hi2, _, info2 = photofit.offset_bounds(a, rv, n0, st, pack=False)
    assert hi2.max() <= 0.081 and not info2["pack"]


@needs_fixture
def test_skin_hands_and_recolour(fx):
    from pipeline.avatar.body import PART_NAMES

    _, a = fx
    tm = texture.texel_map(a, 256)
    tex = np.full((256, 256, 3), 0.3, np.float32)
    reg, _ = texture.texel_regions(a, tm)
    part = a.tri_part[tm.tid]
    face = (part == PART_NAMES.index("head")) & (reg == texture.REGIONS.index("skin"))
    hand = np.isin(part, [PART_NAMES.index("hand.L"), PART_NAMES.index("hand.R")])
    tex[tm.ys[face], tm.xs[face]] = (0.8, 0.6, 0.5)
    tex[tm.ys[hand], tm.xs[hand]] = (0.1, 0.4, 0.4)  # a handle's teal
    out, rep = photofit.skin_hands(tex.copy(), a, tm)
    np.testing.assert_allclose(out[tm.ys[hand], tm.xs[hand]], np.tile([0.8, 0.6, 0.5], (hand.sum(), 1)), atol=1e-6)
    np.testing.assert_allclose(out[tm.ys[~hand], tm.xs[~hand]], tex[tm.ys[~hand], tm.xs[~hand]])
    assert rep["hands"] == int(hand.sum())
    # unseen texels follow the colour change of their chart's seen texels
    lab = np.zeros((16, 16), np.int32)
    lab[:, :8], lab[:, 8:] = 1, 2
    tex0 = np.full((16, 16, 3), 0.5, np.float32)
    fit = tex0.copy()
    seen = np.zeros((16, 16), bool)
    seen[:, :3] = True
    fit[:, :3] = 0.7
    rec, rep2 = photofit.recolour_unseen(fit, tex0, seen | (lab == 2), lab)
    np.testing.assert_allclose(rec[:, 3:8], 0.7, atol=1e-5)
    np.testing.assert_allclose(rec[:, 8:], 0.5, atol=1e-6)
    assert rep2["unseenTexels"] == 16 * 5


def test_floor_term_pulls_the_lowest_foot_point_to_the_floor():
    P = SimpleNamespace(feet=torch.tensor([0, 1]))
    Vw = torch.tensor([[[0.0, 0.02, 0.0], [0.0, 0.05, 0.0], [0.0, -0.5, 0.0]],
                       [[0.0, -0.01, 0.0], [0.0, 0.3, 0.0], [0.0, -0.5, 0.0]]])
    loss, ymin = photofit.floor_term(P, Vw)
    np.testing.assert_allclose(ymin.numpy(), [0.02, -0.01], atol=1e-7)
    assert abs(float(loss) - (2.0 ** 2 + 1.0 ** 2) / 2) < 1e-4  # in cm^2; the third vertex is not a foot


# ------------------------------------------------------------------------------------------------- fill


@needs_fixture
def test_garment_fill_takes_the_neighbouring_garment_colour(fx):
    _, a = fx
    tm = texture.texel_map(a, 256)
    reg, back = texture.texel_regions(a, tm)
    P = texture.texel_points(a.positions, a, tm)
    tex = np.zeros((256, 256, 3), np.float32)
    col = np.where((reg == texture.REGIONS.index("legs"))[:, None], [30.0, 30.0, 35.0], [180.0, 180.0, 185.0])
    col[reg == texture.REGIONS.index("skin")] = (200, 150, 120)
    tex[tm.ys, tm.xs] = col
    rng = np.random.default_rng(1)
    seen = rng.random(len(tm.tid)) < 0.8
    # a hole on the back of the legs, and a stray bright texel among the seen dark ones
    hole = (reg == texture.REGIONS.index("legs")) & back & (P[:, 2] < np.percentile(P[:, 2], 20))
    seen &= ~hole
    img, label, centres, rep = fill.garment_fill(a, tm, tex, seen)
    got = img[tm.ys[hole], tm.xs[hole]]
    assert np.abs(got - [30, 30, 35]).max() < 6
    np.testing.assert_allclose(img[tm.ys[seen], tm.xs[seen]], tex[tm.ys[seen], tm.xs[seen]])
    assert rep["clusters"] >= 3 and (label >= 0).mean() > 0.95
    _, jpeg, rep2 = fill.fill(a, tm, tex.astype(np.uint8), seen)
    assert rep2["method"] == "garment" and jpeg[:2] == b"\xff\xd8"


def test_colour_clusters_merge_near_colours():
    rng = np.random.default_rng(0)
    lab = np.concatenate([rng.normal([50, 0, 0], 1.0, (500, 3)), rng.normal([52, 1, 0], 1.0, (500, 3)),
                          rng.normal([20, 30, 10], 1.0, (400, 3))])
    ctr, cnt = fill.colour_clusters(lab, 4, 14.0, 0.03, rng)
    assert len(ctr) == 2 and sorted(int(c) for c in cnt) == [400, 1000]


# ----------------------------------------------------------------------------------------------- refine


def test_nudges_are_smoothed_along_the_track():
    params = {d: (np.full((11, 3), 0.01), np.zeros(3)) for d in range(10)}
    params[5] = (np.full((11, 3), 0.11), np.array([0.05, 0.0, 0.0]))  # one detection's fit jumps away
    frame_of = {d: 2 * d for d in range(10)}
    sm = refine.smooth_track(params, frame_of, sigma=1.5)
    assert sm[5][0][0, 0] < 0.06 and sm[5][1][0] < 0.03
    assert abs(sm[0][0][0, 0] - 0.01) < 0.005  # far from the jump nothing changes much
    flat = refine.smooth_track({d: (np.full((11, 3), 0.02), np.ones(3)) for d in range(6)}, frame_of, 1.5)
    np.testing.assert_allclose(flat[3][0], 0.02)
    assert refine.smooth_track(params, frame_of, 0.0)[5][0][0, 0] == 0.11


def test_hmr_file_prefers_refined_detections(tmp_path):
    from pipeline.avatar import run

    assert run.hmr_file(tmp_path) == "hmr.npz"
    (tmp_path / "hmr-refined.npz").write_bytes(b"")
    assert run.hmr_file(tmp_path) == "hmr-refined.npz"
    assert run.hmr_file(tmp_path, "off") == "hmr.npz"


def test_ambient_occlusion_is_zero_in_the_open_and_high_in_a_corner():
    pytest.importorskip("open3d")
    # an open floor tile, and a corner where a wall meets it
    V = np.array([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 1], [0.0, 0, 0.5]], np.float64)
    floor = np.array([[0, 3, 2], [0, 2, 1]])
    occ = raster.ambient_occlusion(V, floor, rays=256)
    assert occ.max() < 1e-6
    wall = np.array([[0, 4, 5], [0, 5, 3]])
    F = np.concatenate([floor, wall, [[6, 2, 1]]])
    occ = raster.ambient_occlusion(V, F, rays=256, radius=0.5)
    assert occ[6] > 0.05 and occ[1] < occ[6]
