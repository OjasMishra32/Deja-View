"""Avatar step 3 (pipeline/avatar/ground.py): cameras, identities, the floor slide, smoothing helpers. Pure numpy."""

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.avatar import ground  # noqa: E402
from pipeline.avatar.util import apply_T, quat_continuous, quat_to_mat, smooth_quats  # noqa: E402


def test_camera_track_converts_opengl_to_cv():
    doc = {"track": [{"frameIndex": 0, "time": 0.0, "position": [0.0, 1.6, 0.0], "quaternion": [0, 0, 0, 1]}]}
    T = ground.camera_track(doc)[0]
    # 2 m in front of an OpenGL camera that looks down -Z, and 0.5 m below its centre (cv y points down)
    np.testing.assert_allclose(apply_T(T, np.array([0.0, 0.5, 2.0])), [0.0, 1.1, -2.0], atol=1e-12)


def test_tracking_keeps_identities_through_gaps_and_bystanders():
    rng = np.random.default_rng(0)
    used = np.arange(0, 120, 1)
    frames, pos, feat = [], [], []
    who = []
    for n in used:
        people = [(-0.7 + 0.002 * n, 0.9, -2.0), (0.7, 0.9, -2.0 - 0.003 * n)]
        for k, p in enumerate(people):
            if k == 1 and 40 <= n < 52:  # person 1 hidden for 12 frames
                continue
            frames.append(n)
            pos.append(np.array(p) + rng.normal(0, 0.02, 3))
            f = np.zeros(8)
            f[k] = 1
            feat.append(f + rng.normal(0, 0.1, 8))
            who.append(k)
        if 60 <= n < 75:  # a bystander walking through the background
            frames.append(n)
            pos.append(np.array([3.0 - 0.05 * (n - 60), 0.9, 2.0]))
            feat.append(rng.normal(0, 1, 8))
            who.append(2)
    order = rng.permutation(len(frames))  # detection order within the arrays does not matter
    frames, pos, feat, who = np.array(frames)[order], np.array(pos)[order], np.array(feat)[order], np.array(who)[order]
    conf = np.ones(len(frames))
    ids = ground.track_people(frames, used, pos, conf, feat)
    ids = ground.merge_tracks(ids, frames, used, pos, conf)
    tids, counts = np.unique(ids[ids >= 0], return_counts=True)
    main = tids[np.argsort(-counts)][:2]
    for t in main:
        members = set(who[ids == t])
        assert len(members) == 1, members
    assert {int(who[ids == t][0]) for t in main} == {0, 1}
    assert counts.max() == 120


def test_ray_floor_scale_recovers_true_depth():
    # camera 1.6 m up, pitched down 20 deg; a person whose soles are 0.9 m below the pelvis
    pitch = np.radians(-20)
    R_gl = np.array([[1, 0, 0], [0, np.cos(pitch), -np.sin(pitch)], [0, np.sin(pitch), np.cos(pitch)]])
    T_gl = np.eye(4)
    T_gl[:3, :3] = R_gl
    T_gl[:3, 3] = [0, 1.6, 0]
    Tv = (T_gl @ np.diag([1.0, -1, -1, 1]))[None]
    pel_w = np.array([0.2, 0.9, -3.0])
    pel_true = apply_T(np.linalg.inv(Tv[0]), pel_w)
    sole_w = pel_w + np.array([0.0, -0.9, 0.1])
    V_rel = (Tv[0, :3, :3].T @ (sole_w - pel_w))[None, None]
    s = ground.ray_floor_scale(Tv, (pel_true / 1.25)[None], V_rel)
    np.testing.assert_allclose(s, [1.25], atol=1e-9)


def test_quaternion_smoothing_is_sign_safe():
    q = np.tile([0.0, 0.0, np.sin(0.2), np.cos(0.2)], (20, 1))
    q[::2] *= -1  # same rotations, alternating signs
    s = smooth_quats(q[:, None], 7)[:, 0]
    np.testing.assert_allclose(np.abs(s @ q[1]), 1.0, atol=1e-9)
    assert np.all(np.sum(quat_continuous(q)[1:] * quat_continuous(q)[:-1], -1) > 0)
    np.testing.assert_allclose(quat_to_mat(s), np.broadcast_to(quat_to_mat(q[1]), (20, 3, 3)), atol=1e-9)


def test_image_floor_scale_keeps_pixels_and_lands_the_feet():
    # a camera 1.6 m up looking slightly down; a true body with its feet on the floor 2 m ahead, seen by a network
    # that got it 9% too small (and so 9% too close): scaling about the camera centre must undo exactly that
    pitch = np.radians(-20.0)
    T = np.eye(4)
    c, s = np.cos(pitch), np.sin(pitch)
    T[:3, :3] = np.array([[1, 0, 0], [0, c, -s], [0, s, c]]) @ np.diag([1.0, -1.0, -1.0])  # OpenGL -> cv
    T[:3, 3] = [0.0, 1.6, 0.0]
    Tinv = np.linalg.inv(T)
    pel_w = np.array([0.1, 0.95, -2.0])
    feet_w = np.array([[0.0, 0.0, -2.05], [0.2, 0.02, -1.95], [0.1, 0.4, -2.0]])
    pel_true = apply_T(Tinv, pel_w)
    feet_true = apply_T(Tinv, feet_w) - pel_true
    k = 1 / 1.09
    lam = ground.image_floor_scale(T[None], (k * pel_true)[None], (k * feet_true)[None])
    np.testing.assert_allclose(lam, [1.09], rtol=1e-9)
    # pixels do not move under the scale
    p_net = k * (pel_true + feet_true)
    p_fix = lam[0] * p_net
    np.testing.assert_allclose(p_fix[:, :2] / p_fix[:, 2:], p_net[:, :2] / p_net[:, 2:], atol=1e-12)
    # a camera with nothing below it gives NaN
    up = ground.image_floor_scale(T[None], np.array([[0.0, -3.0, 0.5]]), np.zeros((1, 1, 3)))
    assert np.isnan(up[0])
