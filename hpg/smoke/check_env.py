#!/usr/bin/env python3
"""Import check for one environment, without a GPU (run by hpg/setup.sh after building it).

  python hpg/smoke/check_env.py flashworld|anysplat|video
"""
from __future__ import annotations

import glob
import importlib
import os
import sys

REQUIRED = {
    "flashworld": ["torch", "torchvision", "diffusers", "transformers", "accelerate", "einops", "plyfile", "PIL", "cv2",
                   "imageio", "huggingface_hub", "omegaconf", "gsplat", "gradio", "fastapi", "uvicorn", "numpy"],
    "anysplat": ["torch", "torchvision", "einops", "jaxtyping", "omegaconf", "huggingface_hub", "safetensors", "scipy",
                 "matplotlib", "colorspacious", "e3nn", "dacite", "cv2", "imageio", "PIL", "gsplat", "numpy"],
    "video": ["torch", "numpy"],
}
OPTIONAL = {
    "flashworld": ["av", "moviepy", "hf_transfer", "pillow_heif"],
    "anysplat": ["xformers", "torch_scatter", "lightning", "skvideo", "pillow_heif"],
    "video": ["cv2", "transformers"],
}


def main() -> int:
    env = sys.argv[1] if len(sys.argv) > 1 else "flashworld"
    print(f"python {sys.version.split()[0]} at {sys.executable}")
    bad = []
    for name in REQUIRED.get(env, []):
        try:
            mod = importlib.import_module(name)
            print(f"  ok   {name} {getattr(mod, '__version__', '')}")
        except Exception as e:
            print(f"  FAIL {name}: {type(e).__name__}: {e}")
            bad.append(name)
    for name in OPTIONAL.get(env, []):
        try:
            mod = importlib.import_module(name)
            print(f"  ok   {name} {getattr(mod, '__version__', '')} (optional)")
        except Exception as e:
            print(f"  --   {name} missing (optional): {str(e).splitlines()[0][:100]}")
    try:
        import torch

        flags = ""
        try:
            flags = torch._C._cuda_getArchFlags()
        except Exception:
            pass
        print(f"  torch {torch.__version__}, built for CUDA {torch.version.cuda}, arch flags: {flags or '?'}")
        if torch.version.cuda is None:
            print("  FAIL torch is a CPU-only build")
            bad.append("torch-cuda")
        elif not any(a in flags for a in ("sm_120", "sm_100", "compute_120")):
            print("  WARN this torch build lists no Blackwell (sm_100/sm_120) kernels")
    except Exception:
        pass
    if "gsplat" in REQUIRED.get(env, []) and "gsplat" not in bad:
        import gsplat

        pkg = os.path.dirname(gsplat.__file__)
        libs = glob.glob(os.path.join(pkg, "csrc*.so")) + glob.glob(os.path.join(pkg, "**", "*.so"), recursive=True)
        if libs:
            print(f"  gsplat CUDA extension: {os.path.basename(libs[0])}")
        else:
            print("  WARN gsplat has no compiled extension; it would JIT-compile on first use (slow, needs the CUDA module)")
    if env == "flashworld":
        try:
            importlib.import_module("spaces")
            print("  FAIL the `spaces` package is installed (switches FlashWorld into HF Spaces mode)")
            bad.append("spaces")
        except ImportError:
            pass
    if bad:
        print(f"{env}: missing {bad}")
        return 1
    print(f"{env}: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
