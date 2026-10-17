#!/usr/bin/env python3
"""Look at an object asset before it goes anywhere near Roblox.

    python pipeline/objects/preflight.py --glb data/scenes/kitchen/objects/fridge/roblox.glb \
        --out data/scenes/kitchen/objects/fridge/preflight

Extracts every texture embedded in the GLB, builds a labelled contact sheet, and scans
each image for QR codes and barcodes with OpenCV when it is available. Roblox moderation
flags QR codes, URLs, contact details and promotional text. A human must look at the
sheet; this report never approves an upload by itself.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

REPORT_FILE = "preflight.json"


def read_glb(path: str | Path) -> tuple[dict, bytes]:
    data = Path(path).read_bytes()
    if len(data) < 20:
        raise ValueError("not a GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError("not a glTF 2 binary")
    off = 12
    js: dict | None = None
    bin_chunk = b""
    while off < min(length, len(data)):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            bin_chunk = chunk
    if js is None:
        raise ValueError("GLB has no JSON chunk")
    return js, bin_chunk


def extract_images(glb_path: str | Path, out_dir: str | Path) -> list[dict]:
    js, blob = read_glb(glb_path)
    out = Path(out_dir)
    tex = out / "textures"
    tex.mkdir(parents=True, exist_ok=True)
    views = js.get("bufferViews") or []
    images = []
    for i, img in enumerate(js.get("images") or []):
        bv = img.get("bufferView")
        if bv is None or bv >= len(views):
            continue
        v = views[bv]
        start = int(v.get("byteOffset", 0))
        end = start + int(v.get("byteLength", 0))
        raw = blob[start:end]
        ext = ".png" if "png" in str(img.get("mimeType", "")) else ".jpg"
        path = tex / f"texture_{i:02d}{ext}"
        path.write_bytes(raw)
        images.append({"index": i, "file": path.name, "mime": img.get("mimeType"), "bytes": len(raw)})
    return images


def contact_sheet(images: list[dict], tex_dir: str | Path, out_path: str | Path, cols: int = 4, tile: int = 320) -> Path:
    from PIL import Image, ImageDraw
    tex = Path(tex_dir)
    rows = max(1, (len(images) + cols - 1) // cols)
    sheet = Image.new("RGB", (cols * tile, rows * (tile + 18)), (28, 28, 32))
    draw = ImageDraw.Draw(sheet)
    for i, info in enumerate(images):
        img = Image.open(tex / info["file"]).convert("RGB")
        img.thumbnail((tile - 8, tile - 8))
        x = (i % cols) * tile + (tile - img.width) // 2
        y = (i // cols) * (tile + 18) + 18 + (tile - img.height) // 2
        sheet.paste(img, (x, y))
        draw.text(((i % cols) * tile + 6, (i // cols) * (tile + 18) + 3), info["file"], fill=(230, 230, 230))
    sheet.save(out_path, quality=92)
    return Path(out_path)


def scan_codes(images: list[dict], tex_dir: str | Path) -> dict:
    try:
        import cv2
    except Exception as e:  # noqa: BLE001
        return {"status": "unavailable", "reason": str(e), "qr": [], "qrCandidates": [], "barcodes": []}
    tex = Path(tex_dir)
    qr = []
    candidates = []
    bars = []
    try:
        detector = cv2.QRCodeDetector()
    except Exception:  # noqa: BLE001
        detector = None
    try:
        barcode = cv2.barcode.BarcodeDetector()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        barcode = None
    for info in images:
        img = cv2.imread(str(tex / info["file"]))
        if img is None:
            continue
        for scale in (1.0, 2.0):
            probe = img if scale == 1.0 else cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            if detector is not None:
                text, points, _ = detector.detectAndDecode(probe)
                if points is not None and len(points):
                    # A real QR or link has a payload. An empty payload on a fragmented texture atlas
                    # is a pattern hit, not a promotion: show it for review, do not call it a violation.
                    entry = {"file": info["file"], "scale": scale, "text": text}
                    (qr if str(text).strip() else candidates).append(entry)
            if barcode is not None:
                res = barcode.detectAndDecode(probe)
                if res and len(res) >= 2 and res[0]:
                    texts = res[1] if isinstance(res[1], (list, tuple)) else [res[1]]
                    bars.append({"file": info["file"], "scale": scale, "text": list(texts)})
    return {"status": "ok", "qr": qr, "qrCandidates": candidates, "barcodes": bars}


def preflight(glb_path: str | Path, out_dir: str | Path) -> dict:
    glb_path = Path(glb_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    images = extract_images(glb_path, out)
    sheet = contact_sheet(images, out / "textures", out / "textures.jpg")
    scan = scan_codes(images, out / "textures")
    clear = scan["status"] == "ok" and not scan["qr"] and not scan["barcodes"]
    report = {
        "version": 1,
        "glb": str(glb_path),
        "bytes": glb_path.stat().st_size,
        "images": images,
        "sheet": str(sheet),
        "scan": scan,
        "clear": bool(clear),
        "approved": False,
        "note": "A human must inspect the contact sheet. This report never approves an upload by itself.",
    }
    (out / REPORT_FILE).write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    out = Path(args.out) if args.out else Path(args.glb).parent / "preflight"
    report = preflight(args.glb, out)
    print(f"textures: {len(report['images'])}")
    print(f"sheet: {report['sheet']}")
    print(f"scan: {report['scan']['status']}  qr={len(report['scan']['qr'])}  candidates={len(report['scan'].get('qrCandidates', []))}  barcodes={len(report['scan']['barcodes'])}")
    print(f"clear: {report['clear']}")
    print("Inspect the sheet yourself. The report does not approve the upload.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
