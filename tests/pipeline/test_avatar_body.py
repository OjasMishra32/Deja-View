"""Avatar step 4 (pipeline/avatar/body.py) and the kinematics ground.py relies on.

Pure numpy. The body-model fixture (topology, weights, one network frame) is written on HiPerGator by
`python -m pipeline.avatar.body export --out anny-fixture.npz --hmr hmr.npz` and copied to
data/tmp/avatars/fixture/anny-fixture.npz (AVATAR_FIXTURE overrides); tests that need it skip without it.
"""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.avatar import body, ground  # noqa: E402
from pipeline.avatar.util import mat_to_quat, quat_to_mat, rigid_inv  # noqa: E402

FIXTURE = Path(os.environ.get("AVATAR_FIXTURE", ROOT / "data" / "tmp" / "avatars" / "fixture" / "anny-fixture.npz"))
needs_fixture = pytest.mark.skipif(not FIXTURE.exists(), reason=f"no body fixture at {FIXTURE}")


@pytest.fixture(scope="module")
def fx():
    return dict(np.load(FIXTURE))


def random_skeleton(J=12, seed=0):
    rng = np.random.default_rng(seed)
    parents = np.array([-1] + [int(rng.integers(0, j)) for j in range(1, J)])
    rest = np.zeros((J, 4, 4))
    for j in range(J):
        R = quat_to_mat(rng.normal(size=4) / 2 + np.array([0, 0, 0, 1.0]))
        rest[j] = np.eye(4)
        rest[j, :3, :3] = R
        rest[j, :3, 3] = rng.normal(size=3) * 0.3
    return parents, rest


def test_forward_and_pose_params_roundtrip():
    parents, rest = random_skeleton()
    rng = np.random.default_rng(1)
    delta = quat_to_mat(rng.normal(size=(3, len(parents), 4)))
    G = ground.forward(delta, rest, parents)
    back = ground.pose_params(G, rest, parents)
    np.testing.assert_allclose(back, delta, atol=1e-9)
    # rebuilding on another rest skeleton keeps each bone's local rotation and that skeleton's bone offsets
    _, rest2 = random_skeleton(seed=5)
    G2 = ground.forward(back, rest2, parents)
    for j in range(1, len(parents)):
        p = parents[j]
        loc = rigid_inv(G2[:, p]) @ G2[:, j]
        np.testing.assert_allclose(loc[:, :3, 3], np.broadcast_to((rigid_inv(rest2[p]) @ rest2[j])[:3, 3], (3, 3)), atol=1e-9)


def test_triangulate_and_split_seams():
    faces = np.array([[0, 1, 2, 3], [1, 4, 5, 2]])
    fuv = np.array([[0, 1, 2, 3], [4, 5, 6, 7]])  # vertex 1 and 2 have two UVs each (a seam)
    tris, tuv = body.triangulate(faces, fuv)
    assert tris.shape == (4, 3) and tuv.shape == (4, 3)
    src_v, src_uv, new = body.split_seams(tris, tuv)
    assert len(src_v) == 8  # 6 positions, 2 of them duplicated across the seam
    np.testing.assert_array_equal(src_v[new], tris)
    np.testing.assert_array_equal(src_uv[new], tuv)


def test_top_k_renormalises():
    w = np.array([[0.5, 0.2, 0.1, 0.1, 0.1], [1.0, 0, 0, 0, 0]])
    i = np.array([[3, 1, 2, 4, 5], [7, 0, 0, 0, 0]])
    wk, ik = body.top_k(w, i, 4)
    np.testing.assert_allclose(wk.sum(1), 1.0)
    assert ik[0, 0] == 3 and ik[1, 0] == 7 and wk[1, 0] == 1.0


@needs_fixture
def test_numpy_lbs_matches_network_vertices(fx):
    """Our LBS of the rest mesh at the frame's phenotype reproduces the network's own vertices (v3d, stored as
    float16, so ~1 mm of quantisation) within 2 mm."""
    G = fx["frame_bone_poses"]
    V = body.lbs(fx["frame_rest_vertices"], fx["weights"], fx["indices"], G, fx["frame_rest_bone_poses"])
    off = fx["frame_transl_pelvis"] - G[0, :3, 3]
    err = np.linalg.norm(V + off - fx["frame_v3d"], axis=1)
    assert err.max() < 0.002, err.max()
    assert np.abs(V - fx["frame_anny_posed"]).max() < 1e-5


@needs_fixture
def test_network_bones_follow_our_forward_kinematics(fx):
    par = fx["bone_parents"]
    G = fx["frame_bone_poses"]
    R = fx["frame_net_rest_bone_poses"]
    delta = ground.pose_params(G, R, par)
    np.testing.assert_allclose(ground.forward(delta[None], R, par)[0], G, atol=1e-4)


@needs_fixture
def test_top4_truncation_error(fx):
    G = fx["frame_bone_poses"]
    full = body.lbs(fx["frame_rest_vertices"], fx["weights"], fx["indices"], G, fx["frame_rest_bone_poses"])
    wk, ik = body.top_k(fx["weights"], fx["indices"], 4)
    top4 = body.lbs(fx["frame_rest_vertices"], wk, ik, G, fx["frame_rest_bone_poses"])
    err = np.linalg.norm(full - top4, axis=1)
    print(f"top-4 truncation: p99 {1000 * np.percentile(err, 99):.2f} mm, max {1000 * err.max():.2f} mm")
    assert np.percentile(err, 99) < 0.005


@needs_fixture
def test_asset_parts_and_lateral_axis(fx):
    a = body.build_asset(fx, fx["rest_vertices"], fx["rest_bone_poses"])
    counts = np.bincount(a.tri_part, minlength=len(body.PART_NAMES))
    names = body.PART_NAMES
    for side in ("hand", "foot"):
        assert counts[names.index(f"{side}.L")] == counts[names.index(f"{side}.R")] > 100
    for p in body.DROP_PARTS:
        assert counts[names.index(p)] == 0
    assert counts[names.index("head")] > 1000
    ax, sign = body.lateral_axis(fx["rest_bone_poses"], fx["bone_labels"])
    assert (ax, sign) == (0, 1.0)  # +x points from the right hand to the left hand
    # every split vertex keeps its source position and a valid UV
    np.testing.assert_allclose(a.positions, fx["rest_vertices"][a.src_vertex])
    assert a.uv.min() >= 0 and a.uv.max() <= 1
    assert 12000 < len(a.positions) < 16000  # cavities dropped, seams split: ~13.5k
    np.testing.assert_allclose(a.weights.sum(1), 1.0, atol=1e-5)


def test_quaternion_helpers():
    rng = np.random.default_rng(2)
    R = quat_to_mat(rng.normal(size=(5, 4)))
    np.testing.assert_allclose(quat_to_mat(mat_to_quat(R)), R, atol=1e-9)
