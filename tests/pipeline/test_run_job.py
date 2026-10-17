"""Dispatcher behaviour and an end-to-end Third Wheel job with stand-in models (TW_FAKE_MODELS=1)."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from pipeline_helpers import ROOT, make_clip, requires_ffmpeg

from common.media import save_jpg
from common.frame_pick import best_photo, best_video_frame

PY = sys.executable
RUN_JOB = str(ROOT / "pipeline" / "run_job.py")


def _job(tmp: Path, mode: str, files: dict[str, Path] | None = None, prompt: str | None = None, params: dict | None = None) -> Path:
    jd = tmp / f"job-{mode}"
    (jd / "input").mkdir(parents=True)
    for name, src in (files or {}).items():
        shutil.copy(src, jd / "input" / name)
    spec = {"id": jd.name, "mode": mode, "params": params or {}}
    if prompt:
        spec["prompt"] = prompt
    (jd / "job.json").write_text(json.dumps(spec))
    return jd


def _run(jd: Path, **env) -> subprocess.CompletedProcess:
    e = dict(os.environ, TW_DISABLE_FLASHWORLD="1", **env)
    return subprocess.run([PY, RUN_JOB, str(jd)], capture_output=True, text=True, env=e, timeout=600)


def _check_vec(v, n):
    assert isinstance(v, list) and len(v) == n and all(isinstance(x, (int, float)) for x in v)


# Words that must never reach the app (progress.json `error`/`stage`, result `caption`): tools, models, services, jargon.
FORBIDDEN = ("FlashWorld", "AnySplat", "Depth Anything", "Hugging Face", "HiPerGator", "Space", "CUDA", "Traceback",
             "local fallback", "no GPU world model", "plate", "Rent Free", "Third Wheel", "ThirdWheel", "/")


def assert_product_copy(text: str) -> None:
    assert text and text.strip() == text and text[-1] in ".!?", text
    for word in FORBIDDEN:
        assert word not in text, f"{word!r} in {text!r}"


def check_job_result(res: dict) -> None:
    """Shape checks against shared/types.ts JobResult / WorldAsset / VideoLayer."""
    assert set(res) <= {"world", "video", "thumb", "caption"}
    w = res["world"]
    assert isinstance(w["file"], str) and w["file"].endswith((".ply", ".spz"))
    _check_vec(w["transform"]["position"], 3)
    _check_vec(w["transform"]["quaternion"], 4)
    assert isinstance(w["transform"]["scale"], (int, float))
    assert w["floorY"] is None or isinstance(w["floorY"], (int, float))
    assert w["source"] in ("flashworld", "anysplat", "marble-sample", "plate-depth", "other")
    if "spawn" in w:
        _check_vec(w["spawn"]["position"], 3)
        assert isinstance(w["spawn"]["yaw"], (int, float))
    if "bounds" in w:
        _check_vec(w["bounds"]["min"], 3)
        _check_vec(w["bounds"]["max"], 3)
    v = res["video"]
    assert v["layout"] == "tw-pack-v1" and v["file"].endswith(".mp4")
    for k in ("width", "height", "fps", "duration"):
        assert isinstance(v[k], (int, float)) and v[k] > 0
    assert v["width"] % 4 == 0 and v["height"] % 4 == 0
    assert isinstance(v["hasAudio"], bool)
    assert set(v["intrinsics"]) == {"fx", "fy", "cx", "cy"}
    assert v["depth"]["encoding"] == "inverse" and 0 < v["depth"]["near"] < v["depth"]["far"]
    _check_vec(v["cameraPose"]["position"], 3)
    _check_vec(v["cameraPose"]["quaternion"], 4)
    assert np.linalg.norm(v["cameraPose"]["quaternion"]) == pytest.approx(1.0, abs=1e-4)


def test_unknown_mode_fails_cleanly(tmp_path):
    jd = _job(tmp_path, "teleport")
    r = _run(jd)
    assert r.returncode == 1
    assert (jd / "FAILED").exists() and not (jd / "DONE").exists()
    prog = json.loads((jd / "progress.json").read_text())
    assert prog["done"] is True and prog["error"] == "This kind of scene isn't supported."
    assert "unknown mode" in prog["detail"]  # the technical cause stays next to it, for the log


def test_missing_job_json(tmp_path):
    jd = tmp_path / "empty"
    jd.mkdir()
    r = _run(jd)
    assert r.returncode == 2 and (jd / "FAILED").exists()
    prog = json.loads((jd / "progress.json").read_text())
    assert_product_copy(prog["error"])
    assert "job.json" in prog["detail"]


def test_rentfree_without_gpu_says_gpu_backend_required(tmp_path):
    from PIL import Image

    img = tmp_path / "room.png"
    Image.fromarray(np.random.default_rng(0).integers(0, 255, (120, 160, 3), dtype=np.uint8)).save(img)
    jd = _job(tmp_path, "rentfree", {"00.png": img})
    (jd / "input" / "meta.json").write_text(json.dumps({"00.png": {"source": "IMG_1.PNG"}}))
    r = _run(jd)
    assert r.returncode == 1
    err = (jd / "FAILED").read_text()
    assert "GPU backend" in err  # FAILED keeps the technical cause for the log
    prog = json.loads((jd / "progress.json").read_text())
    assert prog["error"] == "No GPU is free to build this world right now. Try again in a few minutes."
    assert_product_copy(prog["error"])
    assert "GPU backend" in prog["detail"]
    assert (jd / "work" / "input.jpg").exists()  # the input was still picked and normalised to JPEG


def test_rentfree_prompt_only_without_gpu(tmp_path):
    jd = _job(tmp_path, "rentfree", prompt="a cosy attic library")
    (jd / "input" / "meta.json").write_text("{}")  # the server's metadata file is not an input
    r = _run(jd)
    assert r.returncode == 1 and "GPU backend" in (jd / "FAILED").read_text()
    prog = json.loads((jd / "progress.json").read_text())
    assert prog["error"].startswith("Worlds from a prompt alone need a GPU")
    assert_product_copy(prog["error"])


def test_reconstruct_without_gpu(tmp_path):
    img = tmp_path / "a.jpg"
    save_jpg(img, np.zeros((32, 32, 3), np.uint8))
    jd = _job(tmp_path, "reconstruct", {f"{i:02d}.jpg": img for i in range(8)})
    r = _run(jd)
    assert r.returncode == 1 and "GPU backend" in (jd / "FAILED").read_text()


def test_thirdwheel_without_video(tmp_path):
    img = tmp_path / "a.jpg"
    save_jpg(img, np.zeros((32, 32, 3), np.uint8))
    jd = _job(tmp_path, "thirdwheel", {"00.jpg": img})
    r = _run(jd)
    assert r.returncode == 1 and "needs one video" in (jd / "FAILED").read_text()
    prog = json.loads((jd / "progress.json").read_text())
    assert prog["error"] == "Video mode needs one video, filmed from a still, propped-up phone."


def test_tiny_photo_is_refused_with_a_clear_message(tmp_path):
    from PIL import Image

    img = tmp_path / "dot.png"
    Image.new("RGB", (1, 1), (200, 30, 30)).save(img)
    jd = _job(tmp_path, "rentfree", {"00.png": img}, params={"localFallback": True})
    r = _run(jd)
    assert r.returncode == 1
    prog = json.loads((jd / "progress.json").read_text())
    assert prog["error"] == "This photo is too small (1x1). Use one at least 320 px on the short side."
    assert "ZeroDivision" not in (jd / "log.txt").read_text()


@requires_ffmpeg
def test_transport_stream_clips_are_accepted_as_videos(tmp_path):
    clip = make_clip(tmp_path / "c.mp4", seconds=1.0, audio=False)
    ts = tmp_path / "video.ts"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-c", "copy", "-f", "mpegts", str(ts)], check=True)
    import sys as _sys

    _sys.path.insert(0, str(ROOT / "pipeline"))
    from common.jobio import Job

    jd = _job(tmp_path, "thirdwheel", {"video.ts": ts})
    assert [p.name for p in Job(jd, echo=False).input_videos()] == ["video.ts"]


@requires_ffmpeg
def test_frames_can_be_picked_by_time_from_a_transport_stream(tmp_path):
    """MPEG-TS has no seek index: an input-side seek into a clip with one keyframe decoded nothing."""
    from common.frame_pick import best_video_frame
    from common.media import iter_frames

    ts = tmp_path / "game.ts"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=3:r=25", "-c:v", "libx264",
                    "-g", "250", "-pix_fmt", "yuv420p", "-f", "mpegts", str(ts)], check=True)
    for t in (0.0, 1.5, 2.5):
        frames = list(iter_frames(ts, (320, 240), start=t, max_frames=1))
        assert len(frames) == 1 and frames[0].shape == (240, 320, 3), t
    pick = best_video_frame(ts)
    assert pick.image.shape == (240, 320, 3)


def test_world_params_seed_defaults_to_the_attempt(tmp_path):
    import run_job
    from common.jobio import Job

    jd = _job(tmp_path, "rentfree", params={"attempt": 3, "trajectory": "orbit360"})
    params = run_job.world_params(Job(jd, echo=False))
    assert params == {"seed": 3, "trajectory": "orbit360"}
    jd2 = _job(tmp_path / "b", "rentfree", params={"attempt": 3, "seed": 9})
    assert run_job.world_params(Job(jd2, echo=False))["seed"] == 9


def test_best_photo_prefers_sharp(tmp_path):
    import cv2

    rng = np.random.default_rng(0)
    sharp = rng.integers(0, 255, (240, 320, 3), dtype=np.uint8)
    blurry = cv2.GaussianBlur(sharp, (0, 0), 4)
    save_jpg(tmp_path / "a.jpg", blurry)
    save_jpg(tmp_path / "b.jpg", sharp)
    best, scores = best_photo([tmp_path / "a.jpg", tmp_path / "b.jpg"])
    assert best.name == "b.jpg" and len(scores) == 2


@requires_ffmpeg
def test_best_video_frame_avoids_motion(tmp_path):
    clip = make_clip(tmp_path / "c.mp4", seconds=2.0, audio=False)
    pick = best_video_frame(clip)
    assert pick.image.shape[:2] == (240, 320)
    assert 0 <= pick.time <= 2.0


@requires_ffmpeg
def test_thirdwheel_end_to_end_with_stand_in_models(tmp_path, synthetic_clip):
    jd = _job(tmp_path, "thirdwheel", {"video.mp4": synthetic_clip}, params={"maxSplats": 50000})
    r = _run(jd, TW_FAKE_MODELS="1", TW_DEVICE="cpu")
    assert r.returncode == 0, (jd / "log.txt").read_text()[-3000:]
    assert (jd / "DONE").exists()
    prog = json.loads((jd / "progress.json").read_text())
    assert prog == {"stage": "Done", "progress": 1.0, "done": True}
    res = json.loads((jd / "out" / "scene.json").read_text())
    check_job_result(res)
    out = jd / "out"
    for name in (res["world"]["file"], res["video"]["file"], res["thumb"], res["video"]["plate"]):
        assert (out / name).exists(), name
    v = res["video"]
    assert (v["width"], v["height"]) == (320, 240)
    assert v["hasAudio"] is True
    assert v["fps"] == pytest.approx(15.0)
    assert v["duration"] == pytest.approx(2.0, abs=0.1)
    # decode back and check layout / depth range / mask presence
    sys.path.insert(0, str(Path(__file__).parent))
    from verify_pack import verify

    rep = verify(out)
    assert rep["ok"], rep["checks"]
    assert rep["mask"]["coverageMean"] > 0.05  # the moving block is foreground
    log = (jd / "log.txt").read_text()
    assert "camera is steady" in log
    assert res["caption"] == "The room is built from the background of your clip. 2 seconds of video with sound."
    assert_product_copy(res["caption"])
    # work arrays are cleaned up unless keepWork
    assert not (jd / "work" / "depth_raw.npy").exists()


@requires_ffmpeg
def test_thirdwheel_warns_when_camera_moves(tmp_path):
    clip = make_clip(tmp_path / "shaky.mp4", seconds=2.0, audio=False, moving_camera=True)
    jd = _job(tmp_path, "thirdwheel", {"video.mov": clip}, params={"maxSplats": 30000})
    r = _run(jd, TW_FAKE_MODELS="1", TW_DEVICE="cpu")
    assert r.returncode == 0, (jd / "log.txt").read_text()[-3000:]
    log = (jd / "log.txt").read_text()
    assert "WARNING: the camera moved" in log
    res = json.loads((jd / "out" / "scene.json").read_text())
    assert res["video"]["hasAudio"] is False
    # The warning reaches the person through the caption, as a product sentence.
    assert "The phone moved" in res["caption"] and "no sound" in res["caption"]
    assert_product_copy(res["caption"])


@requires_ffmpeg
def test_thirdwheel_generated_room_branch(tmp_path, synthetic_clip, monkeypatch):
    """GPU branch with a stand-in for flashworld_run.generate_room: the world comes back with an
    input camera and a depth map 1.5x the plate's, so the video must be scaled by 1.5 and placed
    at the world's input camera."""
    import types

    calls = {}

    def generate_room(image, prompt, out_dir, progress=None, timeout=1200.0, **params):
        from PIL import Image

        calls.update(image=image, prompt=prompt, params=params)
        out = Path(out_dir)
        w, h = Image.open(image).size
        plate_depth = np.load(Path(out_dir).parents[0] / "plate_depth.npy")
        assert plate_depth.shape == (h, w)
        inv = (1.0 / (plate_depth * 1.5)).reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
        np.save(out / "input_depth.npy", (1.0 / inv).astype(np.float32))
        K = params["intrinsics"]
        (out / "input_camera.json").write_text(json.dumps({"width": w, "height": h, **K, "position": [0.0, 1.2, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0]}))
        (out / "world.spz").write_bytes(b"\x00" * 16)
        res = {"world": {"file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": [1, 0, 0, 0], "scale": 1.0},
                         "floorY": 0.0, "spawn": {"position": [0, 0, 0.5], "yaw": 0.0}, "source": "flashworld"},
               "thumb": "thumb.jpg"}
        (out / "scene.json").write_text(json.dumps(res))
        if progress:
            progress("Generating", 1.0)
        return res

    monkeypatch.setitem(sys.modules, "flashworld_run", types.SimpleNamespace(generate_room=generate_room))
    monkeypatch.delenv("TW_DISABLE_FLASHWORLD", raising=False)
    monkeypatch.setenv("TW_FW_REQUESTS", str(tmp_path / "fw-requests"))
    monkeypatch.setenv("TW_FAKE_MODELS", "1")
    monkeypatch.setenv("TW_DEVICE", "cpu")
    import run_job

    jd = _job(tmp_path, "thirdwheel", {"video.mp4": synthetic_clip}, prompt="a small kitchen", params={"keepWork": True})
    assert run_job.run(jd) == 0, (jd / "log.txt").read_text()[-3000:]
    res = json.loads((jd / "out" / "scene.json").read_text())
    check_job_result(res)
    assert res["world"]["source"] == "flashworld" and (jd / "out" / "world.spz").exists()
    assert res["caption"].startswith("The room was imagined from the space behind the people in your clip.")
    assert_product_copy(res["caption"])
    assert (jd / "out" / "input_camera.json").exists() and (jd / "out" / "input_depth.npy").exists()
    assert calls["prompt"] == "a small kitchen" and "intrinsics" in calls["params"] and calls["params"]["cameraHeight"] > 0
    v = res["video"]
    assert v["cameraPose"]["position"] == [0.0, 1.2, 0.0]
    stats = json.loads((jd / "work" / "tw_stats.json").read_text())
    log = (jd / "log.txt").read_text()
    assert "room alignment: scale 1.5" in log, log[-2000:]
    # near/far were scaled by the alignment (video metres -> world units)
    assert stats["frames"] > 0 and v["depth"]["far"] > v["depth"]["near"]


@requires_ffmpeg
def test_thirdwheel_tells_the_person_when_nobody_moves(tmp_path):
    """A clip of an empty room still becomes a scene, and the caption says why nothing moves."""
    w, h, fps, n = 320, 240, 15, 30
    rng = np.random.default_rng(5)
    bg = np.zeros((h, w, 3), np.uint8)
    bg[:] = (150, 120, 100)
    bg[: h // 2] = (90, 110, 140)
    for _ in range(60):
        x, y = rng.integers(0, w - 12), rng.integers(0, h - 12)
        bg[y : y + 10, x : x + 10] = rng.integers(0, 255, 3)
    raw = tmp_path / "empty.rgb"
    raw.write_bytes(bg.tobytes() * n)
    clip = tmp_path / "empty.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-framerate", str(fps),
                    "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", str(clip)], check=True)
    jd = _job(tmp_path, "thirdwheel", {"video.mp4": clip}, params={"maxSplats": 30000})
    r = _run(jd, TW_FAKE_MODELS="1", TW_DEVICE="cpu")
    assert r.returncode == 0, (jd / "log.txt").read_text()[-3000:]
    res = json.loads((jd / "out" / "scene.json").read_text())
    assert "We didn't find anyone moving in this clip" in res["caption"], res["caption"]
    assert_product_copy(res["caption"])
