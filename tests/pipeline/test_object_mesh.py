"""Object mesh crop and orbit geometry. The bake runs on PACE; these checks are pure."""
import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
from objects import mesh


def _splats(n=100):
    import splat_io as sio
    rng = np.random.default_rng(2)
    means = rng.uniform(-2, 2, (n, 3))
    return sio.Splats.from_rgb(means, rng.uniform(0.2, 1, (n, 3)), 0.02)


def test_crop_keeps_only_the_bounds_and_needs_enough_points():
    s = _splats(4000)
    lo, hi = np.array([-1.0, -1.0, -1.0]), np.array([1.0, 1.0, 1.0])
    got = mesh.crop_splats(s, lo, hi)
    assert len(got) > 0
    assert np.all(got.means >= lo) and np.all(got.means <= hi)
    with pytest.raises(ValueError):
        mesh.crop_splats(s, np.array([9, 9, 9]), np.array([9.1, 9.1, 9.1]))


def test_orbit_views_sit_on_the_sphere_and_look_at_the_centre():
    centre = np.array([0.0, 0.8, 0.0])
    views = mesh.orbit_views(centre, radius=2.0, count=6, size=256)
    assert len(views) == 6 * 3 + 1
    for v in views:
        pos = v.c2w[:3, 3]
        fwd = -v.c2w[:3, 2]
        target = centre - pos
        target /= np.linalg.norm(target)
        assert np.dot(fwd, target) > 0.999
        assert 1.9 <= np.linalg.norm(pos - centre) <= 2.1


def test_object_room_uses_the_crop_and_the_object_frame():
    s = _splats(50)
    lo, hi = np.array([-1.0, 0.0, -1.0]), np.array([1.0, 2.0, 1.0])
    room = mesh.object_room(s, {"id": "fridge"}, None, lo, hi, np.array([0.0, 1.0, 0.0]))
    assert len(room.splats) == len(s)
    assert room.floor_y == 0.0
    assert np.allclose(room.lo, lo) and np.allclose(room.hi, hi)
    assert room.transform["scale"] == 1
