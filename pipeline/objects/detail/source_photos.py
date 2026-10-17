#!/usr/bin/env python3
"""Task 1: how much detail does the splat lose against the capture photos?

    python pipeline/objects/detail/source_photos.py --photos data/scenes/kitchen/frames \
        --cameras data/scenes/kitchen/cameras.json --scene data/scenes/kitchen --out runs/source-photos

For every source photo that has a pose (AnySplat writes `cameras.json` with position + quaternion per input file
and `input_camera.json` with the intrinsics), it renders the splats from that pose at 512 px and at the photo's own
resolution, and reports the variance of the Laplacian of each (overall and inside an object mask when `--masks`
holds `<photo stem>.png`). Without poses it still reports the photos' sharpness against the scene's 512 px views,
which bounds the gap. Writes `source-photos.json` and a side-by-side sheet. Never uploads anything.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from objects.detail import metrics as M  # noqa: E402

PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def load(path: Path, width: int | None = None) -> np.ndarray:
    from PIL import Image

    im = Image.open(path).convert("RGB")
    if width and im.width != width:
        im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
    return np.asarray(im, np.float64) / 255.0


def resize_mask(mask: np.ndarray, shape) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize((shape[1], shape[0]), Image.NEAREST)) > 127


def sharpness_table(pairs: list[tuple[str, np.ndarray, np.ndarray, np.ndarray | None]]) -> list[dict]:
    """[(name, photo, render, mask)] at the same size -> Laplacian variance of each and their ratio."""
    rows = []
    for name, photo, render, mask in pairs:
        lp, lr = M.laplacian_variance(photo, mask), M.laplacian_variance(render, mask)
        rows.append({"photo": name, "lapVarPhoto": lp, "lapVarSplat": lr,
                     "ratio": (lp / lr) if lp is not None and lr else None,
                     "ssim": M.ssim(photo, render, mask), "psnr": M.psnr(photo, render, mask)})
    return rows


def run(photos: Path, out: Path, scene: Path | None = None, cameras: Path | None = None, masks: Path | None = None,
        width: int = 512, log=print) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in photos.iterdir() if p.suffix.lower() in PHOTO_EXT)
    if not files:
        raise SystemExit(f"no photos in {photos}")
    doc: dict = {"photos": str(photos), "count": len(files), "width": width}
    native = [M.laplacian_variance(load(p)) for p in files]
    at512 = [M.laplacian_variance(load(p, width)) for p in files]
    doc["photoLapVarNative"] = M.summarise(native)
    doc["photoLapVar512"] = M.summarise(at512)
    if scene is not None and (scene / "views" / "views.json").exists():
        meta = json.loads((scene / "views" / "views.json").read_text())
        vl = [M.laplacian_variance(load(scene / "views" / v["file"], width)) for v in meta["views"]]
        doc["splatViewLapVar512"] = M.summarise(vl)
    if scene is not None and cameras is not None and cameras.exists():
        import splat_io as sio

        from objects import scene as obj_scene

        splats, _ = obj_scene.load_scene(scene)
        cam_doc = json.loads(cameras.read_text())
        intr = json.loads((cameras.parent / "input_camera.json").read_text())
        by_file = {Path(c["file"]).name: c for c in cam_doc.get("cameras", []) if c.get("file")}
        pairs = []
        for p in files:
            c = by_file.get(p.name)
            if c is None:
                continue
            c2w = np.eye(4)
            c2w[:3, :3] = sio.quat_xyzw_to_matrix(c["quaternion"])
            c2w[:3, 3] = c["position"]
            photo = load(p, width)
            s = width / float(intr["width"])
            h = photo.shape[0]
            r = sio.render(splats, c2w, intr["fx"] * s, intr["fy"] * s, intr["cx"] * s, intr["cy"] * s, width, h)
            render = np.asarray(r.rgb, np.float64) / 255.0
            mask = None
            if masks is not None and (masks / f"{p.stem}.png").exists():
                mask = resize_mask(load(masks / f"{p.stem}.png").mean(axis=-1) > 0.5, photo.shape)
            pairs.append((p.name, photo, render, mask))
        doc["posed"] = sharpness_table(pairs)
        doc["posedRatio"] = M.summarise([r["ratio"] for r in doc["posed"]])
        if pairs:
            from objects.detail.evaluate import contact_sheet

            contact_sheet([[ph, rd] for _, ph, rd, _ in pairs[:6]], ["photo", "splat 512"], out / "sheet.jpg")
    if doc.get("splatViewLapVar512") and doc.get("photoLapVar512"):
        doc["viewRatio"] = round(doc["photoLapVar512"] / doc["splatViewLapVar512"], 3)
    (out / "source-photos.json").write_text(json.dumps(doc, indent=2))
    log(json.dumps({k: v for k, v in doc.items() if k != "posed"}, indent=1))
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scene", default=None)
    ap.add_argument("--cameras", default=None, help="AnySplat cameras.json (input_camera.json beside it)")
    ap.add_argument("--masks", default=None)
    ap.add_argument("--width", type=int, default=512)
    a = ap.parse_args(argv)
    run(Path(a.photos), Path(a.out), Path(a.scene) if a.scene else None, Path(a.cameras) if a.cameras else None,
        Path(a.masks) if a.masks else None, a.width)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
