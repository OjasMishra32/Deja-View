"""Ink pass for textures that contain signs, posters, or text.

Roblox moderation flags QR codes, links, contact details, and promotional text. A real
poster or sign cannot be uploaded as readable pixels. This pass makes the texture
unreadable to a scanner while keeping the captured colours and the object's look:
mega-smooth (downscale then upscale), blur, posterize, and grain.
"""
from __future__ import annotations

import numpy as np


def ink_array(rgb: np.ndarray, strength: float = 1.0, seed: int = 0) -> np.ndarray:
    """rgb uint8 [H, W, 3] -> an inked uint8 image. Pure PIL, no GPU."""
    from PIL import Image, ImageFilter

    img = Image.fromarray(np.asarray(rgb, np.uint8), "RGB")
    w, h = img.size
    factor = max(0.18, min(0.6, 0.35 / max(strength, 0.2)))
    small = img.resize((max(8, int(w * factor)), max(8, int(h * factor))), Image.Resampling.BILINEAR)
    smooth = small.resize((w, h), Image.Resampling.BICUBIC)
    smooth = smooth.filter(ImageFilter.GaussianBlur(radius=2.2 * strength))
    arr = np.asarray(smooth, np.float32)
    levels = max(3, int(10 - 4 * strength))
    arr = np.round(arr / 255.0 * levels) / levels * 255.0
    rng = np.random.default_rng(seed)
    arr = arr + rng.normal(0.0, 7.0 * strength, arr.shape)
    return np.clip(arr, 0, 255).astype(np.uint8)


def ink_tensor(rgb, strength: float = 1.0, seed: int = 0):
    """Torch [H, W, 3] float 0..1 -> inked tensor, for the bake path on the GPU."""
    import torch
    import torch.nn.functional as F

    x = rgb.permute(2, 0, 1)[None]
    h, w = x.shape[-2:]
    factor = max(0.18, min(0.6, 0.35 / max(strength, 0.2)))
    x = F.interpolate(x, size=(max(8, int(h * factor)), max(8, int(w * factor))), mode="area")
    x = F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False)
    k = 9
    sigma = 2.2 * strength
    coords = torch.arange(k, dtype=x.dtype, device=x.device) - (k - 1) / 2
    g = torch.exp(-(coords ** 2) / (2 * sigma ** 2))
    g = (g / g.sum()).view(1, 1, k, 1) * (g / g.sum()).view(1, 1, 1, k)
    x = F.conv2d(x, g.expand(3, 1, k, k), padding=k // 2, groups=3)
    levels = max(3, int(10 - 4 * strength))
    x = torch.round(x * levels) / levels
    gen = torch.Generator(device=x.device).manual_seed(seed)
    x = x + torch.randn(x.shape, generator=gen, device=x.device, dtype=x.dtype) * (0.025 * strength)
    return x.clamp(0, 1)[0].permute(1, 2, 0)
