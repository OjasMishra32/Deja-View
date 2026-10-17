"""Where the avatar stage keeps its weights and caches.

Importing this module sets defaults for the environment variables the libraries read (ANNY_CACHE_DIR,
TORCH_HOME, HF_HOME), so import it before anny, torch.hub or diffusers. Values already set win.
"""

from __future__ import annotations

import os
from pathlib import Path

HPG_ROOT = Path(os.environ.get("HPG_ROOT", "/blue/phz3152/sbernalorta/thirdwheel"))
MODELS = Path(os.environ.get("HF_HOME", str(HPG_ROOT / "models")))

os.environ.setdefault("HF_HOME", str(MODELS))
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))
os.environ.setdefault("ANNY_CACHE_DIR", str(MODELS / "anny"))

ANNY_CACHE = Path(os.environ["ANNY_CACHE_DIR"])
TORCH_HOME = Path(os.environ["TORCH_HOME"])

# The checkpoint loader insists on this exact file name.
MULTIHMR2_CKPT = Path(os.environ.get("MULTIHMR2_CKPT", str(MODELS / "multihmr2" / "multihmr2.pt")))
MULTIHMR2_URL = "https://download.europe.naverlabs.com/ComputerVision/MultiHMR/multihmr2.pt"
MULTIHMR2_BYTES = 1_613_132_154

DINOV3_HUB = "facebookresearch/dinov3"
DINOV3_ARCH = "dinov3_vitl16"

QWEN_EDIT_REPO = "Qwen/Qwen-Image-Edit-2511"

STATE = Path(os.environ.get("TW_STATE", str(HPG_ROOT / "state")))
