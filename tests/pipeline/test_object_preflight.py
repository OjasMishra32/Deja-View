"""Preflight GLB parsing, texture extraction, sheet, and the safe default."""
import io
import json
import struct

import numpy as np
from PIL import Image

import pipeline_helpers  # noqa: F401
from objects import preflight


def _tiny_glb(tmp_path):
    buf = io.BytesIO()
    Image.fromarray(np.full((8, 8, 3), 200, np.uint8)).save(buf, format="PNG")
    png = buf.getvalue()
    pad = (-len(png)) % 4
    blob = png + b"\x00" * pad
    doc = {
        "asset": {"version": "2.0"},
        "images": [{"mimeType": "image/png", "bufferView": 0}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(png)}],
        "buffers": [{"byteLength": len(blob)}],
    }
    js = json.dumps(doc).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    out = tmp_path / "tiny.glb"
    out.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js +
                    struct.pack("<II", len(blob), 0x004E4942) + blob)
    return out


def test_extract_and_sheet_from_a_glb(tmp_path):
    glb = _tiny_glb(tmp_path)
    out = tmp_path / "pre"
    images = preflight.extract_images(glb, out)
    assert len(images) == 1
    assert (out / "textures" / images[0]["file"]).exists()
    sheet = preflight.contact_sheet(images, out / "textures", out / "textures.jpg")
    assert sheet.exists() and sheet.stat().st_size > 0


def test_report_is_never_approved_automatically(tmp_path):
    glb = _tiny_glb(tmp_path)
    report = preflight.preflight(glb, tmp_path / "pre")
    assert report["approved"] is False
    assert report["images"]
    assert "clear" in report
