import json
from pathlib import Path

from pipeline.objects import assets


def _write(tmp_path: Path, name: str, approved: bool | None, digest: str | None = None) -> Path:
    d = tmp_path / "objects" / name
    (d / "preflight").mkdir(parents=True)
    glb = d / "roblox.glb"
    glb.write_bytes(b"glb-" + name.encode())
    (tmp_path / "objects.json").write_text(json.dumps({
        "sceneId": "kitchen", "units": "studs",
        "objects": [{"id": name, "label": name, "center": [0, 0, 0], "size": [1, 1, 1]}],
    }))
    if approved is not None:
        (d / "preflight" / "approval.json").write_text(json.dumps({
            "approved": approved, "sha1": digest or assets.sha1(glb), "reviewer": "captain",
        }))
    return d


def test_plan_allows_only_matching_approval(tmp_path):
    _write(tmp_path, "fridge", True)
    _write(tmp_path, "stove", False)
    _write(tmp_path, "sink", True, "0" * 40)
    _write(tmp_path, "poster", None)
    got = {it["objectId"]: it for it in assets.plan(tmp_path)}
    assert got["fridge"]["approved"] is True
    assert got["stove"]["reason"] == "denied"
    assert got["sink"]["reason"] == "approval does not match this file"
    assert got["poster"]["reason"] == "no personal approval"


def test_record_writes_asset_id(tmp_path):
    _write(tmp_path, "fridge", True)
    doc = assets.record(tmp_path, "fridge", 1234567890)
    assert doc["objects"][0]["assetId"] == 1234567890
    saved = json.loads((tmp_path / "objects.json").read_text())
    assert saved["objects"][0]["assetId"] == 1234567890
