#!/usr/bin/env python3
"""AnySplat runner: several photos (or frames of a video) -> a faithful Gaussian splat reconstruction.

  python pipeline/anysplat_run.py --images DIR --out OUTDIR [--progress progress.json]
  python pipeline/anysplat_run.py --video clip.mp4 --out OUTDIR

Writes OUTDIR/world.ply (standard 3DGS PLY; --spz also writes world.spz and points scene.json at it), thumb.jpg,
scene.json (JobResult with `world`), input_camera.json + input_depth.npy for the first view, cameras.json (every
input view in the viewer frame) and anysplat.json (diagnostics). Frames and transform: docs/FLASHWORLD.md section 7.

Importable: `generate(images=None, video=None, out_dir=..., progress=None, **options) -> dict` keeps the model
loaded between calls.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import types
from pathlib import Path
from typing import Any, Sequence

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import splat_io as sio  # noqa: E402

ANYSPLAT_MODEL = os.environ.get("ANYSPLAT_MODEL", "lhjiang/anysplat")
INPUT_SIZE = 448
DEFAULT_MAX_VIEWS = int(os.environ.get("ANYSPLAT_MAX_VIEWS", "32"))
DEFAULT_MAX_SPLATS = 1_000_000
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"}


def log(msg: str) -> None:
    print(f"[anysplat] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------------------------------------------


def list_images(src: str | Path | Sequence[str | Path]) -> list[Path]:
    if isinstance(src, (str, Path)) and Path(src).is_dir():
        files = [p for p in sorted(Path(src).iterdir()) if p.suffix.lower() in IMAGE_EXTS and not p.name.startswith(".")]
    elif isinstance(src, (str, Path)):
        files = [Path(src)]
    else:
        files = [Path(p) for p in src]
    if not files:
        raise ValueError(f"no images found in {src}")
    return files


def choose_views(n_total: int, max_views: int) -> list[int]:
    """Evenly spaced indices (always including the first and the last) when there are too many views."""
    if n_total <= max_views:
        return list(range(n_total))
    return sorted(set(int(round(x)) for x in np.linspace(0, n_total - 1, max_views)))


def extract_video_frames(video: str | Path, out_dir: str | Path, count: int, oversample: int = 3) -> list[Path]:
    """Samples `count` frames spread over the video, keeping the sharpest of `oversample` candidates per slot."""
    from PIL import Image

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="asframes-"))
    try:
        dur = 0.0
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                               capture_output=True, text=True, timeout=60)
            dur = float(r.stdout.strip() or 0)
        except Exception:
            pass
        want = count * oversample
        fps = want / dur if dur > 0 else 4.0
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={fps:.4f}", "-frames:v", str(want), "-q:v", "2",
                        str(tmp / "%05d.jpg")], check=True, timeout=1200)
        cands = sorted(tmp.glob("*.jpg"))
        if not cands:
            raise RuntimeError(f"could not decode frames from {video}")
        slots = np.array_split(np.arange(len(cands)), min(count, len(cands)))
        picked = []
        for k, slot in enumerate(slots):
            best = max(slot, key=lambda i: _sharpness(Image.open(cands[i])))
            dst = out_dir / f"{k:03d}.jpg"
            shutil.copy(cands[best], dst)
            picked.append(dst)
        return picked
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _sharpness(im) -> float:
    w, h = im.size
    s = min(1.0, 480 / w)
    g = np.asarray(im.convert("L").resize((max(1, int(w * s)), max(1, int(h * s)))), np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def load_view(path: Path, size: int = INPUT_SIZE):
    """EXIF-oriented RGB, short side resized to `size`, centre-cropped square (AnySplat's preprocessing).
    Returns (array [size,size,3] float32 0..1, info about the crop in original pixels)."""
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    w, h = im.size
    s = size / min(w, h)
    nw, nh = max(size, int(round(w * s))), max(size, int(round(h * s)))
    im2 = im.resize((nw, nh), Image.BICUBIC)
    x0, y0 = (nw - size) // 2, (nh - size) // 2
    crop = im2.crop((x0, y0, x0 + size, y0 + size))
    info = {"width": w, "height": h, "scale": nw / w, "x0": x0, "y0": y0, "file": path.name}
    return np.asarray(crop, np.float32) / 255.0, info


# --------------------------------------------------------------------------------------------------------------
# Compatibility shims for AnySplat's optional CUDA extensions
# --------------------------------------------------------------------------------------------------------------


def _sdpa_attention(q, k, v, attn_bias=None, p: float = 0.0, scale=None, op=None, **_):
    """xformers.ops.memory_efficient_attention on [B, M, H, K] tensors, via PyTorch SDPA."""
    import torch.nn.functional as F

    out = F.scaled_dot_product_attention(
        q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=attn_bias, dropout_p=0.0, scale=scale
    )
    return out.transpose(1, 2).contiguous()


def make_xformers_shim() -> types.ModuleType:
    ops = types.ModuleType("xformers.ops")
    ops.memory_efficient_attention = _sdpa_attention  # type: ignore[attr-defined]
    flash = types.SimpleNamespace(FwOp=None, BwOp=None)
    ops.fmha = types.SimpleNamespace(flash=flash)  # type: ignore[attr-defined]
    return ops


def make_torch_scatter_shim() -> types.ModuleType:
    import torch

    def _expand(index, src):
        return index.reshape(-1, *([1] * (src.dim() - 1))).expand_as(src)

    def scatter_add(src, index, dim=0, out=None, dim_size=None):
        if dim != 0:
            raise NotImplementedError("shim supports dim=0 only")
        size = int(dim_size) if dim_size is not None else int(index.max()) + 1
        res = torch.zeros((size,) + tuple(src.shape[1:]), dtype=src.dtype, device=src.device)
        return res.scatter_add_(0, _expand(index, src), src)

    def scatter_max(src, index, dim=0, out=None, dim_size=None):
        if dim != 0:
            raise NotImplementedError("shim supports dim=0 only")
        size = int(dim_size) if dim_size is not None else int(index.max()) + 1
        base = torch.zeros((size,) + tuple(src.shape[1:]), dtype=src.dtype, device=src.device)
        res = base.scatter_reduce(0, _expand(index, src), src, reduce="amax", include_self=False)
        return res, torch.zeros(res.shape, dtype=torch.long, device=src.device)

    mod = types.ModuleType("torch_scatter")
    mod.scatter_add = scatter_add  # type: ignore[attr-defined]
    mod.scatter_max = scatter_max  # type: ignore[attr-defined]
    return mod


def install_shims(force_xformers_shim: bool = False) -> dict:
    """Puts stand-ins into sys.modules for missing extensions. Returns what was shimmed."""
    used = {}
    try:
        if force_xformers_shim:
            raise ImportError("forced")
        import xformers.ops  # noqa: F401
    except Exception:
        shim = make_xformers_shim()
        pkg = types.ModuleType("xformers")
        pkg.ops = shim  # type: ignore[attr-defined]
        sys.modules["xformers"] = pkg
        sys.modules["xformers.ops"] = shim
        used["xformers"] = "sdpa"
    try:
        import torch_scatter  # noqa: F401
    except Exception:
        sys.modules["torch_scatter"] = make_torch_scatter_shim()
        used["torch_scatter"] = "torch.scatter_reduce"
    # Imported at module level by training/evaluation code that inference never calls.
    try:
        import skvideo  # noqa: F401
    except Exception:
        sys.modules["skvideo"] = types.ModuleType("skvideo")
        used["skvideo"] = "empty"
    try:
        import lightning.pytorch  # noqa: F401
    except Exception:
        import torch

        light = types.ModuleType("lightning")
        lp = types.ModuleType("lightning.pytorch")
        lp.LightningModule = torch.nn.Module  # type: ignore[attr-defined]
        light.pytorch = lp  # type: ignore[attr-defined]
        sys.modules["lightning"] = light
        sys.modules["lightning.pytorch"] = lp
        used["lightning"] = "placeholder"
    return used


def find_anysplat_src() -> Path:
    cands = []
    if os.environ.get("ANYSPLAT_SRC"):
        cands.append(Path(os.environ["ANYSPLAT_SRC"]))
    if os.environ.get("HPG_ROOT"):
        cands.append(Path(os.environ["HPG_ROOT"]) / "src" / "AnySplat")
    cands += [HERE.parent / "third_party" / "AnySplat", HERE.parent.parent / "AnySplat"]
    for c in cands:
        if (c / "src" / "model" / "model" / "anysplat.py").is_file():
            return c.resolve()
    raise RuntimeError("AnySplat source not found; set ANYSPLAT_SRC to a checkout of https://github.com/InternRobotics/AnySplat")


# --------------------------------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------------------------------


class AnySplatModel:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.model = None
        self.shims: dict = {}
        self.load_seconds = 0.0

    def load(self) -> None:
        if self.model is not None:
            return
        import torch

        if not torch.cuda.is_available():
            if os.environ.get("ANYSPLAT_ALLOW_CPU") != "1":
                raise RuntimeError("AnySplat needs a CUDA GPU (none visible)")
            self.device = "cpu"  # debugging only: minutes per view
        t0 = time.time()
        src = find_anysplat_src()
        if str(src) in sys.path:
            sys.path.remove(str(src))
        sys.path.insert(0, str(src))
        mod = sys.modules.get("src")
        if mod is not None and not str(getattr(mod, "__file__", "") or "").startswith(str(src)):
            for k in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
                del sys.modules[k]
        self.shims = install_shims(os.environ.get("ANYSPLAT_XFORMERS") == "shim")
        from src.model.model.anysplat import AnySplat  # AnySplat's own package

        if "xformers" not in self.shims and (self.device == "cpu" or not _flash_attention_works()):
            import src.model.encoder.heads.head_modules as hm

            hm.xops = make_xformers_shim()
            self.shims["xformers"] = "sdpa (flash op failed on this GPU)"
        model = AnySplat.from_pretrained(ANYSPLAT_MODEL)
        model = model.to(self.device).eval()
        for p in model.parameters():
            p.requires_grad = False
        self.model = model
        self.load_seconds = time.time() - t0
        log(f"AnySplat ready in {self.load_seconds:.1f}s (shims: {self.shims or 'none'})")

    def infer(self, views: np.ndarray) -> tuple[sio.Splats, np.ndarray, np.ndarray, float]:
        """views [V, S, S, 3] in 0..1 -> (splats in AnySplat's world, c2w OpenCV [V,4,4], K normalised [V,3,3], seconds)."""
        import torch

        self.load()
        x = torch.from_numpy(np.ascontiguousarray(views.transpose(0, 3, 1, 2))).float().to(self.device)[None]
        _sync()
        t0 = time.time()
        with torch.no_grad():
            gaussians, pose = self.model.inference(x)
        _sync()
        secs = time.time() - t0
        harm = gaussians.harmonics[0].float()  # [G, 3, d_sh], channel-major
        rot = gaussians.rotations[0].float()  # xyzw
        rot = torch.nn.functional.normalize(rot, dim=-1)[:, [3, 0, 1, 2]]
        splats = sio.Splats(
            gaussians.means[0].float().cpu().numpy(),
            gaussians.scales[0].float().cpu().numpy(),
            rot.cpu().numpy(),
            gaussians.opacities[0].float().reshape(-1).cpu().numpy(),
            harm[:, :, 0].cpu().numpy(),
            harm[:, :, 1:16].transpose(1, 2).cpu().numpy() if harm.shape[-1] > 1 else None,
        )
        c2w = pose["extrinsic"][0].float().cpu().numpy()
        K = pose["intrinsic"][0].float().cpu().numpy()
        del gaussians
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return splats, c2w, K, secs


def _sync() -> None:
    import torch

    if torch.cuda.is_available():
        torch.cuda.synchronize()


def _flash_attention_works() -> bool:
    try:
        import torch
        import xformers.ops as xops

        q = torch.randn(1, 64, 2, 64, device="cuda", dtype=torch.bfloat16)
        xops.memory_efficient_attention(q, q, q, op=(xops.fmha.flash.FwOp, xops.fmha.flash.BwOp))
        torch.cuda.synchronize()
        return True
    except Exception as e:
        log(f"xformers flash attention unavailable ({str(e).splitlines()[0][:120]}); using PyTorch SDPA")
        return False


_MODEL: AnySplatModel | None = None


def get_model() -> AnySplatModel:
    global _MODEL
    if _MODEL is None:
        _MODEL = AnySplatModel()
    return _MODEL


# --------------------------------------------------------------------------------------------------------------
# Post-processing
# --------------------------------------------------------------------------------------------------------------


def finish_reconstruction(
    splats: sio.Splats,
    c2w_cv: np.ndarray,
    K_norm: np.ndarray,
    infos: list[dict],
    out_dir: Path,
    progress: sio.Progress | None = None,
    camera_height: float = 1.45,
    max_splats: int | None = DEFAULT_MAX_SPLATS,
    sh_degree: int = 0,
    write_spz: bool = False,
    first_image=None,
    extra_diag: dict | None = None,
    prefer_gpu: bool = True,
) -> dict:
    """AnySplat output (OpenCV cameras, arbitrary scale) -> world.ply + placement + previews."""
    prog = progress or sio.Progress(None)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    poses_gl = [sio.c2w_cv_to_gl(c) for c in c2w_cv]
    centres = np.array([p[:3, 3] for p in poses_gl])
    raw = len(splats)
    prog("Cleaning up the splats", 0.0)
    splats = splats.subset(sio.prune_indices(splats, max_splats, cameras=centres))
    prog("Finding the floor", 0.2)
    place = sio.place_world(splats.means, splats.opacities, poses_gl[0], camera_height=camera_height,
                            scale_limits=(1e-4, 1e4), fallback_scale=None, fallback_median_distance=2.5)
    s = place["scale"]
    prog("Writing the world", 0.35)
    sio.write_ply(out_dir / "world.ply", splats, sh_degree=sh_degree)
    world_file = "world.ply"
    if write_spz:
        sio.write_spz(out_dir / "world.spz", splats, sh_degree=min(sh_degree, 3))
        world_file = "world.spz"

    # First view in original pixels: undo AnySplat's resize + square crop.
    info0 = infos[0]
    S = INPUT_SIZE
    sc = info0["scale"]
    k0 = K_norm[0]
    fx, fy = k0[0, 0] * S / sc, k0[1, 1] * S / sc
    cx, cy = (k0[0, 2] * S + info0["x0"]) / sc, (k0[1, 2] * S + info0["y0"]) / sc
    ow, oh = info0["width"], info0["height"]
    dscale = min(1.0, 1024 / max(ow, oh))
    dw, dh = max(1, int(round(ow * dscale))), max(1, int(round(oh * dscale)))
    prog("Rendering depth at the first photo", 0.5)
    tensors: dict = {}
    r = sio.render(splats, poses_gl[0], fx * dscale, fy * dscale, cx * dscale, cy * dscale, dw, dh, prefer_gpu=prefer_gpu,
                   tensors=tensors)
    depth = (r.depth * s).astype(np.float32)
    depth[r.alpha < 0.5] = 0.0
    np.save(out_dir / "input_depth.npy", depth)
    prog("Rendering the thumbnail", 0.75)
    tw = 640
    th = max(1, int(round(oh * tw / ow)))
    ts = tw / ow
    if r.backend == "gsplat":
        thumb = sio.render(splats, poses_gl[0], fx * ts, fy * ts, cx * ts, cy * ts, tw, th, prefer_gpu=True, tensors=tensors).rgb
        thumb_src = "render"
    elif first_image is not None:
        iw, ih = first_image.size
        thumb = np.asarray(first_image.convert("RGB").resize((tw, max(1, int(round(ih * tw / iw))))))
        thumb_src = "photo"
    else:
        thumb = sio.render_points(splats, poses_gl[0], fx * ts, fy * ts, cx * ts, cy * ts, tw, th).rgb
        thumb_src = "render"
    sio.save_jpeg(out_dir / "thumb.jpg", thumb, quality=86)
    del tensors

    R, t, _ = sio.transform_parts(place["transform"])
    cams = []
    for p, inf in zip(poses_gl, infos):
        cams.append({"file": inf.get("file"), "position": [round(float(v), 5) for v in (s * (R @ p[:3, 3]) + t)],
                     "quaternion": sio.matrix_to_quat_xyzw(R @ p[:3, :3])})
    sio.write_json_atomic(out_dir / "cameras.json", {"convention": "OpenGL cameras in the viewer frame", "cameras": cams})
    sio.write_json_atomic(out_dir / "input_camera.json", {
        "width": ow, "height": oh, "fx": round(float(fx), 4), "fy": round(float(fy), 4), "cx": round(float(cx), 4), "cy": round(float(cy), 4),
        "position": place["camera"]["position"], "quaternion": place["camera"]["quaternion"],
        "depthWidth": dw, "depthHeight": dh,
        "crop": {"x": round(info0["x0"] / sc), "y": round(info0["y0"] / sc), "w": round(S / sc), "h": round(S / sc)},
        "convention": "OpenGL camera (looks down -Z, +Y up) in the viewer frame; intrinsics in pixels of width x height",
    })
    world = {
        "file": world_file,
        "transform": place["transform"],
        "floorY": place["floorY"],
        "spawn": place["spawn"],
        "bounds": place["bounds"],
        "source": "anysplat",
        "splatCount": len(splats),
    }
    result = {"world": world, "thumb": "thumb.jpg", "caption": f"Reconstructed from {len(infos)} views with AnySplat."}
    sio.write_json_atomic(out_dir / "scene.json", result)
    sio.write_json_atomic(out_dir / "anysplat.json", {
        "views": len(infos), "rawSplats": raw, "keptSplats": len(splats), "shDegree": min(sh_degree, splats.sh_degree),
        "placement": {k: v for k, v in place.items() if k != "bounds"}, "render": r.backend, "thumb": thumb_src,
        "depthValidFraction": float(np.mean(depth > 0)), "postSeconds": round(time.time() - t0, 2), **(extra_diag or {}),
    })
    prog("Done", 1.0)
    return result


# --------------------------------------------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------------------------------------------


def generate(
    images: Any = None,
    video: str | Path | None = None,
    out_dir: str | Path = "out",
    progress: Any = None,
    *,
    max_views: int = DEFAULT_MAX_VIEWS,
    max_splats: int | None = DEFAULT_MAX_SPLATS,
    sh_degree: int = 0,
    camera_height: float = 1.45,
    write_spz: bool = False,
) -> dict:
    """Photos (a directory, a list of paths) or a video -> reconstruction files in out_dir. Returns the JobResult."""
    from PIL import Image, ImageOps

    prog = progress if isinstance(progress, sio.Progress) else sio.Progress(progress)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t_start = time.time()
    tmpdir = None
    try:
        if video is not None:
            prog("Picking frames from the video", 0.02)
            tmpdir = Path(tempfile.mkdtemp(prefix="anysplat-"))
            files = extract_video_frames(video, tmpdir, max_views)
        else:
            files = list_images(images)
            files = [files[i] for i in choose_views(len(files), max_views)]
        if len(files) < 2:
            raise ValueError("AnySplat needs at least 2 views (8 or more recommended)")
        prog(f"Preparing {len(files)} views", 0.05)
        loaded = [load_view(f) for f in files]
        views = np.stack([v for v, _ in loaded])
        infos = [i for _, i in loaded]
        first = ImageOps.exif_transpose(Image.open(files[0])).convert("RGB")
        model = get_model()
        if model.model is None:
            prog("Loading AnySplat onto the GPU", 0.08)
            model.load()
        prog("Reconstructing", 0.2)
        splats, c2w, K, secs = model.infer(views)
        log(f"{len(splats)} splats from {len(files)} views in {secs:.1f}s")
        return finish_reconstruction(
            splats, c2w, K, infos, out_dir, prog.sub(0.75, 0.99), camera_height, max_splats, sh_degree, write_spz, first,
            extra_diag={"inferSeconds": round(secs, 2), "loadSeconds": round(model.load_seconds, 1), "shims": model.shims,
                        "totalSeconds": round(time.time() - t_start, 2)},
        )
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AnySplat: photos or a video -> Gaussian splat reconstruction")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--images", help="directory of photos (or a single file)")
    src.add_argument("--video", help="video to sample frames from")
    ap.add_argument("--out", required=True)
    ap.add_argument("--progress")
    ap.add_argument("--max-views", type=int, default=DEFAULT_MAX_VIEWS)
    ap.add_argument("--max-splats", type=int, default=DEFAULT_MAX_SPLATS)
    ap.add_argument("--sh-degree", type=int, default=0, choices=[0, 1, 2, 3])
    ap.add_argument("--camera-height", type=float, default=1.45)
    ap.add_argument("--spz", action="store_true", help="also write world.spz and reference it in scene.json")
    args = ap.parse_args(argv)
    prog = sio.Progress(args.progress)
    try:
        res = generate(args.images, args.video, args.out, prog, max_views=args.max_views, max_splats=args.max_splats,
                       sh_degree=args.sh_degree, camera_height=args.camera_height, write_spz=args.spz)
    except Exception as e:
        traceback.print_exc()
        prog.fail(f"{type(e).__name__}: {e}")
        return 1
    prog.done()
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
