"""Torch device selection (cuda > mps > cpu) and batch sizing."""
from __future__ import annotations

import os
from functools import lru_cache

from . import env as _env  # noqa: F401


@lru_cache(maxsize=1)
def pick_device() -> str:
    """Best available device. TW_DEVICE=cpu|mps|cuda overrides."""
    import torch

    forced = os.environ.get("TW_DEVICE", "").strip().lower()
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def has_cuda() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def inference_dtype(device: str):
    """fp16 on CUDA and MPS (measured on an M4: ~15-25% faster, depth within 0.05%, person
    masks IoU 0.999 against fp32), fp32 on CPU. TW_FP32=1 forces fp32."""
    import torch

    if os.environ.get("TW_FP32") == "1":
        return torch.float32
    if device in ("cuda", "mps"):
        return torch.float16
    return torch.float32


def free_memory_bytes(device: str) -> int:
    """Rough memory available for activations on the device."""
    import torch

    if device == "cuda":
        free, _total = torch.cuda.mem_get_info()
        return int(free)
    if device == "mps":
        try:
            rec = int(torch.mps.recommended_max_memory())
            used = int(torch.mps.driver_allocated_memory())
            return max(rec - used, 512 << 20)
        except Exception:
            return 4 << 30
    try:
        import psutil  # optional

        return int(psutil.virtual_memory().available)
    except Exception:
        return 4 << 30


def adaptive_batch(device: str, bytes_per_item: int, lo: int = 1, hi: int = 16) -> int:
    """Batch size that keeps activations within ~40% of the free memory."""
    env = os.environ.get("TW_BATCH")
    if env:
        return max(1, int(env))
    if device == "cpu":
        return max(lo, min(hi, 2))
    budget = free_memory_bytes(device) * 0.4
    return int(max(lo, min(hi, budget // max(bytes_per_item, 1))))


def empty_cache(device: str) -> None:
    import torch

    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        try:
            torch.mps.empty_cache()
        except Exception:
            pass


def sync(device: str) -> None:
    import torch

    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        try:
            torch.mps.synchronize()
        except Exception:
            pass
