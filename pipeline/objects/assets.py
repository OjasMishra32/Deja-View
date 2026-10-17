"""Plan and record Roblox asset uploads for scene objects.

An upload is allowed only when the object's preflight/approval.json is approved and its
sha1 matches the current roblox.glb. Any change to the file invalidates the approval.

The asset id is written back onto the object in objects.json, which is what the Roblox
ObjectLayer reads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha1(path: str | Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def plan(scene_dir: str | Path) -> list[dict]:
    """Every object with a GLB, with its approval state and the reason for it."""
    scene_dir = Path(scene_dir)
    objects_dir = scene_dir / "objects"
    out: list[dict] = []
    if not objects_dir.is_dir():
        return out
    for obj_dir in sorted(objects_dir.iterdir()):
        glb = obj_dir / "roblox.glb"
        if not glb.is_file():
            continue
        digest = sha1(glb)
        approval_path = obj_dir / "preflight" / "approval.json"
        approval = None
        if approval_path.is_file():
            try:
                approval = json.loads(approval_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                approval = None
        approved = bool(approval and approval.get("approved") is True)
        matches = bool(approval and approval.get("sha1") == digest)
        if not approval:
            reason = "no personal approval"
        elif not approved:
            reason = "denied"
        elif not matches:
            reason = "approval does not match this file"
        else:
            reason = "approved"
        out.append({
            "objectId": obj_dir.name,
            "glb": str(glb),
            "sha1": digest,
            "bytes": glb.stat().st_size,
            "approved": approved and matches,
            "reason": reason,
            "approval": approval,
        })
    return out


def record(scene_dir: str | Path, object_id: str, asset_id: int) -> dict:
    """Set assetId on one object in objects.json and return the document."""
    path = Path(scene_dir) / "objects.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    for obj in doc.get("objects", []):
        if obj.get("id") == object_id:
            obj["assetId"] = int(asset_id)
            break
    else:
        raise KeyError(f"{object_id} is not in {path}")
    path.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--json", action="store_true", help="machine-readable plan")
    args = ap.parse_args(argv)
    items = plan(args.scene)
    if args.json:
        print(json.dumps(items))
        return 0
    for it in items:
        print(f"{it['objectId']:24} {it['bytes'] / 1e6:5.2f} MB  {'READY' if it['approved'] else 'SKIP':4}  {it['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
