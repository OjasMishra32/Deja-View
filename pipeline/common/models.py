"""Model wrappers that run on CUDA, MPS or CPU.

Depth: Depth Anything V2 through Hugging Face transformers. The metric indoor variants output
z-depth in metres directly; the relative variant outputs affine-invariant inverse depth.
Person segmentation: torchvision DeepLabV3 (COCO with VOC labels, class 15 = person).
Inpainting: Big LaMa (Suvorov et al. 2022, github.com/advimman/lama, Apache-2.0) as the TorchScript
file published by the simple-lama-inpainting project (Apache-2.0), loaded with torch.jit.

Run `python pipeline/common/models.py --prefetch` to download every default weight into
HF_HOME / TORCH_HOME (data/models by default).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import warnings
from pathlib import Path

if __package__ in (None, ""):
    # Run as a script: put pipeline/ (not pipeline/common/) first on the path so helper module
    # names never shadow the standard library.
    _here = str(Path(__file__).resolve().parent)
    sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != Path(_here)]
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common import env as _env  # noqa: F401
    from common.device import inference_dtype, pick_device
else:
    from . import env as _env  # noqa: F401
    from .device import inference_dtype, pick_device

import numpy as np

DEPTH_MODELS = {
    "metric-indoor-small": "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
    "metric-indoor-base": "depth-anything/Depth-Anything-V2-Metric-Indoor-Base-hf",
    "metric-indoor-large": "depth-anything/Depth-Anything-V2-Metric-Indoor-Large-hf",
    "relative-small": "depth-anything/Depth-Anything-V2-Small-hf",
}
DEFAULT_FRAME_DEPTH = "metric-indoor-small"
DEFAULT_PLATE_DEPTH = "metric-indoor-base"
PERSON_SEGMENTERS = ("deeplabv3-mobilenet", "deeplabv3-resnet50")
DEFAULT_SEGMENTER = "deeplabv3-resnet50"
# Single-file TorchScript weights, cached as TORCH_HOME/hub/checkpoints/<file> (where torch.hub
# keeps its downloads). Every URL serves the same bytes; the SHA-256 is checked after download.
INPAINTERS = {
    "big-lama": {
        "file": "big-lama.pt",
        "urls": (
            "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt",
            "https://huggingface.co/fashn-ai/LaMa/resolve/main/big-lama.pt",
        ),
        "sha256": "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c",
        "bytes": 205_803_670,
        "license": "Apache-2.0",
    },
}
DEFAULT_INPAINTER = "big-lama"

_IMAGENET_MEAN = (0.485, 0.456, 0.406)
_IMAGENET_STD = (0.229, 0.224, 0.225)


def _to_tensor_batch(frames, device, dtype):
    """uint8 (B,H,W,3) or list of (H,W,3) -> float tensor (B,3,H,W) in [0,1]."""
    import torch

    if isinstance(frames, np.ndarray) and frames.ndim == 3:
        frames = frames[None]
    arr = np.ascontiguousarray(np.stack(list(frames)) if not isinstance(frames, np.ndarray) else frames)
    t = torch.from_numpy(arr).to(device)
    t = t.permute(0, 3, 1, 2).to(dtype) / 255.0
    return t


def _normalize(t):
    import torch

    mean = torch.tensor(_IMAGENET_MEAN, device=t.device, dtype=t.dtype).view(1, 3, 1, 1)
    std = torch.tensor(_IMAGENET_STD, device=t.device, dtype=t.dtype).view(1, 3, 1, 1)
    return (t - mean) / std


def depth_input_size(h: int, w: int, short_side: int = 518, multiple: int = 14) -> tuple[int, int]:
    """Network input size: short side ~short_side, aspect kept, both sides multiples of 14."""
    s = short_side / min(h, w)
    nh = max(multiple, int(round(h * s / multiple)) * multiple)
    nw = max(multiple, int(round(w * s / multiple)) * multiple)
    return nh, nw


class DepthEstimator:
    """Batched monocular depth. Returns float32 maps resized to the requested output size."""

    def __init__(self, name: str = DEFAULT_FRAME_DEPTH, device: str | None = None, short_side: int = 518):
        import torch
        from transformers import AutoModelForDepthEstimation

        if name not in DEPTH_MODELS:
            raise ValueError(f"unknown depth model {name!r}; choose from {sorted(DEPTH_MODELS)}")
        self.name = name
        self.repo = DEPTH_MODELS[name]
        self.metric = name.startswith("metric")
        self.device = device or pick_device()
        self.dtype = inference_dtype(self.device)
        self.short_side = short_side
        try:
            model = AutoModelForDepthEstimation.from_pretrained(self.repo, local_files_only=True)
        except OSError:
            model = AutoModelForDepthEstimation.from_pretrained(self.repo)
        self.model = model.to(self.device, dtype=self.dtype).eval()
        self._torch = torch

    def __call__(self, frames, out_hw: tuple[int, int] | None = None) -> np.ndarray:
        torch = self._torch
        x = _to_tensor_batch(frames, self.device, self.dtype)
        b, _, h, w = x.shape
        nh, nw = depth_input_size(h, w, self.short_side)
        with torch.inference_mode():
            x = torch.nn.functional.interpolate(x, size=(nh, nw), mode="bicubic", align_corners=False, antialias=True)
            x = _normalize(x.clamp(0, 1))
            pred = self.model(pixel_values=x).predicted_depth
            if pred.ndim == 3:
                pred = pred[:, None]
            oh, ow = out_hw if out_hw else (h, w)
            pred = torch.nn.functional.interpolate(pred.float(), size=(oh, ow), mode="bilinear", align_corners=False)
            out = pred[:, 0].float().cpu().numpy()
        return out.astype(np.float32)


class PersonSegmenter:
    """Soft person probability per pixel, (B,H,W) float32 in [0,1]."""

    PERSON = 15

    def __init__(self, name: str = DEFAULT_SEGMENTER, device: str | None = None, short_side: int = 520):
        import torch
        from torchvision.models import segmentation as seg

        self.name = name
        self.device = device or pick_device()
        self.dtype = inference_dtype(self.device)
        self.short_side = short_side
        if name == "deeplabv3-mobilenet":
            weights = seg.DeepLabV3_MobileNet_V3_Large_Weights.DEFAULT
            model = seg.deeplabv3_mobilenet_v3_large(weights=weights, aux_loss=True)
        elif name == "deeplabv3-resnet50":
            weights = seg.DeepLabV3_ResNet50_Weights.DEFAULT
            model = seg.deeplabv3_resnet50(weights=weights, aux_loss=True)
        else:
            raise ValueError(f"unknown segmenter {name!r}; choose from {PERSON_SEGMENTERS}")
        self.model = model.to(self.device, dtype=self.dtype).eval()
        self._torch = torch

    def __call__(self, frames, out_hw: tuple[int, int] | None = None) -> np.ndarray:
        torch = self._torch
        x = _to_tensor_batch(frames, self.device, self.dtype)
        b, _, h, w = x.shape
        s = self.short_side / min(h, w)
        nh, nw = max(8, int(round(h * s / 8)) * 8), max(8, int(round(w * s / 8)) * 8)
        with torch.inference_mode():
            x = torch.nn.functional.interpolate(x, size=(nh, nw), mode="bilinear", align_corners=False, antialias=True)
            logits = self.model(_normalize(x))["out"].float()
            prob = torch.softmax(logits, dim=1)[:, self.PERSON : self.PERSON + 1]
            oh, ow = out_hw if out_hw else (h, w)
            prob = torch.nn.functional.interpolate(prob, size=(oh, ow), mode="bilinear", align_corners=False)
            out = prob[:, 0].clamp(0, 1).cpu().numpy()
        return out.astype(np.float32)


def _offline() -> bool:
    return any(os.environ.get(k, "").strip().lower() in ("1", "true", "yes", "on") for k in ("HF_HUB_OFFLINE", "TW_OFFLINE"))


def _sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def inpainter_weights(name: str = DEFAULT_INPAINTER, download: bool = True, timeout: float = 30.0) -> Path:
    """Local path of an inpainter's TorchScript file, downloading it when missing (and allowed).

    Raises FileNotFoundError when the file is not cached and HF_HUB_OFFLINE / TW_OFFLINE is set
    (HiPerGator compute nodes) or download=False, RuntimeError when every URL fails.
    """
    import urllib.request

    if name not in INPAINTERS:
        raise ValueError(f"unknown inpainter {name!r}; choose from {sorted(INPAINTERS)}")
    spec = INPAINTERS[name]
    path = Path(os.environ["TORCH_HOME"]) / "hub" / "checkpoints" / spec["file"]
    if path.is_file() and path.stat().st_size == spec["bytes"]:
        return path
    if not download or _offline():
        raise FileNotFoundError(f"{path} is not cached (run pipeline/common/models.py --prefetch with network access)")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".part{os.getpid()}")
    errors = []
    for url in spec["urls"]:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r, open(tmp, "wb") as f:
                while True:
                    block = r.read(1 << 20)
                    if not block:
                        break
                    f.write(block)
            got = _sha256(tmp)
            if got != spec["sha256"]:
                raise RuntimeError(f"sha256 {got[:12]}... does not match {spec['sha256'][:12]}...")
            os.replace(tmp, path)
            return path
        except Exception as e:  # try the next mirror
            errors.append(f"{url}: {e}")
        finally:
            if tmp.exists():
                tmp.unlink()
    raise RuntimeError(f"could not download {spec['file']}: " + "; ".join(errors))


class Inpainter:
    """Big LaMa inpainting: fills the masked pixels of an RGB image.

    Runs in fp32: the Fourier convolution blocks need it (cuFFT half precision only takes
    power-of-two sizes, and the fills lose contrast in fp16). The input is reflect-padded to
    multiples of 8 and the output cropped back. If the MPS backend rejects the graph, the model
    moves to the CPU once and stays there.
    """

    def __init__(self, name: str = DEFAULT_INPAINTER, device: str | None = None, weights: str | Path | None = None):
        import torch

        self.name = name
        self.device = device or pick_device()
        path = Path(weights) if weights else inpainter_weights(name)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)  # torch.jit is deprecated, still the format LaMa ships in
            self.model = torch.jit.load(str(path), map_location="cpu").eval()
        if self.device != "cpu":
            self.model = self.model.to(self.device)
        self._torch = torch

    def _run(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        torch = self._torch
        h, w = mask.shape
        ph, pw = (-h) % 8, (-w) % 8
        if ph or pw:
            mode = "reflect" if (ph < h and pw < w) else "edge"
            img = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode=mode)
            mask = np.pad(mask, ((0, ph), (0, pw)), mode="edge")
        with torch.inference_mode():
            x = torch.from_numpy(np.ascontiguousarray(img)).to(self.device).permute(2, 0, 1)[None].float() / 255.0
            m = torch.from_numpy(np.ascontiguousarray(mask.astype(np.float32))).to(self.device)[None, None]
            y = self.model(x, m)
            out = (y[0].permute(1, 2, 0).clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
        return out[:h, :w]

    def __call__(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """rgb (H,W,3) uint8, mask (H,W) bool (True = fill). Returns the network's (H,W,3) uint8 output;
        the caller composites it (outside the mask it only approximates the input)."""
        rgb = np.asarray(rgb, np.uint8)
        mask = np.asarray(mask, bool)
        if rgb.shape[:2] != mask.shape:
            raise ValueError(f"image {rgb.shape[:2]} and mask {mask.shape} differ in size")
        try:
            return self._run(rgb, mask)
        except RuntimeError:
            if self.device != "mps":
                raise
            self.model = self.model.to("cpu")
            self.device = "cpu"
            return self._run(rgb, mask)


def prefetch(depth_names=(DEFAULT_FRAME_DEPTH, DEFAULT_PLATE_DEPTH), segmenters=PERSON_SEGMENTERS, inpainters=(DEFAULT_INPAINTER,)) -> None:
    from huggingface_hub import snapshot_download
    from torchvision.models import segmentation as seg

    for name in depth_names:
        repo = DEPTH_MODELS[name]
        t0 = time.time()
        path = snapshot_download(repo, allow_patterns=["*.json", "*.safetensors", "*.txt"])
        print(f"depth  {name:22s} {repo}  ok ({time.time() - t0:.1f}s) -> {path}")
    for name in segmenters:
        weights = {
            "deeplabv3-mobilenet": seg.DeepLabV3_MobileNet_V3_Large_Weights.DEFAULT,
            "deeplabv3-resnet50": seg.DeepLabV3_ResNet50_Weights.DEFAULT,
        }[name]
        t0 = time.time()
        weights.get_state_dict(progress=False)
        print(f"person {name:22s} {weights.url}  ok ({time.time() - t0:.1f}s)")
    for name in inpainters:
        t0 = time.time()
        path = inpainter_weights(name, timeout=120.0)
        print(f"inpaint {name:21s} {INPAINTERS[name]['license']}  ok ({time.time() - t0:.1f}s) -> {path}")
    print(f"HF_HOME={os.environ['HF_HOME']}  TORCH_HOME={os.environ['TORCH_HOME']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefetch", action="store_true", help="download the default weights")
    ap.add_argument("--all", action="store_true", help="with --prefetch: also the relative-depth model")
    args = ap.parse_args(argv)
    if args.prefetch:
        if args.all:
            prefetch(
                depth_names=(DEFAULT_FRAME_DEPTH, DEFAULT_PLATE_DEPTH, "relative-small"),
                segmenters=PERSON_SEGMENTERS,
            )
        else:
            prefetch()
        return 0
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
