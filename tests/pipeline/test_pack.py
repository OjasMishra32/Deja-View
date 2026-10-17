import subprocess
from fractions import Fraction

import numpy as np
import pytest
from conftest import requires_ffmpeg

from common.media import iter_frames, probe
from tw.pack import (
    PackWriter,
    check_dims,
    decode_inverse_depth,
    encode_inverse,
    encode_inverse_depth,
    pack_frame,
    packed_size,
    unpack_frame,
)


def test_inverse_depth_roundtrip_within_one_code():
    near, far = 0.4, 6.0
    d = np.geomspace(near, far, 1000).astype(np.float32)
    code = encode_inverse_depth(d, near, far)
    back = decode_inverse_depth(code, near, far)
    # one code step in inverse depth
    step = (1 / near - 1 / far) / 255
    assert np.all(np.abs(1 / back - 1 / d) <= step * 0.5 + 1e-6)


def test_inverse_depth_endpoints_and_clamping():
    near, far = 0.5, 4.0
    assert encode_inverse_depth(np.array([near]), near, far)[0] == 255
    assert encode_inverse_depth(np.array([far]), near, far)[0] == 0
    assert encode_inverse_depth(np.array([0.1]), near, far)[0] == 255  # closer than near
    assert encode_inverse_depth(np.array([50.0]), near, far)[0] == 0  # beyond far
    assert decode_inverse_depth(np.array([255]), near, far)[0] == pytest.approx(near)
    assert decode_inverse_depth(np.array([0]), near, far)[0] == pytest.approx(far)
    # matches the formula in shared/types.ts: 1/d = 1/far + v * (1/near - 1/far)
    v = 100 / 255
    assert decode_inverse_depth(np.array([100]), near, far)[0] == pytest.approx(1 / (1 / far + v * (1 / near - 1 / far)))


def test_encode_inverse_matches_depth_encoder():
    near, far = 0.3, 9.0
    d = np.linspace(0.3, 9.0, 77)
    assert np.array_equal(encode_inverse(1 / d, near, far), encode_inverse_depth(d, near, far))


def test_monotonic_closer_is_brighter():
    code = encode_inverse_depth(np.array([1.0, 2.0, 3.0]), 0.5, 5.0)
    assert code[0] > code[1] > code[2]


def test_band_layout():
    w, h = 64, 48
    rgb = np.random.default_rng(0).integers(0, 255, (h, w, 3), dtype=np.uint8)
    depth = np.full((h // 2, w // 2), 200, np.uint8)
    mask = np.zeros((h // 2, w // 2), np.uint8)
    mask[:, : w // 4] = 255
    p = pack_frame(rgb, depth, mask)
    assert p.shape == (h * 3 // 2, w, 3)
    assert packed_size(w, h) == (w, h * 3 // 2)
    assert np.array_equal(p[:h], rgb)
    assert np.all(p[h:, : w // 2] == 200)  # left half: depth
    assert np.all(p[h:, w // 2 : w // 2 + w // 4] == 255)  # right half: mask
    assert np.all(p[h:, w // 2 + w // 4 :] == 0)
    r, dg, mg = unpack_frame(p, w, h)
    assert np.array_equal(r, rgb) and np.all(dg == 200) and mg.shape == (h // 2, w // 2)


def test_dims_must_divide_by_four():
    with pytest.raises(ValueError):
        check_dims(66, 48)
    with pytest.raises(ValueError):
        pack_frame(np.zeros((48, 64, 3), np.uint8), np.zeros((10, 10), np.uint8), np.zeros((24, 32), np.uint8))


@requires_ffmpeg
def test_packwriter_h264_roundtrip_with_audio(tmp_path):
    w, h, fps, n = 128, 96, 12, 24
    audio_src = tmp_path / "tone.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", str(audio_src)], check=True)
    yy, xx = np.mgrid[0 : h // 2, 0 : w // 2]
    depth = (xx * 255 // (w // 2 - 1)).astype(np.uint8)  # horizontal ramp
    mask = np.where((xx - w // 4) ** 2 + (yy - h // 4) ** 2 < 12**2, 255, 0).astype(np.uint8)
    out = tmp_path / "tw.mp4"
    with PackWriter(out, w, h, Fraction(fps), audio_src=audio_src, duration=n / fps) as wr:
        for i in range(n):
            rgb = np.zeros((h, w, 3), np.uint8)
            rgb[..., 0] = 200
            rgb[..., 1] = (i * 10) % 255
            wr.write(pack_frame(rgb, depth, mask))
    info = probe(out)
    assert (info.width, info.height) == (w, h * 3 // 2)
    assert info.has_audio and info.audio_codec == "aac"
    assert abs(info.duration - n / fps) < 0.15
    frames = list(iter_frames(out, (w, h * 3 // 2)))
    assert len(frames) == n
    _, dg, mg = unpack_frame(frames[n // 2], w, h)
    # Gray bands survive yuv420p limited range + crf 18 within a few codes when read as luma.
    # The outermost row/column next to another band can pick up a few codes from chroma
    # subsampling (this synthetic frame is adversarial: saturated colour above the band, a
    # full-range ramp next to the mask).
    err = np.abs(dg - depth)
    assert err.mean() < 1.0
    assert err[1:, :-1].max() <= 6
    assert err.max() <= 10
    assert np.abs(mg - mask).mean() < 3
    band = frames[n // 2][h + 2 :].astype(np.int16)
    assert np.abs(band - band.mean(axis=2, keepdims=True)).max() <= 4  # stays gray away from the boundary
    # +faststart: moov before mdat
    head = out.read_bytes()[:65536]
    assert 0 <= head.find(b"moov") < max(head.find(b"mdat"), 1 << 30)
