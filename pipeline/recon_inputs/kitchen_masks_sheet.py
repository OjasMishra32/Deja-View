#!/usr/bin/env python3
"""Evidence sheet of the person masks of one prepared video group: sample frames with the masked area tinted red.

  python pipeline/recon_inputs/kitchen_masks_sheet.py --work WORK --group cook --out EVID/masks-cook.jpg [--n 12]
      [--names cook/f000123.jpg ...]

Frames are spread evenly over the clip (or the given --names); each tile shows the time, the frame index and the
masked fraction. Also prints the masked-fraction distribution over every frame of the group.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def main(argv=None) -> int:
    import cv2

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--group", default="cook")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--tile", type=int, default=480)
    ap.add_argument("--names", nargs="*", default=None)
    a = ap.parse_args(argv)
    frames = json.loads((a.work / "frames.json").read_text())
    recs = sorted((im for im in frames["images"] if im["group"] == a.group), key=lambda r: r.get("frameIndex", 0))
    fr = np.array([r.get("masked", 0.0) for r in recs])
    print(f"{len(recs)} frames; masked fraction min {fr.min():.3f} median {np.median(fr):.3f} max {fr.max():.3f}; "
          f"no person in {int((fr == 0).sum())}")
    if a.names:
        pick = [r for r in recs if r["name"] in set(a.names)]
    else:
        pick = [recs[i] for i in np.linspace(0, len(recs) - 1, min(a.n, len(recs))).round().astype(int)]
    tiles = []
    for r in pick:
        img = cv2.imread(str(a.work / "images" / r["name"]))
        m = cv2.imread(str(a.work / "masks" / f"{r['name']}.png"), cv2.IMREAD_GRAYSCALE)
        if m is not None:
            sel = m < 128
            img[sel] = (0.45 * img[sel] + 0.55 * np.array([40, 40, 235])).astype(np.uint8)
            cnts, _ = cv2.findContours(sel.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(img, cnts, -1, (0, 0, 255), 3)
        h = int(round(a.tile * img.shape[0] / img.shape[1]))
        img = cv2.resize(img, (a.tile, h), interpolation=cv2.INTER_AREA)
        label = f"{r['name'].split('/')[-1]}"
        if "time" in r:
            label = f"t={r['time']:.1f}s f{r['frameIndex']}"
        label += f"  {100 * r.get('masked', 0):.0f}% masked"
        cv2.rectangle(img, (0, 0), (a.tile, 26), (0, 0, 0), -1)
        cv2.putText(img, label, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(img)
    th = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, th - t.shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles]
    while len(tiles) % a.cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.concatenate(tiles[k:k + a.cols], axis=1) for k in range(0, len(tiles), a.cols)]
    a.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out), np.concatenate(rows, axis=0), [cv2.IMWRITE_JPEG_QUALITY, 82])
    print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
