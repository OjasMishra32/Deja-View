import json
from fractions import Fraction

import numpy as np
import pytest
from pipeline_helpers import make_clip, requires_ffmpeg

from common.jobio import Job, JobError, write_json_atomic
from common.media import MediaError, fit_size, iter_frames, load_image, output_fps, probe


def test_fit_size_long_side_and_multiples():
    assert fit_size(1920, 1080) == (1280, 720)
    assert fit_size(3840, 2160) == (1280, 720)
    assert fit_size(1080, 1920) == (720, 1280)
    assert fit_size(720, 1280) == (720, 1280)
    w, h = fit_size(1440, 1080)
    assert (w, h) == (1280, 960)
    w, h = fit_size(642, 362)  # small odd sizes still come out as multiples of 16
    assert w % 16 == 0 and h % 16 == 0


def test_output_fps_caps_at_30():
    assert output_fps(Fraction(60)) == 30
    assert output_fps(Fraction(60000, 1001)) == Fraction(30000, 1001)
    assert output_fps(Fraction(120)) == 30
    assert output_fps(Fraction(25)) == 25
    assert output_fps(Fraction(24000, 1001)) == Fraction(24000, 1001)


@requires_ffmpeg
def test_probe_and_decode(tmp_path):
    clip = make_clip(tmp_path / "c.mp4", seconds=1.0, fps=10)
    info = probe(clip)
    assert (info.width, info.height) == (320, 240)
    assert info.has_audio and info.fps == pytest.approx(10)
    frames = list(iter_frames(clip, (160, 112), fps=Fraction(5)))
    assert len(frames) in (5, 6) and frames[0].shape == (112, 160, 3)


def test_media_error_keeps_detail_and_product_sentence():
    e = MediaError("ffprobe could not read x.mp4: moov atom not found", user="We couldn't read this video.")
    assert str(e) == "ffprobe could not read x.mp4: moov atom not found" and e.user == "We couldn't read this video."
    assert MediaError("technical only").user is None
    assert isinstance(e, RuntimeError)


def _product_sentence(e: MediaError) -> str:
    assert e.user and e.user.endswith("."), e.user
    for word in ("ffmpeg", "ffprobe", "pillow", "heif", "stream", "decode"):
        assert word not in e.user.lower(), e.user
    return e.user


@requires_ffmpeg
def test_media_errors_carry_a_product_sentence(tmp_path):
    import subprocess

    (tmp_path / "notes.mp4").write_text("not a video")
    with pytest.raises(MediaError) as ei:
        probe(tmp_path / "notes.mp4")
    assert "notes.mp4" in str(ei.value) and "ffprobe" in str(ei.value)
    assert "video" in _product_sentence(ei.value)
    with pytest.raises(MediaError) as ei:
        list(iter_frames(tmp_path / "notes.mp4", (64, 48)))
    assert "could not decode" in str(ei.value) and _product_sentence(ei.value)
    audio = tmp_path / "voice.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "aac", str(audio)], check=True)
    with pytest.raises(MediaError) as ei:
        probe(audio)
    assert "no video stream" in str(ei.value) and "no video" in _product_sentence(ei.value)
    (tmp_path / "broken.jpg").write_bytes(b"\xff\xd8\xff\x00 not really a jpeg")
    with pytest.raises(MediaError) as ei:
        load_image(tmp_path / "broken.jpg")
    assert "broken.jpg" in str(ei.value) and "photo" in _product_sentence(ei.value)


def test_load_image_heic_and_png(tmp_path):
    from PIL import Image

    rgb = np.zeros((40, 60, 3), np.uint8)
    rgb[:, :30] = (255, 0, 0)
    Image.fromarray(rgb).save(tmp_path / "a.png")
    assert np.array_equal(load_image(tmp_path / "a.png"), rgb)
    pillow_heif = pytest.importorskip("pillow_heif")
    try:
        pillow_heif.from_bytes(mode="RGB", size=(60, 40), data=rgb.tobytes()).save(str(tmp_path / "a.heic"), quality=95)
    except Exception as e:  # encoder not available in this build
        pytest.skip(f"HEIC encoder unavailable: {e}")
    out = load_image(tmp_path / "a.heic")
    assert out.shape == (40, 60, 3) and out[20, 10, 0] > 200 and out[20, 50, 0] < 60


def test_job_progress_mapping_and_markers(tmp_path):
    (tmp_path / "input").mkdir()
    (tmp_path / "input" / "video.mp4").write_bytes(b"")
    (tmp_path / "input" / "meta.json").write_text(json.dumps({"video.mp4": {"focal35": 26}}))
    write_json_atomic(tmp_path / "job.json", {"id": "j1", "mode": "thirdwheel", "params": {"maxSeconds": 5}})
    job = Job(tmp_path, echo=False)
    assert [p.name for p in job.input_files()] == ["video.mp4"]
    assert job.input_meta("video.mp4")["focal35"] == 26
    job.set_range(0.0, 0.5)
    job.progress("Halfway", 0.5)
    assert json.loads((tmp_path / "progress.json").read_text()) == {"stage": "Halfway", "progress": 0.25}
    cb = job.subprogress(0.5, 1.0)  # second half of the current range
    cb("Sub", 1.0)
    assert json.loads((tmp_path / "progress.json").read_text())["progress"] == 0.5
    job.progress("Back", 0.1)  # never goes backwards
    assert json.loads((tmp_path / "progress.json").read_text())["progress"] == 0.5
    job.finish_failed("boom")
    assert (tmp_path / "FAILED").read_text().strip() == "boom"
    job.clear_markers()
    job.finish_ok()
    assert (tmp_path / "DONE").exists() and not (tmp_path / "FAILED").exists()
    assert json.loads((tmp_path / "progress.json").read_text()) == {"stage": "Done", "progress": 1.0, "done": True}


def test_job_requires_job_json(tmp_path):
    with pytest.raises(JobError):
        Job(tmp_path)


def test_write_json_rejects_nan(tmp_path):
    with pytest.raises(ValueError):
        write_json_atomic(tmp_path / "x.json", {"a": float("nan")})
    write_json_atomic(tmp_path / "x.json", {"a": np.float32(1.5), "b": np.arange(3)})
    assert json.loads((tmp_path / "x.json").read_text()) == {"a": 1.5, "b": [0, 1, 2]}
