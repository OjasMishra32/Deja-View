"""CPU tests for pipeline/flashworld_run.py: trajectories, request JSON, conventions, post-processing, protocols.

The FlashWorld-convention test imports FlashWorld's own utils.py from FLASHWORLD_SRC (a checkout of the upstream
repo) and is skipped when that is not set."""
from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageFilter

import flashworld_run as fw
import splat_io as sio
from gpu_helpers import ROOT, SAMPLES

EVIDENCE = ROOT / "data" / "evidence" / "gpu"
BEDROOM = SAMPLES / "sample-painted-bedroom" / "world.spz"


def _yaws(poses):
    return [math.degrees(sio.yaw_of_forward(R @ [0, 0, -1])) % 360 for R, _ in poses]


# ---------------------------------------------------------------------------------------------------- trajectories


@pytest.mark.parametrize("name", fw.TRAJECTORIES)
def test_trajectory_shape(name):
    poses = fw.trajectory(name)
    assert len(poses) == 24
    R0, t0 = poses[0]
    np.testing.assert_allclose(R0, np.eye(3), atol=1e-12)
    np.testing.assert_allclose(t0, 0, atol=1e-12)
    for R, t in poses:
        np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-9)
        assert abs(np.linalg.det(R) - 1) < 1e-9
        assert np.all(np.isfinite(t))
    t_norm = max(np.linalg.norm(t) for _, t in poses)
    assert t_norm > 0.5, "FlashWorld collapses the scene when the cameras do not move"
    steps = [np.linalg.norm(poses[i + 1][1] - poses[i][1]) for i in range(23)]
    assert max(steps) < 0.45


@pytest.mark.parametrize("name", ["spin360", "orbit360"])
def test_360_presets_cover_every_direction(name):
    ys = sorted(_yaws(fw.trajectory(name)))
    gaps = np.diff(ys + [ys[0] + 360])
    assert gaps.max() < 50, f"largest yaw gap {gaps.max():.1f} deg"


def test_pan180_covers_front_half():
    ys = [((y + 180) % 360) - 180 for y in _yaws(fw.trajectory("pan180"))]
    assert min(ys) <= -85 and max(ys) >= 70


def test_unknown_trajectory():
    with pytest.raises(ValueError):
        fw.trajectory("loop-de-loop")


# ---------------------------------------------------------------------------------------------------- intrinsics and requests


def test_focal_px_defaults():
    assert fw.focal_px(4000, 3000, f35=26) == pytest.approx(26 * 5000 / math.hypot(36, 24))
    assert fw.focal_px(1000, 800, hfov_deg=90) == pytest.approx(500)
    wide = fw.focal_px(1920, 1080)
    assert math.degrees(2 * math.atan(960 / wide)) == pytest.approx(70)
    assert fw.focal_px(4000, 3000) == pytest.approx(26 * 5000 / math.hypot(36, 24))


def _photo(path: Path, w: int, h: int, f35: float | None = None) -> Path:
    rng = np.random.default_rng(0)
    arr = (rng.uniform(0, 255, size=(h // 8, w // 8, 3))).astype(np.uint8)
    im = Image.fromarray(arr).resize((w, h), Image.NEAREST)
    kw = {}
    if f35:
        ex = Image.Exif()
        ex.get_ifd(0x8769)[41989] = f35
        kw["exif"] = ex.tobytes()
    im.save(path, quality=90, **kw)
    return path


def test_request_for_landscape_photo(tmp_path):
    img = _photo(tmp_path / "room.jpg", 4000, 3000, f35=26)
    req, extra = fw.build_request(img, "", "spin360", embed_image=True)
    assert req["resolution"] == [24, 480, 704]
    assert req["image_index"] == 0 and len(req["cameras"]) == 24
    assert req["image_prompt"].startswith("data:image/png;base64,")
    meta = req["thirdwheel"]
    f = 26 * 5000 / math.hypot(36, 24)
    assert meta["original"]["fx"] == pytest.approx(f, rel=1e-4)
    assert meta["focal35mm"] == 26
    crop = meta["crop"]
    assert crop["w"] == 4000 and crop["h"] == round(4000 * 480 / 704) and crop["x"] == 0
    c0 = req["cameras"][0]
    assert c0["quaternion"] == [1.0, 0.0, 0.0, 0.0] and c0["position"] == [0.0, 0.0, 0.0]
    assert c0["fx"] == pytest.approx(f * 704 / 4000, rel=1e-4)
    assert c0["cx"] == pytest.approx(352, abs=0.5) and c0["cy"] == pytest.approx(240, abs=0.5)
    assert extra["image"].size == (704, 480)
    rows = fw.cameras_tensor_rows(req)
    assert rows.shape == (24, 11)
    np.testing.assert_allclose(rows[0, :7], [1, 0, 0, 0, 0, 0, 0])
    assert rows[0, 9] == pytest.approx(0.5, abs=1e-3) and rows[0, 10] == pytest.approx(0.5, abs=1e-3)


def test_request_for_portrait_photo_and_intrinsics_override(tmp_path):
    img = _photo(tmp_path / "tall.jpg", 1500, 2000)
    K = {"fx": 1400.0, "fy": 1400.0, "cx": 760.0, "cy": 990.0}
    req, extra = fw.build_request(img, "a kitchen", "pan180", intrinsics=K)
    assert req["resolution"] == [24, 704, 480]
    assert req["text_prompt"] == "a kitchen"
    meta = req["thirdwheel"]
    assert meta["original"]["fx"] == 1400.0 and meta["original"]["cx"] == 760.0
    s = 480 / meta["crop"]["w"]
    assert req["cameras"][5]["fx"] == pytest.approx(1400 * s, rel=1e-4)
    assert req["cameras"][5]["cx"] == pytest.approx((760 - meta["crop"]["x"]) * s, rel=1e-4)


def test_text_only_request():
    req, extra = fw.build_request(None, "a sunlit greenhouse", "forward")
    assert req["image_prompt"] is None and extra["image"] is None
    assert req["resolution"] == [24, 480, 704]
    assert req["cameras"][0]["fy"] == pytest.approx(0.5 * 480 / math.tan(math.radians(30)), rel=1e-4)
    assert req["thirdwheel"]["hasImage"] is False


def _flashworld_utils():
    src = os.environ.get("FLASHWORLD_SRC")
    if not src or not (Path(src) / "utils.py").exists():
        pytest.skip("set FLASHWORLD_SRC to a FlashWorld checkout to check the camera conventions")
    torch = pytest.importorskip("torch")
    pytest.importorskip("plyfile")
    spec = importlib.util.spec_from_file_location("flashworld_utils_under_test", Path(src) / "utils.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, torch


@pytest.mark.parametrize("name", fw.TRAJECTORIES)
def test_request_matches_flashworld_camera_conventions(name):
    """Runs FlashWorld's own normalize_cameras/create_rays on our request."""
    U, torch = _flashworld_utils()
    req, _ = fw.build_request(None, "x", name)
    cams = torch.from_numpy(fw.cameras_tensor_rows(req))[None]
    norm, ref_w2c, t_norm = U.normalize_cameras(cams, return_meta=True)
    ours = fw.request_poses(req)
    k = float(t_norm.reshape(-1)[0]) + 0.01
    assert float(t_norm.reshape(-1)[0]) == pytest.approx(max(np.linalg.norm(p[:3, 3]) for p in ours), rel=1e-5)
    # View 0 is the identity, so FlashWorld's output frame is our input camera's frame.
    np.testing.assert_allclose(norm[0, 0, :7].numpy(), [1, 0, 0, 0, 0, 0, 0], atol=1e-5)
    for i in range(24):
        R_fw = U.quaternion_to_matrix(norm[0, i, :4]).numpy()
        np.testing.assert_allclose(R_fw, ours[i][:3, :3], atol=1e-4)
        np.testing.assert_allclose(norm[0, i, 4:7].numpy() * k, ours[i][:3, 3], atol=1e-4)
    # Rays: the centre ray of each view points along that view's -Z, i.e. the OpenGL convention.
    _, H, W = req["resolution"]
    _, rays_d = U.create_rays(norm[0], H // 16, W // 16)
    for i in (0, 4, 8, 12, 20):
        centre = rays_d[i, H // 32, W // 32].numpy()
        fwd = ours[i][:3, :3] @ [0, 0, -1]
        assert float(np.dot(centre, fwd)) > 0.99


# ---------------------------------------------------------------------------------------------------- post-processing


def _bedroom_in_flashworld_frame(max_n: int = 300_000) -> sio.Splats:
    s = sio.read_spz(BEDROOM)
    s = s.subset(np.arange(0, len(s), max(1, len(s) // max_n)))
    return sio.transform_splats(s, np.diag([1.0, -1.0, -1.0]))  # Marble is OpenCV; FlashWorld output is OpenGL


needs_bedroom = pytest.mark.skipif(not BEDROOM.exists(), reason="sample worlds not fetched (bun run samples)")


@needs_bedroom
def test_finish_world_writes_the_contract(tmp_path):
    photo = _photo(tmp_path / "photo.jpg", 1280, 800)
    req, extra = fw.build_request(photo, "a bedroom", "spin360")
    splats = _bedroom_in_flashworld_frame()
    out = tmp_path / "out"
    res = fw.finish_world(splats, req, out, extra["original_image"], None, camera_height=1.45, max_splats=200_000, prefer_gpu=False)
    for f in ("world.spz", "thumb.jpg", "scene.json", "input_camera.json", "input_depth.npy", "flashworld.json"):
        assert (out / f).exists(), f
    scene = json.loads((out / "scene.json").read_text())
    assert scene == res
    w = scene["world"]
    assert w["file"] == "world.spz" and w["source"] == "flashworld" and w["splatCount"] == 200_000
    assert w["floorY"] == 0.0
    assert set(w["transform"]) == {"position", "quaternion", "scale"}
    assert len(w["transform"]["quaternion"]) == 4 and len(w["transform"]["position"]) == 3
    assert w["spawn"]["position"] == [0.0, 0.0, 0.0] and abs(w["spawn"]["yaw"]) < 0.05
    assert w["transform"]["scale"] == pytest.approx(1.45 / 1.121, rel=0.03)
    assert scene["thumb"] == "thumb.jpg" and isinstance(scene["caption"], str)
    # The gallery shows the caption as is: product copy, no model names.
    assert scene["caption"] in ("Generated from one photo: the rest of the room was imagined.", "Generated from your prompt.")
    # The floor lands at y = 0 in the viewer frame.
    world = sio.apply_transform(sio.read_spz(out / "world.spz").means, w["transform"])
    ys = world[:, 1]
    hist, edges = np.histogram(ys[(ys > -0.5) & (ys < 0.5)], bins=50)
    assert abs(0.5 * (edges[np.argmax(hist)] + edges[np.argmax(hist) + 1])) < 0.05
    cam = json.loads((out / "input_camera.json").read_text())
    assert cam["width"] == 1280 and cam["height"] == 800
    assert cam["position"][1] == pytest.approx(1.45, abs=1e-4)
    assert cam["depthWidth"] == 1024 and cam["depthHeight"] == 640
    d = np.load(out / "input_depth.npy")
    assert d.shape == (640, 1024) and d.dtype == np.float32
    assert np.mean(d > 0) > 0.9 and 0.5 < np.median(d[d > 0]) < 8
    diag = json.loads((out / "flashworld.json").read_text())
    assert diag["placement"]["floor"]["found"] is True
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    shutil.copy(out / "thumb.jpg", EVIDENCE / "finish_world_thumb.jpg")
    # Depth as an image for eyeballing.
    v = np.where(d > 0, 1.0 / np.maximum(d, 1e-3), 0)
    sio.save_jpeg(EVIDENCE / "finish_world_input_depth.jpg", (np.repeat((v / v.max() * 255)[..., None], 3, 2)).astype(np.uint8))


@needs_bedroom
def test_emit_request_and_postprocess_space_output(tmp_path):
    # A "photo" of the bedroom (a CPU render), the request for the Space, and a fake Space SPZ in T_norm units.
    base = _bedroom_in_flashworld_frame(200_000)
    r = sio.render_points(base, np.eye(4), 500, 500, 400, 250, 800, 500)
    photo = tmp_path / "photo.png"
    Image.fromarray(r.rgb).save(photo)
    req_path = tmp_path / "request.json"
    assert fw.main(["--image", str(photo), "--hfov", str(math.degrees(2 * math.atan(400 / 500))), "--emit-request", str(req_path)]) == 0
    req = json.loads(req_path.read_text())
    assert req["text_prompt"] == fw.NEUTRAL_CAPTION
    assert req["image_prompt"].startswith("data:image/png;base64,")
    t_norm = max(np.linalg.norm(p[:3, 3]) for p in fw.request_poses(req))
    space = sio.Splats(base.means * (t_norm / (t_norm + 0.01)), base.scales * (t_norm / (t_norm + 0.01)), base.quats,
                       base.opacities, base.sh_dc, base.sh_rest)
    sio.write_spz(tmp_path / "space.spz", space)
    out = tmp_path / "out"
    assert fw.main(["--from-spz", str(tmp_path / "space.spz"), "--request", str(req_path), "--out", str(out),
                    "--max-splats", "150000", "--progress", str(tmp_path / "p.json")]) == 0
    scene = json.loads((out / "scene.json").read_text())
    assert scene["world"]["floorY"] == 0.0
    assert scene["world"]["transform"]["scale"] == pytest.approx(1.45 / 1.121, rel=0.03)
    assert json.loads((tmp_path / "p.json").read_text())["done"] is True
    cam = json.loads((out / "input_camera.json").read_text())
    assert (cam["width"], cam["height"]) == (800, 500)
    assert cam["fx"] == pytest.approx(500, rel=1e-3)


def test_from_spz_requires_request(tmp_path):
    with pytest.raises(SystemExit):
        fw.main(["--from-spz", str(tmp_path / "x.spz"), "--out", str(tmp_path / "o")])


# ---------------------------------------------------------------------------------------------------- entry points and protocols


def test_generate_needs_input(tmp_path):
    with pytest.raises(ValueError):
        fw.generate(None, "  ", tmp_path)


def test_params_mapping():
    kw = fw._kw_from_params({"trajectory": "orbit360", "seed": 3, "cameraHeight": 1.1, "maxSplats": 5, "sceneId": "x",
                             "intrinsics": {"fx": 1, "fy": 1, "cx": 0, "cy": 0}})
    assert kw == {"trajectory_name": "orbit360", "seed": 3, "camera_height": 1.1, "max_splats": 5,
                  "intrinsics": {"fx": 1, "fy": 1, "cx": 0, "cy": 0}}
    assert "trajectory_name" not in fw._kw_from_params({"trajectory": "nope"})
    cli = fw._cli_from_params({"cameraHeight": 1.1, "trajectory": "pan180"})
    assert cli == ["--camera-height", "1.1", "--trajectory", "pan180"]


def test_generate_room_without_any_gpu(tmp_path, monkeypatch):
    monkeypatch.delenv("TW_FW_REQUESTS", raising=False)
    monkeypatch.delenv("TW_PY_FLASHWORLD", raising=False)
    monkeypatch.setattr(fw, "_can_run_here", lambda: False)
    with pytest.raises(RuntimeError, match="no FlashWorld GPU"):
        fw.generate_room(tmp_path / "plate.jpg", None, tmp_path / "out")


def _fake_worker(req_dir: Path, fail: bool, stop: threading.Event):
    while not stop.is_set():
        for d in req_dir.iterdir():
            if d.name.startswith(".") or (d / "CLAIMED").exists():
                continue
            (d / "CLAIMED").touch()
            r = json.loads((d / "request.json").read_text())
            sio.write_json_atomic(d / "progress.json", {"stage": "Generating the world", "progress": 0.5})
            if fail:
                (d / "FAILED").write_text("CUDA out of memory\n")
            else:
                sio.write_json_atomic(Path(r["out_dir"]) / "scene.json", {"world": {"file": "world.spz"}, "echo": r})
                (d / "DONE").touch()
        time.sleep(0.05)


@pytest.mark.parametrize("fail", [False, True])
def test_worker_request_protocol(tmp_path, monkeypatch, fail):
    req_dir = tmp_path / "fw-requests"
    req_dir.mkdir()
    stop = threading.Event()
    th = threading.Thread(target=_fake_worker, args=(req_dir, fail, stop), daemon=True)
    th.start()
    monkeypatch.setenv("TW_FW_REQUESTS", str(req_dir))
    seen = []
    try:
        if fail:
            with pytest.raises(RuntimeError, match="out of memory"):
                fw.generate_room(tmp_path / "plate.jpg", "a kitchen", tmp_path / "room", progress=lambda s, v: seen.append(s), timeout=10,
                                 cameraHeight=1.1)
        else:
            res = fw.generate_room(tmp_path / "plate.jpg", "a kitchen", tmp_path / "room", progress=lambda s, v: seen.append(s), timeout=10,
                                   cameraHeight=1.1)
            assert res["world"]["file"] == "world.spz"
            assert res["echo"]["params"] == {"cameraHeight": 1.1}
            assert res["echo"]["prompt"] == "a kitchen"
    finally:
        stop.set()
        th.join(2)


def test_pick_best_image(tmp_path):
    sharp = _photo(tmp_path / "a_sharp.jpg", 800, 600)
    blurred = tmp_path / "b_blur.jpg"
    Image.open(sharp).filter(ImageFilter.GaussianBlur(6)).save(blurred)
    assert fw.pick_best_image([blurred, sharp]).name == "a_sharp.jpg"
    assert fw.pick_best_image([blurred]).name == "b_blur.jpg"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_best_video_frame(tmp_path):
    vid = tmp_path / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "3",
                    "-pix_fmt", "yuv420p", str(vid)], check=True)
    out = fw.best_video_frame(vid, tmp_path / "best.png")
    im = Image.open(out)
    assert im.size == (320, 240)
