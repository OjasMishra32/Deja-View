"""Object records (objects-all.json or objects.json) in metres. Pure; shared by reconstruct and evaluate."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class ObjectBox:
    id: str
    label: str
    centre: np.ndarray  # metres, room frame
    half: np.ndarray  # metres
    record: dict

    @property
    def lo(self) -> np.ndarray:
        return self.centre - self.half

    @property
    def hi(self) -> np.ndarray:
        return self.centre + self.half

    @property
    def size(self) -> np.ndarray:
        return self.half * 2


def objects_file(scene_dir: str | Path, explicit: str | Path | None = None) -> Path:
    scene_dir = Path(scene_dir)
    for cand in ([Path(explicit)] if explicit else []) + [scene_dir / "objects-all.json", scene_dir / "objects.json"]:
        if cand.exists():
            return cand
    raise FileNotFoundError(f"no objects-all.json or objects.json in {scene_dir}")


def load_objects(path: str | Path) -> list[ObjectBox]:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    studs = float(doc.get("studsPerMeter") or 3.57)
    out = []
    for o in doc.get("objects", []):
        c = np.asarray(o["center"], np.float64) / studs
        h = np.asarray(o["size"], np.float64) / studs / 2.0
        out.append(ObjectBox(str(o["id"]), str(o.get("label", o["id"])), c, h, o))
    return out


def pick(objects: list[ObjectBox], wanted: list[str] | None) -> list[ObjectBox]:
    if not wanted or wanted == ["all"]:
        return objects
    got = [o for o in objects if o.id in wanted or o.label in wanted]
    missing = [w for w in wanted if not any(o.id == w or o.label == w for o in got)]
    if missing:
        raise ValueError(f"not in the objects file: {', '.join(missing)}")
    return got
