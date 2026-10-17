#!/usr/bin/env python3
"""FlashWorld runner: one photo and/or a text prompt -> a walkable Gaussian splat world.

  python pipeline/flashworld_run.py (--image IMG | --prompt TEXT) [--prompt TEXT] --out OUTDIR [--progress progress.json]

Writes OUTDIR/world.spz, thumb.jpg, scene.json (a JobResult with `world`), input_camera.json, input_depth.npy,
request.json and flashworld.json. See docs/FLASHWORLD.md for the formats and the coordinate frames.

Other modes (no GPU needed):
  --emit-request REQ.json      write the FlashWorld request (24 cameras, image embedded) and exit; for the HF Space
  --from-spz WORLD.spz --request REQ.json --out OUTDIR
                               post-process a raw FlashWorld SPZ (e.g. from the Space): prune, level, scale,
                               floor, spawn, thumbnail, input camera and depth, scene.json

Importable: `generate(image=None, prompt=None, out_dir=..., progress=None, **options) -> dict` keeps the model
loaded between calls (the HiPerGator worker uses it). `generate_room(...)` is the entry point for other pipelines
(Third Wheel): it uses the warm worker, this process, or a FlashWorld Python, whichever is available.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import splat_io as sio  # noqa: E402

N_FRAMES = 24
RES_LANDSCAPE = (480, 704)  # (H, W)
RES_PORTRAIT = (704, 480)
TRAJECTORIES = ("spin360", "orbit360", "pan180", "forward")
DEFAULT_TRAJECTORY = os.environ.get("FLASHWORLD_TRAJECTORY", "spin360")
DEFAULT_CAMERA_HEIGHT = 1.45
DEFAULT_MAX_SPLATS = int(os.environ.get("FLASHWORLD_MAX_SPLATS", "1000000"))
DEFAULT_SH_DEGREE = 2
TEXT_ONLY_FOV_Y = 60.0
NEUTRAL_CAPTION = "A realistic, detailed, static 3D scene with consistent lighting."
PREPARED_IMAGE_NAME = "input_fw.png"
FW_CKPT_REPO = "imlixinyang/FlashWorld"
FW_CKPT_REVISION = os.environ.get("FLASHWORLD_CKPT_REVISION", "6a8e88c6f88678ac098e4c82675f0aee555d6e5d")
CAPTION_MODEL = os.environ.get("TW_CAPTION_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
CAPTION_INSTRUCTION = (
    "Describe this place in one or two sentences for a 3D scene generator: the kind of place, the main objects, "
    "materials, colours and lighting. Do not mention people, the photo or the camera."
)


def log(msg: str) -> None:
    print(f"[flashworld] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------------------------------------------
# Camera trajectories (OpenGL camera-to-world, metres; view 0 is the input camera at the origin)
# --------------------------------------------------------------------------------------------------------------


def _pose(yaw_deg: float, pitch_deg: float, pos: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    R = sio.rot_y(math.radians(yaw_deg)) @ sio.rot_x(math.radians(pitch_deg))
    return R, np.asarray(pos, np.float64)


def _dir(yaw_deg: float) -> np.ndarray:
    a = math.radians(yaw_deg)
    return np.array([-math.sin(a), 0.0, -math.cos(a)])


def _keyframes(keys: list[tuple[float, float, float, Sequence[float]]], n: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """Piecewise-linear interpolation of (frame, yaw, pitch, position) keys at integer frames 0..n-1."""
    ks = np.array([k[0] for k in keys], np.float64)
    out = []
    for i in range(n):
        yaw = float(np.interp(i, ks, [k[1] for k in keys]))
        pitch = float(np.interp(i, ks, [k[2] for k in keys]))
        pos = [float(np.interp(i, ks, [k[3][j] for k in keys])) for j in range(3)]
        out.append(_pose(yaw, pitch, pos))
    return out


def trajectory(preset: str = "spin360", n: int = N_FRAMES) -> list[tuple[np.ndarray, np.ndarray]]:
    """The camera path FlashWorld generates along. See docs/FLASHWORLD.md section 4 for the reasoning."""
    if n != N_FRAMES:
        raise ValueError(f"FlashWorld presets are defined for {N_FRAMES} views")
    poses: list[tuple[np.ndarray, np.ndarray]] = []
    if preset == "spin360":
        r = 0.3
        for k in range(16):
            yaw = 22.5 * k
            pitch = -10.0 * (1 - math.cos(2 * math.pi * k / 16)) / 2
            poses.append(_pose(yaw, pitch, r * (_dir(yaw) - _dir(0))))
        for j in range(1, 9):
            poses.append(_pose(-20.0 + 40.0 * (j - 1) / 7, -8.0, [0.0, 0.0, -0.2 * j]))
    elif preset == "orbit360":
        R = 0.6
        for k in range(18):
            th = 20.0 * k
            a = math.radians(th)
            pitch = -6.0 * (1 - math.cos(a)) / 2
            poses.append(_pose(th, pitch, [-R + R * math.cos(a), 0.0, -R * math.sin(a)]))
        for j in range(1, 7):
            poses.append(_pose(-15.0 + 30.0 * (j - 1) / 5, -6.0, [0.0, 0.0, -0.1 - 0.25 * (j - 1)]))
    elif preset == "pan180":
        poses = _keyframes(
            [(0, 0, 0, (0, 0, 0)), (5, 75, -4, (0, 0, -0.1)), (16, -90, -6, (0, 0, -0.5)), (23, 0, -6, (0, 0, -1.2))], n
        )
    elif preset == "forward":
        for k in range(n):
            f = k / (n - 1)
            poses.append(_pose(25.0 * math.sin(2 * math.pi * f), -5.0 * math.sin(math.pi * f), [0.0, 0.0, -2.0 * f]))
    else:
        raise ValueError(f"unknown trajectory {preset!r} (one of {', '.join(TRAJECTORIES)})")
    R0, t0 = poses[0]
    assert np.allclose(R0, np.eye(3)) and np.allclose(t0, 0), "view 0 must be the input camera"
    return poses


# --------------------------------------------------------------------------------------------------------------
# Images and intrinsics
# --------------------------------------------------------------------------------------------------------------


def _register_heif() -> None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass


def load_image(image: Any):
    """Path, PIL image or HxWx3 uint8 array -> (PIL RGB image, EXIF 35 mm focal length or None)."""
    from PIL import Image, ImageOps

    if isinstance(image, (str, Path)):
        _register_heif()
        im = Image.open(image)
        f35 = exif_focal_35mm(im)
        im = ImageOps.exif_transpose(im)
    elif isinstance(image, np.ndarray):
        im, f35 = Image.fromarray(image.astype(np.uint8)), None
    else:
        im, f35 = image, None
    return im.convert("RGB"), f35


def exif_focal_35mm(im) -> float | None:
    try:
        exif = im.getexif()
        sub = exif.get_ifd(0x8769)
        v = sub.get(41989) or exif.get(41989)
        v = float(v) if v else None
        return v if v and 8 <= v <= 400 else None
    except Exception:
        return None


def focal_px(width: int, height: int, f35: float | None = None, hfov_deg: float | None = None) -> float:
    """Focal length in pixels: from an explicit horizontal FOV, from EXIF 35 mm-equivalent focal length, or a
    default (26 mm-equivalent phone main camera; 70 degrees horizontal for wide frames without EXIF)."""
    if hfov_deg:
        return 0.5 * width / math.tan(math.radians(hfov_deg) / 2)
    if f35:
        return f35 * math.hypot(width, height) / math.hypot(36.0, 24.0)
    if width / max(height, 1) >= 1.7:
        return 0.5 * width / math.tan(math.radians(70.0) / 2)
    return 26.0 * math.hypot(width, height) / math.hypot(36.0, 24.0)


def choose_resolution(width: int, height: int, orientation: str = "auto") -> tuple[int, int]:
    if orientation == "portrait" or (orientation == "auto" and height > width * 1.05):
        return RES_PORTRAIT
    return RES_LANDSCAPE


def prepare_image(im, res: tuple[int, int], K: dict):
    """Center-crops to the target aspect and resizes to res=(H, W). Returns (image, crop box, target intrinsics)."""
    from PIL import Image

    H, W = res
    w, h = im.size
    if w / h > W / H:
        cw, ch = int(round(h * W / H)), h
    else:
        cw, ch = w, int(round(w * H / W))
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    out = im.crop((x0, y0, x0 + cw, y0 + ch)).resize((W, H), Image.LANCZOS)
    sx, sy = W / cw, H / ch
    Kt = {"fx": K["fx"] * sx, "fy": K["fy"] * sy, "cx": (K["cx"] - x0) * sx, "cy": (K["cy"] - y0) * sy}
    return out, {"x": x0, "y": y0, "w": cw, "h": ch}, Kt


def _png_data_url(im) -> str:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# --------------------------------------------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------------------------------------------


def build_request(
    image: Any = None,
    prompt: str | None = None,
    trajectory_name: str = DEFAULT_TRAJECTORY,
    orientation: str = "auto",
    hfov: float | None = None,
    intrinsics: dict | None = None,
    embed_image: bool = True,
) -> tuple[dict, dict]:
    """Builds the FlashWorld request JSON (docs/FLASHWORLD.md section 2) and our metadata.

    `intrinsics` ({fx, fy, cx, cy} in pixels of the original image) overrides the focal guess, so a caller with a
    calibrated camera (Third Wheel's video) gets a room in exactly that camera's frame."""
    im = None
    f35 = None
    if image is not None:
        im, f35 = load_image(image)
    if im is not None:
        w, h = im.size
        if intrinsics:
            K = {k: float(intrinsics[k]) for k in ("fx", "fy", "cx", "cy")}
        else:
            f = focal_px(w, h, f35, hfov)
            K = {"fx": f, "fy": f, "cx": w / 2.0, "cy": h / 2.0}
        res = choose_resolution(w, h, orientation)
        img_t, crop, Kt = prepare_image(im, res, K)
    else:
        res = RES_PORTRAIT if orientation == "portrait" else RES_LANDSCAPE
        H, W = res
        if hfov:
            f = 0.5 * W / math.tan(math.radians(hfov) / 2)
        else:
            f = 0.5 * H / math.tan(math.radians(TEXT_ONLY_FOV_Y) / 2)
        w, h = W, H
        K = {"fx": f, "fy": f, "cx": W / 2.0, "cy": H / 2.0}
        img_t, crop, Kt = None, {"x": 0, "y": 0, "w": W, "h": H}, dict(K)
    H, W = res
    poses = trajectory(trajectory_name)
    cams = []
    for R, t in poses:
        cams.append(
            {
                "position": [round(float(v), 6) + 0.0 for v in t],
                "quaternion": sio.matrix_to_quat_wxyz(R),
                "fx": round(Kt["fx"], 4),
                "fy": round(Kt["fy"], 4),
                "cx": round(Kt["cx"], 4),
                "cy": round(Kt["cy"], 4),
            }
        )
    text = (prompt or "").strip()
    # Without embedding, image_prompt names the prepared image file generate() writes next to request.json.
    req = {
        "image_prompt": (_png_data_url(img_t) if embed_image else PREPARED_IMAGE_NAME) if img_t is not None else None,
        "text_prompt": text,
        "image_index": 0,
        "resolution": [N_FRAMES, H, W],
        "cameras": cams,
    }
    meta = {
        "trajectory": trajectory_name,
        "resolution": [N_FRAMES, H, W],
        "original": {"width": w, "height": h, **{k: round(v, 4) for k, v in K.items()}},
        "crop": crop,
        "target": {k: round(v, 4) for k, v in Kt.items()},
        "focal35mm": f35,
        "hasImage": img_t is not None,
    }
    req["thirdwheel"] = meta  # ignored by FlashWorld; lets --from-spz recover the original camera
    return req, {"meta": meta, "image": img_t, "original_image": im, "poses": poses}


def cameras_tensor_rows(req: dict) -> np.ndarray:
    """[N, 11] rows as FlashWorld's GenerationSystem.generate expects: quat wxyz, position, fx/W, fy/H, cx/W, cy/H."""
    _, H, W = req["resolution"]
    rows = []
    for c in req["cameras"]:
        q = c["quaternion"]
        p = c["position"]
        rows.append([q[0], q[1], q[2], q[3], p[0], p[1], p[2], c["fx"] / W, c["fy"] / H, c["cx"] / W, c["cy"] / H])
    return np.asarray(rows, np.float32)


def request_poses(req: dict) -> list[np.ndarray]:
    """Camera-to-world 4x4 (OpenGL) of every request camera, relative to camera 0 (FlashWorld's output frame)."""
    mats = [sio.pose_matrix(sio.quat_wxyz_to_matrix(c["quaternion"]), c["position"]) for c in req["cameras"]]
    inv0 = np.linalg.inv(mats[0])
    return [inv0 @ m for m in mats]


# --------------------------------------------------------------------------------------------------------------
# Captioning (optional)
# --------------------------------------------------------------------------------------------------------------


class Captioner:
    """Qwen2.5-VL captioner, loaded on first use. Any failure disables it and returns None."""

    def __init__(self, model_id: str = CAPTION_MODEL, device: str = "cuda"):
        self.model_id = model_id
        self.device = device
        self.model = None
        self.processor = None
        self.disabled = False

    def _load(self) -> bool:
        if self.model is not None:
            return True
        if self.disabled:
            return False
        try:
            import torch
            from transformers import AutoProcessor

            try:
                from transformers import Qwen2_5_VLForConditionalGeneration as VLM
            except ImportError:
                from transformers import AutoModelForImageTextToText as VLM  # type: ignore
            if torch.cuda.is_available():
                free, _ = torch.cuda.mem_get_info()
                if free < 12e9:
                    raise RuntimeError(f"only {free / 1e9:.1f} GB free on the GPU")
            t0 = time.time()
            self.processor = AutoProcessor.from_pretrained(self.model_id, min_pixels=256 * 28 * 28, max_pixels=768 * 28 * 28)
            self.model = VLM.from_pretrained(self.model_id, torch_dtype=torch.bfloat16).to(self.device).eval()
            log(f"captioner {self.model_id} loaded in {time.time() - t0:.1f}s")
            return True
        except Exception as e:
            log(f"captioner unavailable ({e}); using the neutral caption")
            self.disabled = True
            self.model = None
            return False

    def caption(self, im) -> str | None:
        if not self._load():
            return None
        try:
            import torch

            messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": CAPTION_INSTRUCTION}]}]
            text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self.processor(text=[text], images=[im], return_tensors="pt").to(self.device)
            with torch.no_grad():
                out = self.model.generate(**inputs, max_new_tokens=80, do_sample=False)
            new = out[:, inputs["input_ids"].shape[1] :]
            cap = self.processor.batch_decode(new, skip_special_tokens=True)[0].strip()
            cap = " ".join(cap.split())
            return cap[:600] if cap else None
        except Exception as e:
            log(f"captioning failed ({e}); using the neutral caption")
            return None


# --------------------------------------------------------------------------------------------------------------
# FlashWorld model wrapper
# --------------------------------------------------------------------------------------------------------------


def find_flashworld_src() -> Path:
    cands = []
    if os.environ.get("FLASHWORLD_SRC"):
        cands.append(Path(os.environ["FLASHWORLD_SRC"]))
    if os.environ.get("HPG_ROOT"):
        cands.append(Path(os.environ["HPG_ROOT"]) / "src" / "FlashWorld")
    cands += [HERE.parent / "third_party" / "FlashWorld", HERE.parent.parent / "FlashWorld"]
    for c in cands:
        if (c / "app.py").is_file() and (c / "utils.py").is_file():
            return c.resolve()
    raise RuntimeError(
        "FlashWorld source not found; set FLASHWORLD_SRC to a checkout of "
        "https://github.com/imlixinyang/FlashWorld (hpg/setup.sh clones it to $HPG_ROOT/src/FlashWorld)"
    )


def _stub_web_modules() -> None:
    """FlashWorld's app.py imports gradio/fastapi/uvicorn at module level but only uses them under __main__."""
    import types

    for name in ("gradio", "uvicorn", "fastapi", "fastapi.staticfiles", "fastapi.responses"):
        try:
            __import__(name)
        except Exception:
            mod = types.ModuleType(name)
            mod.FastAPI = mod.StaticFiles = mod.FileResponse = object  # type: ignore[attr-defined]
            sys.modules[name] = mod


def fp8_supported(device: str = "cuda") -> bool:
    try:
        import torch

        a = torch.randn(32, 64, device=device).to(torch.float8_e4m3fn)
        b = torch.randn(32, 64, device=device).to(torch.float8_e4m3fn)
        one = torch.tensor(1.0, device=device)
        torch._scaled_mm(a, b.t(), out_dtype=torch.bfloat16, scale_a=one, scale_b=one)
        torch.cuda.synchronize()
        return True
    except Exception as e:
        log(f"native FP8 matmul unavailable ({str(e).splitlines()[0][:120]}); using the dequantised path")
        return False


def choose_offload(mode: str = "auto") -> tuple[bool, bool, bool]:
    """(offload_t5, offload_vae, offload_transformer_during_vae) for the GPU we are on."""
    if mode == "none":
        return False, False, False
    if mode == "t5":
        return True, False, False
    if mode == "t5+transformer":
        return True, False, True
    if mode == "all":
        return True, True, False
    import torch

    total = torch.cuda.get_device_properties(0).total_memory / 1e9
    if total >= 60:
        return False, False, False
    if total >= 34:
        return True, False, False
    if total >= 22:
        return True, False, True
    return True, True, False


class FlashWorld:
    """Loads FlashWorld once and turns requests into Splats (file frame = camera 0, request units)."""

    def __init__(self, device: str = "cuda", offload: str = "auto", ckpt: str | None = None):
        self.device = device
        self.offload_mode = offload
        self.ckpt = ckpt or os.environ.get("FLASHWORLD_CKPT")
        self.system = None
        self.load_seconds = 0.0
        self.fp8_native = None
        self.lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self.system is not None

    def load(self) -> None:
        if self.system is not None:
            return
        t0 = time.time()
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("FlashWorld needs a CUDA GPU (none visible)")
        src = find_flashworld_src()
        # FlashWorld imports its own top-level `app`, `utils`, `models`, `quant`: its checkout must win.
        for name in ("app", "utils", "models", "quant"):
            mod = sys.modules.get(name)
            f = getattr(mod, "__file__", None) or ""
            if mod is not None and not f.startswith(str(src)):
                del sys.modules[name]
        if str(src) in sys.path:
            sys.path.remove(str(src))
        sys.path.insert(0, str(src))
        try:
            import spaces  # noqa: F401

            raise RuntimeError("the `spaces` package is installed; uninstall it (it switches FlashWorld to HF Spaces mode)")
        except ImportError:
            pass
        _stub_web_modules()
        try:
            import gsplat  # noqa: F401
        except ImportError as e:
            raise RuntimeError(f"gsplat is not installed in this environment ({e})")
        import app as fw_app  # FlashWorld's app.py

        if getattr(fw_app, "mode", "Local") != "Local":
            raise RuntimeError(f"FlashWorld is in {fw_app.mode} mode")
        ckpt = self.ckpt
        if not ckpt:
            from huggingface_hub import hf_hub_download

            ckpt = hf_hub_download(FW_CKPT_REPO, "model.ckpt", revision=FW_CKPT_REVISION)
        off_t5, off_vae, off_tr = choose_offload(self.offload_mode)
        log(f"loading FlashWorld from {src} (ckpt {ckpt}; offload t5={off_t5} vae={off_vae} transformer={off_tr})")
        dev = torch.device(self.device)
        self.system = fw_app.GenerationSystem(
            ckpt_path=ckpt, device=dev, offload_t5=off_t5, offload_vae=off_vae, offload_transformer_during_vae=off_tr
        )
        self.fp8_native = fp8_supported(self.device)
        if not self.fp8_native:
            for m in self.system.modules():
                if hasattr(m, "native_fp8_support"):
                    m.native_fp8_support = False
        self.load_seconds = time.time() - t0
        log(f"FlashWorld ready in {self.load_seconds:.1f}s on {torch.cuda.get_device_name(0)}")

    def generate(self, req: dict, image_t=None, seed: int = 0) -> tuple[sio.Splats, dict]:
        """Runs one request. `image_t` is the prepared W x H PIL image (or None for text only)."""
        import torch

        self.load()
        n, H, W = req["resolution"]
        cams = torch.from_numpy(cameras_tensor_rows(req))
        img = None
        if image_t is not None:
            arr = np.asarray(image_t, np.float32) / 255.0 * 2 - 1
            img = torch.from_numpy(arr).permute(2, 0, 1).contiguous()
        text = req.get("text_prompt") or ""
        with self.lock:
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            torch.cuda.synchronize()
            t0 = time.time()
            scene, _ref, t_norm = self.system.generate(cams, n, img, text, int(req.get("image_index", 0)), H, W)
            torch.cuda.synchronize()
            gen_s = time.time() - t0
            sp = scene.detach().float()
            k = float(t_norm.reshape(-1)[0].item()) + 0.01
            dim = sp.shape[-1]
            n_sh = (dim - 11) // 3
            xyz, op, sc, rot, feat = sp.split([3, 1, 3, 4, dim - 11], dim=-1)
            splats = sio.Splats(
                (xyz * k).cpu().numpy(),
                (sc * k).cpu().numpy(),
                torch.nn.functional.normalize(rot, dim=-1).cpu().numpy(),
                op[:, 0].cpu().numpy(),
                feat[:, :3].cpu().numpy(),
                feat[:, 3:].reshape(-1, n_sh - 1, 3).cpu().numpy() if n_sh > 1 else None,
            )
            del scene, sp
            torch.cuda.empty_cache()
        return splats, {"generateSeconds": round(gen_s, 2), "tNorm": round(k - 0.01, 5), "rawSplats": len(splats)}


_MODEL: FlashWorld | None = None
_CAPTIONER: Captioner | None = None


def get_model(offload: str = "auto") -> FlashWorld:
    global _MODEL
    if _MODEL is None:
        _MODEL = FlashWorld(offload=offload)
    return _MODEL


def get_captioner() -> Captioner:
    global _CAPTIONER
    if _CAPTIONER is None:
        _CAPTIONER = Captioner()
    return _CAPTIONER


# --------------------------------------------------------------------------------------------------------------
# Post-processing: splats -> files
# --------------------------------------------------------------------------------------------------------------


def _depth_size(w: int, h: int, long_side: int = 1024) -> tuple[int, int]:
    s = min(1.0, long_side / max(w, h))
    return max(1, int(round(w * s))), max(1, int(round(h * s)))


def finish_world(
    splats: sio.Splats,
    req: dict,
    out_dir: Path,
    original_image=None,
    progress: sio.Progress | None = None,
    camera_height: float = DEFAULT_CAMERA_HEIGHT,
    max_splats: int | None = DEFAULT_MAX_SPLATS,
    sh_degree: int = DEFAULT_SH_DEGREE,
    caption_text: str | None = None,
    extra_diag: dict | None = None,
    write_ply: bool = False,
    prefer_gpu: bool = True,
) -> dict:
    """Prunes, places and writes a FlashWorld world. `splats` are in camera-0 frame, request units."""
    prog = progress or sio.Progress(None)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    meta = req.get("thirdwheel") or {}
    poses = request_poses(req)
    idx_cam = int(req.get("image_index", 0))
    cam_in = poses[idx_cam]
    prog("Cleaning up the world", 0.0)
    raw_count = len(splats)
    keep = sio.prune_indices(splats, max_splats, cameras=np.array([p[:3, 3] for p in poses]))
    splats = splats.subset(keep)
    prog("Finding the floor", 0.2)
    place = sio.place_world(splats.means, splats.opacities, cam_in, camera_height=camera_height, scale_limits=(0.3, 3.0), fallback_scale=1.0)
    s = place["scale"]
    prog("Saving the world", 0.35)
    sio.write_spz(out_dir / "world.spz", splats, sh_degree=sh_degree)
    if write_ply:
        sio.write_ply(out_dir / "world.ply", splats, sh_degree=sh_degree)

    # Input camera, depth and thumbnail.
    orig = meta.get("original") or {}
    _, H, W = req["resolution"]
    ow, oh = int(orig.get("width") or W), int(orig.get("height") or H)
    K = {k: float(orig.get(k, req["cameras"][idx_cam][k])) for k in ("fx", "fy", "cx", "cy")}
    dw, dh = _depth_size(ow, oh, 1024)
    sx, sy = dw / ow, dh / oh
    prog("Measuring the room", 0.5)
    tensors: dict = {}
    # Pixel-corner convention (pixel i spans [i, i+1)), as in gsplat and FlashWorld: intrinsics scale directly.
    r = sio.render(splats, cam_in, K["fx"] * sx, K["fy"] * sy, K["cx"] * sx, K["cy"] * sy, dw, dh,
                   prefer_gpu=prefer_gpu, tensors=tensors)
    depth = (r.depth * s).astype(np.float32)
    depth[r.alpha < 0.5] = 0.0
    np.save(out_dir / "input_depth.npy", depth)
    prog("Making the thumbnail", 0.75)
    tw = 640
    th = max(1, int(round(oh * tw / ow)))
    tsx, tsy = tw / ow, th / oh
    thumb_src = "render"
    if r.backend == "gsplat":
        tr = sio.render(splats, cam_in, K["fx"] * tsx, K["fy"] * tsy, K["cx"] * tsx, K["cy"] * tsy, tw, th,
                        prefer_gpu=True, tensors=tensors)
        thumb = tr.rgb
    elif original_image is not None:
        iw, ih = original_image.size
        thumb = np.asarray(original_image.resize((tw, max(1, int(round(ih * tw / iw))))))
        thumb_src = "photo"
    else:
        thumb = sio.render_points(splats, cam_in, K["fx"] * tsx, K["fy"] * tsy, K["cx"] * tsx, K["cy"] * tsy, tw, th).rgb
    sio.save_jpeg(out_dir / "thumb.jpg", thumb, quality=86)
    del tensors

    cam_json = {
        "width": ow,
        "height": oh,
        **{k: round(v, 4) for k, v in K.items()},
        "position": place["camera"]["position"],
        "quaternion": place["camera"]["quaternion"],
        "depthWidth": dw,
        "depthHeight": dh,
        "crop": meta.get("crop") or {"x": 0, "y": 0, "w": ow, "h": oh},
        "convention": "OpenGL camera (looks down -Z, +Y up) in the viewer frame; intrinsics in pixels of width x height",
    }
    sio.write_json_atomic(out_dir / "input_camera.json", cam_json)

    world = {
        "file": "world.spz",
        "transform": place["transform"],
        "floorY": place["floorY"],
        "spawn": place["spawn"],
        "bounds": place["bounds"],
        "source": "flashworld",
        "splatCount": len(splats),
    }
    text = (caption_text or "").strip()
    has_image = bool(meta["hasImage"]) if "hasImage" in meta else bool(req.get("image_prompt"))
    if has_image:
        caption = "Generated from one photo: the rest of the room was imagined."
    else:
        caption = "Generated from your prompt."
    result = {"world": world, "thumb": "thumb.jpg", "caption": caption}
    sio.write_json_atomic(out_dir / "scene.json", result)
    diag = {
        "trajectory": meta.get("trajectory"),
        "resolution": req["resolution"],
        "text": text,
        "rawSplats": raw_count,
        "keptSplats": len(splats),
        "shDegree": min(sh_degree, splats.sh_degree),
        "placement": {k: v for k, v in place.items() if k not in ("bounds",)},
        "render": r.backend,
        "thumb": thumb_src,
        "depthValidFraction": float(np.mean(depth > 0)),
        "postSeconds": round(time.time() - t0, 2),
        **(extra_diag or {}),
    }
    sio.write_json_atomic(out_dir / "flashworld.json", diag)
    prog("Done", 1.0)
    return result


def _request_for_disk(req: dict, image_name: str | None) -> dict:
    r = dict(req)
    if r.get("image_prompt"):
        r["image_prompt"] = image_name or "input.png"
    return r


# --------------------------------------------------------------------------------------------------------------
# Public entry points
# --------------------------------------------------------------------------------------------------------------


def generate(
    image: Any = None,
    prompt: str | None = None,
    out_dir: str | Path = "out",
    progress: Any = None,
    *,
    trajectory_name: str | None = None,
    seed: int = 0,
    camera_height: float = DEFAULT_CAMERA_HEIGHT,
    max_splats: int | None = DEFAULT_MAX_SPLATS,
    sh_degree: int = DEFAULT_SH_DEGREE,
    caption: str = "auto",
    orientation: str = "auto",
    hfov: float | None = None,
    intrinsics: dict | None = None,
    offload: str = "auto",
    write_ply: bool = False,
) -> dict:
    """Image and/or prompt -> world files in out_dir. Returns the JobResult dict (also written to scene.json).

    progress: a progress.json path, a callable(stage, fraction) or None. The model stays loaded across calls."""
    if image is None and not (prompt and prompt.strip()):
        raise ValueError("give an image, a prompt, or both")
    prog = progress if isinstance(progress, sio.Progress) else sio.Progress(progress)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    traj = trajectory_name or DEFAULT_TRAJECTORY
    t_start = time.time()
    prog("Preparing the input", 0.01)
    model = get_model(offload)
    if not model.loaded:
        prog("Warming up the world model (the first run takes a minute or two)", 0.03)
        model.load()
    text = (prompt or "").strip()
    cap_src = "prompt" if text else None
    req, extra = build_request(image, text, traj, orientation, hfov, intrinsics, embed_image=False)
    if image is not None and not text:
        if caption == "auto":
            prog("Describing the photo", 0.12)
            c = get_captioner().caption(extra["image"])
            text, cap_src = (c, "captioner") if c else (NEUTRAL_CAPTION, "neutral")
        elif caption and caption != "none":
            text, cap_src = caption, "given"
        else:
            text, cap_src = NEUTRAL_CAPTION, "neutral"
        req["text_prompt"] = text
    log(f"text ({cap_src}): {text}")
    if extra["image"] is not None:
        extra["image"].save(out_dir / PREPARED_IMAGE_NAME)
    sio.write_json_atomic(out_dir / "request.json", _request_for_disk(req, PREPARED_IMAGE_NAME))
    prog("Generating the world", 0.2)
    splats, gen = model.generate(req, extra["image"], seed=seed)
    log(f"generated {gen['rawSplats']} splats in {gen['generateSeconds']}s (T_norm {gen['tNorm']})")
    result = finish_world(
        splats, req, out_dir, extra["original_image"], prog.sub(0.8, 0.99), camera_height, max_splats, sh_degree, text,
        extra_diag={**gen, "loadSeconds": round(model.load_seconds, 1), "captionSource": cap_src, "seed": seed,
                    "fp8Native": model.fp8_native},
        write_ply=write_ply,
    )
    diag = sio.read_json(out_dir / "flashworld.json", {}) or {}
    diag["totalSeconds"] = round(time.time() - t_start, 2)
    sio.write_json_atomic(out_dir / "flashworld.json", diag)
    return result


def postprocess_spz(spz_path: str | Path, request: dict | str | Path, out_dir: str | Path, progress: Any = None, **kw) -> dict:
    """Raw FlashWorld SPZ (for example from the HF Space) + the request that produced it -> our output files.

    The Space exports in T_norm units (docs/FLASHWORLD.md section 3); we rescale to request units first."""
    req = request if isinstance(request, dict) else json.loads(Path(request).read_text())
    splats = sio.read_splats(spz_path)
    poses = request_poses(req)
    t_norm = max(float(np.linalg.norm(p[:3, 3])) for p in poses)
    if t_norm > 0:
        k = (t_norm + 0.01) / t_norm
        splats.means *= k
        splats.scales *= k
    orig = None
    ip = req.get("image_prompt")
    if ip and isinstance(ip, str) and ip.startswith("data:"):
        from PIL import Image

        orig = Image.open(io.BytesIO(base64.b64decode(ip.split(",", 1)[1]))).convert("RGB")
    prog = progress if isinstance(progress, sio.Progress) else sio.Progress(progress)
    return finish_world(splats, req, Path(out_dir), orig, prog, extra_diag={"source": str(spz_path)}, **kw)


def submit_to_worker(image: str | Path, prompt: str | None, out_dir: str | Path, requests_dir: str | Path,
                     progress: Any = None, timeout: float = 900.0, params: dict | None = None) -> dict:
    """Hands a room request to the warm HiPerGator worker (hpg/worker.py) and waits for it."""
    rq = Path(requests_dir)
    rq.mkdir(parents=True, exist_ok=True)
    rid = f"{int(time.time() * 1000)}-{os.getpid()}"
    tmp = rq / f".{rid}.tmp"
    tmp.mkdir()
    sio.write_json_atomic(tmp / "request.json", {
        "image": str(Path(image).resolve()) if image else None,
        "prompt": prompt,
        "out_dir": str(Path(out_dir).resolve()),
        "params": params or {},
    })
    os.rename(tmp, rq / rid)
    prog = progress if isinstance(progress, sio.Progress) else sio.Progress(progress)
    t0 = time.time()
    last = None
    while True:
        d = rq / rid
        if (d / "DONE").exists():
            return json.loads((Path(out_dir) / "scene.json").read_text())
        if (d / "FAILED").exists():
            raise RuntimeError((d / "FAILED").read_text().strip() or "the worker failed to generate the room")
        p = sio.read_json(d / "progress.json")
        if isinstance(p, dict) and (p.get("stage"), p.get("progress")) != last:
            last = (p.get("stage"), p.get("progress"))
            prog(p.get("stage"), p.get("progress"))
        if time.time() - t0 > timeout:
            raise TimeoutError(f"the GPU worker did not finish the room within {timeout:.0f}s")
        time.sleep(1.0)


def generate_room(image: str | Path | None, prompt: str | None, out_dir: str | Path, progress: Any = None,
                  timeout: float = 1200.0, **params) -> dict:
    """For other pipelines (Third Wheel): same outputs as generate(), wherever a FlashWorld GPU is reachable.

    Order: the warm worker (TW_FW_REQUESTS set by hpg/worker.py), this process if FlashWorld can load here
    (CUDA + FLASHWORLD_SRC), a FlashWorld Python (TW_PY_FLASHWORLD) as a subprocess. Raises RuntimeError when
    none is available so the caller can fall back (plate_room.py)."""
    req_dir = os.environ.get("TW_FW_REQUESTS")
    if req_dir and image:
        return submit_to_worker(image, prompt, out_dir, req_dir, progress, timeout, params)
    if _can_run_here():
        return generate(image, prompt, out_dir, progress, **kwargs_from_params(params))
    py = os.environ.get("TW_PY_FLASHWORLD")
    if py and Path(py).exists():
        cmd = [py, "-u", str(Path(__file__).resolve()), "--out", str(out_dir)]
        if image:
            cmd += ["--image", str(image)]
        if prompt:
            cmd += ["--prompt", prompt]
        prog_file = Path(out_dir) / "fw_progress.json"
        cmd += ["--progress", str(prog_file)] + _cli_from_params(params)
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen(cmd)
        prog = progress if isinstance(progress, sio.Progress) else sio.Progress(progress)
        t0 = time.time()
        while proc.poll() is None:
            p = sio.read_json(prog_file)
            if isinstance(p, dict):
                prog(p.get("stage"), p.get("progress"))
            if time.time() - t0 > timeout:
                proc.kill()
                raise TimeoutError("FlashWorld subprocess timed out")
            time.sleep(1.0)
        if proc.returncode != 0:
            raise RuntimeError(f"FlashWorld subprocess failed (exit {proc.returncode})")
        return json.loads((Path(out_dir) / "scene.json").read_text())
    raise RuntimeError("no FlashWorld GPU available (no worker, no CUDA here, TW_PY_FLASHWORLD unset)")


def _can_run_here() -> bool:
    try:
        import torch

        if not torch.cuda.is_available():
            return False
        find_flashworld_src()
        import gsplat  # noqa: F401

        return True
    except Exception:
        return False


_PARAM_KEYS = {
    "trajectory": "trajectory_name", "seed": "seed", "cameraHeight": "camera_height", "maxSplats": "max_splats",
    "shDegree": "sh_degree", "caption": "caption", "orientation": "orientation", "hfov": "hfov",
    "intrinsics": "intrinsics", "offload": "offload",
}


def kwargs_from_params(params: dict | None) -> dict:
    """Job params (camelCase, from job.json) -> generate() keyword arguments. Unknown keys are ignored."""
    out = {}
    for k, v in (params or {}).items():
        if k in _PARAM_KEYS and v is not None:
            out[_PARAM_KEYS[k]] = v
        elif k in _PARAM_KEYS.values() and v is not None:
            out[k] = v
    if "trajectory_name" in out and out["trajectory_name"] not in TRAJECTORIES:
        out.pop("trajectory_name")
    return out


_kw_from_params = kwargs_from_params


def _cli_from_params(params: dict | None) -> list[str]:
    kw = kwargs_from_params(params)
    flags = {"trajectory_name": "--trajectory", "seed": "--seed", "camera_height": "--camera-height",
             "max_splats": "--max-splats", "sh_degree": "--sh-degree", "caption": "--caption",
             "orientation": "--orientation", "hfov": "--hfov", "offload": "--offload"}
    out: list[str] = []
    for k, v in kw.items():
        if k in flags:
            out += [flags[k], str(v)]
        elif k == "intrinsics":
            out += ["--intrinsics", json.dumps(v)]
    return out


# --------------------------------------------------------------------------------------------------------------
# Input selection (several photos or a video)
# --------------------------------------------------------------------------------------------------------------


def _sharpness(im) -> float:
    """Variance of the Laplacian at a working width of at most 640 px."""
    w, h = im.size
    s = min(1.0, 640 / w)
    g = np.asarray(im.convert("L").resize((max(1, int(w * s)), max(1, int(h * s)))), np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def pick_best_image(paths: Sequence[str | Path]) -> Path:
    if len(paths) == 1:
        return Path(paths[0])
    try:
        from common.frame_pick import best_photo  # the shared pipeline helper when available

        return Path(best_photo([Path(p) for p in paths])[0])
    except Exception:
        pass
    best, best_s = None, -1.0
    for p in paths:
        try:
            im, _ = load_image(p)
            sc = math.log1p(_sharpness(im)) * min(1.0, 0.7 + 0.3 * im.size[0] * im.size[1] / (1280 * 720))
        except Exception:
            continue
        if sc > best_s:
            best, best_s = Path(p), sc
    if best is None:
        raise ValueError("none of the photos could be read")
    return best


def best_video_frame(video: str | Path, out_png: str | Path, samples: int = 40) -> Path:
    """The sharpest, steadiest frame of a video, saved as PNG."""
    try:
        from common.frame_pick import best_video_frame as shared_pick

        pick = shared_pick(Path(video))
        from PIL import Image

        Image.fromarray(pick.image).save(out_png)
        return Path(out_png)
    except Exception:
        pass
    from PIL import Image

    tmpd = Path(tempfile.mkdtemp(prefix="fwframes-"))
    try:
        dur = 0.0
        try:
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                                       capture_output=True, text=True, timeout=60).stdout.strip() or 0)
        except Exception:
            pass
        fps = max(0.5, min(8.0, samples / dur)) if dur > 0 else 2.0
        try:  # HDR (iPhone HLG/PQ) clips are tone-mapped to SDR; empty for SDR video
            from common.media import sdr_filters

            tone = sdr_filters(video)
        except Exception:
            tone = []
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", ",".join([f"fps={fps:.3f}", *tone]), "-frames:v", str(samples),
                        str(tmpd / "%04d.png")], check=True, timeout=600)
        frames = sorted(tmpd.glob("*.png"))
        if not frames:
            raise RuntimeError("could not decode any frame from the video")
        small = [np.asarray(Image.open(f).convert("L").resize((160, 90)), np.float32) for f in frames]
        scores = []
        for i, f in enumerate(frames):
            sh = math.log1p(_sharpness(Image.open(f)))
            nb = [small[j] for j in (i - 1, i + 1) if 0 <= j < len(small)]
            # Mean absolute change to the neighbouring samples, 0..1: penalises frames taken while moving.
            motion = float(np.mean([np.mean(np.abs(small[i] - b)) / 255.0 for b in nb])) if nb else 0.0
            scores.append(sh - 40.0 * motion)
        best = frames[int(np.argmax(scores))]
        shutil.copy(best, out_png)
        return Path(out_png)
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="FlashWorld: photo and/or prompt -> walkable splat world")
    ap.add_argument("--image", action="append", help="input photo (repeat to let the runner pick the sharpest)")
    ap.add_argument("--video", help="pick the sharpest, steadiest frame of this video as the input photo")
    ap.add_argument("--prompt", help="text prompt (alone: text-to-world; with an image: describes the room)")
    ap.add_argument("--out", help="output directory")
    ap.add_argument("--progress", help="progress.json to keep updated")
    ap.add_argument("--trajectory", default=DEFAULT_TRAJECTORY, choices=TRAJECTORIES)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--camera-height", type=float, default=DEFAULT_CAMERA_HEIGHT, help="input camera height above the floor, metres")
    ap.add_argument("--max-splats", type=int, default=DEFAULT_MAX_SPLATS)
    ap.add_argument("--sh-degree", type=int, default=DEFAULT_SH_DEGREE, choices=[0, 1, 2])
    ap.add_argument("--caption", default="auto", help="auto (captioner, else neutral), none, or the text to use")
    ap.add_argument("--orientation", default="auto", choices=["auto", "landscape", "portrait"])
    ap.add_argument("--hfov", type=float, help="horizontal FOV of the input photo in degrees (default: EXIF or 26 mm)")
    ap.add_argument("--intrinsics", help='JSON {"fx","fy","cx","cy"} in pixels of the input photo')
    ap.add_argument("--offload", default="auto", choices=["auto", "none", "t5", "t5+transformer", "all"])
    ap.add_argument("--ply", action="store_true", help="also write world.ply")
    ap.add_argument("--emit-request", metavar="REQ.json", help="write the FlashWorld request JSON and exit (no GPU)")
    ap.add_argument("--from-spz", metavar="WORLD.spz", help="post-process a raw FlashWorld SPZ (needs --request)")
    ap.add_argument("--request", metavar="REQ.json", help="the request that produced --from-spz")
    args = ap.parse_args(argv)

    intr = json.loads(args.intrinsics) if args.intrinsics else None
    image = None
    if args.video:
        tmp_png = Path(tempfile.mkdtemp(prefix="fwvid-")) / "frame.png"
        image = best_video_frame(args.video, tmp_png)
    elif args.image:
        image = pick_best_image(args.image)

    if args.emit_request:
        if image is None and not args.prompt:
            ap.error("--emit-request needs --image/--video or --prompt")
        req, _ = build_request(image, args.prompt or "", args.trajectory, args.orientation, args.hfov, intr, embed_image=True)
        if image is not None and not (args.prompt or "").strip():
            req["text_prompt"] = args.caption if args.caption not in ("auto", "none") else NEUTRAL_CAPTION
        sio.write_json_atomic(args.emit_request, req)
        print(args.emit_request)
        return 0

    if not args.out:
        ap.error("--out is required")
    prog = sio.Progress(args.progress)
    try:
        if args.from_spz:
            if not args.request:
                ap.error("--from-spz needs --request")
            result = postprocess_spz(args.from_spz, args.request, args.out, prog, camera_height=args.camera_height,
                                     max_splats=args.max_splats, sh_degree=args.sh_degree, write_ply=args.ply)
        else:
            if image is None and not args.prompt:
                ap.error("give --image, --video or --prompt")
            result = generate(image, args.prompt, args.out, prog, trajectory_name=args.trajectory, seed=args.seed,
                              camera_height=args.camera_height, max_splats=args.max_splats, sh_degree=args.sh_degree,
                              caption=args.caption, orientation=args.orientation, hfov=args.hfov, intrinsics=intr,
                              offload=args.offload, write_ply=args.ply)
    except Exception as e:
        traceback.print_exc()
        prog.fail(f"{type(e).__name__}: {e}")
        return 1
    prog.done()
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
