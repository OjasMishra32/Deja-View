"""Never-seen plate pixels: LaMa inpainting (with a stand-in model unless the real weights are cached),
the mirrored-texture fallback, and the plate depth fill. Synthetic data only."""
import hashlib
from pathlib import Path

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  puts pipeline/ on sys.path
from common import models as M
from tw import plate as P


def _striped(h=90, w=120, period=12):
    """Vertical stripes on a gradient: easy to continue, hard to fake."""
    x = np.arange(w)[None, :]
    y = np.arange(h)[:, None]
    img = np.zeros((h, w, 3), np.float32)
    img[..., 0] = 60 + 120 * ((x // (period // 2)) % 2)
    img[..., 1] = 40 + y * (36.0 / h)
    img[..., 2] = 90
    return np.clip(img, 0, 255).astype(np.uint8)


def _hole(h=90, w=120, box=(25, 70, 50, 75)):
    m = np.zeros((h, w), bool)
    y0, y1, x0, x1 = box
    m[y0:y1, x0:x1] = True
    return m


class Recorder:
    """Stand-in inpainter: paints the mask a fixed colour and records what it was given."""

    device = "fake"
    load_seconds = 0.0

    def __init__(self, colour=(10, 200, 30), everywhere=False):
        self.colour = np.array(colour, np.uint8)
        self.everywhere = everywhere  # paint outside the mask too (a model only approximates the input there)
        self.calls = []

    def __call__(self, rgb, mask):
        self.calls.append((rgb.copy(), mask.copy()))
        out = rgb.copy()
        out[np.ones_like(mask) if self.everywhere else mask] = self.colour
        return out


class Broken:
    device = "fake"

    def __call__(self, rgb, mask):
        raise RuntimeError("MPS backend out of memory")


# ---------------------------------------------------------------------------------- mask handling

def test_region_contains_holes_and_grows_by_the_dilation():
    holes = _hole()
    reg = P.inpaint_region(holes, 4)
    assert reg[holes].all()
    assert reg.sum() > holes.sum()
    assert reg[25 + 20, 50 - 4] and not reg[25 + 20, 50 - 6]  # 4 px out, not 6
    assert not P.inpaint_region(np.zeros((10, 10), bool), 3).any()
    assert np.array_equal(P.inpaint_region(holes, 0), holes)


def test_default_dilation_scales_with_resolution():
    small = P.inpaint_region(_hole(90, 120), None).sum() - _hole(90, 120).sum()
    big_holes = np.zeros((720, 1280), bool)
    big_holes[200:500, 600:800] = True
    big = P.inpaint_region(big_holes, None).sum() - big_holes.sum()
    r = P._px(P.INPAINT_DILATE_FRAC, (720, 1280))
    assert 4 <= r <= 6
    assert big > 2 * (300 + 200) * (r - 1) and small > 0


def test_feather_is_one_inside_and_ramps_to_zero_outside():
    reg = _hole()
    a = P.feather_alpha(reg, 5)
    assert a.dtype == np.float32
    assert (a[reg] == 1).all()
    row = a[45, 75:84]
    assert np.all(np.diff(row) <= 1e-6) and row[0] > 0.7 and row[-1] == 0
    assert (a[:, :40] == 0).all()
    assert np.array_equal(P.feather_alpha(reg, 0), reg.astype(np.float32))


def test_inpaint_holes_only_touches_the_region_and_its_feather():
    img, holes = _striped(), _hole()
    rec = Recorder(everywhere=True)
    out, info = P.inpaint_holes(img, holes, rec, dilate_px=3, feather_px=4, min_margin=8)
    reg = P.inpaint_region(holes, 3)
    assert (out[reg] == rec.colour).all()  # alpha is 1 on the whole region
    far = ~P.inpaint_region(holes, 3 + 4 + 1)
    assert np.array_equal(out[far], img[far])  # untouched beyond the feather
    ring = P.inpaint_region(holes, 3 + 3) & ~reg
    blend = (out[ring].astype(int) - img[ring]) / (rec.colour.astype(int) - img[ring]).clip(-255, 255).astype(float)
    assert ((out[ring] != img[ring]).any(axis=-1)).all()  # the seam is blended...
    assert ((out[ring] != rec.colour).any(axis=-1)).all()  # ...not replaced
    assert np.isfinite(blend).any()
    assert info["region"] == pytest.approx(reg.mean())
    # The model saw a crop around the region with context, and its mask is exactly the region there.
    (sub, m), = rec.calls
    x0, y0, cw, ch = info["crop"]
    assert sub.shape[:2] == m.shape == (ch, cw)
    assert np.array_equal(m, reg[y0 : y0 + ch, x0 : x0 + cw])
    assert m.sum() == reg.sum()
    assert x0 <= 50 - 3 - 8 and y0 <= 25 - 3 - 8
    assert info["scale"] == 1.0


def test_large_crop_is_resized_down_and_mask_still_covers_every_hole():
    img = np.repeat(_striped(), 4, axis=0).repeat(4, axis=1)  # 360 x 480
    holes = np.repeat(_hole(), 4, axis=0).repeat(4, axis=1)
    rec = Recorder()
    out, info = P.inpaint_holes(img, holes, rec, max_side=128)
    (sub, m), = rec.calls
    assert max(sub.shape[:2]) <= 128 and info["scale"] < 1
    # Every full-resolution region pixel maps into a masked low-resolution pixel.
    import cv2

    x0, y0, cw, ch = info["crop"]
    up = cv2.resize(m.astype(np.uint8), (cw, ch), interpolation=cv2.INTER_NEAREST) > 0
    reg = P.inpaint_region(holes)[y0 : y0 + ch, x0 : x0 + cw]
    assert up[reg].mean() > 0.99
    assert np.abs(out[holes].astype(int) - rec.colour).max() <= 12  # resized back, bicubic


def test_no_holes_is_a_no_op():
    img = _striped()
    rec = Recorder()
    out, info = P.inpaint_holes(img, np.zeros(img.shape[:2], bool), rec)
    assert out is img and not rec.calls and info["region"] == 0.0


def test_mask_size_mismatch_is_rejected():
    with pytest.raises(ValueError):
        P.inpaint_holes(_striped(), np.zeros((10, 10), bool), Recorder())


# ---------------------------------------------------------------------------------- fallback path

def test_fallback_to_mirror_fill_when_the_model_fails():
    img, holes = _striped(), _hole()
    out, info = P.fill_never_seen(img, holes, Broken())
    assert info["method"] == "mirror" and "out of memory" in info["error"]
    assert np.array_equal(out, P.fill_holes(img, holes))


def test_fallback_when_the_model_returns_the_wrong_shape():
    img, holes = _striped(), _hole()
    out, info = P.fill_never_seen(img, holes, lambda rgb, mask: rgb[:-1])
    assert info["method"] == "mirror" and "ValueError" in info["error"]
    assert np.array_equal(out, P.fill_holes(img, holes))


def test_no_model_means_mirror_fill_without_error():
    img, holes = _striped(), _hole()
    logs = []
    out, info = P.fill_never_seen(img, holes, None, log=logs.append)
    assert info["method"] == "mirror" and "error" not in info
    assert np.array_equal(out, P.fill_holes(img, holes))
    assert any("mirrored-texture" in line for line in logs)


def test_lamafill_falls_back_when_weights_are_missing_offline(tmp_path, monkeypatch):
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "torch"))
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    img, holes = _striped(), _hole()
    logs = []
    out, info = P.fill_never_seen(img, holes, P.LamaFill(device="cpu"), log=logs.append)
    assert info["method"] == "mirror" and "FileNotFoundError" in info["error"]
    assert np.array_equal(out, P.fill_holes(img, holes))
    assert any("LaMa unavailable" in line for line in logs)
    assert not (tmp_path / "torch").exists()  # nothing downloaded


def test_build_plate_reports_the_fill_and_keeps_the_hole_mask():
    rng = np.random.default_rng(0)
    bg = rng.integers(40, 200, (40, 60, 3), dtype=np.uint8)
    frames = np.repeat(bg[None], 12, 0).copy()
    person = np.zeros(frames.shape[:3], np.float32)
    frames[:, 5:35, 20:30] = (250, 10, 10)
    person[:, 5:35, 20:30] = 1.0
    rec = Recorder()
    plate, holes, stats = P.build_plate(frames, person, inpaint=rec)
    _, holes0, stats0 = P.build_plate(frames, person)
    assert np.array_equal(holes, holes0) and stats["holeFrac"] == stats0["holeFrac"]
    assert stats["inpaint"]["method"] == "lama" and stats0["inpaint"]["method"] == "mirror"
    assert (plate[holes] == rec.colour).all()
    assert stats["inpaint"]["region"] >= stats["holeFrac"]


def test_build_plate_without_holes_never_calls_the_model():
    rng = np.random.default_rng(0)
    bg = rng.integers(40, 200, (30, 40, 3), dtype=np.uint8)
    frames = np.repeat(bg[None], 8, 0).copy()
    rec = Recorder()
    plate, holes, stats = P.build_plate(frames, None, inpaint=rec)
    assert not holes.any() and not rec.calls and "inpaint" not in stats


# ---------------------------------------------------------------------------------- determinism

def test_inpaint_and_fallback_are_deterministic():
    img, holes = _striped(), _hole()
    a, _ = P.inpaint_holes(img, holes, Recorder())
    b, _ = P.inpaint_holes(img, holes, Recorder())
    assert np.array_equal(a, b)
    assert np.array_equal(P.fill_never_seen(img, holes, None)[0], P.fill_never_seen(img, holes, None)[0])


# ---------------------------------------------------------------------------------- model wrapper

@pytest.mark.filterwarnings("ignore::FutureWarning")  # torch.jit.script is deprecated; LaMa still ships as TorchScript
def test_inpainter_pads_to_multiples_of_eight_and_crops_back(tmp_path):
    torch = pytest.importorskip("torch")

    class HalfGrey(torch.nn.Module):
        """TorchScript stand-in with LaMa's signature: masked pixels become 0.5."""

        def forward(self, image: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
            return image * (1 - mask) + 0.5 * mask

    path = tmp_path / "fake.pt"
    torch.jit.script(HalfGrey()).save(str(path))
    inp = M.Inpainter(device="cpu", weights=path)
    img = np.random.default_rng(1).integers(0, 255, (37, 53, 3), dtype=np.uint8)
    mask = np.zeros((37, 53), bool)
    mask[10:20, 30:53] = True
    out = inp(img, mask)
    assert out.shape == img.shape and out.dtype == np.uint8
    assert (out[mask] == 128).all()
    assert np.array_equal(out[~mask], img[~mask])
    with pytest.raises(ValueError):
        inp(img, mask[:-1])


def test_weights_download_checks_sha256_and_leaves_no_partial_file(tmp_path, monkeypatch):
    src = tmp_path / "src.pt"
    src.write_bytes(b"lama" * 1000)
    good = hashlib.sha256(src.read_bytes()).hexdigest()
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "torch"))
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TW_OFFLINE", raising=False)
    spec = {"file": "x.pt", "urls": (src.as_uri(),), "sha256": "0" * 64, "bytes": 4000, "license": "test"}
    monkeypatch.setitem(M.INPAINTERS, "test-model", spec)
    ckpt = tmp_path / "torch" / "hub" / "checkpoints"
    with pytest.raises(RuntimeError, match="sha256"):
        M.inpainter_weights("test-model")
    assert not any(ckpt.iterdir())
    spec["sha256"] = good
    path = M.inpainter_weights("test-model")
    assert path == ckpt / "x.pt" and path.read_bytes() == src.read_bytes()
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    assert M.inpainter_weights("test-model") == path  # cached: no network needed
    with pytest.raises(FileNotFoundError):
        M.inpainter_weights("big-lama")  # not in this TORCH_HOME, and offline


def _cached_lama() -> Path | None:
    try:
        return M.inpainter_weights(download=False)
    except (FileNotFoundError, OSError):
        return None


@pytest.mark.skipif(_cached_lama() is None, reason="Big LaMa weights not cached (pipeline/common/models.py --prefetch)")
def test_real_lama_continues_stripes_and_is_deterministic_on_cpu():
    img = _striped(192, 256, period=24)
    holes = _hole(192, 256, (64, 128, 96, 160))
    lama = P.LamaFill(device="cpu")
    a, info = P.inpaint_holes(img, holes, lama)
    b, _ = P.inpaint_holes(img, holes, lama)
    lama.release()
    assert np.array_equal(a, b)
    assert info["region"] > holes.mean() and lama.model is None
    err = np.abs(a[holes].astype(int) - img[holes]).mean()
    flat = np.abs(img[holes].astype(int) - img[holes].mean(axis=0)).mean()
    mirror = np.abs(P.fill_holes(img, holes)[holes].astype(int) - img[holes]).mean()
    assert err < 0.6 * flat and err < mirror, (err, flat, mirror)


# ---------------------------------------------------------------------------------- plate depth

def _plane_depth(h=80, w=100):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    inv = 0.3 + 0.002 * xx + 0.004 * yy  # a plane: inverse depth affine in the pixel
    return (1.0 / inv).astype(np.float32)


def test_depth_fill_keeps_planes_and_leaves_the_rest_alone():
    depth = _plane_depth()
    rgb = np.full(depth.shape + (3,), 128, np.uint8)
    holes = _hole(80, 100, (20, 50, 30, 60))
    noisy = depth.copy()
    reg = P.inpaint_region(holes)
    noisy[reg] = 0.4  # a near blob the network guessed on the inpainted pixels
    out, info = P.fill_depth_holes(noisy, rgb, holes)
    assert np.array_equal(out[~reg], depth[~reg])
    assert np.abs(out[reg] / depth[reg] - 1).max() < 2e-3
    assert info["region"] == pytest.approx(reg.mean()) and info["occluderPx"] == 0


def test_depth_fill_follows_inpainted_colour_edges():
    h, w = 80, 120
    depth = np.full((h, w), 2.0, np.float32)
    depth[:, 60:] = 2.2  # two background surfaces, close enough not to count as an occluder
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[:, :60] = (200, 180, 160)
    rgb[:, 60:] = (40, 60, 90)  # the inpainted plate continues the edge through the hole
    holes = _hole(h, w, (20, 60, 40, 80))
    out, _ = P.fill_depth_holes(depth, rgb, holes)
    left, right = out[25:55, 42:58], out[25:55, 62:78]
    assert np.abs(left - 2.0).max() < 0.03 and np.abs(right - 2.2).max() < 0.03
    flat, _ = P.fill_depth_holes(depth, np.full_like(rgb, 128), holes)  # no colour guide: a ramp
    assert np.abs(flat[25:55, 55:65] - 2.1).max() < 0.08


def test_depth_fill_does_not_pull_an_occluder_forward_into_the_hole():
    h, w = 90, 120
    depth = np.full((h, w), 3.0, np.float32)  # the wall
    rgb = np.full((h, w, 3), 90, np.uint8)
    holes = _hole(h, w, (20, 70, 30, 60))
    reg = P.inpaint_region(holes)
    blender = np.zeros((h, w), bool)
    blender[30:80, 60:75] = True
    blender &= ~reg
    depth[blender] = 1.2  # an object in front, touching the hole on its right
    rgb[blender] = (200, 120, 60)
    rgb[reg] = (95, 92, 88)  # inpainted wall
    out, info = P.fill_depth_holes(depth, rgb, holes)
    assert info["occluderPx"] > 0
    assert np.median(out[holes]) > 2.8 and out[holes].min() > 2.4
    naive, _ = P.fill_depth_holes(depth, rgb, holes, occluder_rel=1e9)
    assert out[holes].min() > naive[holes].min()


def test_depth_fill_edge_cases_and_determinism():
    depth = _plane_depth()
    rgb = np.full(depth.shape + (3,), 128, np.uint8)
    same, info = P.fill_depth_holes(depth, rgb, np.zeros(depth.shape, bool))
    assert same is depth and info["region"] == 0.0
    allh, info = P.fill_depth_holes(depth, rgb, np.ones(depth.shape, bool))
    assert np.array_equal(allh, depth) and info.get("skipped")
    holes = _hole(80, 100, (0, 30, 70, 100))  # touching two image borders
    a, _ = P.fill_depth_holes(depth, rgb, holes)
    b, _ = P.fill_depth_holes(depth, rgb, holes)
    assert np.array_equal(a, b) and np.isfinite(a).all() and (a > 0).all()
    # rgb at another resolution and holes at another resolution are resized
    c, _ = P.fill_depth_holes(depth, np.repeat(np.repeat(rgb, 2, 0), 2, 1), np.repeat(np.repeat(holes, 2, 0), 2, 1))
    assert c.shape == depth.shape and np.isfinite(c).all()


# ---------------------------------------------------------------------------------- run.py wiring

def test_run_config_selects_the_fill(monkeypatch):
    from tw import run as R

    monkeypatch.delenv("TW_FAKE_MODELS", raising=False)
    monkeypatch.delenv("TW_PLATE_INPAINT", raising=False)
    cfg = R.TwConfig.from_params({}, device="cpu")
    assert cfg.plate_inpaint == "lama"
    lf = R._plate_inpainter(cfg)
    assert isinstance(lf, P.LamaFill) and lf.model is None  # nothing loaded until a hole needs it
    assert R._plate_inpainter(R.TwConfig.from_params({"plateInpaint": "mirror"}, device="cpu")) is None
    monkeypatch.setenv("TW_PLATE_INPAINT", "mirror")
    assert R._plate_inpainter(cfg) is None
    monkeypatch.delenv("TW_PLATE_INPAINT")
    monkeypatch.setenv("TW_FAKE_MODELS", "1")
    assert R._plate_inpainter(cfg) is None
