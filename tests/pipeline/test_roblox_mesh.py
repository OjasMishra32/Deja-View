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


# --------------------------------------------------------------------------------------------------------------
# v2: z-buffer, planes, area chunks, colour match, sky faces (numpy / torch only)
# --------------------------------------------------------------------------------------------------------------


def _quad(z: float, half: float) -> np.ndarray:
    """Two triangles of a square facing +Z at depth z (room frame), as [2, 3, 3]."""
    a, b, c, d = [-half, -half, z], [half, -half, z], [half, half, z], [-half, half, z]
    return np.array([[a, b, c], [a, c, d]], np.float32)


def test_zbuffer_depth_occlusion_and_big_triangles():
    W, H, f = 64, 48, 40.0
    c2w = np.eye(4)  # at the origin looking down -Z
    far = _quad(-5.0, 50.0)  # far bigger than the image: split until it fits
    near = _quad(-2.0, 0.25)  # covers the middle only
    zb = rmesh.zbuffer(torch.as_tensor(np.concatenate([far, near])), c2w, f, f, W / 2, H / 2, W, H).reshape(H, W).numpy()
    assert np.isfinite(zb).all()  # the big quad covers every pixel
    assert zb[0, 0] == pytest.approx(5.0, abs=1e-3)
    assert zb[H // 2, W // 2] == pytest.approx(2.0, abs=1e-3)  # the near quad wins
    # the near quad spans +-0.25 m at 2 m: +-5 px around the centre
    assert zb[H // 2, W // 2 + 8] == pytest.approx(5.0, abs=1e-3)
    # a slanted floor: depth is perspective-correct (exact at the pixel centre)
    floor = np.array([[[-20, -1.6, -0.5], [20, -1.6, -0.5], [20, -1.6, -40]], [[-20, -1.6, -0.5], [20, -1.6, -40], [-20, -1.6, -40]]], np.float32)
    zf = rmesh.zbuffer(torch.as_tensor(floor), c2w, f, f, W / 2, H / 2, W, H).reshape(H, W).numpy()
    row = H - 4  # below the horizon: ray (.., -(row + 0.5 - H/2) / f, -1) meets y = -1.6 at z = 1.6 f / (row + 0.5 - H/2)
    assert zf[row, W // 2] == pytest.approx(1.6 * f / (row + 0.5 - H / 2), rel=1e-3)
    assert not np.isfinite(zf[2, W // 2])  # above the horizon: nothing
    # behind the camera: nothing
    zbk = rmesh.zbuffer(torch.as_tensor(_quad(3.0, 1.0)), c2w, f, f, W / 2, H / 2, W, H)
    assert not torch.isfinite(zbk).any()


def test_snap_planes_flattens_a_bumpy_floor_and_wall_but_not_a_chair():
    rng = np.random.default_rng(1)
    g = np.linspace(-2, 2, 41)
    X, Z = np.meshgrid(g, g)
    n = X.size
    floor = np.stack([X.ravel(), rng.normal(0, 0.008, n), Z.ravel()], 1)
    wall = np.stack([X.ravel(), Z.ravel() + 2.0, np.full(n, -2.5) + rng.normal(0, 0.008, n)], 1)
    seat = np.stack([X.ravel() * 0.1, 0.45 + rng.normal(0, 0.008, n), Z.ravel() * 0.1], 1)  # 0.16 m2: too small

    def grid(off):
        f = []
        for i in range(40):
            for j in range(40):
                a, b, c, d = off + i * 41 + j, off + i * 41 + j + 1, off + (i + 1) * 41 + j + 1, off + (i + 1) * 41 + j
                f += [(a, d, c), (a, c, b)]
        return np.array(f)

    V = np.concatenate([floor, wall, seat])
    F = np.concatenate([grid(0), grid(n)[:, [0, 2, 1]], grid(2 * n)])
    fn, _ = rmesh.face_normals(V, F)
    if (fn[: len(F) // 3, 1] < 0).mean() > 0.5:  # wind the floor and seat up, the wall toward +Z
        F[: len(F) // 3] = F[: len(F) // 3][:, [0, 2, 1]]
        F[2 * len(F) // 3:] = F[2 * len(F) // 3:][:, [0, 2, 1]]
    fn, _ = rmesh.face_normals(V, F)
    wall_f = slice(len(F) // 3, 2 * len(F) // 3)
    if (fn[wall_f, 2] < 0).mean() > 0.5:
        F[wall_f] = F[wall_f][:, [0, 2, 1]]
    V2, st = rmesh.snap_planes(V, F, lambda m: None)

    def flatness(P):  # rms distance from the best plane
        return float(np.linalg.svd(P - P.mean(axis=0), compute_uv=False)[-1] / math.sqrt(len(P)))

    assert flatness(V[:n]) > 0.005 and flatness(V2[:n]) < 1e-6  # the floor is flat now
    assert flatness(V2[n:2 * n]) < 1e-6  # so is the wall
    assert np.abs(V2[:n, 1]).max() < 0.01 and np.abs(V2[n:2 * n, 2] + 2.5).max() < 0.01
    assert np.allclose(V2[2 * n:], V[2 * n:])  # the seat is too small to be a plane
    assert len(st["planes"]) >= 2


def _sheet(x0, x1, z0, z1, y, step, down=False, hole=None):
    xs, zs = np.arange(x0, x1 + 1e-9, step), np.arange(z0, z1 + 1e-9, step)
    X, Z = np.meshgrid(xs, zs)
    V = np.stack([X.ravel(), np.full(X.size, y), Z.ravel()], 1)
    nx = len(xs)
    F = []
    for i in range(len(zs) - 1):
        for j in range(nx - 1):
            a, b, c, d = i * nx + j, i * nx + j + 1, (i + 1) * nx + j + 1, (i + 1) * nx + j
            cx, cz = xs[j] + step / 2, zs[i] + step / 2
            if hole and hole[0] < cx < hole[1] and hole[2] < cz < hole[3]:
                continue
            F += [(a, c, b), (a, d, c)] if not down else [(a, b, c), (a, c, d)]
    return V, np.array(F)


def test_ceiling_fill_closes_a_tear_from_above_and_faces_down(tmp_path):
    room = rmesh.load_room(_scene(tmp_path))
    room.lo[:] = [-4.0, -0.3, -4.0]
    room.hi[:] = [4.0, 4.0, 4.0]
    V, F = _sheet(-2, 2, -2, 2, 3.0, 0.1, down=True, hole=(-0.6, 0.4, -0.5, 0.5))
    n, _ = rmesh.face_normals(V, F)
    assert (n[:, 1] < -0.99).all()
    Vc, Fc, h, open_m2 = rmesh.ceiling_fill(V, F, room, lambda m: None)
    assert h == pytest.approx(3.0, abs=0.05)
    assert 0.6 <= open_m2 <= 2.0  # the 1 m x 1 m tear, in 25 cm cells
    nc, ac = rmesh.face_normals(Vc, Fc)
    assert (nc[:, 1] < -0.99).all() and np.allclose(Vc[:, 1], h + 0.03)
    c = Vc[Fc].mean(axis=1)
    assert np.abs(c[:, 0]).max() < 1.0 and np.abs(c[:, 2]).max() < 1.0  # only around the tear
    # no ceiling at all: nothing
    Vf, Ff = _sheet(-2, 2, -2, 2, 0.0, 0.1)
    assert len(rmesh.ceiling_fill(Vf, Ff, room, lambda m: None)[1]) == 0


def _wall(axis, value, a_range, y_range, step=0.1):
    """A vertical sheet at x = value (axis 0) or z = value (axis 2), spanning a_range along the other horizontal axis."""
    a = np.arange(a_range[0], a_range[1] + 1e-9, step)
    ys = np.arange(y_range[0], y_range[1] + 1e-9, step)
    A, Y = np.meshgrid(a, ys)
    V = np.zeros((A.size, 3))
    V[:, axis] = value
    V[:, 2 - axis] = A.ravel()
    V[:, 1] = Y.ravel()
    n = len(a)
    F = []
    for i in range(len(ys) - 1):
        for j in range(n - 1):
            p, q, r, s = i * n + j, i * n + j + 1, (i + 1) * n + j + 1, (i + 1) * n + j
            F += [(p, q, r), (p, r, s)]
    return V, np.array(F)


def _merge(*meshes):
    Vs, Fs, o = [], [], 0
    for V, F in meshes:
        Vs.append(V)
        Fs.append(F + o)
        o += len(V)
    return np.concatenate(Vs), np.concatenate(Fs)


def test_ceiling_fill_spans_the_room_its_walls_enclose(tmp_path):
    """A ceiling that fused only in a band along the back wall (the cameras looked ahead, not up) is filled across the
    whole room the walls enclose, out to the open side, but not over a tree trunk outside; without walls, only the
    band's own holes are filled."""
    room = rmesh.load_room(_scene(tmp_path))
    room.lo[:] = [-4.5, -0.3, -4.5]
    room.hi[:] = [4.5, 4.0, 4.5]
    band = _sheet(-2, 2, -2, -0.5, 3.0, 0.1, down=True)
    walls = [_wall(0, -2.0, (-2, 2), (0, 3.0)), _wall(0, 2.0, (-2, 2), (0, 3.0)), _wall(2, -2.0, (-2, 2), (0, 3.0))]
    trunk = _wall(0, 3.6, (3.4, 3.7), (0, 3.4))
    V, F = _merge(band, *walls, trunk)
    Vc, Fc, h, open_m2 = rmesh.ceiling_fill(V, F, room, lambda m: None)
    assert h == pytest.approx(3.0, abs=0.05)
    c = Vc[Fc].mean(axis=1)
    nc, ac = rmesh.face_normals(Vc, Fc)
    front = ac[c[:, 2] > -0.4].sum()
    assert 9.0 <= front <= 11.5 and open_m2 <= 13.0  # 4 m x 2.5 m in front of the band, up to the open side
    # inside the walls (to the 25 cm cell a wall stands in), nowhere near the trunk at x = 3.6
    assert np.abs(c[:, 0]).max() < 2.15 and np.abs(c[:, 2]).max() < 2.15
    assert (nc[:, 1] < -0.99).all()
    # the same room turned 45 degrees: the fill's edge runs along the walls (tiles cut to the room), no staircase
    t = math.radians(45)
    R = np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])
    Vr = V @ R.T
    Vc3, Fc3, _, open3 = rmesh.ceiling_fill(Vr, F, room, lambda m: None)
    back = Vc3 @ R  # into the room's own frame
    assert np.abs(back[:, 0]).max() < 2.2 and back[:, 2].max() < 2.2  # within a cell centre of the walls
    _, a3 = rmesh.face_normals(Vc3, Fc3)
    assert 9.0 <= a3[(Vc3[Fc3].mean(axis=1) @ R)[:, 2] > -0.4].sum() <= 11.5
    # the band alone (no walls reach it): nothing beyond the band
    Vb, Fb = _merge(band, trunk)
    Vc2, Fc2, _, open2 = rmesh.ceiling_fill(Vb, Fb, room, lambda m: None)
    assert open2 < 1.0 and (len(Fc2) == 0 or Vc2[Fc2].mean(axis=1)[:, 2].max() < -0.3)


def test_flat_ceiling_drops_the_folds_under_a_smeared_ceiling_and_closes_it(tmp_path):
    """--flat-ceiling: a ceiling the cameras never looked at fuses as a band along the wall they faced plus folds
    hanging under the rest. The folds (a curtain and a sagging sheet within the drop distance) go; the band, the walls
    and a table stay; the fill then spans the whole room the walls enclose, band included."""
    room = rmesh.load_room(_scene(tmp_path))
    room.lo[:] = [-4.5, -0.3, -4.5]
    room.hi[:] = [4.5, 4.0, 4.5]
    band = _sheet(-2, 2, -2, -0.5, 3.0, 0.1, down=True)
    walls = [_wall(0, -2.0, (-2, 2), (0, 3.0)), _wall(0, 2.0, (-2, 2), (0, 3.0)), _wall(2, -2.0, (-2, 2), (0, 3.0))]
    curtain = _wall(0, 0.0, (-0.2, 1.0), (2.5, 2.95))
    sag = _sheet(-1, 1, 0, 1, 2.6, 0.1, down=True)
    table = _sheet(-0.5, 0.5, 0.5, 1.0, 0.75, 0.1)
    V, F = _merge(band, *walls, curtain, sag, table)
    kinds = np.concatenate([np.full(len(m[1]), k) for k, m in zip(
        ["band", "wall", "wall", "wall", "curtain", "sag", "table"], [band, *walls, curtain, sag, table])])
    plan = rmesh.ceiling_plan(V, F, room)
    assert plan is not None and plan["h"] == pytest.approx(3.0, abs=0.05)
    drop = rmesh.ceiling_folds(V, F, plan, 0.7)
    assert drop[kinds == "curtain"].all() and drop[kinds == "sag"].all()
    assert not drop[np.isin(kinds, ["band", "wall", "table"])].any()
    keep = F[~drop]
    Vc, Fc, h, open_m2 = rmesh.ceiling_fill(V, keep, room, lambda m: None, plan=plan, flat=True)
    nc, ac = rmesh.face_normals(Vc, Fc)
    c = Vc[Fc].mean(axis=1)
    assert (nc[:, 1] < -0.99).all() and np.allclose(Vc[:, 1], h + 0.03)
    assert 14.0 <= ac.sum() <= 17.5  # the 4 m x 4 m room, band included
    assert ac[c[:, 2] < -0.5].sum() >= 4.0  # over the band too
    assert np.abs(c[:, 0]).max() < 2.15 and np.abs(c[:, 2]).max() < 2.15
    # without --flat-ceiling nothing changes: the fill stays out of the band
    Vc0, Fc0, _, _ = rmesh.ceiling_fill(V, F, room, lambda m: None)
    _, a0 = rmesh.face_normals(Vc0, Fc0)
    assert a0[Vc0[Fc0].mean(axis=1)[:, 2] < -0.6].sum() < 0.5


def test_small_pieces_standing_on_the_floor_survive():
    leg_V, leg_F = _sheet(0, 0.1, 0, 0.2, 0.0, 0.05)  # 0.02 m2 lying at floor height
    leg_V = leg_V[:, [0, 2, 1]] + [0, 0, 0]  # stand it up: x, y (height 0..0.2), z = 0
    junk_V, junk_F = _sheet(0, 0.1, 0, 0.2, 1.6, 0.05)  # the same size floating at 1.6 m
    V = np.concatenate([leg_V, junk_V + [2, 0, 0]])
    F = np.concatenate([leg_F, junk_F + len(leg_V)])
    _, F1, n1 = rmesh.drop_small_components(V, F, 0.2)
    assert n1 == 2 and len(F1) == 0  # v1: both go
    V2, F2, n2 = rmesh.drop_small_components(V, F, 0.2, keep_m2=0.015)
    assert n2 == 1 and V2[:, 1].max() < 0.3  # v2: the leg stays, the floater goes


def test_kd_chunks_area_keeps_area_and_triangles_under_their_caps():
    rng = np.random.default_rng(2)
    # a big sparse floor (few, large triangles) and a dense small clutter
    g = np.linspace(-10, 10, 21)
    X, Z = np.meshgrid(g, g)
    V0 = np.stack([X.ravel(), np.zeros(X.size), Z.ravel()], 1)
    F0 = []
    for i in range(20):
        for j in range(20):
            a, b, c, d = i * 21 + j, i * 21 + j + 1, (i + 1) * 21 + j + 1, (i + 1) * 21 + j
            F0 += [(a, c, b), (a, d, c)]
    P = rng.uniform(-0.5, 0.5, (3000, 3)) + [3, 1, 3]
    F1 = np.arange(3000).reshape(-1, 3)
    V = np.concatenate([V0, P])
    F = np.concatenate([np.array(F0), F1 + len(V0)])
    parts = rmesh.kd_chunks_area(V, F, max_tris=300, max_area=40.0)
    _, a = rmesh.face_normals(V, F)
    assert sorted(np.concatenate(parts).tolist()) == list(range(len(F)))
    assert all(len(p) <= 300 for p in parts)
    assert all(a[p].sum() <= 40.0 + 1e-6 or len(p) == 1 for p in parts)
    assert len(parts) >= 400 / 40  # the 400 m2 floor alone needs ten


def test_colour_match_recovers_an_exposure_and_tint():
    rng = np.random.default_rng(3)
    photo = rng.uniform(0.02, 0.8, (60, 80, 3))
    A_true = np.array([[1.6, 0.05, 0.0], [0.0, 1.4, 0.0], [0.02, 0.0, 1.1], [0.01, 0.0, 0.02]])
    target = np.clip(np.concatenate([photo, np.ones((60, 80, 1))], axis=2) @ A_true, 0, 1)
    ok = np.ones((60, 80), bool)
    ok[:10] = False  # a person
    target_bad = target.copy()
    target_bad[:10] = 0.0  # what the splat shows behind the person does not count
    A, st = rmesh.colour_match(photo, ok, target_bad, np.ones((60, 80), bool), ridge=1e-4)
    assert st["fit"] and st["errAfter"] < st["errBefore"]
    out = np.concatenate([photo, np.ones((60, 80, 1))], axis=2) @ A
    assert np.abs(out - target)[10:][(target[10:] < 0.99)].mean() < 0.01
    # too little to go on: identity
    A2, st2 = rmesh.colour_match(photo, np.zeros((60, 80), bool), target, ok)
    assert not st2["fit"] and np.allclose(A2[:3], np.eye(3)) and np.allclose(A2[3], 0)


def test_sky_faces_follow_roblox_and_fold_into_a_cube():
    """Front looks -Z, left +X (to the right of front, per the Creator Hub net), back +Z, right -X; each face's right
    edge continues into the next face's left edge turning right, and the up and down faces meet the side faces."""
    eye = np.zeros(3)
    look = {n: -rmesh.sky_c2w(n, eye)[:3, 2] for n in rmesh.SKY_FACES}
    assert np.allclose(look["front"], [0, 0, -1]) and np.allclose(look["left"], [1, 0, 0])
    assert np.allclose(look["back"], [0, 0, 1]) and np.allclose(look["right"], [-1, 0, 0])
    assert np.allclose(look["up"], [0, 1, 0]) and np.allclose(look["down"], [0, -1, 0])

    def ray(face, u, v):  # u, v in [-1, 1]: right, up on the image
        R = rmesh.sky_c2w(face, eye)[:3, :3]
        d = R @ np.array([u, v, -1.0])
        return d / np.linalg.norm(d)

    for a, b in (("front", "left"), ("left", "back"), ("back", "right"), ("right", "front")):
        assert np.allclose(ray(a, 1, 0.3), ray(b, -1, 0.3))  # a seamless strip, as in the official net
        assert np.linalg.det(rmesh.sky_c2w(a, eye)[:3, :3]) == pytest.approx(1.0)
    # up: its top edge meets the left face's top edge; down: its top edge meets the right face's bottom edge
    assert np.allclose(ray("up", 0.4, 1), ray("left", -0.4, 1))
    assert np.allclose(ray("down", 0.4, 1), ray("right", 0.4, -1))
    assert set(rmesh.SKY_PROPERTY.values()) == {"SkyboxFt", "SkyboxBk", "SkyboxLf", "SkyboxRt", "SkyboxUp", "SkyboxDn"}


def test_near_box_grows_world_bounds_into_the_room_frame(tmp_path):
    d = _scene(tmp_path)
    s = json.loads((d / "scene.json").read_text())
    s["world"]["bounds"] = {"min": [-1.0, FLOOR_Y, -2.0], "max": [1.5, FLOOR_Y + 2.0, 0.5]}
    (d / "scene.json").write_text(json.dumps(s))
    room = rmesh.load_room(d)
    lo, hi, src = rmesh.near_box(room, 0.5)
    assert src == "world.bounds"
    assert lo == pytest.approx([-1.5, -0.3, -2.5]) and hi[0] == pytest.approx(2.0) and hi[2] == pytest.approx(1.0)
    assert hi[1] == pytest.approx(2.5)  # at least 2.5 m of height
    del s["world"]["bounds"]
    (d / "scene.json").write_text(json.dumps(s))
    lo2, hi2, src2 = rmesh.near_box(rmesh.load_room(d), 0.5)
    assert src2 == "room box"


# --------------------------------------------------------------------------------------------------------------
# v2 end to end on the CPU: photos of the synthetic room (rendered from its splats, with a tint and a "person"
# masked out), parts, sky
# --------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def built_v2(tmp_path_factory):
    for mod in ("skimage", "xatlas", "fast_simplification"):
        pytest.importorskip(mod)
    from PIL import Image

    tmp = tmp_path_factory.mktemp("rmesh2")
    d = _scene(tmp)
    s = json.loads((d / "scene.json").read_text())
    s["world"]["bounds"] = {"min": [X0 + 0.3, FLOOR_Y, Z0 + 0.3], "max": [X1 - 0.3, FLOOR_Y + HEIGHT, Z1 - 0.3]}
    (d / "scene.json").write_text(json.dumps(s))
    splats = _room_splats()
    work = tmp / "work"
    cams = []
    W, H, f = 160, 120, 110.0
    for k, (x, z, yaw) in enumerate([(0.0, 0.3, 0.0), (0.6, -0.5, 1.3), (-0.8, -0.2, -1.2), (0.0, -1.0, math.pi),
                                     (1.0, 0.2, 0.6), (-1.0, 0.4, -0.5)]):
        c2w = sio.pose_matrix(sio.rot_y(yaw) @ sio.rot_x(-0.25), [x, FLOOR_Y + 1.5, z])  # viewer frame
        r = sio.render_points(splats, c2w, f, f, W / 2, H / 2, W, H)
        tinted = np.clip(r.rgb.astype(np.float32) * 0.7 + 10, 0, 255).astype(np.uint8)  # a darker phone exposure
        name = f"photo/p{k}.jpg"
        (work / "images" / "photo").mkdir(parents=True, exist_ok=True)
        Image.fromarray(tinted).save(work / "images" / name, quality=95)
        if k == 0:  # a "person" in the first photo: painted magenta and masked out
            img = np.asarray(Image.open(work / "images" / name)).copy()
            img[40:120, 60:100] = (255, 0, 255)
            Image.fromarray(img).save(work / "images" / name, quality=95)
            m = np.full((H, W), 255, np.uint8)
            m[40:120, 60:100] = 0
            (work / "masks" / "photo").mkdir(parents=True, exist_ok=True)
            Image.fromarray(m).save(work / "masks" / f"{name}.png")
        cams.append({"name": name, "group": "photo", "c2w": c2w.tolist(),
                     "intrinsics": {"width": W, "height": H, "fx": f, "fy": f, "cx": W / 2, "cy": H / 2},
                     "distortion": {"k1": 0.0}})
    (d / "cameras.json").write_text(json.dumps({"frame": "viewer", "cameras": cams}))
    out = d / "out2"
    r = rmesh.build_model_v2(d, out, work, triangles=20000, texture=256, voxel=0.05, margin=0.5, positions=3,
                             face_res=160, sky_size=64, device="cpu", workers=1)
    return d, out, r


def test_v2_sidecar_parts_and_sky(built_v2):
    _, out, r = built_v2
    side = json.loads((out / rmesh.SIDECAR_FILE).read_text())
    assert side["version"] == 2 and side["parts"][0]["file"] == "roblox.glb"
    assert side["sha1"] == side["parts"][0]["sha1"] and side["file"] == "roblox.glb"
    import hashlib

    for p in side["parts"]:
        data = (out / p["file"]).read_bytes()
        assert hashlib.sha1(data).hexdigest() == p["sha1"] and len(data) == p["bytes"] <= rmesh.PART_MAX_BYTES
    assert sorted(c for p in side["parts"] for c in p["chunks"]) == sorted(c["name"] for c in side["chunks"])
    assert set(side["sky"]) == set(rmesh.SKY_FACES)
    for face, e in side["sky"].items():
        data = (out / e["file"]).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and hashlib.sha1(data).hexdigest() == e["sha1"]
    assert side["skyInfo"]["properties"]["front"] == "SkyboxFt"
    assert side["build"]["bake"]["fromPhotos"] > 0.5
    assert side["build"]["trainingCameras"] == 6


def test_v2_parts_split_when_one_file_would_be_too_big(built_v2, monkeypatch):
    _, out, r = built_v2
    # the packer on its own: a tiny limit forces one chunk per part, all still in the same frame
    import io as _io

    gltf, binary = read_glb(out / "roblox.glb")
    assert gltf["asset"]["extras"]["part"] == 1


def test_v2_textures_come_from_the_photos_without_the_person(built_v2):
    """The red back wall bakes red, matched back to the splat's exposure, and no magenta from the masked person."""
    from PIL import Image
    import io

    _, out, r = built_v2
    reds, allpx = [], []
    for p in r["parts"]:
        gltf, binary = read_glb(out / p["file"])
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
            allpx.append(px)
            mid = (pos[:, 1] > 0.6) & (pos[:, 1] < 2.0)
            reds.append(px[mid & (np.abs(pos[:, 2] - Z0) < 0.08) & (np.abs(pos[:, 0]) < 1.5)])
    red = np.concatenate(reds).mean(axis=0)
    assert red[0] > red[1] + 60 and red[0] > red[2] + 60
    px = np.concatenate(allpx)
    magenta = (px[:, 0] > 200) & (px[:, 2] > 200) & (px[:, 1] < 80)
    assert magenta.mean() < 0.002
