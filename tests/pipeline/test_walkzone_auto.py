"""Automatic walk zones (team/shivin.md Update 19, job 1): view scoring, the zone and its fence, the collider in the
viewer's format, the spawn, the comparison with a hand-made collider, and a synthetic room end to end on the CPU
point renderer. No GPU, no scene data."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
import splat_io as sio
import walkzone_auto as W


def sheet(a, b, c, step=0.05):
    """Splat centres filling the parallelogram a + s (b - a) + t (c - a)."""
    a, b, c = (np.asarray(v, float) for v in (a, b, c))
    n1 = max(2, int(np.linalg.norm(b - a) / step) + 1)
    n2 = max(2, int(np.linalg.norm(c - a) / step) + 1)
    s, t = np.meshgrid(np.linspace(0, 1, n1), np.linspace(0, 1, n2))
    return (a + s.reshape(-1, 1) * (b - a) + t.reshape(-1, 1) * (c - a))


def make_room(floaters=True, opening=True, seed=0):
    """A 4 x 3 m room, 2.5 m high: textured walls, floor and ceiling, a table, optionally a floater cloud at eye
    height and a missing wall piece that opens onto bare floor outside (z 1.5 .. 3)."""
    rng = np.random.default_rng(seed)
    parts = [sheet([-2, 0, -1.5], [2, 0, -1.5], [-2, 0, 1.5]),  # floor
             sheet([-2, 2.5, -1.5], [2, 2.5, -1.5], [-2, 2.5, 1.5]),  # ceiling
             sheet([-2, 0, -1.5], [2, 0, -1.5], [-2, 2.5, -1.5]),  # back wall z = -1.5
             sheet([-2, 0, -1.5], [-2, 0, 1.5], [-2, 2.5, -1.5]),  # x = -2
             sheet([2, 0, -1.5], [2, 0, 1.5], [2, 2.5, -1.5])]  # x = 2
    if opening:
        parts.append(sheet([-2, 0, 1.5], [0.5, 0, 1.5], [-2, 2.5, 1.5]))  # front wall, open for x > 0.5
        parts.append(sheet([0.5, 0, 1.5], [2, 0, 1.5], [0.5, 0, 3.0]))  # bare floor outside, nothing else
    else:
        parts.append(sheet([-2, 0, 1.5], [2, 0, 1.5], [-2, 2.5, 1.5]))
    table = np.concatenate([sheet([0.9, y, 0.2], [1.5, y, 0.2], [0.9, y, 0.8]) for y in np.arange(0.05, 0.85, 0.05)])
    parts.append(table)
    P = np.concatenate(parts)
    cols = rng.uniform(0.15, 0.85, (len(P), 3))
    opac = np.full(len(P), 0.95)
    if floaters:
        cloud = rng.normal([-1.25, 1.6, -0.75], 0.08, (120, 3))
        P = np.concatenate([P, cloud])
        cols = np.concatenate([cols, np.full((120, 3), 0.5)])
        opac = np.concatenate([opac, np.full(120, 0.6)])
    n = len(P)
    sh = (cols - 0.5) / 0.28209479177387814
    return sio.Splats(P, np.full((n, 3), 0.035), np.tile([1.0, 0, 0, 0], (n, 1)), opac, sh)


def renderer(splats):
    def render(c2w, fx, fy, cx, cy, w, h):
        r = sio.render_points(splats, c2w, fx, fy, cx, cy, w, h, max_radius=4)
        return np.asarray(r.rgb), np.asarray(r.alpha), np.asarray(r.depth)
    return render


def small():
    return W.Thresholds(width=64, height=40)


WORLD = {"bounds": {"min": [-2.0, 0.0, -1.5], "max": [2.0, 2.5, 3.0]}, "floorY": 0.0}


def cams():
    return [{"name": f"c{i}", "c2w": W.view_c2w(x, z, yaw)} for i, (x, z, yaw) in
            enumerate([(-1.0, 0.5, 0.0), (0.5, -0.5, 1.6), (-0.5, -0.5, 3.1)])]


# --- pure pieces -----------------------------------------------------------------------------------------------------

def test_view_c2w_matches_the_viewer_yaw():
    for yaw in (0.0, 0.7, -2.0):
        m = W.view_c2w(1.0, 2.0, yaw, pitch_deg=0.0)
        np.testing.assert_allclose(-m[:3, 2], [-math.sin(yaw), 0, -math.cos(yaw)], atol=1e-12)  # app.ts forward
        np.testing.assert_allclose(m[:3, 3], [1.0, W.EYE, 2.0])
    assert W.view_c2w(0, 0, 0.0, pitch_deg=-8)[1, 2] > 0  # looking slightly down


def test_score_view():
    t = W.Thresholds()
    rng = np.random.default_rng(0)
    rgb = rng.uniform(0, 255, (40, 64, 3))
    full, d = np.ones((40, 64)), np.full((40, 64), 3.0)
    good = W.score_view(rgb, full, d, W.lap_var(rgb), t)
    assert good["good"] and good["coverage"] == 1 and good["sharpness"] == 1
    holes = W.score_view(rgb, np.where(np.arange(64) < 40, 1.0, 0.0)[None].repeat(40, 0), d, None, t)
    assert not holes["good"] and holes["coverage"] < 0.9
    close = W.score_view(rgb, full, np.full((40, 64), 0.2), None, t)
    assert not close["good"] and close["near"] == 1
    blurry = W.score_view(np.full_like(rgb, 128) + rng.normal(0, 1, rgb.shape), full, d, W.lap_var(rgb), t)
    assert not blurry["good"] and blurry["sharpness"] < 0.35


def test_trace_loops_and_simplify():
    m = np.zeros((20, 20), bool)
    m[2:12, 3:15] = True
    m[5:8, 6:9] = False  # a hole
    loops = W.trace_loops(m, (0.0, 0.0), 0.1)
    areas = sorted(W.polygon_area(l) for l in loops)
    assert len(loops) == 2
    assert areas[0] == pytest.approx(-1.2) and areas[1] == pytest.approx(0.09)  # outer and hole wind oppositely
    stair = np.zeros((30, 30), bool)
    for i in range(30):
        stair[i, :i + 1] = True  # a staircase triangle
    raw = W.trace_loops(stair, (0.0, 0.0), 0.05)[0]
    simple = W.simplify(raw, 0.06)
    assert len(simple) < len(raw) / 5 and abs(W.polygon_area(simple)) == pytest.approx(abs(W.polygon_area(raw)), rel=0.08)
    # two cells touching only at a corner still trace as closed loops
    pinch = np.zeros((4, 4), bool)
    pinch[1, 1] = pinch[2, 2] = True
    assert sum(abs(W.polygon_area(l)) for l in W.trace_loops(pinch, (0, 0), 1.0)) == pytest.approx(2.0)


def test_room_to_file_inverts_the_scene_transform():
    world = {"transform": {"quaternion": [0, math.sin(0.3), 0, math.cos(0.3)], "position": [1, 2, 3], "scale": 2.0},
             "floorY": 0.4}
    R, t, s = sio.transform_parts(world["transform"])
    P = np.array([[0.5, 0.0, -1.0], [2.0, 1.0, 0.0]])
    F = W.room_to_file(P, world)
    np.testing.assert_allclose(s * F @ R.T + t - [0, 0.4, 0], P, atol=1e-12)


def test_collider_layout_matches_the_viewer_and_clear_path(tmp_path):
    zone = np.zeros((60, 80), bool)
    zone[10:50, 10:70] = True
    loops = [W.simplify(l, 0.04) for l in W.trace_loops(zone, (-2.0, -1.5))]
    solid = np.zeros((30, 40), bool)
    solid[14:16, 20:22] = True  # a 0.2 m post inside
    V, F, info = W.collider_mesh(loops, solid, (-2.0, -1.5), zone, (-2.0, -1.5), spawn=None)
    assert info["columns"] == 4 and info["fenceTriangles"] > 0
    assert V[:, 1].min() == 0 and V[:, 1].max() == W.FENCE_TOP > 2.6  # roof above clear-path's furniture tops
    tops = V[F].reshape(-1, 3, 3)
    flat = np.ptp(tops[:, :, 1], axis=1) < 1e-9
    assert set(np.round(tops[flat][:, 0, 1], 3)) == {0.0, W.COLUMN_TOP, W.FENCE_TOP}
    W.write_collider(tmp_path / "c.glb", V, F)
    V2, F2 = W.read_collider(tmp_path / "c.glb")
    np.testing.assert_allclose(V2, V.astype(np.float32))
    assert np.array_equal(F2, F)
    doc = json.loads((tmp_path / "c.glb").read_bytes()[20:20 + int.from_bytes((tmp_path / "c.glb").read_bytes()[12:16],
                                                                               "little")])
    assert len(doc["meshes"]) == 1 and doc["accessors"][1]["componentType"] == 5125  # what clear-path expects
    # the spawn keeps its clearance: no column within 0.45 m
    _, _, info2 = W.collider_mesh(loops, solid, (-2.0, -1.5), zone, (-2.0, -1.5), spawn=(0.05, 0.05))
    assert info2["columns"] == 0


def test_walkable_from_a_hand_collider_and_compare(tmp_path):
    zone = np.zeros((60, 80), bool)
    zone[10:50, 10:70] = True
    loops = W.trace_loops(zone, (-2.0, -1.5))
    V, F, _ = W.collider_mesh(loops, np.zeros((30, 40), bool), (-2.0, -1.5), zone, (-2.0, -1.5))
    reach, o = W.walkable_from_collider(V, F, (0.0, 0.0), np.array([-2.0, -1.5]), np.array([2.0, 1.5]))
    assert reach.sum() * W.MASK ** 2 == pytest.approx(3.0 * 2.0, rel=0.12)
    same = W.compare_masks(zone, (-2.0, -1.5), reach, o)
    assert same["iou"] > 0.85 and same["handCovered"] > 0.9
    open_v, _ = W.walkable_from_collider(V[:4], F[:2], (0.0, 0.0), np.array([-2.0, -1.5]), np.array([2.0, 1.5]))
    assert not open_v.any()  # a floor with no fence is not an enclosed zone


# --- end to end ------------------------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def room_run(tmp_path_factory):
    out = tmp_path_factory.mktemp("wz")
    splats = make_room()
    zone = np.zeros((120, 160), bool)
    zone[int(1.0 / W.MASK):int(3.5 / W.MASK), int(1.0 / W.MASK):int(4.0 / W.MASK)] = True  # x -1.75..1.25, z ..
    hand_loops = W.trace_loops(zone, (-2.75, -2.25))
    Vh, Fh, _ = W.collider_mesh(hand_loops, np.zeros((5, 5), bool), (0, 0), zone, (-2.75, -2.25))
    W.write_collider(out / "hand.glb", Vh, Fh)
    doc = W.build(splats, WORLD, cams(), out / "auto", small(), renderer(splats), hand_collider=out / "hand.glb",
                  hand_spawn=(0.0, 0.0), log=lambda *_: None)
    return doc, out


def test_room_end_to_end_zone(room_run):
    doc, out = room_run
    spots = {(s["x"], s["z"]): s for s in doc["spots"]}
    inside = [s for (x, z), s in spots.items() if -1.5 < x < 1.5 and -1.0 < z < 1.0 and not (0.7 < x < 1.7 and 0.0 < z < 1.0)]
    outside = [s for (x, z), s in spots.items() if z > 1.6]
    assert inside and sum(s["passed"] for s in inside) / len(inside) > 0.8
    assert outside and not any(s["passed"] for s in outside)  # bare floor beyond the opening: you'd see the void
    fence = np.vstack([np.array(l) for l in doc["fence"]])
    assert fence[:, 1].max() < 2.0 and fence[:, 1].min() > -1.6 and fence[:, 0].min() > -2.1
    assert 6.0 < doc["areaM2"] < 14.0
    rejected = {r["reason"] for r in doc["rejected"]}
    assert "solid within reach" in rejected  # the table and the walls


def test_room_end_to_end_floaters_spawn_collider_compare(room_run):
    doc, out = room_run
    # the floater cloud at (-1.25, 1.6, -0.75): no spot near it passes, whether its views or its mass rule it out
    near = [s for s in doc["spots"] + doc["rejected"] if math.hypot(s["x"] + 1.25, s["z"] + 0.75) < 0.36]
    assert near and not any(s.get("passed") for s in near)
    assert any("floaters" in s["reason"] or "good views" in s["reason"] or s["reason"] == "solid within reach"
               for s in near)
    sx, _, sz = doc["spawn"]["room"]
    assert -1.8 < sx < 1.8 and -1.3 < sz < 1.3 and doc["spawn"]["view"]["coverage"] > 0.9
    yaw = doc["spawn"]["yaw"]
    fwd = np.array([-math.sin(yaw), -math.cos(yaw)])
    assert not (sz > 0.5 and fwd[1] > 0.7 and sx > 0.5)  # not staring out of the opening
    V, F = W.read_collider(out / "auto" / "collider.glb")
    assert len(F) == doc["collider"]["triangles"] and doc["collider"]["columns"] > 0  # the table is solid
    assert (out / "auto" / "topdown.png").exists()
    hm = doc["handMade"]
    assert hm["iou"] > 0.5 and hm["handCovered"] > 0.7


def test_install_archives_and_sets_the_spawn(tmp_path, room_run):
    doc, out = room_run
    scene = tmp_path / "data" / "scenes" / "room"
    scene.mkdir(parents=True)
    (scene / "scene.json").write_text(json.dumps({"id": "room", "world": {"file": "world.spz", "floorY": 0.0}}))
    (scene / "collider.glb").write_bytes(b"old collider")
    res = W.install(scene, out / "auto", doc)
    s = json.loads((scene / "scene.json").read_text())
    assert s["world"]["collider"] == "collider.glb" and s["world"]["spawn"]["yaw"] == doc["spawn"]["yaw"]
    assert s["world"]["walkZone"]["auto"] is True
    assert (tmp_path / "data" / "archive" / "colliders").exists()
    assert open(res["archived"], "rb").read() == b"old collider"
    assert (scene / "collider.glb").read_bytes() == (out / "auto" / "collider.glb").read_bytes()
