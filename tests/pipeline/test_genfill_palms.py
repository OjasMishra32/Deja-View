"""genfill palms: trunk finding and crown building (numpy only)."""
import numpy as np

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
import splat_io as sio
from genfill import palms as P


def _trunk_cloud(x, z, r, top, rng, n=3000, colour=(0.78, 0.66, 0.52)):
    y = rng.uniform(0.0, top, n)
    a = rng.uniform(0, 2 * np.pi, n)
    pts = np.stack([x + r * np.cos(a), y, z + r * np.sin(a)], 1)
    return sio.Splats.from_rgb(pts, colour, 0.03, opacities=0.9)


def test_find_trunks_locates_columns_and_their_tops():
    rng = np.random.default_rng(0)
    parts = [_trunk_cloud(1.0, 2.0, 0.12, 4.2, rng), _trunk_cloud(-3.0, 0.5, 0.15, 5.0, rng)]
    floor = sio.Splats.from_rgb(np.c_[rng.uniform(-5, 5, 4000), np.zeros(4000), rng.uniform(-5, 5, 4000)], [0.6] * 3, 0.05)
    s = sio.concat_splats(parts + [floor])
    tr = sorted(P.find_trunks(s), key=lambda t: t.x)
    assert len(tr) == 2
    assert abs(tr[0].x + 3.0) < 0.1 and abs(tr[1].z - 2.0) < 0.1
    assert abs(tr[1].top - 4.2) <= 0.3 and abs(tr[0].top - 5.0) <= 0.3
    assert 0.08 <= tr[1].radius <= 0.2


def test_crown_is_a_palm_shaped_cloud_at_the_top():
    t = P.Trunk(0.0, 0.0, 0.12, 4.0)
    s, rep = P.palm_splats([t], crown_y=6.5, boots_from=5.0, seed=1)
    assert len(s) > 4000 and rep[0]["splats"]["crown"] > 3000
    m = s.means
    crown = m[m[:, 1] > 5.5]
    r = np.linalg.norm(crown[:, [0, 2]], axis=1)
    assert r.max() > 1.5 and r.max() < 3.5          # fronds spread out ~2 m
    assert crown[:, 1].max() < 9.5                  # not a tower
    assert (m[:, 1] > 4.0).mean() > 0.9             # everything added is above the cut-off trunk
    # needles: long and thin
    sc = np.sort(s.scales, 1)
    assert np.median(sc[:, 2] / sc[:, 1]) > 1.5
    # deterministic for a seed
    s2, _ = P.palm_splats([t], crown_y=6.5, boots_from=5.0, seed=1)
    np.testing.assert_allclose(s.means, s2.means)
