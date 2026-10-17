"""pipeline/roblox_mesh.py: splat world -> textured Roblox model (.glb in studs + sidecar). The pieces run on numpy and
torch on the CPU; the end-to-end build uses a synthetic box room (floor, four walls, a table, a ceiling, a hole in
the floor) with the CPU point renderer and coarse settings. Needs scikit-image, xatlas and fast-simplification (the
HiPerGator flashworld environment has them); the tests that need them skip without them."""
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "pipeline") not in sys.path:
    sys.path.insert(0, str(ROOT / "pipeline"))

torch = pytest.importorskip("torch")
import roblox_mesh as rmesh  # noqa: E402
import splat_io as sio  # noqa: E402

SPM = rmesh.STUDS_PER_METER
FLOOR_Y = -1.4
HEIGHT = 2.6
X0, X1, Z0, Z1 = -2.0, 2.0, -3.0, 1.0
TABLE = (0.5, 1.2, -2.0, -1.3, 0.75)
HOLE = (-1.6, -0.9, -2.6, -1.9)  # a patch of floor the world has no splats for


def _plane(axis: int, value: float, a_range, b_range, step=0.03):
    a = np.arange(a_range[0], a_range[1] + 1e-9, step)
    b = np.arange(b_range[0], b_range[1] + 1e-9, step)
    A, B = np.meshgrid(a, b)
    pts = np.zeros((A.size, 3))
    free = [i for i in range(3) if i != axis]
    pts[:, axis] = value
    pts[:, free[0]] = A.ravel()
    pts[:, free[1]] = B.ravel()
    return pts


def _room_splats() -> sio.Splats:
    f = FLOOR_Y
    floor = _plane(1, f, (X0, X1), (Z0, Z1))
    hx0, hx1, hz0, hz1 = HOLE
    floor = floor[~((floor[:, 0] > hx0) & (floor[:, 0] < hx1) & (floor[:, 2] > hz0) & (floor[:, 2] < hz1))]
    groups = [
        (floor, (0.45, 0.35, 0.25), (0.025, 0.004, 0.025)),
        (_plane(1, f + HEIGHT, (X0, X1), (Z0, Z1)), (0.95, 0.95, 0.95), (0.025, 0.004, 0.025)),
        (_plane(2, Z0, (X0, X1), (f, f + HEIGHT)), (0.75, 0.15, 0.15), (0.025, 0.025, 0.004)),  # red back wall
        (_plane(2, Z1, (X0, X1), (f, f + HEIGHT)), (0.8, 0.8, 0.75), (0.025, 0.025, 0.004)),
        (_plane(0, X0, (f, f + HEIGHT), (Z0, Z1)), (0.8, 0.8, 0.75), (0.004, 0.025, 0.025)),
        (_plane(0, X1, (f, f + HEIGHT), (Z0, Z1)), (0.15, 0.25, 0.85), (0.004, 0.025, 0.025)),  # blue right wall
    ]
    tx0, tx1, tz0, tz1, th = TABLE
    top = _plane(1, f + th, (tx0, tx1), (tz0, tz1), 0.02)
    sides = np.concatenate([
        _plane(0, tx0, (f, f + th), (tz0, tz1), 0.02), _plane(0, tx1, (f, f + th), (tz0, tz1), 0.02),
        _plane(2, tz0, (tx0, tx1), (f, f + th), 0.02), _plane(2, tz1, (tx0, tx1), (f, f + th), 0.02),
    ])
    groups.append((np.concatenate([top, sides]), (0.1, 0.6, 0.2), (0.015, 0.015, 0.015)))
    means = np.concatenate([g[0] for g in groups])
    rgb = np.concatenate([np.broadcast_to(np.array(g[1], np.float32), (len(g[0]), 3)) for g in groups])
    scales = np.concatenate([np.broadcast_to(np.array(g[2], np.float32), (len(g[0]), 3)) for g in groups])
    return sio.Splats.from_rgb(means, rgb, scales, opacities=0.97)


def _scene(tmp: Path) -> Path:
    d = tmp / "scene-m"
    d.mkdir(parents=True, exist_ok=True)
    sio.write_splats(d / "world.ply", _room_splats())
    world = {"file": "world.ply", "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
             "floorY": FLOOR_Y, "source": "other"}
    scene = {"id": "scene-m", "name": "Mesh room", "mode": "rentfree", "status": "ready",
             "createdAt": "2026-10-17T00:00:00Z", "updatedAt": "2026-10-17T00:00:00Z", "world": world}
    (d / "scene.json").write_text(json.dumps(scene))
    return d


def read_glb(path: Path) -> tuple[dict, bytes]:
    b = path.read_bytes()
    magic, version, total = struct.unpack("<III", b[:12])
    assert magic == 0x46546C67 and version == 2 and total == len(b)
    jl, jt = struct.unpack("<II", b[12:20])
    assert jt == 0x4E4F534A and jl % 4 == 0
    gltf = json.loads(b[20:20 + jl])
    bl, bt = struct.unpack("<II", b[20 + jl:28 + jl])
    assert bt == 0x004E4942 and bl % 4 == 0
    return gltf, b[28 + jl:28 + jl + bl]


def accessor(gltf: dict, binary: bytes, i: int) -> np.ndarray:
    a = gltf["accessors"][i]
    bv = gltf["bufferViews"][a["bufferView"]]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a["componentType"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
    arr = np.frombuffer(binary, dt, a["count"] * n, bv["byteOffset"])
    return arr.reshape(-1, n) if n > 1 else arr


# --------------------------------------------------------------------------------------------------------------
# pieces (numpy / torch only)
# --------------------------------------------------------------------------------------------------------------


def test_depth_edges_ignore_a_grazing_floor_and_catch_a_step():
    # a floor 1.6 m below a camera looking at the horizon: depth grows fast toward the horizon, but it is a plane
    H = W = 64
    f = 32.0
    v = torch.arange(H, dtype=torch.float32)[:, None] + 0.5
    ray_down = (v - H / 2) / f
    d = torch.where(ray_down > 0.02, 1.6 / ray_down.clamp(min=1e-6), torch.zeros_like(ray_down)).expand(H, W).clone()
    d[d > 60] = 0  # beyond the far limit: no data
    e = rmesh.depth_edges(d)
    rows = (d[:, 0] > 0).nonzero().squeeze(1)
    inner = rows[6:-6]  # away from the rim next to empty pixels (the widest stencil is 4 pixels, then grown by 1)
    assert not bool(e[inner][:, 6:-6].any())
    # a box in front of a wall: its outline is an edge, its middle is not
    d2 = torch.full((H, W), 5.0)
    d2[20:44, 20:44] = 2.0
    e2 = rmesh.depth_edges(d2)
    assert bool(e2[20, 30]) and bool(e2[43, 30]) and bool(e2[30, 19])
    assert not bool(e2[32, 32]) and not bool(e2[5, 5])


def test_fill_holes_closes_a_hole_but_not_the_rim():
    n = 12
    xs, zs = np.meshgrid(np.arange(n), np.arange(n))
    V = np.stack([xs.ravel(), np.zeros(n * n), zs.ravel()], 1).astype(float)
    F = []
    for i in range(n - 1):
        for j in range(n - 1):
            if 4 <= i <= 6 and 4 <= j <= 6:
                continue  # a 3 x 3 hole
            a = j * n + i
            F += [[a, a + n, a + n + 1], [a, a + n + 1, a + 1]]
    F = np.array(F)
    V2, F2, k = rmesh.fill_holes(V, F)
    assert k == 1 and len(V2) == len(V) + 1 and len(F2) == len(F) + 12  # the hole's rim has 12 edges
    assert np.all(rmesh.face_normals(V2, F2)[0][:, 1] > 0)  # wound like the faces around it


def test_opposite_sides_keep_their_own_unit_normals():
    # a thin sheet collapsed onto its other side: two quads on the same four vertices, facing up and down
    V = np.array([[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0], [2, 0, 0], [2, 0, 1]], np.float64)
    up = np.array([[0, 1, 2], [0, 2, 3], [3, 2, 5], [3, 5, 4]])
    down = np.array([[0, 2, 1], [0, 3, 2]])
    F = np.concatenate([up, down])
    N = rmesh.vertex_normals(V, F)
    assert np.allclose(np.linalg.norm(N, axis=1), 1.0)  # cancelled vertices get a unit normal too
    V2, F2, k = rmesh.split_opposed(V, F)
    assert k == 4 and len(V2) == len(V) + 4
    N2 = rmesh.vertex_normals(V2, F2)
    assert np.allclose(np.linalg.norm(N2, axis=1), 1.0)
    fn, _ = rmesh.face_normals(V2, F2)
    for f in range(len(F2)):  # every corner's normal agrees with its own face
        assert np.all(N2[F2[f]] @ fn[f] > 0.9)
    assert np.array_equal(V2[F2], V[F])  # same triangles in the same places


def test_floor_fill_gets_an_underside():
    V = np.array([[0, -0.05, 0], [0, -0.05, 1], [1, -0.05, 1], [1, -0.05, 0]], np.float64)
    ch = rmesh.Chunk("floor_00", "floor", V, np.tile([0.0, 1.0, 0.0], (4, 1)),
                     np.array([[0, 0], [0, 1], [1, 1], [1, 0]], np.float32), np.array([[0, 1, 2], [0, 2, 3]]), 8)
    rmesh.add_underside(ch)
    assert len(ch.F) == 4 and len(ch.V) == len(ch.N) == len(ch.UV) == 8
    assert np.ptp(ch.V[:, 1]) == pytest.approx(rmesh.FLOOR_UNDERSIDE_M)
    fn, _ = rmesh.face_normals(ch.V, ch.F)
    assert np.all(fn[:2, 1] > 0.99) and np.all(fn[2:, 1] < -0.99)
    assert np.all(ch.N[4:, 1] < -0.99) and np.array_equal(ch.UV[4:], ch.UV[:4])


def test_kd_chunks_respect_the_limit_and_cover_every_face():
    rng = np.random.default_rng(0)
    V = rng.uniform(-10, 10, (30000, 3))
    F = rng.integers(0, len(V), (50000, 3))
    chunks = rmesh.kd_chunks(V, F, 18000)
    assert all(len(c) <= 18000 for c in chunks)
    allf = np.sort(np.concatenate(chunks))
    assert np.array_equal(allf, np.arange(len(F)))
    assert rmesh.CHUNK_TRIANGLES < rmesh.ROBLOX_MAX_TRIANGLES == 20000
    # a texel budget: at least this many chunks even when fewer would fit, about equal in size
    sixteen = rmesh.kd_chunks(V, F[:30000], 18000, 16)
    assert len(sixteen) == 16 and max(len(c) for c in sixteen) - min(len(c) for c in sixteen) <= 1000
    assert np.array_equal(np.sort(np.concatenate(sixteen)), np.arange(30000))


def test_glb_writer_round_trip(tmp_path):
    V = np.array([[0, 0, 0], [1, 0, 0], [1, 0, -1], [0, 0, -1]], np.float64)
    ch = rmesh.Chunk("room_00", "room", V, np.tile([0.0, 1.0, 0.0], (4, 1)),
                     np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32), np.array([[0, 1, 2], [0, 2, 3]]), 8,
                     image=np.full((8, 8, 3), 200, np.uint8))
    centre = np.array([0.5, 0.0, -0.5]) * SPM
    b = rmesh.glb_bytes([ch], [centre], {"sceneId": "x", "name": "X"})
    p = tmp_path / "m.glb"
    p.write_bytes(b)
    gltf, binary = read_glb(p)
    node = gltf["nodes"][0]
    assert node["name"] == "room_00" and node["translation"] == pytest.approx(list(centre))
    prim = gltf["meshes"][0]["primitives"][0]
    pos = accessor(gltf, binary, prim["attributes"]["POSITION"])
    # studs, relative to the node: adding the translation gives metres x 3.57
    assert np.allclose(pos + centre, V * SPM, atol=1e-5)
    assert gltf["accessors"][prim["attributes"]["POSITION"]]["min"] == pytest.approx(list(pos.min(axis=0)))
    idx = accessor(gltf, binary, prim["indices"])
    assert idx.dtype == np.uint16 and list(idx) == [0, 1, 2, 0, 2, 3]
    # counter-clockwise seen from above: the face normal points up (+Y)
    a, bb, c = (V[i] for i in idx[:3])
    assert np.cross(bb - a, c - a)[1] > 0
    img = gltf["images"][0]
    assert img["mimeType"] == "image/jpeg"
    jpg = binary[gltf["bufferViews"][img["bufferView"]]["byteOffset"]:][:4]
    assert jpg[:2] == b"\xff\xd8"
    assert gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] == {"index": 0}


# --------------------------------------------------------------------------------------------------------------
# end to end on the CPU
# --------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    for mod in ("skimage", "xatlas", "fast_simplification"):
        pytest.importorskip(mod)
    d = _scene(tmp_path_factory.mktemp("rmesh"))
    out = d / "out"
    r = rmesh.build_model(d, out, triangles=20000, texture=256, voxel=0.05, positions=3, face_res=160, workers=1,
                          device="cpu")
    return d, out, r


def test_sidecar_and_files(built):
    _, out, r = built
    assert (out / rmesh.GLB_FILE).is_file() and (out / rmesh.SIDECAR_FILE).is_file()
    side = json.loads((out / rmesh.SIDECAR_FILE).read_text())
    assert side == json.loads(json.dumps(r))
    assert side["units"] == "studs" and side["studsPerMeter"] == pytest.approx(3.57)
    assert side["sha1"] and side["bytes"] == (out / rmesh.GLB_FILE).stat().st_size
    names = [c["name"] for c in side["chunks"]]
    assert len(names) == len(set(names)) and any(n.startswith("room_") for n in names)
    assert all(c["triangles"] <= rmesh.CHUNK_TRIANGLES for c in side["chunks"])
    assert side["triangles"] == sum(c["triangles"] for c in side["chunks"])
    assert side["floorY"] == pytest.approx(FLOOR_Y)
    assert len(side["spawn"]) == 3 and side["spawn"][1] == 0.0


def test_glb_matches_the_sidecar_and_the_room_frame(built):
    _, out, r = built
    gltf, binary = read_glb(out / rmesh.GLB_FILE)
    by_name = {c["name"]: c for c in r["chunks"]}
    allpos = []
    for node in gltf["nodes"]:
        c = by_name[node["name"]]
        assert node["translation"] == pytest.approx(c["center"], abs=1e-3)
        prim = gltf["meshes"][node["mesh"]]["primitives"][0]
        pos = accessor(gltf, binary, prim["attributes"]["POSITION"]) + np.array(node["translation"])
        assert len(accessor(gltf, binary, prim["indices"])) // 3 == c["triangles"]
        normals = accessor(gltf, binary, prim["attributes"]["NORMAL"])
        assert np.allclose(np.linalg.norm(normals, axis=1), 1.0, atol=1e-4)  # glTF wants unit normals
        assert min(c["size"]) > 0  # every mesh has some thickness (Roblox sizes a MeshPart by it)
        if c["kind"] == "room":  # the floor fill may reach a little past the walls, under them
            allpos.append(pos)
    P = np.concatenate(allpos) / SPM  # back to room-frame metres
    room = P[P[:, 1] < 2.0]
    # the room frame: floor at y = 0, walls where the splats are (no flips, no offsets)
    assert np.percentile(P[:, 1], 1) == pytest.approx(0.0, abs=0.08)
    assert room[:, 0].min() == pytest.approx(X0, abs=0.12) and room[:, 0].max() == pytest.approx(X1, abs=0.12)
    assert room[:, 2].min() == pytest.approx(Z0, abs=0.12) and room[:, 2].max() == pytest.approx(Z1, abs=0.12)


def test_lid_is_its_own_chunk_and_the_hole_is_filled(built):
    _, _, r = built
    kinds = {c["kind"] for c in r["chunks"]}
    assert "ceiling" in kinds and r["hasCeiling"]
    assert r["ceilingY"] == pytest.approx(HEIGHT * SPM, abs=0.3 * SPM)
    assert "floor" in kinds and r["floorFillM2"] >= 0.25  # the 0.7 m x 0.7 m hole at least


def test_texture_colours_follow_the_walls(built):
    """The red back wall bakes red, the blue right wall blue (sampled through the atlas)."""
    from PIL import Image
    import io

    _, out, r = built
    gltf, binary = read_glb(out / rmesh.GLB_FILE)
    reds, blues = [], []
    for node in gltf["nodes"]:
        prim = gltf["meshes"][node["mesh"]]["primitives"][0]
        if "TEXCOORD_0" not in prim["attributes"]:
            continue
        pos = (accessor(gltf, binary, prim["attributes"]["POSITION"]) + np.array(node["translation"])) / SPM
        uv = accessor(gltf, binary, prim["attributes"]["TEXCOORD_0"])
        tex = gltf["textures"][gltf["materials"][prim["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
        bv = gltf["bufferViews"][gltf["images"][tex["source"]]["bufferView"]]
        img = np.asarray(Image.open(io.BytesIO(binary[bv["byteOffset"]:bv["byteOffset"] + bv["byteLength"]])).convert("RGB"))
        T = img.shape[0]
        px = img[np.clip((uv[:, 1] * T).astype(int), 0, T - 1), np.clip((uv[:, 0] * T).astype(int), 0, T - 1)].astype(float)
        mid = (pos[:, 1] > 0.6) & (pos[:, 1] < 2.0)
        reds.append(px[mid & (np.abs(pos[:, 2] - Z0) < 0.08) & (np.abs(pos[:, 0]) < 1.5)])
        blues.append(px[mid & (np.abs(pos[:, 0] - X1) < 0.08) & (pos[:, 2] > Z0 + 0.5) & (pos[:, 2] < Z1 - 0.5)])
    red = np.concatenate(reds).mean(axis=0)
    blue = np.concatenate(blues).mean(axis=0)
    assert red[0] > red[1] + 60 and red[0] > red[2] + 60
    assert blue[2] > blue[0] + 60 and blue[2] > blue[1] + 30
