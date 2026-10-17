"""CPU tests for pipeline/anysplat_run.py: input handling, shims, and the post-processing contract."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image

import anysplat_run as asr
import splat_io as sio
from gpu_helpers import synthetic_room


def test_choose_views():
    assert asr.choose_views(5, 32) == [0, 1, 2, 3, 4]
    v = asr.choose_views(100, 32)
    assert len(v) == 32 and v[0] == 0 and v[-1] == 99 and v == sorted(v)


def test_list_images(tmp_path):
    for n in ("b.jpg", "a.png", ".hidden.jpg", "notes.txt"):
        (tmp_path / n).write_bytes(b"x")
    assert [p.name for p in asr.list_images(tmp_path)] == ["a.png", "b.jpg"]
    with pytest.raises(ValueError):
        asr.list_images([])


def test_load_view_crop_math(tmp_path):
    im = Image.fromarray(np.random.default_rng(0).integers(0, 255, size=(960, 1280, 3), dtype=np.uint8))
    p = tmp_path / "v.jpg"
    im.save(p)
    arr, info = asr.load_view(p)
    assert arr.shape == (448, 448, 3) and arr.dtype == np.float32 and arr.max() <= 1.0
    assert info["width"] == 1280 and info["height"] == 960
    assert info["scale"] == pytest.approx(448 / 960, rel=1e-3)
    assert info["x0"] == (round(1280 * 448 / 960) - 448) // 2 and info["y0"] == 0


def test_torch_scatter_shim_matches_reference():
    torch = pytest.importorskip("torch")
    sh = asr.make_torch_scatter_shim()
    idx = torch.tensor([0, 2, 2, 1, 0, 2])
    src = torch.tensor([[1.0, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]])
    out = sh.scatter_add(src, idx, dim=0)
    assert out.tolist() == [[10, 12], [7, 8], [19, 22]]
    m, _ = sh.scatter_max(torch.tensor([0.5, -1.0, 3.0, 2.0, 0.1, 1.0]), idx, dim=0)
    assert m.tolist() == [0.5, 2.0, 3.0]


def test_xformers_shim_matches_explicit_attention():
    torch = pytest.importorskip("torch")
    ops = asr.make_xformers_shim()
    g = torch.Generator().manual_seed(0)
    q, k, v = (torch.randn(2, 5, 3, 8, generator=g) for _ in range(3))  # [B, M, H, K]
    out = ops.memory_efficient_attention(q, k, v, op=(ops.fmha.flash.FwOp, ops.fmha.flash.BwOp), p=0.0)
    qh, kh, vh = (t.transpose(1, 2) for t in (q, k, v))
    ref = torch.softmax(qh @ kh.transpose(-1, -2) / math.sqrt(8), dim=-1) @ vh
    torch.testing.assert_close(out, ref.transpose(1, 2), atol=1e-5, rtol=1e-5)


def test_install_shims_fills_missing_modules(monkeypatch):
    pytest.importorskip("torch")
    for name in ("xformers", "xformers.ops", "torch_scatter", "skvideo", "lightning", "lightning.pytorch"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    used = asr.install_shims(force_xformers_shim=True)
    assert used["xformers"] == "sdpa"
    import xformers.ops as xops  # the shim

    assert xops.memory_efficient_attention is asr._sdpa_attention
    import torch_scatter  # real or shim

    assert hasattr(torch_scatter, "scatter_add") and hasattr(torch_scatter, "scatter_max")
    for name in ("xformers", "xformers.ops", "torch_scatter", "skvideo", "lightning", "lightning.pytorch"):
        sys.modules.pop(name, None)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_extract_video_frames(tmp_path):
    vid = tmp_path / "walk.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "4", "-pix_fmt", "yuv420p", str(vid)],
                   check=True)
    frames = asr.extract_video_frames(vid, tmp_path / "frames", 8)
    assert len(frames) == 8 and all(f.exists() for f in frames)
    assert Image.open(frames[0]).size == (320, 240)


def test_finish_reconstruction_contract(tmp_path, rng):
    """Synthetic AnySplat-like output: an arbitrary-scale world, OpenCV cameras, first camera pitched down."""
    room, _ = synthetic_room(rng, camera_height=1.5, pitch_deg=-10.0)  # OpenGL frame of camera 0
    unit = 0.37  # AnySplat's units are not metres
    pose0 = sio.pose_matrix(sio.quat_xyzw_to_matrix([0.05, 0.3, -0.02, 0.95]), [0.4, -0.2, 1.1])  # camera 0 in "AnySplat world" (GL)
    world = sio.transform_splats(room, pose0[:3, :3], pose0[:3, 3] * 0, 1.0)
    world = sio.Splats(world.means * unit + pose0[:3, 3], world.scales * unit, world.quats, world.opacities, world.sh_dc, None)
    c2w_cv0 = sio.c2w_cv_to_gl(pose0)  # the GL<->CV axis flip is its own inverse
    second = c2w_cv0.copy()
    second[:3, 3] += [0.1, 0, 0]
    c2w_cv = np.stack([c2w_cv0, second])
    K = np.array([[[0.9, 0, 0.5], [0, 0.9, 0.5], [0, 0, 1]]] * 2, np.float32)
    infos = [{"width": 1280, "height": 960, "scale": 448 / 960, "x0": 74, "y0": 0, "file": "000.jpg"},
             {"width": 1280, "height": 960, "scale": 448 / 960, "x0": 74, "y0": 0, "file": "001.jpg"}]
    out = tmp_path / "out"
    res = asr.finish_reconstruction(world, c2w_cv, K, infos, out, None, camera_height=1.45, max_splats=60000, sh_degree=0,
                                    write_spz=False, prefer_gpu=False)
    for f in ("world.ply", "thumb.jpg", "scene.json", "input_camera.json", "input_depth.npy", "cameras.json", "anysplat.json"):
        assert (out / f).exists(), f
    w = res["world"]
    assert w["file"] == "world.ply" and w["source"] == "anysplat" and w["floorY"] == 0.0
    assert w["transform"]["scale"] == pytest.approx(1.45 / (1.5 * unit), rel=0.04)
    pts = sio.apply_transform(sio.read_ply(out / "world.ply").means, w["transform"])
    assert np.percentile(pts[:, 1], 2) == pytest.approx(0.0, abs=0.04)
    assert abs(w["spawn"]["yaw"]) < 0.03
    cam = json.loads((out / "input_camera.json").read_text())
    assert cam["fx"] == pytest.approx(0.9 * 448 / (448 / 960), rel=1e-4)
    assert cam["cx"] == pytest.approx((0.5 * 448 + 74) / (448 / 960), rel=1e-4)
    assert cam["position"] == [0.0, pytest.approx(1.45, abs=1e-5), 0.0]
    cams = json.loads((out / "cameras.json").read_text())["cameras"]
    assert len(cams) == 2
    assert cams[0]["position"] == pytest.approx([0, 1.45, 0], abs=1e-4)
    d = np.linalg.norm(np.subtract(cams[1]["position"], cams[0]["position"]))
    assert d == pytest.approx(0.1 * w["transform"]["scale"], rel=1e-3)
    res2 = asr.finish_reconstruction(world, c2w_cv, K, infos, tmp_path / "out2", None, write_spz=True, prefer_gpu=False, max_splats=20000)
    assert res2["world"]["file"] == "world.spz" and (tmp_path / "out2" / "world.spz").exists()
