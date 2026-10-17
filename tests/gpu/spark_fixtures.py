"""Writes SPZ/PLY files with pipeline/splat_io.py for the Spark browser check (tests/gpu/spark_check.ts).

  .venv/bin/python tests/gpu/spark_fixtures.py [OUTDIR]

Outputs (default data/evidence/gpu/spark/):
  bedroom_v3.spz        the Marble bedroom sample re-encoded as SPZ v3 (OpenCV frame: view with quaternion 1,0,0,0)
  bedroom_v2.spz        the same as SPZ v2
  bedroom_gl_v3.spz     the bedroom baked into an OpenGL camera frame, like FlashWorld output (identity quaternion)
  bedroom_gl.ply        the same as a standard 3DGS PLY
  sh2_spheres.spz       synthetic SH degree 2 splats (red/green/blue balls on a grey floor), OpenGL frame
  manifest.json         what the check page should load and with which transform
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
import splat_io as sio  # noqa: E402


def spheres_scene(seed: int = 0) -> sio.Splats:
    rng = np.random.default_rng(seed)
    parts = []
    # Floor: a 6 x 6 m grey grid at y = -1.5 (camera height 1.5).
    gx, gz = np.meshgrid(np.linspace(-3, 3, 240), np.linspace(-6, 0, 240))
    fm = np.stack([gx.ravel(), np.full(gx.size, -1.5), gz.ravel()], 1)
    fc = np.where(((np.floor(gx * 2) + np.floor(gz * 2)) % 2 == 0).ravel()[:, None], 0.75, 0.45) * np.ones((1, 3))
    parts.append(sio.Splats.from_rgb(fm, fc, [0.015, 0.002, 0.015], 0.95))
    for centre, colour in (((-1.0, -0.9, -3.0), (0.9, 0.15, 0.1)), ((0.0, -0.9, -3.5), (0.1, 0.8, 0.2)), ((1.0, -0.9, -3.0), (0.15, 0.3, 0.95))):
        d = rng.normal(size=(6000, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        m = np.asarray(centre) + 0.5 * d
        parts.append(sio.Splats.from_rgb(m, np.tile(colour, (len(m), 1)), np.full((len(m), 3), 0.02, np.float32), 0.98))
    s = sio.concat_splats(parts)
    rest = (rng.normal(size=(len(s), 8, 3)) * 0.05).astype(np.float32)
    return sio.Splats(s.means, s.scales, s.quats, s.opacities, s.sh_dc, rest)


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "evidence" / "gpu" / "spark"
    out.mkdir(parents=True, exist_ok=True)
    src = ROOT / "data" / "scenes" / "sample-painted-bedroom" / "world.spz"
    manifest = []
    if src.exists():
        bed = sio.read_spz(src)
        sio.write_spz(out / "bedroom_v3.spz", bed, version=3)
        sio.write_spz(out / "bedroom_v2.spz", bed, version=2)
        flip = np.diag([1.0, -1.0, -1.0])
        gl = sio.transform_splats(bed, flip)
        sio.write_spz(out / "bedroom_gl_v3.spz", gl, version=3)
        sio.write_ply(out / "bedroom_gl.ply", gl)
        manifest += [
            {"name": "sample_original", "file": str(src.relative_to(ROOT)), "quaternion": [1, 0, 0, 0]},
            {"name": "bedroom_v3", "file": str((out / "bedroom_v3.spz").relative_to(ROOT)), "quaternion": [1, 0, 0, 0]},
            {"name": "bedroom_v2", "file": str((out / "bedroom_v2.spz").relative_to(ROOT)), "quaternion": [1, 0, 0, 0]},
            {"name": "bedroom_gl_v3", "file": str((out / "bedroom_gl_v3.spz").relative_to(ROOT)), "quaternion": [0, 0, 0, 1]},
            {"name": "bedroom_gl_ply", "file": str((out / "bedroom_gl.ply").relative_to(ROOT)), "quaternion": [0, 0, 0, 1]},
        ]
    sph = spheres_scene()
    sio.write_spz(out / "sh2_spheres.spz", sph, version=3)
    manifest.append({"name": "sh2_spheres", "file": str((out / "sh2_spheres.spz").relative_to(ROOT)), "quaternion": [0, 0, 0, 1]})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
