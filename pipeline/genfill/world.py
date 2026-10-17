"""A scene folder as genfill sees it: the splats, scene.json, the training cameras, and (optionally) their images.

numpy only. The training cameras come from the scene's cameras.json (viewer frame, OpenGL c2w, pinhole intrinsics
of the undistorted image, distortion of the original), which pipeline/recon/frame.py writes next to world.spz.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PIPELINE = HERE.parent
for p in (str(PIPELINE), str(PIPELINE / "recon")):
    if p not in sys.path:
        sys.path.insert(1, p)

import splat_io as sio  # noqa: E402

from .geom import Intr  # noqa: E402


@dataclass
class TrainCam:
    name: str
    group: str
    c2w: np.ndarray  # OpenGL camera-to-world, viewer frame
    intr: Intr
    distortion: dict = field(default_factory=dict)

    @property
    def position(self) -> np.ndarray:
        return self.c2w[:3, 3]

    @property
    def forward(self) -> np.ndarray:
        return -self.c2w[:3, 2]


@dataclass
class World:
    scene_dir: Path
    scene: dict
    world_file: str
    splats: sio.Splats
    cams: list[TrainCam]
    digest: str

    @property
    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        b = self.scene.get("world", {}).get("bounds")
        if b:
            return np.asarray(b["min"], np.float64), np.asarray(b["max"], np.float64)
        m = self.splats.means[self.splats.opacities > 0.5]
        rb = sio.robust_bounds(m, 1, 99)
        return np.asarray(rb["min"], np.float64), np.asarray(rb["max"], np.float64)

    def cam_xz(self) -> np.ndarray:
        return np.array([[c.position[0], c.position[2]] for c in self.cams]) if self.cams else np.zeros((0, 2))

    def eye_height(self, default: float = 1.6) -> float:
        return default


def file_digest(path: Path, nbytes: int = 1 << 22) -> str:
    """sha1 of the size and the first and last 4 MB: enough to tell two worlds apart cheaply."""
    h = hashlib.sha1()
    size = path.stat().st_size
    h.update(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(nbytes))
        if size > nbytes:
            f.seek(max(0, size - nbytes))
            h.update(f.read(nbytes))
    return h.hexdigest()[:16]


def read_cameras(path: Path) -> list[TrainCam]:
    if not path.exists():
        return []
    doc = json.loads(path.read_text())
    out = []
    for c in doc.get("cameras", []):
        k = c["intrinsics"]
        out.append(TrainCam(c["name"], str(c.get("group", "")), np.asarray(c["c2w"], np.float64), Intr.from_json(k),
                            dict(c.get("distortion") or {})))
    return out


def load(scene_dir: Path | str, world_file: str | None = None, cameras: Path | str | None = None) -> World:
    scene_dir = Path(scene_dir)
    scene = json.loads((scene_dir / "scene.json").read_text())
    wf = world_file or scene.get("world", {}).get("file", "world.spz")
    path = scene_dir / wf
    s = sio.read_splats(path)
    cams = read_cameras(Path(cameras) if cameras else scene_dir / "cameras.json")
    return World(scene_dir, scene, wf, s, cams, file_digest(path))


def load_image(images: Path, cam: TrainCam, with_mask: bool = True, masks: Path | None = None):
    """The training image of a camera, undistorted onto its pinhole intrinsics (as the trainer saw it), and its
    people mask (True = use). Returns (rgb uint8, mask bool) or (None, None) when the file is missing."""
    import cv2

    p = images / cam.name
    bgr = cv2.imread(str(p), cv2.IMREAD_COLOR)
    if bgr is None:
        return None, None
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    mask = np.ones(rgb.shape[:2], bool)
    if with_mask:
        mdir = masks if masks is not None else images.parent / "masks"
        mp = mdir / f"{cam.name}.png"
        if mp.exists():
            m = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE)
            if m is not None and m.shape == mask.shape:
                mask = m > 127
    d = cam.distortion or {}
    if any(abs(float(v)) > 0 for v in d.values()):
        from cams import Camera

        k = cam.intr
        if set(d) <= {"k1"}:
            camm = Camera("SIMPLE_RADIAL", k.width, k.height, np.array([k.fx, k.cx, k.cy, d.get("k1", 0.0)]))
        else:
            camm = Camera("OPENCV", k.width, k.height,
                          np.array([k.fx, k.fy, k.cx, k.cy, d.get("k1", 0.0), d.get("k2", 0.0), d.get("p1", 0.0), d.get("p2", 0.0)]))
        if not camm.is_pinhole():
            mx, my = camm.undistort_maps()
            rgb = cv2.remap(rgb, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            mask = cv2.remap(mask.astype(np.uint8) * 255, mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 127
    if rgb.shape[:2] != (cam.intr.height, cam.intr.width):
        rgb = cv2.resize(rgb, (cam.intr.width, cam.intr.height), interpolation=cv2.INTER_AREA)
        mask = cv2.resize(mask.astype(np.uint8), (cam.intr.width, cam.intr.height), interpolation=cv2.INTER_NEAREST) > 0
    return rgb, mask


def write_json(path: Path | str, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(sio.jsonable(obj), indent=1) + "\n")
    os.replace(tmp, path)


def save_png(path: Path | str, rgb: np.ndarray) -> None:
    from PIL import Image

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.png")
    Image.fromarray(np.asarray(rgb, np.uint8)).save(tmp, optimize=True)
    os.replace(tmp, path)


def save_jpg(path: Path | str, rgb: np.ndarray, quality: int = 88) -> None:
    sio.save_jpeg(path, rgb, quality=quality)


def label(rgb: np.ndarray, text: str, scale: float = 0.55) -> np.ndarray:
    """Writes a caption into the top-left corner (white on a dark band)."""
    import cv2

    out = np.ascontiguousarray(rgb.copy())
    h = int(22 * scale / 0.55)
    out[:h] = (out[:h].astype(np.float32) * 0.35).astype(np.uint8)
    cv2.putText(out, text, (6, int(h * 0.75)), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def sheet(images: list[np.ndarray], cols: int, pad: int = 4) -> np.ndarray:
    return sio.contact_sheet(images, cols=cols, pad=pad)
