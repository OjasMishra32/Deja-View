"""pipeline/roblox_map.py: splat world -> Roblox boxes (studs). Uses a synthetic box room with a table, a red back
wall, a ceiling and a few floaters, so every rule can be checked exactly."""
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "pipeline") not in sys.path:
    sys.path.insert(0, str(ROOT / "pipeline"))

import roblox_map as rm  # noqa: E402
import splat_io as sio  # noqa: E402

SPM = rm.STUDS_PER_METER
FLOOR_Y = -1.4  # scene frame; the camera (headset spawn) is at the origin, 1.4 m above the floor
HEIGHT = 2.6
X0, X1, Z0, Z1 = -2.0, 2.0, -3.0, 1.0
TABLE = (0.5, 1.2, -2.0, -1.3, 0.75)  # x0, x1, z0, z1, top height above the floor
FLOATERS = [(-1.0, 1.7, -1.0), (0.0, 1.9, -0.5), (-0.5, 1.5, -2.0)]  # room frame


def _rm_plane(axis_fixed: int, value: float, a_range, b_range, step=0.025):
    a = np.arange(a_range[0], a_range[1] + 1e-9, step)
    b = np.arange(b_range[0], b_range[1] + 1e-9, step)
    A, B = np.meshgrid(a, b)
    pts = np.zeros((A.size, 3))
    free = [i for i in range(3) if i != axis_fixed]
    pts[:, axis_fixed] = value
    pts[:, free[0]] = A.ravel()
    pts[:, free[1]] = B.ravel()
    return pts


def _rm_room_splats(with_floaters=True) -> sio.Splats:
    f = FLOOR_Y
    groups = [
        (_rm_plane(1, f, (X0, X1), (Z0, Z1)), (0.45, 0.35, 0.25), (0.02, 0.003, 0.02)),  # floor (flat discs)
        (_rm_plane(1, f + HEIGHT, (X0, X1), (Z0, Z1)), (0.95, 0.95, 0.95), (0.02, 0.003, 0.02)),  # ceiling
        (_rm_plane(2, Z0, (X0, X1), (f, f + HEIGHT)), (0.75, 0.15, 0.15), (0.02, 0.02, 0.003)),  # back wall, red
        (_rm_plane(2, Z1, (X0, X1), (f, f + HEIGHT)), (0.8, 0.8, 0.75), (0.02, 0.02, 0.003)),  # front wall
        (_rm_plane(0, X0, (f, f + HEIGHT), (Z0, Z1)), (0.8, 0.8, 0.75), (0.003, 0.02, 0.02)),  # left wall
        (_rm_plane(0, X1, (f, f + HEIGHT), (Z0, Z1)), (0.8, 0.8, 0.75), (0.003, 0.02, 0.02)),  # right wall
    ]
    tx0, tx1, tz0, tz1, th = TABLE
    top = _rm_plane(1, f + th, (tx0, tx1), (tz0, tz1))
    sides = np.concatenate([
        _rm_plane(0, tx0, (f, f + th), (tz0, tz1)), _rm_plane(0, tx1, (f, f + th), (tz0, tz1)),
        _rm_plane(2, tz0, (tx0, tx1), (f, f + th)), _rm_plane(2, tz1, (tx0, tx1), (f, f + th)),
    ])
    groups.append((np.concatenate([top, sides]), (0.15, 0.25, 0.85), (0.015, 0.015, 0.015)))
    if with_floaters:
        fl = np.array([[x, y + f, z] for x, y, z in FLOATERS for _ in range(3)])
        groups.append((fl, (0.1, 0.9, 0.1), (0.01, 0.01, 0.01)))
    means = np.concatenate([g[0] for g in groups])
    rgb = np.concatenate([np.broadcast_to(np.array(g[1], np.float32), (len(g[0]), 3)) for g in groups])
    scales = np.concatenate([np.broadcast_to(np.array(g[2], np.float32), (len(g[0]), 3)) for g in groups])
    return sio.Splats.from_rgb(means, rgb, scales, opacities=0.95)


def _rm_scene(tmp_path: Path, fmt="ply", floor_y=None, camera=False, spawn=None, name="Test room") -> Path:
    d = tmp_path / "scene-x"
    d.mkdir(parents=True, exist_ok=True)
    s = _rm_room_splats()
    world_file = f"world.{fmt}"
    sio.write_splats(d / world_file, s)
    world = {"file": world_file, "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
             "floorY": floor_y, "source": "other"}
    if spawn is not None:
        world["spawn"] = spawn
    scene = {"id": "scene-x", "name": name, "mode": "rentfree", "status": "ready",
             "createdAt": "2026-10-17T00:00:00Z", "updatedAt": "2026-10-17T00:00:00Z", "world": world}
    (d / "scene.json").write_text(json.dumps(scene))
    if camera:
        (d / "input_camera.json").write_text(json.dumps({
            "width": 640, "height": 480, "fx": 420.0, "fy": 420.0, "cx": 320.0, "cy": 240.0,
            "position": [0.0, 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0]}))
    return d


@pytest.fixture(scope="module")
def rm_built(tmp_path_factory):
    d = _rm_scene(tmp_path_factory.mktemp("rmap"))
    return d, rm.build_map(d, 6000)


def _rm_parts(data):
    return np.array([p[:9] for p in data["parts"]], np.float64)


def test_header_and_units(rm_built):
    _, data = rm_built
    assert data["sceneId"] == "scene-x"
    assert data["name"] == "Test room"
    assert data["studsPerMeter"] == pytest.approx(3.57)
    assert len(data["parts"]) <= 6000
    assert all(len(p) == 9 for p in data["parts"])  # no camera: no imagined flag
    assert data["imagined"] is False


def test_floor_estimated_like_the_viewer(rm_built):
    _, data = rm_built
    assert data["floorY"] == pytest.approx(FLOOR_Y, abs=0.03)
    assert data["build"]["floorEstimated"] is True


def test_floor_slab_first_and_bottom_up(rm_built):
    _, data = rm_built
    P = _rm_parts(data)
    n_slab = data["build"]["slab"]
    assert n_slab >= 1
    slab = P[:n_slab]
    assert np.allclose(slab[:, 1], -0.5) and np.allclose(slab[:, 4], 1.0)  # top at y = 0, 1 stud thick
    # the slab pieces cover the room's footprint
    area = float(np.sum(slab[:, 3] * slab[:, 5]))
    assert area >= 0.95 * (X1 - X0) * (Z1 - Z0) * SPM * SPM
    bottoms = P[n_slab:, 1] - P[n_slab:, 4] / 2
    assert np.all(np.diff(bottoms) >= -1e-6)
    assert bottoms.min() >= -1e-6  # nothing but the slab under the floor


def test_ceiling_left_out(rm_built):
    _, data = rm_built
    P = _rm_parts(data)
    top = P[:, 1] + P[:, 4] / 2
    assert top.max() <= HEIGHT * SPM + 0.01
    high = top > 2.3 * SPM
    covered = float(np.sum(P[high, 3] * P[high, 5]))
    assert covered < 0.25 * (X1 - X0) * (Z1 - Z0) * SPM * SPM  # only wall tops, no lid
    assert data["ceilingY"] <= HEIGHT * SPM + 0.01


def test_floaters_dropped(rm_built):
    _, data = rm_built
    P = _rm_parts(data)
    for x, y, z in FLOATERS:
        c = np.array([x, y, z]) * SPM
        lo = P[:, :3] - P[:, 3:6] / 2 - 0.05
        hi = P[:, :3] + P[:, 3:6] / 2 + 0.05
        inside = np.all((c >= lo) & (c <= hi), axis=1)
        assert not inside.any(), f"floater at {x, y, z} became a part"


def test_table_and_wall_colours(rm_built):
    _, data = rm_built
    P = _rm_parts(data)
    tx0, tx1, tz0, tz1, th = TABLE
    c = np.array([(tx0 + tx1) / 2, th, (tz0 + tz1) / 2]) * SPM
    near = np.linalg.norm(P[:, :3] - c, axis=1) < 0.25 * SPM
    assert near.any()
    blue = P[near][:, 6:9].mean(axis=0)
    assert blue[2] > blue[0] + 60  # the table stays blue
    back = (P[:, 2] < (Z0 + 0.15) * SPM) & (P[:, 1] > 0.5 * SPM) & (np.abs(P[:, 0]) < 1.5 * SPM)
    area = P[back, 3] * P[back, 4]
    red = (P[back][:, 6:9] * area[:, None]).sum(axis=0) / area.sum()
    assert red[0] > red[1] + 80 and red[0] > red[2] + 80


def test_greedy_merge_saves_parts(rm_built):
    _, data = rm_built
    b = data["build"]
    assert b["boxes"] < b["voxels"] / 4  # flat walls merge into a few big boxes


def test_two_decimal_grid_is_exact(rm_built):
    _, data = rm_built
    for p in data["parts"][:2000]:
        for v in p[:6]:
            assert abs(v * 100 - round(v * 100)) < 1e-6
    assert data["voxel"] * 100 % 2 == pytest.approx(0, abs=1e-6)


def test_spawn_is_free_and_away_from_the_headset(rm_built):
    _, data = rm_built
    sx, sy, sz = data["spawn"]
    assert sy == 0
    d = math.hypot(sx, sz) / SPM
    assert 1.0 <= d <= 3.5
    assert X0 * SPM < sx < X1 * SPM and Z0 * SPM < sz < Z1 * SPM
    tx0, tx1, tz0, tz1, _ = TABLE
    assert not (tx0 * SPM - 1 < sx < tx1 * SPM + 1 and tz0 * SPM - 1 < sz < tz1 * SPM + 1)
    # spawnYaw faces the headset spawn: facing = (-sin yaw, -cos yaw)
    yaw = data["spawnYaw"]
    f = np.array([-math.sin(yaw), -math.cos(yaw)])
    to_h = np.array([-sx, -sz]) / max(math.hypot(sx, sz), 1e-9)
    assert float(f @ to_h) > 0.99


def test_budget_respected(tmp_path):
    d = _rm_scene(tmp_path)
    data = rm.build_map(d, 300)
    assert len(data["parts"]) <= 300
    assert data["build"]["maxParts"] == 300
    data = rm.build_map(d, 10)  # clamped to the minimum budget
    assert len(data["parts"]) <= rm.MIN_PARTS


def test_given_floor_and_spz(tmp_path):
    d = _rm_scene(tmp_path, fmt="spz", floor_y=FLOOR_Y, spawn={"position": [0.0, FLOOR_Y, 0.0], "yaw": 0.0})
    data = rm.build_map(d, 2000)
    assert data["floorY"] == pytest.approx(FLOOR_Y)
    assert data["build"]["floorEstimated"] is False
    assert len(data["parts"]) <= 2000


def test_imagined_flag_from_the_capture_camera(tmp_path):
    d = _rm_scene(tmp_path, camera=True)
    data = rm.build_map(d, 4000)
    assert data["imagined"] is True
    P = np.array(data["parts"], np.float64)
    assert P.shape[1] == 10
    back = (P[:, 2] < (Z0 + 0.2) * SPM) & (P[:, 1] > 0.3 * SPM) & (np.abs(P[:, 0]) < 1.0 * SPM)
    behind = P[:, 2] > (Z1 - 0.2) * SPM  # the wall behind the camera was never seen
    assert back.any() and behind.any()
    assert P[back, 9].mean() < 0.2
    assert P[behind, 9].mean() > 0.9


def test_colour_is_averaged_in_linear_light():
    lin = rm.srgb_to_linear(np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]])).mean(axis=0)
    assert rm.to_u8(lin).tolist() == [188, 188, 188]  # not 128: light adds up linearly
    assert rm.to_u8(rm.srgb_to_linear(np.array([0.5, 0.25, 1.0]))).tolist() == [128, 64, 255]


def test_viewer_floor_port_finds_the_lowest_strong_layer():
    rng = np.random.default_rng(1)
    ys = np.concatenate([rng.normal(-1.2, 0.01, 4000), rng.normal(-0.45, 0.01, 1500), rng.uniform(-1.2, 1.2, 3000)])
    y, conf = rm.viewer_floor(ys, below=-0.3)
    assert y == pytest.approx(-1.2, abs=0.03)
    assert conf > 0.2


def test_parts_bucket_clamp():
    assert rm.clamp_max_parts(None) == rm.DEFAULT_MAX_PARTS
    assert rm.clamp_max_parts(50) == rm.MIN_PARTS
    assert rm.clamp_max_parts(99999) == rm.MAX_PARTS_CAP


def test_cli_writes_json_with_key_and_preview(tmp_path):
    d = _rm_scene(tmp_path)
    out = tmp_path / "out" / "roblox-map.json"
    png = tmp_path / "preview.png"
    r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "roblox_map.py"), "--scene", str(d), "--out", str(out),
                        "--max-parts", "1500", "--key", "k123", "--preview", str(png), "--quiet"],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    line = json.loads(r.stdout.strip().splitlines()[-1])
    assert line["ok"] is True and line["parts"] <= 1500
    data = json.loads(out.read_text())
    assert data["build"]["key"] == "k123"
    assert png.stat().st_size > 1000
    head = out.read_bytes()[:400]
    assert b", " not in head and b": " not in head  # compact JSON


def test_cli_reports_a_scene_without_a_world(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    (d / "scene.json").write_text(json.dumps({"id": "empty", "name": "Empty", "status": "ready"}))
    r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "roblox_map.py"), "--scene", str(d), "--out",
                        str(tmp_path / "o.json"), "--quiet"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 2
    assert json.loads(r.stdout.strip().splitlines()[-1])["ok"] is False
    assert not (tmp_path / "o.json").exists()


def test_topdown_floor_plan_and_bake(tmp_path):
    """--topdown (the map bake, contracts 4.2 and 11): a JPEG from above with the ceiling cut off, covering exactly
    the box it reports, right = +X and down = +Z; plus floorY and the viewer's own robust bounds for scene.json."""
    from PIL import Image

    d = _rm_scene(tmp_path)  # floorY null: estimated
    jpg = tmp_path / "topdown.jpg"
    data = rm.build_map(d, 3000, topdown=jpg)
    bake = data["bake"]
    assert bake["floorY"] == pytest.approx(FLOOR_Y, abs=0.05)
    assert bake["floorEstimated"] is True and bake["boundsComputed"] is True
    b = bake["bounds"]
    # scene frame: y includes the floor; x and z inside the room
    assert b["min"][1] == pytest.approx(FLOOR_Y, abs=0.1)
    assert X0 - 0.05 <= b["min"][0] < -1.5 and 1.5 < b["max"][0] <= X1 + 0.05
    assert Z0 - 0.05 <= b["min"][2] < -2.5 and 0.5 < b["max"][2] <= Z1 + 0.05
    td = bake["topdown"]
    assert td["file"] == "topdown.jpg"
    im = Image.open(jpg)
    assert list(im.size) == td["px"] and max(im.size) <= 1024
    assert td["pxPerMeter"] == pytest.approx(100.0)
    w, h = im.size
    assert w / h == pytest.approx((td["max"][0] - td["min"][0]) / (td["max"][1] - td["min"][1]), rel=0.02)
    # the ceiling (white) is cut off: the table (blue) shows from above, at its place in the room
    px = np.asarray(im.convert("RGB"), np.float64)
    tx0, tx1, tz0, tz1, _ = TABLE
    u = int(((tx0 + tx1) / 2 - td["min"][0]) / (td["max"][0] - td["min"][0]) * w)
    v = int(((tz0 + tz1) / 2 - td["min"][1]) / (td["max"][1] - td["min"][1]) * h)
    r, g, bl = px[v, u]
    assert bl > r + 30 and bl > g, (r, g, bl)
    assert px.mean() < 200  # not a white ceiling
    # a scene with bounds keeps them (the topdown stays inside them)
    sc = json.loads((d / "scene.json").read_text())
    sc["world"]["bounds"] = {"min": [-1.0, FLOOR_Y, -2.0], "max": [1.0, FLOOR_Y + 2.6, 0.5]}
    (d / "scene.json").write_text(json.dumps(sc))
    data2 = rm.build_map(d, 3000, topdown=jpg)
    assert data2["bake"]["boundsComputed"] is False
    t2 = data2["bake"]["topdown"]
    assert t2["min"][0] >= -1.0 - 1e-6 and t2["max"][0] <= 1.0 + 1e-6 and t2["min"][1] >= -2.0 - 1e-6 and t2["max"][1] <= 0.5 + 1e-6
    # without --topdown nothing is baked
    assert "bake" not in rm.build_map(d, 3000)
