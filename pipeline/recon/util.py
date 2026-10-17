"""Small helpers shared by the reconstruction steps: paths, logging, JSON, the work folder layout."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PIPELINE_DIR = HERE.parent
# pipeline/ on the path so `common.*` and `splat_io` import the same way they do for the other runners
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(1, str(PIPELINE_DIR))

_T0 = time.time()


def log(step: str, msg: str) -> None:
    print(f"[recon:{step}] {time.strftime('%H:%M:%S')} +{time.time() - _T0:6.1f}s {msg}", file=sys.stderr, flush=True)


def read_json(path: Path | str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path | str, obj: Any, indent: int | None = 1) -> None:
    import numpy as np

    def conv(x: Any) -> Any:
        if isinstance(x, dict):
            return {str(k): conv(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [conv(v) for v in x]
        if isinstance(x, np.ndarray):
            return conv(x.tolist())
        if isinstance(x, np.floating):
            return float(x)
        if isinstance(x, np.integer):
            return int(x)
        if isinstance(x, np.bool_):
            return bool(x)
        return x

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(conv(obj), f, indent=indent)
        f.write("\n")
    os.replace(tmp, path)


class Work:
    """The work folder one capture goes through (every step reads and writes here).

    images/<group>/<name>.jpg   prepared inputs (photos resized, sharp video frames)
    masks/<group>/<name>.jpg.png  255 = use, 0 = ignore (people); COLMAP's mask naming
    frames.json                 what prep.py made: per image source, frame index, time, intrinsics prior
    colmap/                     database, sparse models, text export
    poses.json                  the solved cameras and sparse points (poses.py), COLMAP frame
    frame.json                  COLMAP frame -> room frame (frame.py pre), spawn
    room.json                   cameras + points in the room frame, what train_gs.py reads
    train/                      checkpoints, splats.ply, metrics.json, renders
    """

    def __init__(self, root: Path | str):
        self.root = Path(root)

    @property
    def images(self) -> Path:
        return self.root / "images"

    @property
    def masks(self) -> Path:
        return self.root / "masks"

    @property
    def frames(self) -> Path:
        return self.root / "frames.json"

    @property
    def colmap(self) -> Path:
        return self.root / "colmap"

    @property
    def poses(self) -> Path:
        return self.root / "poses.json"

    @property
    def frame(self) -> Path:
        return self.root / "frame.json"

    @property
    def room(self) -> Path:
        return self.root / "room.json"

    @property
    def train(self) -> Path:
        return self.root / "train"

    def mask_for(self, name: str) -> Path:
        return self.masks / f"{name}.png"
