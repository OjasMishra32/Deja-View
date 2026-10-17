#!/usr/bin/env python3
"""Downloads the model weights into the Hugging Face cache ($HF_HOME = $HPG_ROOT/models). Idempotent.

  python hpg/fetch_weights.py [flashworld] [wan] [captioner] [anysplat] [video]     (default: all)

Run it on a compute node (hpg/setup.sh weights does). Retries each repo a few times.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time

FLASHWORLD_CKPT_REVISION = "6a8e88c6f88678ac098e4c82675f0aee555d6e5d"

GROUPS: dict[str, list[tuple[str, dict]]] = {
    # FlashWorld's distilled transformer + 3DGS decoder (20.9 GB).
    "flashworld": [("imlixinyang/FlashWorld", {"filename": "model.ckpt", "revision": FLASHWORLD_CKPT_REVISION})],
    # The Wan2.2 base FlashWorld builds on: VAE, UMT5 text encoder, transformer (34 GB).
    "wan": [("Wan-AI/Wan2.2-TI2V-5B-Diffusers",
             {"allow_patterns": ["model_index.json", "vae/*", "text_encoder/*", "transformer/*", "tokenizer/*", "scheduler/*"]})],
    # Optional captioner for photos that come without a prompt (7.5 GB).
    "captioner": [(os.environ.get("TW_CAPTION_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct"), {})],
    # AnySplat and the VGGT backbone its constructor loads (2.9 + 5.0 GB).
    "anysplat": [("lhjiang/anysplat", {"allow_patterns": ["config.json", "model.safetensors"]}),
                 ("facebook/VGGT-1B", {"allow_patterns": ["config.json", "model.safetensors"]})],
    # The video pipeline's depth models (pipeline/common/models.py DEFAULT_FRAME_DEPTH and DEFAULT_PLATE_DEPTH; keep
    # these repo ids in sync). Fetched here too, so the weights stage never stamps weights.ok (which switches jobs to
    # HF_HUB_OFFLINE=1) without them, even when the video env does not exist yet (0.1 + 0.4 GB).
    "video": [("depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf", {"allow_patterns": ["*.json", "*.safetensors", "*.txt"]}),
              ("depth-anything/Depth-Anything-V2-Metric-Indoor-Base-hf", {"allow_patterns": ["*.json", "*.safetensors", "*.txt"]})],
}


def fetch(repo: str, opts: dict, tries: int = 4) -> str:
    from huggingface_hub import hf_hub_download, snapshot_download

    last: Exception | None = None
    for i in range(tries):
        try:
            if "filename" in opts:
                return hf_hub_download(repo, opts["filename"], revision=opts.get("revision"))
            return snapshot_download(repo, revision=opts.get("revision"), allow_patterns=opts.get("allow_patterns"))
        except Exception as e:  # network hiccups on large files: retry with backoff
            last = e
            wait = 15 * (i + 1)
            print(f"  {repo}: {type(e).__name__}: {str(e)[:200]} (retry in {wait}s)", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"could not download {repo}: {last}")


def du(path: str) -> float:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / 1e9


def main(argv: list[str]) -> int:
    groups = argv or list(GROUPS)
    unknown = [g for g in groups if g not in GROUPS]
    if unknown:
        print(f"unknown group(s): {unknown}; choose from {list(GROUPS)}", file=sys.stderr)
        return 2
    if importlib.util.find_spec("hf_transfer") is not None:
        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    os.environ.pop("HF_HUB_OFFLINE", None)
    print(f"HF_HOME={os.environ.get('HF_HOME')}", flush=True)
    for g in groups:
        for repo, opts in GROUPS[g]:
            t0 = time.time()
            print(f"[{g}] {repo} ...", flush=True)
            path = fetch(repo, opts)
            size = du(path) if os.path.isdir(path) else os.path.getsize(os.path.realpath(path)) / 1e9
            print(f"[{g}] {repo}: {size:.1f} GB at {path} ({time.time() - t0:.0f}s)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
