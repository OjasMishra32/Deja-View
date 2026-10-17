"""Repository paths and process-wide environment defaults.

Import this module before torch/transformers so the model caches land in data/models
unless the caller (for example a HiPerGator job) already set HF_HOME / TORCH_HOME.
"""
from __future__ import annotations

import logging
import os
import warnings
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PIPELINE_DIR.parent
MODELS_DIR = REPO_ROOT / "data" / "models"

os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf"))
os.environ.setdefault("TORCH_HOME", str(MODELS_DIR / "torch"))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

warnings.filterwarnings("ignore", message=".*Redirects are currently not supported.*")
logging.getLogger("torch.distributed.elastic.multiprocessing.redirects").setLevel(logging.ERROR)
