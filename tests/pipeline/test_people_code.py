"""Handheld people layer (pipeline/recon/people.py): the frame code in the depth band and the helpers that place people."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline" / "recon"))

import people  # noqa: E402


def test_frame_code_roundtrip_and_checks():
    fc = people.FRAME_CODE
    for k in (0, 1, 2, 255, 256, 370, 8191):
        row = np.repeat(people.frame_code_values(k).astype(np.float32), 60)
        assert people.read_frame_code(row) == k
        noisy = row + np.random.default_rng(k).normal(0, 12, row.shape)
        assert people.read_frame_code(noisy) == k
    flat = np.full(fc["blocks"] * 60, 128.0)
    assert people.read_frame_code(flat - 100) is None  # no code: all low
    bad = np.repeat(people.frame_code_values(5).astype(np.float32), 60)
    bad[2 * 60 : 3 * 60] = fc["hi"] if bad[2 * 60] < 128 else fc["lo"]  # one bit flipped: parity fails
    assert people.read_frame_code(bad) is None


def test_write_code_rows_zeroes_the_mask():
    depth = np.full((540, 960), 77, np.uint8)
    mask = np.full((540, 960), 255, np.uint8)
    people.write_code_rows(depth, mask, 123)
    rows = people.FRAME_CODE["rows"]
    assert (mask[-rows:] == 0).all() and (mask[:-rows] == 255).all()
    assert people.read_frame_code(depth[-rows // 2].astype(np.float32)) == 123
    assert (depth[:-rows] == 77).all()


def test_room_depth_makes_the_floor_exact():
    K = {"fx": 400.0, "fy": 400.0, "cx": 320.0, "cy": 180.0}
    rays = people.camera_rays(K, 640, 360)
    c2w = people.gl_c2w([0.0, 1.6, 0.0], [-np.sin(np.radians(15) / 2), 0.0, 0.0, np.cos(np.radians(15) / 2)])  # pitched down 15 deg
    # true floor depth, then rendered 8% short (expected depth on a slanted floor)
    k = (rays @ c2w[:3, :3].T)[..., 1]
    z_true = np.where(k < -1e-4, -1.6 / np.where(k < -1e-4, k, -1.0), 0.0)
    z_render = np.where(z_true > 0, z_true * 0.92, 0.0).astype(np.float32)
    z, floor = people.room_depth(z_render, rays, c2w)
    pts = people.to_room(rays[floor], z[floor], c2w)
    assert floor[-1].all()
    assert np.abs(pts[:, 1]).max() < 1e-4


def test_person_scale_recovers_a_static_person_from_a_moving_camera():
    # a person standing at P; the camera walks round them; the depth network is 30% too far after frame 20
    P = np.array([0.0, -2.0])
    items = []
    for k in range(60):
        ang = np.radians(-40 + k * 1.5)
        C = P + 2.2 * np.array([np.sin(ang), np.cos(ang)])
        err = 1.0 if k < 20 else 1.3
        D = (P - C) * err
        contact = {"ratio": 1.0 / err, "height": 0.0} if k < 20 else None
        items.append((k, {"C": C.tolist(), "D": D.tolist(), "z": float(np.linalg.norm(P - C) * err), "contact": contact}))
    s = people.solve_person_scale(items)
    pos = np.array([np.array(r["C"]) + sk * np.array(r["D"]) for (_, r), sk in zip(items, s)])
    assert np.abs(pos - P).max() < 0.05
    assert abs(s[-1] - 1 / 1.3) < 0.03
