#!/usr/bin/env python3
"""GPU basics on one node: CUDA, Blackwell kernels, FP8 matmul, a gsplat render checked against the CPU renderer.

  python hpg/smoke/smoke_gpu.py --out DIR
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))
import splat_io as sio  # noqa: E402


def scene() -> sio.Splats:
    rng = np.random.default_rng(0)
    gx, gz = np.meshgrid(np.linspace(-3, 3, 200), np.linspace(-6, 0, 200))
    floor = np.stack([gx.ravel(), np.full(gx.size, -1.5), gz.ravel()], 1)
    d = rng.normal(size=(20000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    ball = np.array([0.0, -0.9, -3.0]) + 0.6 * d
    m = np.concatenate([floor, ball])
    rgb = np.concatenate([np.full((len(floor), 3), 0.6), np.tile([0.9, 0.2, 0.1], (len(ball), 1))])
    return sio.Splats.from_rgb(m, rgb, 0.025, 0.95)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    import torch

    rep: dict = {"torch": torch.__version__, "cuda": torch.version.cuda, "available": torch.cuda.is_available()}
    if not torch.cuda.is_available():
        print(json.dumps(rep, indent=2))
        print("FAIL: no CUDA device")
        return 1
    rep["device"] = torch.cuda.get_device_name(0)
    rep["capability"] = list(torch.cuda.get_device_capability(0))
    rep["memoryGB"] = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1)
    rep["archList"] = torch.cuda.get_arch_list()
    a = torch.randn(4096, 4096, device="cuda", dtype=torch.bfloat16)
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(20):
        a @ a
    torch.cuda.synchronize()
    rep["bf16TFLOPS"] = round(20 * 2 * 4096**3 / (time.time() - t0) / 1e12, 1)
    sys.path.insert(0, str(REPO / "pipeline"))
    import flashworld_run as fw

    rep["fp8ScaledMM"] = fw.fp8_supported("cuda")

    s = scene()
    f = 300.0
    t0 = time.time()
    g = sio.render_gsplat(s, np.eye(4), f, f, 320, 200, 640, 400)
    rep["gsplatMs"] = round((time.time() - t0) * 1000, 1)
    c = sio.render_points(s, np.eye(4), f, f, 320, 200, 640, 400)
    sio.save_jpeg(out / "gsplat.jpg", g.rgb)
    sio.save_jpeg(out / "cpu.jpg", c.rgb)
    both = (g.alpha > 0.5) & (c.alpha > 0.5)
    rel = float(np.median(np.abs(g.depth[both] - c.depth[both]) / c.depth[both])) if both.any() else math.nan
    rep["gsplatCoverage"] = float(np.mean(g.alpha > 0.5))
    rep["depthMedianRelDiffVsCpu"] = round(rel, 4)
    # The red ball's centre (0, -0.9, -3) projects to pixel (u, v) = (320, 200 + 300 * 0.9 / 3).
    centre = g.rgb[290, 320].astype(int)
    rep["ballColour"] = centre.tolist()
    ok = rep["gsplatCoverage"] > 0.2 and rel < 0.05 and centre[0] > centre[1] + 60
    rep["ok"] = bool(ok)
    (out / "summary.json").write_text(json.dumps(rep, indent=2))
    print(json.dumps(rep, indent=2))
    print("gpu smoke:", "ok" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
