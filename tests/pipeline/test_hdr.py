"""HDR (HLG / PQ) video is tone-mapped to SDR when decoded; SDR decoding is unchanged.

The clips are built from the same synthetic SDR frames: once as SDR H.264, once as HLG and once as PQ HEVC 10-bit
(BT.2020, SDR white at the BT.2408 reference white: HLG 75%, PQ 203 nits). A correct decoder brings all three back
to (nearly) the same picture.
"""
import os
import shutil
import subprocess
from fractions import Fraction

import numpy as np
import pytest
import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)

from common import hdr, media
from common.media import iter_frames, probe


def _ffmpeg_has(kind: str, name: str) -> bool:
    if shutil.which("ffmpeg") is None:
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", f"-{kind}"], capture_output=True, text=True).stdout
    return any(line.split()[1:2] == [name] for line in out.splitlines() if line.strip())


HAS_X265 = _ffmpeg_has("encoders", "libx265") and _ffmpeg_has("filters", "lut3d")
requires_x265 = pytest.mark.skipif(not HAS_X265, reason="ffmpeg with libx265 and lut3d not installed")

W, H, FPS, N = 320, 180, 10, 8

# Inverse maths for building test clips (SDR display light -> HDR signal), independent of common.hdr.
_M709_TO_2020 = np.array([[0.6274040, 0.3292820, 0.0433136], [0.0690970, 0.9195400, 0.0113612], [0.0163916, 0.0880132, 0.8955950]])
_Y2020 = np.array([0.2627, 0.6780, 0.0593])
_A, _B, _C = 0.17883277, 0.28466892, 0.55991073
_M1, _M2, _C1, _C2, _C3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32


def sdr_to_hdr(rgb8: np.ndarray, transfer: str) -> np.ndarray:
    """SDR BT.709 RGB (uint8, gamma 2.4) to an HLG or PQ BT.2020 signal in [0, 1]; SDR white -> 203 nits."""
    nits = ((rgb8.astype(np.float64) / 255.0) ** 2.4 @ _M709_TO_2020.T) * 203.0
    if transfer == "hlg":
        ys = (nits @ _Y2020 / 1000.0) ** (1 / 1.2)  # inverse OOTF for a 1000 nit display
        e = np.clip(nits / (1000.0 * np.maximum(ys, 1e-12)[..., None] ** 0.2), 0, 1)
        sig = np.where(e <= 1 / 12, np.sqrt(3 * e), _A * np.log(np.maximum(12 * e - _B, 1e-12)) + _C)
    else:
        y = np.clip(nits / 10000.0, 0, 1) ** _M1
        sig = ((_C1 + _C2 * y) / (1 + _C3 * y)) ** _M2
    return np.clip(sig, 0, 1)


def room_frames() -> np.ndarray:
    """A small room-like scene: wall, floor, a window-white card, a skin-toned 'person' that moves, a grey ramp."""
    rng = np.random.default_rng(7)
    bg = np.zeros((H, W, 3), np.uint8)
    bg[:] = (168, 150, 128)
    bg[H // 2 :] = (112, 92, 74)
    for _ in range(40):
        x, y = rng.integers(0, W - 14), rng.integers(0, H - 14)
        bg[y : y + 12, x : x + 12] = rng.integers(30, 230, 3)
    bg[12:52, 210:300] = 255
    bg[H - 16 :] = np.linspace(0, 255, W).round().astype(np.uint8)[None, :, None]
    out = []
    for i in range(N):
        fr = bg.copy()
        x = 40 + 8 * i
        fr[50 : H - 30, x : x + 40] = (60, 90, 170)  # shirt
        fr[30:50, x + 8 : x + 32] = (224, 172, 140)  # face
        out.append(fr)
    return np.stack(out)


def _encode_sdr(frames: np.ndarray, path):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p",
         "-c:v", "libx264", "-crf", "10", "-colorspace", "bt709", "-color_range", "tv", str(path)],
        input=frames.tobytes(), check=True)
    return path


def _encode_hdr(frames: np.ndarray, transfer: str, path):
    trc = {"hlg": "arib-std-b67", "pq": "smpte2084"}[transfer]
    raw = np.round(sdr_to_hdr(frames, transfer) * 65535).astype("<u2").tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "-",
         "-vf", "scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p10le",
         "-c:v", "libx265", "-preset", "fast", "-crf", "8",
         "-x265-params", f"log-level=error:colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc:range=limited",
         "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv", "-tag:v", "hvc1", str(path)],
        input=raw, check=True)
    return path


@pytest.fixture(scope="module", autouse=True)
def lut_dir(tmp_path_factory):
    with pytest.MonkeyPatch.context() as mp:
        d = tmp_path_factory.mktemp("luts")
        mp.setenv("DEJAVIEW_HDR_DIR", str(d))
        mp.setattr(hdr, "_luts", {})
        yield d


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    if not HAS_X265:
        pytest.skip("ffmpeg with libx265 and lut3d not installed")
    d = tmp_path_factory.mktemp("hdr")
    frames = room_frames()
    return {
        "frames": frames,
        "sdr": _encode_sdr(frames, d / "sdr.mp4"),
        "hlg": _encode_hdr(frames, "hlg", d / "hlg.mov"),
        "pq": _encode_hdr(frames, "pq", d / "pq.mp4"),
    }


def _stats(frames: list[np.ndarray]) -> dict:
    import cv2

    a = np.stack(frames)
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in a]).astype(np.float64)
    sat = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2HSV)[..., 1] for f in a]).astype(np.float64)
    return {"mean": gray.mean(), "std": gray.std(), "sat": sat.mean(), "p98": float(np.percentile(gray, 98))}


def _decode(path, **kw) -> list[np.ndarray]:
    return list(iter_frames(path, (W, H), **kw))


# ---- the maths (no ffmpeg) -------------------------------------------------------------------------------------


def test_transfer_detection_and_stream_mapping():
    assert hdr.hdr_transfer("arib-std-b67") == "hlg"
    assert hdr.hdr_transfer("smpte2084") == "pq"
    for sdr in ("bt709", "smpte170m", "bt2020-10", "unknown", "", None):
        assert hdr.hdr_transfer(sdr) is None
    assert hdr.HdrSource.from_stream("bt709", "bt709", "bt709", "tv") is None
    assert hdr.HdrSource.from_stream("arib-std-b67", "bt2020", "bt2020nc", "tv") == hdr.HdrSource("hlg", "bt2020", "bt2020", "tv")
    assert hdr.HdrSource.from_stream("smpte2084", None, None, None) == hdr.HdrSource("pq", "bt2020", "bt2020", "tv")
    assert hdr.HdrSource.from_stream("arib-std-b67", "bt709", "bt709", "pc") == hdr.HdrSource("hlg", "bt709", "bt709", "pc")


def test_tonemap_reference_white_midtones_and_peak():
    white = (0.95) ** (1 / 2.4)  # reference white lands at 0.95 linear after the roll-off (8-bit 250)
    for t in ("hlg", "pq"):
        sdr = np.array([[0, 0, 0], [20, 20, 20], [128, 128, 128], [224, 172, 140], [60, 90, 170], [200, 30, 40]], np.uint8)
        back = hdr.tonemap(sdr_to_hdr(sdr, t), t) * 255.0
        # Below the knee (linear 0.9 of reference white, 8-bit 244) the SDR value comes back exactly.
        assert np.abs(back - sdr).max() < 0.02, (t, back)
        w = hdr.tonemap(sdr_to_hdr(np.array([[255, 255, 255]], np.uint8), t), t)
        assert w == pytest.approx(np.full((1, 3), white), abs=1e-4)
    assert hdr.tonemap(np.array([0.75, 0.75, 0.75]), "hlg") == pytest.approx([white] * 3, abs=2e-4)
    assert hdr.tonemap(np.array([1.0, 1.0, 1.0]), "hlg") == pytest.approx([1.0] * 3)  # 1000 nit peak -> SDR peak
    pq1000 = ((_C1 + _C2 * 0.1**_M1) / (1 + _C3 * 0.1**_M1)) ** _M2
    assert hdr.tonemap(np.array([pq1000] * 3), "pq") == pytest.approx([1.0] * 3, abs=1e-6)
    assert hdr.tonemap(np.array([1.0] * 3), "pq") == pytest.approx([1.0] * 3)  # 10000 nits clips at white
    # The roll-off is monotonic and keeps neutral colours neutral.
    ramp = np.linspace(0, 1, 1001)[:, None].repeat(3, 1)
    for t in ("hlg", "pq"):
        out = hdr.tonemap(ramp, t)
        assert np.all(np.diff(out[:, 0]) >= -1e-12)
        assert np.abs(out[:, 0] - out[:, 2]).max() < 1e-9


def test_out_of_gamut_colours_clip_without_breaking():
    # Pure BT.2020 green is outside BT.709: its red and blue come out negative before the clip.
    sig = sdr_to_hdr(np.array([[0, 255, 0]], np.uint8), "hlg")  # in gamut: exactly BT.709 green
    assert hdr.tonemap(sig, "hlg")[0, 0] == pytest.approx(0.0, abs=5e-3)  # matrices are 7-digit inverses
    wide = np.array([[0.0, 0.7, 0.0]])
    signed = hdr.tonemap_signed(wide, "hlg")
    assert signed[0, 0] < 0 and signed[0, 2] < 0 and signed[0, 1] > 0.5
    assert np.all((hdr.tonemap(wide, "hlg") >= 0) & (hdr.tonemap(wide, "hlg") <= 1))


def test_cube_text_layout(tmp_path):
    text = hdr.cube_text("hlg", size=5)
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    assert lines[0].startswith('TITLE "dejaview-hlg-bt2020-v') and lines[1] == "LUT_3D_SIZE 5"
    rows = np.array([[float(v) for v in ln.split()] for ln in lines[2:]])
    assert rows.shape == (125, 3)
    axis = np.arange(5) / 4
    # Red index fastest: row i is (r=axis[i % 5], g=axis[i // 5 % 5], b=axis[i // 25]).
    for i in (1, 5, 25, 31, 124):
        rgb = np.array([axis[i % 5], axis[i // 5 % 5], axis[i // 25]])
        assert rows[i] == pytest.approx(hdr.lut_values(rgb, "hlg"), abs=6e-7)
    p = hdr.lut_file("pq", size=9)
    assert p.read_text() == hdr.cube_text("pq", size=9)
    assert hdr.lut_file("pq", size=9) == p
    toe = [ln for ln in hdr.toe_file().read_text().splitlines() if ln and not ln.startswith("#")]
    assert toe[1] == "LUT_1D_SIZE 65536" and len(toe) == 2 + 65536


def test_lut_stages_compose_to_the_tone_map():
    """3D entry (linear toe or gamma) -> ffmpeg's clip to [0, 1] -> 1D entry equals the exact tone map."""
    rng = np.random.default_rng(1)
    rgb = np.concatenate([rng.random((4000, 3)), rng.random((1000, 3)) ** 4, np.eye(3) * 0.8, np.ones((1, 3))])
    for t in ("hlg", "pq"):
        stored = np.clip(hdr.lut_values(rgb, t) - hdr._HALF_STEP, 0.0, 1.0)
        assert np.abs(hdr.toe_decode(stored) - hdr.tonemap(rgb, t)).max() < 1e-12
    codes = np.arange(65536) / 65535.0
    ident = codes >= hdr._TOE_V
    assert np.array_equal(hdr.toe_decode(codes)[ident], codes[ident])  # the 1D LUT leaves the gamma part alone


def test_rgb48_to_rgb24_rounds_to_nearest():
    x = np.arange(65536, dtype="<u2")
    got = hdr.rgb48_to_rgb24(np.repeat(x, 3).tobytes(), 65536, 1)[0, :, 0]
    assert np.array_equal(got, np.round(x / 257.0).astype(np.uint8))


# ---- decoding --------------------------------------------------------------------------------------------------


@requires_x265
def test_probe_reports_hdr(clips):
    for t, trc in (("hlg", "arib-std-b67"), ("pq", "smpte2084")):
        info = probe(clips[t])
        assert info.hdr == t and info.color_transfer == trc and info.color_primaries == "bt2020"
        assert info.pix_fmt == "yuv420p10le" and info.hdr_source == hdr.HdrSource(t)
    sdr = probe(clips["sdr"])
    assert sdr.hdr is None and sdr.hdr_source is None
    assert media.hdr_source(clips["hlg"]).transfer == "hlg" and media.hdr_source(clips["sdr"]) is None


@requires_x265
def test_hdr_decodes_like_the_sdr_source(clips):
    ref = _decode(clips["sdr"])
    s_ref = _stats(ref)
    for t in ("hlg", "pq"):
        before = _stats(_decode(clips[t], tonemap=False))
        frames = _decode(clips[t])
        after = _stats(frames)
        # Untone-mapped, the picture is dim and flat (that was the bug).
        assert before["p98"] < s_ref["p98"] - 20 and before["std"] < s_ref["std"] * 0.85, (t, before, s_ref)
        assert abs(after["mean"] - s_ref["mean"]) < 2.0, (t, after, s_ref)
        assert abs(after["std"] - s_ref["std"]) < 2.0, (t, after, s_ref)
        assert abs(after["sat"] - s_ref["sat"]) < 4.0, (t, after, s_ref)
        assert abs(after["p98"] - s_ref["p98"]) <= 8, (t, after, s_ref)  # white -> 250 by design (roll-off)
        diff = np.abs(np.stack(frames).astype(int) - np.stack(ref).astype(int))
        assert diff.mean() < 2.0 and np.percentile(diff, 99) <= 12, (t, diff.mean())
        assert frames[0].dtype == np.uint8 and frames[0].shape == (H, W, 3)


@requires_x265
def test_lut_matches_the_exact_maths(clips):
    for t in ("hlg", "pq"):
        src = hdr.HdrSource(t)
        vf = f"scale={W}:{H}:flags=area+accurate_rnd+full_chroma_int{hdr.scale_options(src)},format=gbrp16le"
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(clips[t]), "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"],
                             capture_output=True, check=True).stdout
        exact = hdr.tonemap(np.frombuffer(raw, "<u2").reshape(-1, H, W, 3) / 65535.0, t) * 255.0
        got = np.stack(_decode(clips[t])).astype(np.float64)
        err = np.abs(got - exact)
        assert err.mean() < 0.6 and np.percentile(err, 99.9) < 3.0 and err.max() < 12, (t, err.mean(), np.percentile(err, 99.9))


@requires_x265
def test_sdr_decode_is_the_plain_ffmpeg_path(clips):
    """SDR keeps the exact command it had before HDR support (and so the exact bytes)."""
    w, h = 160, 96
    for kw, extra in (({}, []), ({"fps": Fraction(5)}, ["fps=5/1"])):
        cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(clips["sdr"]), "-an", "-sn", "-vf",
               ",".join(extra + [f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int"]), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        legacy = subprocess.run(cmd, capture_output=True, check=True).stdout
        got = b"".join(f.tobytes() for f in iter_frames(clips["sdr"], (w, h), **kw))
        assert got == legacy
    # And an HDR file decoded with tonemap=False takes that same plain path.
    plain = b"".join(f.tobytes() for f in iter_frames(clips["hlg"], (w, h), tonemap=False))
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(clips["hlg"]), "-an", "-sn", "-vf",
           f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    assert plain == subprocess.run(cmd, capture_output=True, check=True).stdout


@requires_x265
def test_iter_frames_options_with_hdr(clips):
    frames = list(iter_frames(clips["hlg"], (W, H), fps=Fraction(5), start=0.2, max_frames=2))
    assert len(frames) == 2
    one = next(iter(iter_frames(clips["pq"], (W // 2, H // 2), start=0.3, max_frames=1)))
    assert one.shape == (H // 2, W // 2, 3)
    # Without a prior probe() the colour check probes once and caches the answer.
    media._color_cache.clear()
    assert media.video_color(clips["pq"])["hdr"] == "pq"
    assert media._file_key(clips["pq"]) in media._color_cache


@requires_x265
def test_hdr_falls_back_to_plain_decode_when_the_lut_is_unavailable(clips, monkeypatch):
    def broken(*a, **k):
        raise OSError("read-only temp dir")

    monkeypatch.setattr(media, "lut_file", broken)
    got = np.stack(_decode(clips["hlg"]))
    plain = np.stack(_decode(clips["hlg"], tonemap=False))
    assert np.array_equal(got, plain)
    monkeypatch.undo()
    monkeypatch.setattr(media, "lut_filters", lambda src, lut: ["format=gbrp16le", "lut3d=file='/nonexistent/x.cube'"])
    assert np.array_equal(np.stack(_decode(clips["hlg"])), plain)


@requires_x265
def test_sdr_filters_for_code_that_runs_ffmpeg_itself(clips, tmp_path):
    from PIL import Image

    def still(src, vf: list[str], out):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-frames:v", "1", *(["-vf", ",".join(vf)] if vf else []),
                        "-q:v", "2", str(out)], check=True)
        return np.asarray(Image.open(out).convert("RGB"))

    assert media.sdr_filters(clips["sdr"]) == []
    ref = _stats([still(clips["sdr"], [], tmp_path / "sdr.jpg")])
    for t in ("hlg", "pq"):
        vf = media.sdr_filters(clips[t], jpeg=True)
        assert vf[0].startswith("scale=") and "in_color_matrix=bt2020" in vf[0] and vf[-1].endswith("format=yuvj420p")
        got = _stats([still(clips[t], vf, tmp_path / f"{t}.jpg")])
        assert abs(got["mean"] - ref["mean"]) < 3 and abs(got["p98"] - ref["p98"]) <= 8, (t, got, ref)
        png = still(clips[t], media.sdr_filters(clips[t]), tmp_path / f"{t}.png")
        assert abs(_stats([png])["mean"] - ref["mean"]) < 3


@requires_x265
def test_frame_pick_and_samples_use_the_tone_mapped_frames(clips):
    from common.frame_pick import best_video_frame

    pick = best_video_frame(clips["hlg"])
    ref = best_video_frame(clips["sdr"])
    assert pick.image.shape == ref.image.shape
    assert abs(float(pick.image.mean()) - float(ref.image.mean())) < 3.0


def test_lut_dir_is_private(monkeypatch, tmp_path):
    monkeypatch.delenv("DEJAVIEW_HDR_DIR", raising=False)
    monkeypatch.setattr(hdr.tempfile, "gettempdir", lambda: str(tmp_path))
    d = hdr.lut_dir()
    assert d.parent == tmp_path and (os.stat(d).st_mode & 0o077) == 0
    # Someone else's (or a world-writable) directory is not used.
    os.chmod(d, 0o777)
    monkeypatch.setattr(hdr, "_private_dir", None)
    other = hdr.lut_dir()
    assert other != d and other.is_dir()
    os.chmod(d, 0o700)
