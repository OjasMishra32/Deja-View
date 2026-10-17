"""Plate room quality: depth steps never become curtains of splats, and the shell is a room in the
plate's own colours and brightness, not a dark box."""
import cv2
import numpy as np

from pipeline_helpers import PIPELINE  # noqa: F401  (puts pipeline/ on sys.path)
from common.camera import intrinsics_for
from common.splat_ply import quat_to_matrix, read_splat_ply
from plate_room import LUMA, build_plate_room, depth_steps, resolve_depth_steps

NEAR, WALL = 1.3, 2.7
WALL_RGB = np.array([0.52, 0.27, 0.18], np.float32)  # brick
OBJECT_RGB = np.array([0.92, 0.48, 0.10], np.float32)  # orange blender jar


def _object_in_front_of_wall(W=320, H=180, ramp=7):
    """A narrow object at NEAR standing up from the bottom of the frame in front of a wall at
    WALL, with the soft depth ramp a monocular network draws across the step."""
    K = intrinsics_for(W, H)
    obj = np.zeros((H, W), bool)
    obj[int(H * 0.3) :, int(W * 0.45) : int(W * 0.55)] = True
    inv = np.where(obj, 1.0 / NEAR, 1.0 / WALL).astype(np.float32)
    inv = cv2.blur(inv, (ramp, ramp))
    rng = np.random.default_rng(1)
    wall = np.clip(WALL_RGB + rng.normal(0, 0.03, (H, W, 3)), 0, 1)
    rgb = np.where(obj[..., None], OBJECT_RGB, wall).astype(np.float32)
    rgb = cv2.GaussianBlur(rgb, (0, 0), 0.8)  # anti-aliased colour edge
    return (rgb * 255).round().astype(np.uint8), (1.0 / inv).astype(np.float32), K, obj


def _project(xyz, K):
    z = -xyz[:, 2]
    u = xyz[:, 0] / np.maximum(z, 1e-6) * K["fx"] + K["cx"]
    v = -xyz[:, 1] / np.maximum(z, 1e-6) * K["fy"] + K["cy"]
    return u, v, z


def test_depth_steps_find_soft_ramps_but_not_slopes():
    yy, xx = np.mgrid[0:120, 0:160].astype(np.float32)
    slope = 0.25 + 0.012 * yy  # inverse depth of a counter top at a grazing angle: steep but planar
    assert not depth_steps(slope).any()
    step = np.where(xx < 80, 1.0 / NEAR, 1.0 / WALL).astype(np.float32)
    ramp = cv2.blur(step, (9, 9))  # a 9-pixel soft ramp
    found = depth_steps(ramp)
    assert found[10:-10, 72:88].any(axis=1).all()  # found on every row
    assert not found[:, :64].any() and not found[:, 96:].any()


def test_resolve_depth_steps_leaves_nothing_between_the_surfaces():
    rgb, depth, K, obj = _object_in_front_of_wall()
    res = resolve_depth_steps(1.0 / depth, rgb)
    d = 1.0 / res["inv"]
    assert res["ramp"].sum() > 100
    assert ((d > NEAR * 1.05) & (d < WALL / 1.05)).sum() == 0  # no pixel left on the ramp
    assert np.mean(np.abs(d[obj] - NEAR) < 0.05 * NEAR) > 0.99  # the object keeps its silhouette
    outside = ~(cv2.dilate(obj.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    assert np.mean(np.abs(d[outside] - WALL) < 0.05 * WALL) > 0.99
    # the wall's thin band next to the object takes the wall's colour, not a blend with the object
    far = res["far"]
    assert far.sum() > 50
    assert np.abs(res["colour"][far] - WALL_RGB).max(axis=1).mean() < 0.08


def test_plate_room_has_no_splats_stretched_across_a_step(tmp_path):
    rgb, depth, K, obj = _object_in_front_of_wall()
    res = build_plate_room(rgb, depth, K, tmp_path / "world.ply", max_splats=60_000, log=lambda m: None)
    assert res["levelQuaternion"] == [0.0, 0.0, 0.0, 1.0]
    r = read_splat_ply(tmp_path / "world.ply")
    xyz = r["xyz"]
    H, W = depth.shape
    u, v, z = _project(xyz, K)
    seen = (z > 0.1) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
    # nothing hangs between the object and the wall (the old soft column)
    between = seen & (z > NEAR * 1.08) & (z < WALL / 1.08)
    assert between.sum() == 0
    # and no splat lies along its view ray: its extent along the ray stays about a pixel
    R = quat_to_matrix(r["quat"][seen])
    ray = xyz[seen] / np.linalg.norm(xyz[seen], axis=1, keepdims=True)
    along = np.sqrt(((np.einsum("nij,ni->nj", R, ray) * r["sigma"][seen]) ** 2).sum(1))
    foot = np.linalg.norm(xyz[seen], axis=1) / K["fx"]
    assert (along / foot).max() < 3.0
    # behind the object the wall continues, in the wall's colour (what a step to the side shows)
    inner = cv2.erode(obj.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    ui, vi = np.clip(u.astype(int), 0, W - 1), np.clip(v.astype(int), 0, H - 1)
    behind = seen & inner[vi, ui] & (np.abs(z - WALL) < 0.15)
    assert behind.sum() > 0.5 * inner.sum() * (60_000 * 0.75 / (W * H))
    assert np.abs(r["rgb"][behind].mean(0) - WALL_RGB).max() < 0.08


def _kitchen(W=320, H=180):
    """A brick wall over a counter whose dark front is cut off by the bottom of the frame (the
    floor is not visible), with a light counter top between them."""
    K = intrinsics_for(W, H)
    rows = np.arange(H)[:, None].repeat(W, 1)
    depth = np.where(rows < 0.6 * H, WALL, 1.0).astype(np.float32)
    rng = np.random.default_rng(2)
    rgb = np.clip(WALL_RGB + rng.normal(0, 0.03, (H, W, 3)), 0, 1)
    rgb[rows >= 0.6 * H] = (0.78, 0.72, 0.62)  # counter top
    rgb[rows >= 0.68 * H] = (0.12, 0.11, 0.10)  # dark counter front
    return (rgb * 255).round().astype(np.uint8), depth, K


def test_plate_room_shell_has_the_plates_palette_and_brightness(tmp_path):
    rgb, depth, K = _kitchen()
    res = build_plate_room(rgb, depth, K, tmp_path / "world.ply", max_splats=60_000, log=lambda m: None)
    w = res["world"]
    r = read_splat_ply(tmp_path / "world.ply")
    xyz, col = r["xyz"], r["rgb"]
    lo, hi = np.array(w["bounds"]["min"]), np.array(w["bounds"]["max"])
    on = lambda axis, val: np.abs(xyz[:, axis] - val) < 0.005  # noqa: E731
    faces = {"floor": on(1, lo[1]), "ceiling": on(1, hi[1]), "left": on(0, lo[0]), "right": on(0, hi[0]), "back": on(2, lo[2]), "behind": on(2, hi[2])}
    plate_luma = float(((rgb.reshape(-1, 3) / 255.0) @ LUMA).mean())
    for name, m in faces.items():
        assert m.sum() > 100, name
        luma = float((col[m] @ LUMA).mean())
        # not a dark box: every face is about as bright as the plate (the floor a little darker)
        lo_ratio = 0.6 if name == "floor" else 0.75
        assert lo_ratio * plate_luma < luma < 1.3 * plate_luma, (name, luma, plate_luma)
        # and in the plate's palette: a warm brick plate gives warm walls, floor and ceiling
        mean = col[m].mean(0)
        assert mean[0] > mean[1] > mean[2], (name, mean)
    # gentle variation rather than one flat colour on the walls outside the camera's view
    side = (col[faces["left"]] @ LUMA)
    assert 0.01 < side.std() / side.mean() < 0.25


def test_plate_room_continues_cut_off_surfaces_down_to_the_floor(tmp_path):
    W, H = 320, 180
    K = intrinsics_for(W, H)
    counter = np.zeros((H, W), bool)
    counter[int(H * 0.7) :] = True  # a counter front at 1.0 m cut off by the bottom of the frame
    depth = np.where(counter, 1.0, WALL).astype(np.float32)
    rgb = np.where(counter[..., None], np.array([60, 55, 50]), np.array([130, 70, 50])).astype(np.uint8)
    res = build_plate_room(rgb, depth, K, tmp_path / "world.ply", max_splats=60_000, log=lambda m: None)
    floor_y = res["world"]["floorY"]
    assert floor_y == -1.25  # the floor is not visible: the default camera height
    r = read_splat_ply(tmp_path / "world.ply")
    xyz = r["xyz"]
    bottom_y = -(H - K["cy"]) / K["fy"] * 1.0  # the counter front's lowest visible point
    for dist, top in ((1.0, bottom_y), (WALL, -(H * 0.7 - K["cy"]) / K["fy"] * WALL)):
        below = (np.abs(-xyz[:, 2] - dist) < 0.03 * dist) & (xyz[:, 1] < top - 0.03) & (np.abs(xyz[:, 0]) < 0.3 * dist)
        ys = np.sort(xyz[below, 1])
        assert len(ys) > 50, dist
        assert ys[0] < floor_y + 0.05 and ys[-1] > top - 0.08, (dist, ys[0], ys[-1])
        assert np.diff(ys).max() < 0.05  # one continuous face down to the floor, nothing floats


def test_bilinear_sampling_takes_any_number_of_points():
    """cv2.remap refuses a map with a side of 32767 or more (OpenCV 5 asserts it): a 1 x N map broke every phone
    photo in the local fallback. The samples now go in as a grid, and match small remaps exactly."""
    from plate_room import _sample_bilinear

    rng = np.random.default_rng(3)
    img = rng.random((90, 160, 3)).astype(np.float32)
    n = 100_000
    u = (rng.random(n) * 170 - 5).astype(np.float32)
    v = (rng.random(n) * 100 - 5).astype(np.float32)
    out = _sample_bilinear(img, u, v)
    assert out.shape == (n, 3)
    ref = np.concatenate([
        cv2.remap(img, u[i:i + 4000].reshape(1, -1), v[i:i + 4000].reshape(1, -1), cv2.INTER_LINEAR,
                  borderMode=cv2.BORDER_REPLICATE).reshape(-1, 3)
        for i in range(0, n, 4000)
    ])
    assert np.abs(out - ref).max() < 1e-6
    one = _sample_bilinear(img[..., :1], u, v)
    assert one.shape == (n, 1)
    flat = _sample_bilinear(img[..., 0], u, v)
    assert flat.shape == (n,)
    assert _sample_bilinear(img, u[:0], v[:0]).shape == (0, 3)
