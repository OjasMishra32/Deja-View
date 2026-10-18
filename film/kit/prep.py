"""Turn the Game Lawn's real camera solve and training log into data the film shots read.

Reads film/assets/courts/{poses.json, points.npz, logs/train-*.log, images/}. Writes film/assets/kit/:
  courts.json   cameras (centre and image-plane corners, upright and scaled), stats, training curve
  points.bin    sparse points: float32 xyz, then uint8 rgb, then uint8 track length
  thumbs/       one small JPEG per registered view
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "film/assets/courts"
OUT = ROOT / "film/assets/kit"
PLANE_DEPTH = 0.9  # image planes sit this far in front of each camera, in film units


def qvec_to_r(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def rotation_to(up):
    """A rotation taking `up` onto +Y."""
    up = up / np.linalg.norm(up)
    y = np.array([0.0, 1.0, 0.0])
    v = np.cross(up, y)
    c = float(up @ y)
    if np.linalg.norm(v) < 1e-8:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def training_curve(log: Path):
    rows = []
    pat = re.compile(r"step\s+(\d+)\s+loss\s+([\d.]+)\s+psnr\s+([\d.]+)\s+splats\s+(\d+)\s+sh\s+(\d+)\s+([\d.]+)s\s+pose dR\s+([\d.]+) deg dt\s+([\d.]+) cm")
    for line in log.read_text().splitlines():
        m = pat.search(line)
        if m:
            s, loss, psnr, splats, sh, secs, dr, dt = m.groups()
            rows.append({"step": int(s), "loss": float(loss), "psnr": float(psnr), "splats": int(splats), "sh": int(sh),
                         "seconds": float(secs), "poseDeg": float(dr), "poseCm": float(dt)})
    held = re.search(r"held-out \{'psnr': ([\d.]+), 'ssim': ([\d.]+)", log.read_text())
    gpu = log.read_text().splitlines()[0].strip()
    return rows, ({"psnr": float(held.group(1)), "ssim": float(held.group(2))} if held else None), gpu


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "thumbs").mkdir(exist_ok=True)
    poses = json.loads((SRC / "poses.json").read_text())
    cams = poses["cameras"]
    images = [im for im in poses["images"] if im.get("registered")]
    pts = np.load(SRC / "points.npz")

    rs = [qvec_to_r(im["qvec"]) for im in images]
    up = -np.mean([r[1] for r in rs], axis=0)  # OpenCV y points down
    rot = rotation_to(up)
    xyz = pts["xyz"].astype(np.float64)
    centre = np.median(xyz, axis=0)
    radius = np.percentile(np.linalg.norm(xyz - centre, axis=1), 90)
    scale = 10.0 / radius

    def tf(p):
        return (rot @ (np.asarray(p) - centre).T).T * scale

    out_cams = []
    for im, r in zip(images, rs):
        cam = cams[im["camera"]]
        c = tf(np.asarray(im["center"]))
        x, y, z = (rot @ r[0], rot @ r[1], rot @ r[2])
        hw = cam["width"] / (2 * cam["fx"]) * PLANE_DEPTH
        hh = cam["height"] / (2 * cam["fy"]) * PLANE_DEPTH
        mid = c + z * PLANE_DEPTH
        corners = [mid - x * hw - y * hh, mid + x * hw - y * hh, mid + x * hw + y * hh, mid - x * hw + y * hh]
        name = im["name"]
        thumb = "thumbs/" + name.replace("/", "_")
        src = SRC / "images" / name
        if src.exists() and not (OUT / thumb).exists():
            Image.open(src).convert("RGB").resize((320, 240), Image.LANCZOS).save(OUT / thumb, quality=86)
        out_cams.append({"name": name, "group": im["group"], "centre": c.round(4).tolist(),
                         "corners": [p.round(4).tolist() for p in corners], "forward": z.round(4).tolist(),
                         "observations": im.get("numObservations"), "error": im.get("reprojError"), "thumb": thumb})

    p = tf(xyz).astype(np.float32)
    rgb = pts["rgb"].astype(np.uint8)
    track = np.clip(pts["track"], 0, 255).astype(np.uint8)
    (OUT / "points.bin").write_bytes(p.tobytes() + rgb.tobytes() + track.tobytes())

    log = max((SRC / "logs").glob("train-*.log"), key=lambda f: "train4" in f.read_text())
    curve, held, gpu = training_curve(log)
    meta = {"stats": poses["stats"], "points": int(len(p)), "cameras": out_cams, "training": curve, "heldOut": held,
            "gpu": gpu, "metrics": json.loads((SRC / "train4/metrics.json").read_text())}
    (OUT / "courts.json").write_text(json.dumps(meta))
    print(f"{len(out_cams)} cameras, {len(p)} points, {len(curve)} training rows, held-out {held}, gpu: {gpu[:60]}")


if __name__ == "__main__":
    main()
