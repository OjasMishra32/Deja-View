"""people.py pack: every file the place's world names comes with the memory (splats, collider, top-down map, and
the backdrop's room mesh and sky, from world.backdrop or backdrop.json), checked before anything is copied."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline" / "recon"))
import people  # noqa: E402


def place(tmp, backdrop="block"):
    d = tmp / "the-courts"
    d.mkdir()
    for f in ("world.spz", "collider.glb", "topdown.jpg", "backdrop.glb", "backdrop-sky.jpg"):
        (d / f).write_bytes(f.encode())
    world = {"file": "world.spz", "collider": "collider.glb",
             "topdown": {"file": "topdown.jpg", "min": [0, 0], "max": [1, 1]}}
    if backdrop == "block":
        world["backdrop"] = {"file": "backdrop.glb", "sky": "backdrop-sky.jpg", "floorY": 0.1}
    elif backdrop == "manifest":
        (d / "backdrop.json").write_text(json.dumps({"file": "backdrop.glb", "sky": "backdrop-sky.jpg", "floorY": 0}))
    return d, world


def test_world_files_lists_everything_the_world_names(tmp_path):
    d, world = place(tmp_path)
    assert people.world_files(world, d) == ["world.spz", "collider.glb", "topdown.jpg", "backdrop.glb", "backdrop-sky.jpg"]


def test_backdrop_json_counts_when_the_block_has_no_backdrop(tmp_path):
    d, world = place(tmp_path, backdrop="manifest")
    assert people.world_files(world, d)[-3:] == ["backdrop.json", "backdrop.glb", "backdrop-sky.jpg"]


def test_a_place_without_a_backdrop_is_unchanged(tmp_path):
    d, world = place(tmp_path, backdrop=None)
    assert people.world_files(world, d) == ["world.spz", "collider.glb", "topdown.jpg"]


def test_copy_checks_every_file_before_copying_any(tmp_path):
    d, world = place(tmp_path)
    (d / "backdrop-sky.jpg").unlink()
    out = tmp_path / "memory"
    with pytest.raises(SystemExit) as e:
        people.copy_world_files(world, d, out)
    assert "backdrop-sky.jpg is missing" in str(e.value)
    assert not out.exists() or not any(out.iterdir())  # nothing half-copied


def test_copy_refuses_a_path_outside_the_place(tmp_path):
    d, world = place(tmp_path)
    (tmp_path / "secret.txt").write_text("x")
    world["backdrop"]["sky"] = "../secret.txt"
    with pytest.raises(SystemExit) as e:
        people.copy_world_files(world, d, tmp_path / "memory")
    assert "outside" in str(e.value)


@pytest.mark.parametrize("backdrop", ["block", "manifest"])
def test_pack_writes_a_memory_that_has_every_file_its_scene_names(tmp_path, backdrop):
    """write_scene, the end of `people.py pack`, on a place with a backdrop: every file the memory's scene.json names
    is in the memory's folder."""
    from fractions import Fraction
    from types import SimpleNamespace

    import numpy as np

    d, world = place(tmp_path, backdrop)
    (d / "scene.json").write_text(json.dumps({"id": "the-courts", "world": world}))
    out = tmp_path / "courts-foosball"
    out.mkdir()
    a = SimpleNamespace(world_scene=d, id="courts-foosball", name="Foosball", caption="")
    people.write_scene(a, out, {}, np.eye(4), Fraction(30), 300, {"fx": 1000.0, "fy": 1000.0, "cx": 960.5, "cy": 540.5},
                       1920, 1080, 0.5, 12.0, None, [], {"hasAudio": True})
    scene = json.loads((out / "scene.json").read_text())
    w = scene["world"]
    named = [w["file"], w["collider"], w["topdown"]["file"]]
    bd = w.get("backdrop") or json.loads((out / "backdrop.json").read_text())
    named += [bd["file"], bd["sky"]]
    for rel in named:
        assert (out / rel).read_bytes() == (d / rel).read_bytes(), rel
