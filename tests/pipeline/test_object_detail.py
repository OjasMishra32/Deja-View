"""Object detail (team/shivin-object-detail.md): GLB I/O, the CPU mesh renderer, metrics, map baking, the flat-sign
path and the eval harness end to end on a synthetic scene. Pure numpy + Pillow; no GPU, no scene data."""
from __future__ import annotations

import json

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
from objects.detail import evaluate as ev
from objects.detail import flat, maps
from objects.detail import metrics as M
from objects.detail.glb import STUDS_PER_METER, Prim, glb_info, merged, read_glb, read_mesh, write_glb
from objects.detail.raster import Camera, look_at, orbit_cameras, project, render


def checker(size=256, cells=8, seed=0):
    rng = np.random.default_rng(seed)
    pal = rng.integers(30, 225, (cells, cells, 3))
    idx = (np.arange(size) * cells // size)
    return pal[idx[:, None], idx[None, :]].astype(np.uint8)


def cube(centre=(0.0, 0.5, 0.0), half=0.3, image=None, faces=6):
    """A box with one atlas cell per face (3 x 2 grid), outward-facing, split vertices per face."""
    c = np.asarray(centre, float)
    image = checker() if image is None else image
    dirs = [np.array(d, float) for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
    V, UV, N, F = [], [], [], []
    for k, n in enumerate(dirs[:faces]):
        a = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.5 else np.array([0.0, 0.0, 1.0])
        u = np.cross(a, n)
        v = np.cross(n, u)
        col, row = k % 3, k // 3
        b = len(V)
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            V.append(c + half * (n + su * u + sv * v))
            UV.append([(col + (su + 1) / 2 * 0.98 + 0.01) / 3, (row + (1 - sv) / 2 * 0.98 + 0.01) / 2])
            N.append(n)
        F += [[b, b + 1, b + 2], [b, b + 2, b + 3]]
    return Prim("cube", np.array(V), np.array(F), np.array(N), np.array(UV), image)


def cam_at(eye, target=(0.0, 0.5, 0.0), size=128, fov=50.0):
    f = (size / 2) / np.tan(np.deg2rad(fov) / 2)
    return Camera(look_at(eye, target), f, f, size / 2, size / 2, size, size, "t")


# --- GLB I/O ---------------------------------------------------------------------------------------------------

def test_glb_round_trip_keeps_geometry_texture_and_studs_layout(tmp_path):
    p = cube()
    data = write_glb([p], {"name": "cube"})
    back = read_glb(data)
    assert len(back) == 1
    q = back[0]
    np.testing.assert_allclose(q.V, p.V, atol=1e-5)
    np.testing.assert_array_equal(q.F, p.F)
    np.testing.assert_allclose(q.UV, p.UV, atol=1e-6)
    assert q.image.shape == p.image.shape
    assert np.abs(q.image.astype(int) - p.image.astype(int)).mean() < 6  # JPEG
    # positions are stored in studs relative to the node translation, as the room baker does
    js = json.loads(data[20:20 + int.from_bytes(data[12:16], "little")])
    t = np.array(js["nodes"][0]["translation"])
    np.testing.assert_allclose(t / STUDS_PER_METER, (p.V.min(0) + p.V.max(0)) / 2, atol=1e-3)
    assert glb_info(back) == {"chunks": 1, "triangles": 12, "vertices": 24, "textures": [[256, 256]]}


def test_obj_and_ply_readers(tmp_path):
    obj = tmp_path / "m.obj"
    obj.write_text("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1 2/2 3/3 4/4\n")
    o = read_mesh(obj)[0]
    assert o.F.tolist() == [[0, 1, 2], [0, 2, 3]]
    ply = tmp_path / "m.ply"
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    head = (b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n"
            b"property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n")
    ply.write_bytes(head + V.tobytes() + bytes([3]) + np.array([0, 1, 2], np.int32).tobytes())
    q = read_mesh(ply)[0]
    np.testing.assert_allclose(q.V, V)
    assert q.F.tolist() == [[0, 1, 2]]


# --- renderer --------------------------------------------------------------------------------------------------

def test_render_matches_projection_and_depth():
    p = cube(half=0.3)
    cam = cam_at((0.0, 0.5, 2.0))
    fr = render([p], cam)
    # the front face spans z = 0.3; its projected square is 2*f*0.3/1.7 px wide
    side = 2 * cam.fx * 0.3 / 1.7
    assert abs(fr.mask.sum() - side * side) / (side * side) < 0.06
    centre = fr.depth[64, 64]
    assert abs(centre - 1.7) < 1e-6
    # colour comes from the +z face's atlas cell (index 4: col 1, row 1)
    expect = p.image[int(0.75 * 256), int(0.5 * 256)] / 255.0
    assert np.abs(fr.rgb[64, 64] - expect).max() < 0.08
    np.testing.assert_allclose(fr.normal[64, 64], [0, 0, 1], atol=1e-6)


def test_render_z_buffer_keeps_the_nearer_surface():
    near = cube(centre=(0.0, 0.5, 0.5), half=0.1, image=np.full((8, 8, 3), 250, np.uint8))
    far = cube(centre=(0.0, 0.5, -0.5), half=0.4, image=np.full((8, 8, 3), 10, np.uint8))
    fr = render([far, near], cam_at((0.0, 0.5, 2.0)))
    assert fr.rgb[64, 64].mean() > 0.9 and abs(fr.depth[64, 64] - 1.4) < 1e-6
    assert fr.rgb[64, 10].mean() < 0.1  # the far box shows around the near one


def test_project_convention_matches_splat_io():
    cam = cam_at((0.0, 0.5, 2.0))
    u, v, z = project(np.array([[0.1, 0.6, 0.0]]), cam)
    assert u[0] > 64 and v[0] < 64 and abs(z[0] - 2.0) < 1e-9  # +x right, +y up (v decreases), z forward


def test_orbit_cameras_look_at_the_object():
    cams = orbit_cameras((0.0, 0.5, 0.0), 0.6, count=6, size=256)
    assert len(cams) == 7
    for c in cams:
        u, v, z = project(np.array([[0.0, 0.5, 0.0]]), c)
        assert abs(u[0] - 128) < 1e-6 and abs(v[0] - 128) < 1e-6 and z[0] > 0


# --- metrics ---------------------------------------------------------------------------------------------------

def test_image_metrics():
    rng = np.random.default_rng(1)
    img = rng.random((64, 64, 3))
    m = np.ones((64, 64), bool)
    assert M.psnr(img, img) == 99.0
    assert M.ssim(img, img, m) == pytest.approx(1.0)
    noisy = np.clip(img + rng.normal(0, 0.1, img.shape), 0, 1)
    assert 15 < M.psnr(img, noisy, m) < 25
    assert M.ssim(img, noisy) < 0.95
    blurred = M._gauss_filter(M.gray(img), 2.0)
    assert M.laplacian_variance(blurred) < 0.1 * M.laplacian_variance(img)
    a = np.zeros((10, 10), bool)
    a[:, :5] = True
    b = np.zeros((10, 10), bool)
    b[:, 2:7] = True
    assert M.iou(a, b) == pytest.approx(30 / 70)
    d1, d2 = np.full((10, 10), 2.0), np.full((10, 10), 2.1)
    assert M.depth_mae(d1, d2, a, b) == pytest.approx(0.1)
    assert M.depth_mae(d1, d2, a, ~a) is None


def test_mesh_stats_watertight_and_holes():
    closed = M.mesh_stats(*merged([cube()]))
    assert closed["watertight"] and closed["holes"] == 0 and closed["components"] == 1
    assert closed["triangles"] == 12 and closed["areaM2"] == pytest.approx(6 * 0.36, rel=1e-6)
    open_box = M.mesh_stats(*merged([cube(faces=5)]))
    assert not open_box["watertight"] and open_box["holes"] == 1 and open_box["boundaryEdges"] == 4
    two = M.mesh_stats(*merged([cube(), cube(centre=(2, 0.5, 0))]))
    assert two["components"] == 2


# --- maps ------------------------------------------------------------------------------------------------------

def test_bake_maps_writes_normal_ao_roughness_and_sidecar(tmp_path):
    box = cube()
    floor = Prim("floor", np.array([[-1, 0.2, -1], [1, 0.2, -1], [1, 0.2, 1], [-1, 0.2, 1]], float),
                 np.array([[0, 2, 1], [0, 3, 2]]), np.array([[0, 1, 0]] * 4, float),
                 np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float), np.full((64, 64, 3), 128, np.uint8))
    side = maps.bake_maps([box, floor], tmp_path, size=128, ao_directions=24)
    assert side["kind"] == "deja-view-detail-maps" and len(side["chunks"]) == 2
    for c in side["chunks"]:
        for kind in ("normal", "ao", "roughness", "color"):
            assert (tmp_path / c["maps"][kind]["file"]).exists()
    assert json.loads((tmp_path / "detail-maps.json").read_text())["chunks"][0]["maps"]["normal"]["sha1"]
    # the floor around the box is darker (occluded) than an isolated box face facing up
    from PIL import Image

    ao_floor = np.asarray(Image.open(tmp_path / side["chunks"][1]["maps"]["ao"]["file"])) / 255.0
    ao_box = np.asarray(Image.open(tmp_path / side["chunks"][0]["maps"]["ao"]["file"])) / 255.0
    face, _ = maps.uv_raster(box, 128)
    top = face == 4  # +y face is atlas cell 2: faces 4 and 5 are its triangles
    assert ao_box[top].mean() > 0.9
    near_box = ao_floor[60:68, 60:68].mean()  # under/next to the box centre
    assert near_box < ao_floor[2:6, 2:6].mean()


def test_normal_map_flat_albedo_is_straight_up():
    img = np.full((32, 32, 3), 120, np.uint8)
    n = maps.normal_map(img, np.ones((32, 32), bool))
    assert np.abs(n.astype(int) - [128, 128, 255]).max() <= 1


def test_roughness_is_glossier_on_bright_smooth_white():
    white = np.full((32, 32, 3), 240, np.uint8)
    wood = (checker(32, 16) * np.array([0.8, 0.5, 0.3])).astype(np.uint8)
    cov = np.ones((32, 32), bool)
    assert maps.roughness_map(white, cov).mean() < maps.roughness_map(wood, cov).mean()


# --- classes and the flat path ---------------------------------------------------------------------------------

def test_classify_and_params():
    assert flat.classify(np.array([0.9, 1.8, 0.7])) == "regular"
    assert flat.classify(np.array([0.3, 0.25, 0.2])) == "small"
    assert flat.classify(np.array([0.6, 0.9, 0.02])) == "flat"
    rng = np.random.default_rng(0)
    pts = np.c_[rng.uniform(-0.3, 0.3, 500), rng.uniform(0.8, 1.6, 500), rng.normal(0, 0.003, 500)]
    assert flat.classify(np.array([0.6, 0.8, 0.3]), points=pts) == "flat"  # a loose box, but the splats are a sheet
    big, small = flat.params_for(np.array([0.9, 1.8, 0.7]), "regular"), flat.params_for(np.array([0.3, 0.2, 0.2]),
                                                                                        "small")
    assert 0.005 <= big.voxel <= 0.01 and small.voxel < big.voxel and small.min_component < big.min_component
    assert big.size >= 1024 and big.texture == 2048 and big.room_chunks in (1, 2) and big.chunk_triangles <= 20000
    assert flat.params_for(np.array([0.6, 0.9, 0.02]), "flat").ink  # signs are inked for moderation


def test_principal_axes_finds_the_sheet_normal():
    rng = np.random.default_rng(2)
    R = np.linalg.qr(rng.normal(size=(3, 3)))[0]
    pts = np.c_[rng.uniform(-0.5, 0.5, 2000), rng.uniform(-0.3, 0.3, 2000), rng.normal(0, 0.002, 2000)] @ R.T
    c, axes, half = flat.principal_axes(pts + [1, 1, 1])
    np.testing.assert_allclose(c, [1, 1, 1], atol=0.03)
    assert abs(abs(axes[:, 2] @ R[:, 2]) - 1) < 1e-3 and half[0] > half[1] > half[2]


def test_rectify_recovers_the_poster_and_slab_shows_it_from_the_front():
    poster = checker(128, 4, seed=3)
    centre, right, up, normal = np.array([0.0, 1.2, -1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), \
        np.array([0, 0, 1.0])
    truth = Prim("p", np.array([centre + s * 0.4 * right + t * 0.3 * up for s, t in ((-1, -1), (1, -1), (1, 1),
                                                                                    (-1, 1))]),
                 np.array([[0, 1, 2], [0, 2, 3]]), None, np.array([[0, 1], [1, 1], [1, 0], [0, 0]], float), poster)
    cam = Camera(look_at(centre + [0.3, 0.1, 1.5], centre), 300, 300, 160, 120, 320, 240)
    shot = render([truth], cam)
    tex = flat.rectify(shot.rgb, cam.c2w, cam.fx, cam.fy, cam.cx, cam.cy, centre, right, up, 0.4, 0.3, 64, 48)
    small = np.asarray(__import__("PIL.Image", fromlist=["Image"]).fromarray(poster).resize((64, 48)), float)
    assert np.abs(tex.astype(float) - small)[6:-6, 6:-6].mean() < 25
    s = flat.slab(centre, right, up, normal, 0.4, 0.3, 0.02, poster)
    st = M.mesh_stats(s.V, s.F)
    assert st["triangles"] < 40 and st["watertight"]
    front = render([s], Camera(look_at(centre + [0, 0, 1.5], centre), 300, 300, 160, 120, 320, 240))
    assert front.mask.sum() > 0.8 * (2 * 300 * 0.4 / 1.49) * (2 * 300 * 0.3 / 1.49)
    np.testing.assert_allclose(front.normal[120, 160], normal, atol=1e-6)
    assert np.abs(front.rgb[120, 160] - poster[64, 64] / 255).max() < 0.1


def test_frontal_view_prefers_the_square_on_camera():
    c, n = np.zeros(3), np.array([0, 0, 1.0])
    cams = [{"c2w": look_at([2.0, 0, 0.3], c).tolist()}, {"c2w": look_at([0.1, 0, 2.0], c).tolist()},
            {"c2w": look_at([0, 0, -2.0], c).tolist()}]
    assert flat.frontal_view(n, c, cams) == 1


# --- eval harness end to end -----------------------------------------------------------------------------------

def make_scene(tmp_path, truth: Prim, cams: list[Camera]):
    """A scene with views.json, splat-like reference images + depth (rendered from `truth`) and objects.json."""
    from PIL import Image

    scene = tmp_path / "kitchen"
    views = scene / "views"
    views.mkdir(parents=True)
    out = []
    for i, cam in enumerate(cams):
        fr = render([truth], cam, background=0.3)
        Image.fromarray(np.clip(fr.rgb * 255, 0, 255).astype(np.uint8)).save(views / f"view_{i:02d}.png")
        np.save(views / f"view_{i:02d}_depth.npy", fr.depth.astype(np.float32))
        out.append({"file": f"view_{i:02d}.png", "depth": f"view_{i:02d}_depth.npy", "c2w": cam.c2w.tolist(),
                    "width": cam.width, "height": cam.height, "fx": cam.fx, "fy": cam.fy, "cx": cam.cx, "cy": cam.cy})
    (views / "views.json").write_text(json.dumps({"version": 1, "views": out}))
    lo, hi = truth.V.min(0), truth.V.max(0)
    S = STUDS_PER_METER
    (scene / "objects-all.json").write_text(json.dumps({"studsPerMeter": S, "objects": [
        {"id": "stove", "label": "stove", "center": ((lo + hi) / 2 * S).tolist(), "size": ((hi - lo) * S).tolist()}]}))
    return scene


def test_evaluate_scores_the_sharper_better_fitting_mesh_higher(tmp_path):
    from PIL import Image

    tex = checker(256, 16, seed=5)
    truth = cube(half=0.3, image=tex)
    cams = [cam_at((2.0 * np.sin(a), 0.9, 2.0 * np.cos(a)), size=160) for a in np.linspace(0, 2 * np.pi, 6,
                                                                                            endpoint=False)]
    scene = make_scene(tmp_path, truth, cams)
    blurry = np.asarray(Image.fromarray(tex).resize((32, 32)).resize((256, 256), Image.BILINEAR))
    for name, prim in (("objects", cube(half=0.33, image=blurry, faces=5)), ("objects-detail", cube(half=0.3,
                                                                                                    image=tex))):
        d = scene / name / "stove"
        d.mkdir(parents=True)
        (d / "roblox.glb").write_bytes(write_glb([prim], {"name": "stove"}))
    maps.bake_maps(read_glb(scene / "objects-detail" / "stove" / "roblox.glb"), scene / "objects-detail" / "stove",
                   size=128, ao_directions=8)
    alt = tmp_path / "sugar" / "stove"
    alt.mkdir(parents=True)
    V, F = truth.V, truth.F
    (alt / "mesh.obj").write_text("".join(f"v {x} {y} {z}\n" for x, y, z in V) +
                                  "".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in F))
    doc = ev.evaluate(scene, methods={"sugar": str(tmp_path / "sugar")}, log=lambda *_: None)
    rec = json.loads((scene / "detail-eval" / "stove" / "detail.json").read_text())
    cur, new = rec["meshes"]["current"], rec["meshes"]["new"]
    assert rec["references"]["views"] == 6
    assert new["iou"] > 0.97 and new["iou"] > cur["iou"]
    assert new["depthMAE"] < 0.005 < cur["depthMAE"]
    assert new["ssim"] > cur["ssim"] and new["psnr"] > cur["psnr"] and new["sharpness"] > cur["sharpness"]
    assert new["mesh"]["watertight"] and not cur["mesh"]["watertight"] and cur["mesh"]["holes"] == 1
    assert new["maps"] == {"color": True, "normal": True, "ao": True, "roughness": True}
    assert cur["maps"]["normal"] is False and new["texture"] == [[256, 256]]
    assert new["score"] > cur["score"] and rec["best"] == "new" and rec["card"]["delta"] > 0
    assert "sugar" in rec["meshes"] and rec["meshes"]["sugar"]["iou"] > 0.97  # geometry-only method still scored
    assert (scene / "detail-eval" / "stove" / "sheet.jpg").exists()
    assert (scene / "objects-detail" / "stove" / "detail.json").exists()  # the card reads it beside the GLB
    assert not (scene / "objects" / "stove" / "detail.json").exists()  # the current set is never written
    assert doc["objects"][0]["best"] == "new"


def test_evaluate_ignores_occluders_and_reports_missing_meshes(tmp_path):
    truth = cube(half=0.3)
    wall = cube(centre=(0.0, 0.5, 1.2), half=0.15, image=np.full((8, 8, 3), 200, np.uint8))
    cams = [cam_at((0.0, 0.6, 2.2), size=160), cam_at((2.2, 0.6, 0.0), size=160)]
    from PIL import Image

    scene = make_scene(tmp_path, truth, cams)
    # re-render view 0 with an occluder in front of the object, as furniture would be in the room views
    fr = render([truth, wall], cams[0], background=0.3)
    Image.fromarray(np.clip(fr.rgb * 255, 0, 255).astype(np.uint8)).save(scene / "views" / "view_00.png")
    np.save(scene / "views" / "view_00_depth.npy", fr.depth.astype(np.float32))
    d = scene / "objects-detail" / "stove"
    d.mkdir(parents=True)
    (d / "roblox.glb").write_bytes(write_glb([truth], {}))
    ev.evaluate(scene, log=lambda *_: None)
    rec = json.loads((scene / "detail-eval" / "stove" / "detail.json").read_text())
    assert rec["meshes"]["current"] == {"missing": True}
    assert min(v["iou"] for v in rec["meshes"]["new"]["views"]) > 0.97  # the occluded pixels are not counted
    assert rec["card"]["score"] is not None and rec["card"]["delta"] is None


# --- report, dataset export, source photos ---------------------------------------------------------------------

def test_report_table_and_markers(tmp_path):
    from objects.detail import report

    tex = checker(128, 8, seed=7)
    truth = cube(half=0.3, image=tex)
    cams = [cam_at((2.0 * np.sin(a), 0.9, 2.0 * np.cos(a)), size=96) for a in (0.0, 2.0, 4.0)]
    scene = make_scene(tmp_path, truth, cams)
    for name in ("objects", "objects-detail"):
        d = scene / name / "stove"
        d.mkdir(parents=True)
        (d / "roblox.glb").write_bytes(write_glb([cube(half=0.3 if name != "objects" else 0.4, image=tex)], {}))
    (scene / "objects-detail" / "stove" / "detail-model.json").write_text(json.dumps({"kind": "regular"}))
    ev.evaluate(scene, log=lambda *_: None)
    body = report.table(scene / "detail-eval")
    assert body.splitlines()[0].startswith("| Object | Kind | current score | new score")
    assert "| stove | regular |" in body
    doc = tmp_path / "r.md"
    doc.write_text(f"x\n{report.BEGIN}\nold\n{report.END}\ny\n")
    report.write_between(doc, body)
    text = doc.read_text()
    assert "old" not in text and "| stove |" in text and text.startswith("x\n") and text.endswith("y\n")


def test_dataset_transforms_and_points_ply(tmp_path):
    from objects.detail import export_dataset as ex

    cams = orbit_cameras((0, 0.5, 0), 0.5, count=3, size=64, elevations=(10.0,), top=False)
    t = ex.transforms(cams, ["a.png", "b.png", "c.png"])
    assert t["camera_angle_x"] == pytest.approx(np.deg2rad(50.0))
    assert len(t["frames"]) == 3 and t["frames"][1]["file_path"] == "./images/b"  # 3DGS appends .png
    np.testing.assert_allclose(t["frames"][0]["transform_matrix"], cams[0].c2w)
    xyz = np.random.default_rng(0).random((10, 3))
    ex.write_points_ply(tmp_path / "p.ply", xyz, np.full((10, 3), 200.0))
    q = read_mesh(tmp_path / "p.ply")[0]
    np.testing.assert_allclose(q.V, xyz, atol=1e-6)


def test_source_photo_sharpness_ratio():
    from objects.detail import source_photos as sp

    rng = np.random.default_rng(3)
    photo = rng.random((64, 64, 3))
    soft = np.stack([M._gauss_filter(photo[..., c], 1.5) for c in range(3)], axis=-1)
    rows = sp.sharpness_table([("a.jpg", photo, soft, None), ("b.jpg", photo, photo, None)])
    assert rows[0]["ratio"] > 5 and rows[1]["ratio"] == pytest.approx(1.0)


def test_ao_survives_a_mesh_with_flipped_winding():
    box = cube()
    inside_out = Prim("c", box.V, box.F[:, [0, 2, 1]], -box.N, box.UV, box.image)
    ao = maps.ambient_occlusion([inside_out], size=64, directions=12)[0]
    face, _ = maps.uv_raster(inside_out, 64)
    assert ao[face >= 0].mean() > 0.9  # a lone convex box is unoccluded
