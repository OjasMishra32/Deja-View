"""Fetch and warm everything the avatar stage needs, once, on a CPU node with network access.

    python -m pipeline.avatar.prefetch ckpt dinov3 anny verify   # in $TW_ENVS/avatar, from $TW_REPO
    python -m pipeline.avatar.prefetch qwen                      # any env with huggingface_hub (long: ~57 GB)

Steps:
  ckpt    the Multi-HMR 2 checkpoint -> $HF_HOME/multihmr2/multihmr2.pt (resumable, size-checked)
  dinov3  caches the backbone *code* through torch.hub (weights come from the checkpoint, pretrained=False)
  anny    builds the Anny caches for every body-model variant the stage instantiates
  verify  builds the full network on CPU and loads the checkpoint; reports missing/unexpected keys
  qwen    snapshot of Qwen/Qwen-Image-Edit-2511 into the Hugging Face cache under $HF_HOME

Each finished step writes $TW_STATE/avatar-<step>.ok with a one-line summary.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from pipeline.avatar import paths  # sets ANNY_CACHE_DIR / TORCH_HOME / HF_HOME defaults first


def _stamp(step: str, info: dict) -> None:
    paths.STATE.mkdir(parents=True, exist_ok=True)
    (paths.STATE / f"avatar-{step}.ok").write_text(json.dumps(info, sort_keys=True) + "\n")
    print(f"[prefetch] {step} ok: {json.dumps(info, sort_keys=True)}", flush=True)


def step_ckpt() -> dict:
    dst = paths.MULTIHMR2_CKPT
    dst.parent.mkdir(parents=True, exist_ok=True)
    want = paths.MULTIHMR2_BYTES
    if dst.is_file() and dst.stat().st_size == want:
        return {"path": str(dst), "bytes": want, "cached": True}
    part = dst.with_name(dst.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(paths.MULTIHMR2_URL)
    if have:
        req.add_header("Range", f"bytes={have}-")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        if have and r.status != 206:  # server ignored the range: start over
            have = 0
        mode = "ab" if have else "wb"
        with open(part, mode) as f:
            done = have
            last = t0
            while True:
                buf = r.read(8 << 20)
                if not buf:
                    break
                f.write(buf)
                done += len(buf)
                if time.time() - last > 15:
                    last = time.time()
                    print(f"[prefetch] ckpt {done / 1e9:.2f}/{want / 1e9:.2f} GB", flush=True)
    size = part.stat().st_size
    if size != want:
        raise SystemExit(f"multihmr2.pt: got {size} bytes, expected {want} (re-run to resume)")
    part.replace(dst)
    return {"path": str(dst), "bytes": size, "seconds": round(time.time() - t0, 1)}


def step_dinov3() -> dict:
    import torch

    t0 = time.time()
    net = torch.hub.load(paths.DINOV3_HUB, paths.DINOV3_ARCH, pretrained=False, trust_repo=True)
    hub_dir = Path(torch.hub.get_dir())
    cached = sorted(p.name for p in hub_dir.glob("facebookresearch_dinov3_*"))
    return {
        "hub_dir": str(hub_dir),
        "cached": cached,
        "params_M": round(sum(p.numel() for p in net.parameters()) / 1e6, 1),
        "patch_size": int(net.patch_size),
        "embed_dim": int(net.embed_dim),
        "seconds": round(time.time() - t0, 1),
    }


# Every Anny variant the avatar stage creates: the two inside the network, the session's world-frame one,
# and the one ground.py / body.py rebuild at a person's median phenotype.
ANNY_VARIANTS = {
    "root_relative": dict(local_changes=True, pose_parameterization="root_relative", remove_unattached_vertices=False,
                          all_phenotypes=False),
    "root_relative_lowres": dict(local_changes=True, pose_parameterization="root_relative",
                                 remove_unattached_vertices=False, all_phenotypes=False, topology="notoes_collapse5pc"),
    "root_relative_world": dict(local_changes=True, pose_parameterization="root_relative_world",
                                remove_unattached_vertices=False),
    "plan_default": dict(local_changes=True, pose_parameterization="root_relative", remove_unattached_vertices=False),
}


def step_anny() -> dict:
    import anny

    out = {"cache_dir": str(paths.ANNY_CACHE), "variants": {}}
    paths.ANNY_CACHE.mkdir(parents=True, exist_ok=True)
    for name, kw in ANNY_VARIANTS.items():
        t0 = time.time()
        m = anny.create_fullbody_model(**kw)
        info = {"seconds": round(time.time() - t0, 1)}
        for attr in ("template_vertices", "faces", "texture_coordinates", "face_texture_coordinate_indices"):
            v = getattr(m, attr, None)
            if v is not None and hasattr(v, "shape"):
                info[attr] = list(v.shape)
        for attr in ("bone_labels", "phenotype_labels", "local_change_labels"):
            v = getattr(m, attr, None)
            if v is not None:
                info[attr] = len(v)
        out["variants"][name] = info
        print(f"[prefetch] anny {name}: {info}", flush=True)
    out["cache_files"] = len([p for p in paths.ANNY_CACHE.rglob("*") if p.is_file()])
    return out


def step_verify() -> dict:
    import torch
    from multihmr2.models.detr_root_relative.multi_hmr import DETR_Root_Relative, DETRConfig

    if not paths.MULTIHMR2_CKPT.is_file():
        raise SystemExit("run the ckpt step first")
    t0 = time.time()
    model = DETR_Root_Relative(DETRConfig())
    ck = torch.load(paths.MULTIHMR2_CKPT, map_location="cpu", weights_only=False)
    sd = ck["model_state_dict"]
    keys = set(model.state_dict().keys())
    missing, unexpected = model.load_state_dict({k: v for k, v in sd.items() if k in keys}, strict=False)
    return {
        "ckpt_tensors": len(sd),
        "model_tensors": len(keys),
        "missing": len(missing),
        "missing_sample": list(missing)[:5],
        "ignored_ckpt_keys": len([k for k in sd if k not in keys]),
        "unexpected": len(unexpected),
        "img_size": int(model.img_size),
        "patch_size": int(model.patch_size),
        "seconds": round(time.time() - t0, 1),
    }


def step_qwen() -> dict:
    from huggingface_hub import snapshot_download

    t0 = time.time()
    local = snapshot_download(paths.QWEN_EDIT_REPO, max_workers=int(os.environ.get("QWEN_WORKERS", "16")))
    total = sum(p.stat().st_size for p in Path(local).rglob("*") if p.is_file())
    free = shutil.disk_usage(local).free
    return {"repo": paths.QWEN_EDIT_REPO, "path": local, "GB": round(total / 1e9, 2),
            "seconds": round(time.time() - t0, 1), "free_TB": round(free / 1e12, 2)}


STEPS = {"ckpt": step_ckpt, "dinov3": step_dinov3, "anny": step_anny, "verify": step_verify, "qwen": step_qwen}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("steps", nargs="+", choices=sorted(STEPS))
    args = ap.parse_args(argv)
    print(f"[prefetch] HF_HOME={os.environ['HF_HOME']} TORCH_HOME={os.environ['TORCH_HOME']} "
          f"ANNY_CACHE_DIR={os.environ['ANNY_CACHE_DIR']}", flush=True)
    for s in args.steps:
        print(f"[prefetch] step {s}", flush=True)
        _stamp(s, STEPS[s]())
    return 0


if __name__ == "__main__":
    sys.exit(main())
