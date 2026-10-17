"""Object lift: masks to splats to an object record. No GPU, no model, known answers."""
import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
import reality_split as rs
from objects import lift

W, H, F = 320, 240, 240.0


def _camera(shift=(0.0, 0.0, 0.0)):
    c2w = np.eye(4)
    c2w[:3, 3] = shift
    return rs.InputCamera(W, H, F, F, W / 2, H / 2, c2w, "test")


def _grid(x0, x1, y0, y1, z=-2.0, step=0.1):
    xs = np.arange(x0, x1 + 1e-9, step)
    ys = np.arange(y0, y1 + 1e-9, step)
    xx, yy = np.meshgrid(xs, ys)
    return np.stack([xx.ravel(), yy.ravel(), np.full(xx.size, z)], axis=1)


def _mask_rect(x0, x1, y0=0, y1=H):
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def test_sample_mask_uses_pixel_floor_and_rejects_outside():
    m = _mask_rect(160, 320)
    u = np.array([159.9, 160.0, 320.0, -0.1, np.nan])
    v = np.array([10.0, 10.0, 10.0, 10.0, 10.0])
    assert lift.sample_mask(m, u, v).tolist() == [False, True, False, False, False]


def test_mask_points_selects_only_the_masked_half_and_points_in_front():
    cam = _camera()
    pts = _grid(-1.0, 1.0, -0.5, 0.5)
    keep = lift.mask_points(pts, cam, _mask_rect(160, 320))
    assert keep.sum() > 0
    assert np.all(pts[keep, 0] > 0), "only the right half of the room is masked"
    behind = np.array([[0.5, 0.0, 2.0]])
    assert lift.mask_points(behind, cam, np.ones((H, W), bool)).tolist() == [False]


def test_merge_votes_needs_agreement():
    a = np.array([True, True, False, False])
    b = np.array([True, False, True, False])
    assert lift.merge_votes([a, b], 2).tolist() == [True, False, False, False]
    assert lift.merge_votes([a, b], 1).tolist() == [True, True, True, False]


def test_describe_object_builds_a_studs_record_with_a_median_colour():
    cam = _camera()
    pts = _grid(-0.6, 0.6, -0.4, 0.4, z=-2.0, step=0.05)
    colours = np.tile([0.95, 0.95, 0.92], (len(pts), 1))
    colours[::7] = [0.2, 0.2, 0.2]
    mask = np.ones((H, W), bool)
    obj = lift.describe_object(pts, colours, "Fridge", [(cam, mask)], min_views=1)
    assert obj is not None
    assert obj["id"] == "fridge"
    assert obj["label"] == "Fridge"
    assert obj["shape"] == "box"
    assert obj["source"]["splats"] == len(pts)
    assert obj["color"] == [242, 242, 235]
    assert obj["center"][2] == pytest.approx(-2.0 * lift.STUDS_PER_METER, abs=0.2)
    assert obj["size"][0] == pytest.approx(1.2 * lift.STUDS_PER_METER, abs=0.3)
    assert 0.0 <= obj["confidence"] <= 1.0


def test_describe_object_returns_none_when_too_few_splats():
    cam = _camera()
    pts = _grid(-1.0, 1.0, -0.5, 0.5)
    mask = np.zeros((H, W), bool)
    mask[0:2, 0:2] = True
    assert lift.describe_object(pts, np.ones_like(pts), "nothing", [(cam, mask)], min_views=1) is None


def test_two_views_must_agree():
    cam = _camera()
    pts = _grid(-1.0, 1.0, -0.5, 0.5)
    colours = np.ones_like(pts)
    right = _mask_rect(160, 320)
    top = _mask_rect(0, 320, 0, H // 2)
    both = lift.describe_object(pts, colours, "corner", [(cam, right), (cam, top)], min_views=2)
    assert both is not None
    keep = both["source"]["splats"]
    assert 0 < keep < len(pts)


def test_depth_band_keeps_the_surface_and_drops_the_wall_behind_it():
    cam = _camera()
    pts = np.array([[0.0, 0.0, -2.0], [0.0, 0.0, -4.0]])
    depth = np.full((H, W), 2.0)
    keep = lift.mask_points(pts, cam, np.ones((H, W), bool), depth=depth)
    assert keep.tolist() == [True, False]
