"""The GPU path of flashworld_run.generate() against a stand-in FlashWorld checkout (CPU, no weights).

The stand-in `app.GenerationSystem` has the upstream signature and returns the sample bedroom in FlashWorld's
normalised units, so loading, request tensors, output unpacking, rescaling and post-processing all run for real."""
from __future__ import annotations

import json
import sys
import textwrap

import numpy as np
import pytest

import flashworld_run as fw
import splat_io as sio
from conftest import SAMPLES

torch = pytest.importorskip("torch")
BEDROOM = SAMPLES / "sample-painted-bedroom" / "world.spz"

FAKE_APP = '''
import json, os
import numpy as np
import torch

mode = "Local"
CALLS = []


class _Lin:
    native_fp8_support = True


class GenerationSystem:
    def __init__(self, ckpt_path=None, device="cuda:0", offload_t5=False, offload_vae=False, offload_transformer_during_vae=False):
        CALLS.append({"init": [str(ckpt_path), str(device), offload_t5, offload_vae, offload_transformer_during_vae]})
        self._mods = [_Lin(), _Lin()]

    def modules(self):
        return self._mods

    def generate(self, cameras, n_frame, image=None, text="", image_index=0, image_height=480, image_width=704, video_path=None, video_fps=15):
        CALLS.append({"cameras": cameras.tolist(), "n_frame": n_frame, "image": None if image is None else [list(image.shape), float(image.min()), float(image.max())],
                      "text": text, "image_index": image_index, "hw": [image_height, image_width]})
        t_norm = cameras[:, 4:7].norm(dim=-1).max()
        p = torch.from_numpy(np.load(os.environ["FAKE_FW_SCENE"]))
        k = t_norm + 0.01
        p[:, 0:3] /= k
        p[:, 4:7] /= k
        return p, torch.eye(4)[None], t_norm.reshape(1, 1, 1)
'''


@pytest.fixture
def fake_flashworld(tmp_path, monkeypatch):
    if not BEDROOM.exists():
        pytest.skip("sample worlds not fetched")
    src = tmp_path / "FlashWorld"
    (src / "gsplat").mkdir(parents=True)
    (src / "app.py").write_text(textwrap.dedent(FAKE_APP))
    (src / "utils.py").write_text("")
    (src / "gsplat" / "__init__.py").write_text("")
    s = sio.read_spz(BEDROOM)
    s = s.subset(np.arange(0, len(s), 3))
    s = sio.transform_splats(s, np.diag([1.0, -1.0, -1.0]))
    n = len(s)
    rest = np.zeros((n, 8, 3), np.float32)
    params = np.concatenate([s.means, s.opacities[:, None], s.scales, s.quats, s.sh_dc, rest.reshape(n, 24)], axis=1).astype(np.float32)
    np.save(tmp_path / "scene.npy", params)
    monkeypatch.setenv("FAKE_FW_SCENE", str(tmp_path / "scene.npy"))
    monkeypatch.setenv("FLASHWORLD_SRC", str(src))
    monkeypatch.setenv("FLASHWORLD_CKPT", str(tmp_path / "model.ckpt"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "synchronize", lambda *a, **k: None)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda *a, **k: "Stand-in GPU")
    monkeypatch.setattr(fw, "_MODEL", None)
    monkeypatch.setattr(fw, "_CAPTIONER", None)
    for name in ("app", "gsplat"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    yield src, n
    for name in ("app", "gsplat"):
        sys.modules.pop(name, None)
    if str(src) in sys.path:
        sys.path.remove(str(src))


def test_generate_through_the_model_wrapper(tmp_path, fake_flashworld):
    src, n_raw = fake_flashworld
    from PIL import Image

    photo = tmp_path / "photo.png"
    Image.fromarray((np.random.default_rng(0).uniform(0, 255, size=(600, 900, 3))).astype(np.uint8)).save(photo)
    seen = []
    out = tmp_path / "out"
    res = fw.generate(photo, None, out, lambda st, v: seen.append((st, v)), caption="none", offload="none",
                      max_splats=150_000, trajectory_name="orbit360", seed=5)
    app = sys.modules["app"]
    init = app.CALLS[0]["init"]
    assert init[0].endswith("model.ckpt") and init[2:] == [False, False, False]
    call = app.CALLS[1]
    assert call["n_frame"] == 24 and call["hw"] == [480, 704] and call["image_index"] == 0
    assert call["text"] == fw.NEUTRAL_CAPTION
    assert call["image"][0] == [3, 480, 704] and -1.0 <= call["image"][1] < call["image"][2] <= 1.0
    cams = np.array(call["cameras"])
    assert cams.shape == (24, 11)
    np.testing.assert_allclose(cams[0, :7], [1, 0, 0, 0, 0, 0, 0], atol=1e-6)
    np.testing.assert_allclose(cams[:, 9:], 0.5, atol=1e-3)
    # FP8 probe fails without CUDA, so the wrapper switched the layers to the dequantised path.
    assert all(m.native_fp8_support is False for m in app.GenerationSystem.modules(fw.get_model().system))
    w = res["world"]
    assert w["splatCount"] == 150_000 and w["floorY"] == 0.0
    # Rescaled back to request units: the camera height above the floor is the bedroom's 1.12 m again.
    assert w["transform"]["scale"] == pytest.approx(1.45 / 1.121, rel=0.03)
    diag = json.loads((out / "flashworld.json").read_text())
    assert diag["rawSplats"] == n_raw and diag["seed"] == 5 and diag["trajectory"] == "orbit360"
    assert diag["captionSource"] == "neutral" and diag["fp8Native"] is False
    req = json.loads((out / "request.json").read_text())
    assert req["image_prompt"] == "input_fw.png" and (out / "input_fw.png").exists()
    stages = [s for s, _ in seen]
    assert "Generating the world" in stages and seen[-1][1] <= 0.99
    assert [v for _, v in seen] == sorted(v for _, v in seen)
    # A second call reuses the loaded system.
    fw.generate(None, "a greenhouse", tmp_path / "out2", None, offload="none", max_splats=50_000)
    assert sum(1 for c in app.CALLS if "init" in c) == 1
    assert app.CALLS[-1]["image"] is None and app.CALLS[-1]["text"] == "a greenhouse"


def test_spaces_package_is_refused(tmp_path, fake_flashworld, monkeypatch):
    import types

    monkeypatch.setitem(sys.modules, "spaces", types.ModuleType("spaces"))
    with pytest.raises(RuntimeError, match="spaces"):
        fw.FlashWorld(offload="none").load()
