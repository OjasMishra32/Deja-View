"""Preflight GLB parsing, texture extraction, sheet, and the safe default."""
import io
import json
import struct

import numpy as np
import pytest
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


_EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
_EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"]
_EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"]
_EAN_FIRST = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]


def _ean13_image(digits: str, module: int = 2) -> np.ndarray:
    d = [int(c) for c in digits]
    bits = "101" + "".join((_EAN_L if _EAN_FIRST[d[0]][i] == "L" else _EAN_G)[c] for i, c in enumerate(d[1:7]))
    bits += "01010" + "".join(_EAN_R[c] for c in d[7:]) + "101"
    quiet = 40  # modules of white either side; OpenCV's detector needs a wide quiet zone
    img = np.full((200, (len(bits) + 2 * quiet) * module, 3), 255, np.uint8)
    for i, b in enumerate(bits):
        if b == "1":
            img[60:140, (i + quiet) * module:(i + quiet + 1) * module] = 0
    return img


def test_a_decoded_barcode_is_reported_as_text(tmp_path):
    cv2 = pytest.importorskip("cv2")
    if not hasattr(cv2, "barcode"):
        pytest.skip("this OpenCV build has no barcode detector")
    tex = tmp_path / "textures"
    tex.mkdir()
    Image.fromarray(_ean13_image("4006381333931")).save(tex / "texture_00.png")
    scan = preflight.scan_codes([{"file": "texture_00.png"}], tex)
    json.dumps(scan)  # the report must stay writable
    assert scan["status"] == "ok"
    assert scan["barcodes"] and scan["barcodes"][0]["text"] == ["4006381333931"]
