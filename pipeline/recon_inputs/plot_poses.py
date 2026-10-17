"""Top-down evidence plot of a COLMAP model: sparse points in their colours, camera centres per video.

"Up" is the mean of the cameras' up vectors (handheld video is held roughly level), so the view looks
straight down on the floor; the horizontal axes follow the spread of the camera path. Needs numpy and
matplotlib only.

  python pipeline/recon_inputs/plot_poses.py MODEL_TXT_DIR FRAMES_JSON OUT.png [--title "..."]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_2 = "#52514e"
GRID = "#e4e3df"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]  # first three categorical slots (validated all-pairs)


def qvec_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def read_model(path: Path) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray]:
    images = {}
    lines = [ln for ln in (path / "images.txt").read_text().splitlines() if not ln.startswith("#")]
    for k in range(0, len(lines) - 1, 2):
        t = lines[k].split()
        if len(t) < 10:
            continue
        R = qvec_to_rotmat(np.array([float(v) for v in t[1:5]]))
        tv = np.array([float(v) for v in t[5:8]])
        images[t[9]] = {"center": -R.T @ tv, "forward": R.T @ np.array([0.0, 0.0, 1.0]),
                        "up": -(R.T @ np.array([0.0, 1.0, 0.0]))}
    xyz, rgb, err = [], [], []
    for line in (path / "points3D.txt").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        t = line.split()
        xyz.append([float(v) for v in t[1:4]])
        rgb.append([int(v) for v in t[4:7]])
        err.append(float(t[7]))
    return images, np.asarray(xyz), np.asarray(rgb, np.float64) / 255.0, np.asarray(err)


def plot(model: Path, frames_json: Path, out: Path, title: str) -> dict:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    images, xyz, rgb, err = read_model(model)
    frames = json.loads(frames_json.read_text())
    meta = {im["name"]: im for im in frames["images"]}
    up = np.mean([v["up"] for v in images.values()], axis=0)
    up /= np.linalg.norm(up)
    centers = np.array([v["center"] for v in images.values()])
    flat = centers - np.outer(centers @ up, up)
    flat -= flat.mean(0)
    _, _, vt = np.linalg.svd(flat, full_matrices=False)
    e1 = vt[0] - (vt[0] @ up) * up
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)

    def proj(p):
        return np.stack([p @ e1, p @ e2], axis=-1)

    # Points: drop the worst-fitting ones and far outliers (a few wild points stretch the axes).
    keep = err < np.percentile(err, 95)
    p2 = proj(xyz)
    med = np.median(p2[keep], axis=0)
    dist = np.linalg.norm(p2 - med, axis=1)
    keep &= dist < np.percentile(dist[keep], 98)
    c2 = proj(centers)

    fig, ax = plt.subplots(figsize=(11, 9.5), dpi=150, facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    ax.scatter(p2[keep, 0], p2[keep, 1], s=0.6, c=rgb[keep], alpha=0.55, linewidths=0, rasterized=True)

    by_group: dict[str, list[str]] = {}
    for name in images:
        by_group.setdefault(meta.get(name, {}).get("group", name.split("/")[0]), []).append(name)
    order = sorted(by_group, key=lambda g: -len(by_group[g]))
    slot = {g: SERIES[min(i, 2)] for i, g in enumerate(order)}
    labels = {}
    for i, g in enumerate(order):
        names = sorted(by_group[g], key=lambda n: meta.get(n, {}).get("frameIndex", 0))
        pts = proj(np.array([images[n]["center"] for n in names]))
        fwd = proj(np.array([images[n]["forward"] for n in names]))
        fwd /= np.maximum(np.linalg.norm(fwd, axis=1, keepdims=True), 1e-9)
        scale = 0.03 * np.ptp(c2, axis=0).max()
        ax.plot(pts[:, 0], pts[:, 1], color=slot[g], lw=1.0, alpha=0.5, zorder=3)
        ax.quiver(pts[:, 0], pts[:, 1], fwd[:, 0] * scale, fwd[:, 1] * scale, color=slot[g], angles="xy",
                  scale_units="xy", scale=1, width=0.0018, headwidth=3, headlength=3.5, alpha=0.8, zorder=4)
        ax.scatter(pts[:, 0], pts[:, 1], s=16, color=slot[g], edgecolors=SURFACE, linewidths=0.8, zorder=5,
                   label=f"{g}: {len(names)} cameras" if i < 2 else None)
        labels[g] = len(names)
    if len(order) > 2:
        rest = ", ".join(f"{g} ({labels[g]})" for g in order[2:])
        ax.scatter([], [], s=16, color=SERIES[2], edgecolors=SURFACE, label=f"{rest}")
    clip = [n for n in images if "clip" in meta.get(n, {}).get("roles", [])]
    if clip:
        cp = proj(np.array([images[n]["center"] for n in clip]))
        ax.scatter(cp[:, 0], cp[:, 1], s=70, facecolors="none", edgecolors=TEXT, linewidths=1.0, zorder=6,
                   label=f"players clip: {len(clip)} frames")

    ax.set_aspect("equal")
    lo = np.minimum(p2[keep].min(0), c2.min(0))
    hi = np.maximum(p2[keep].max(0), c2.max(0))
    pad = 0.04 * (hi - lo).max()
    ax.set_xlim(lo[0] - pad, hi[0] + pad)
    ax.set_ylim(lo[1] - pad, hi[1] + pad)
    ax.grid(color=GRID, lw=0.6)
    ax.tick_params(colors=TEXT_2, labelsize=8)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.set_xlabel("COLMAP units (not metric), horizontal axis 1", color=TEXT_2, fontsize=9)
    ax.set_ylabel("horizontal axis 2", color=TEXT_2, fontsize=9)
    n_total = len(frames["images"])
    ax.set_title(title or "Registered cameras and sparse points, top-down", color=TEXT, fontsize=13, loc="left", pad=22)
    ax.text(0, 1.012, f"{len(images)}/{n_total} images registered, {int(keep.sum()):,} of {len(xyz):,} points shown "
            f"(worst 5% reprojection error and far outliers hidden); arrows = viewing direction",
            transform=ax.transAxes, color=TEXT_2, fontsize=9)
    leg = ax.legend(loc="lower right", fontsize=9, frameon=True, facecolor=SURFACE, edgecolor=GRID)
    for t in leg.get_texts():
        t.set_color(TEXT)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)
    return {"registered": len(images), "total": n_total, "points": len(xyz), "shown": int(keep.sum())}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path, help="COLMAP model as TXT (cameras.txt, images.txt, points3D.txt)")
    ap.add_argument("frames", type=Path, help="frames.json of the work folder")
    ap.add_argument("out", type=Path)
    ap.add_argument("--title", default="")
    args = ap.parse_args(argv)
    print(plot(args.model, args.frames, args.out, args.title))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
