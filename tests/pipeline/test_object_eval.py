"""The reconstruction-loop evaluator (team/shivin-reconstruction-loop.md, deliverable 1 and 3): surface metrics,
hard gates, held-out evaluation end to end on a synthetic scene, and the advisory judge. No GPU, no scene data."""
from __future__ import annotations

import json

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
from objects.detail.glb import Prim, write_glb
from objects.detail.objects_io import load_objects
from objects.detail.raster import render
from objects.eval import evaluate as E
from objects.eval import gates as G
from objects.eval import judge as J
from objects.eval.geometry import chamfer, depth_normals, normal_consistency, sample_surface
from test_object_detail import cam_at, checker, cube, make_scene

CLEAN = {"status": "ok", "qr": [], "qrCandidates": [], "barcodes": []}


def test_chamfer_and_surface_samples():
    box = cube(half=0.3)
    P, n = sample_surface(box.V, box.F, 4000)
    assert np.allclose(np.abs(P - [0, 0.5, 0]).max(axis=1), 0.3, atol=1e-9)  # every sample is on a face
    assert np.allclose(np.linalg.norm(n, axis=1), 1)
    same = chamfer(P, P)
    assert same["chamfer"] == 0 and same["meshToSplat"] == 0
    moved = chamfer(P + [0.01, 0, 0], P)
    assert 0.002 < moved["meshToSplat"] <= 0.0101
    assert chamfer(P, np.zeros((0, 3)))["chamfer"] is None


def test_depth_normals_of_a_plane_and_consistency():
    ys, xs = np.mgrid[0:20, 0:20].astype(float)
    P = np.stack([xs * 0.01, ys * 0.01, np.full_like(xs, 2.0)], axis=-1)
    n, ok = depth_normals(P, np.ones((20, 20), bool))
    assert ok[5:15, 5:15].all() and np.allclose(np.abs(n[ok][:, 2]), 1)
    good = normal_consistency(n, ok, np.broadcast_to([0, 0, -1.0], n.shape), np.ones((20, 20), bool))
    bad = normal_consistency(n, ok, np.broadcast_to([1.0, 0, 0], n.shape), np.ones((20, 20), bool))
    assert good["normalCos"] == pytest.approx(1) and good["normalWithin30"] == 1
    assert bad["normalCos"] == pytest.approx(0, abs=1e-9)


def test_hard_gates(tmp_path):
    assert G.code_gate(CLEAN)["pass"]
    assert not G.code_gate(None)["pass"]  # no scanner fails closed
    assert not G.code_gate({"status": "unavailable", "reason": "no cv2"})["pass"]
    assert not G.code_gate({**CLEAN, "qr": [{"text": "https://example.com"}]})["pass"]
    assert G.code_gate({**CLEAN, "qrCandidates": [{"text": ""}]})["pass"]  # empty-payload pattern hits are listed
    assert not G.texture_gate([])["pass"] and G.texture_gate([[512, 512]])["pass"]
    assert G.silhouette_gate([0.9, 0.92, 0.95])["pass"]
    assert not G.silhouette_gate([0.9, 0.95, 0.3])["pass"]  # one broken view is enough
    assert not G.silhouette_gate([])["pass"]
    glb = tmp_path / "roblox.glb"
    glb.write_bytes(b"x")
    assert G.approval_gate(glb, "aaa")["approval"] == "none" and G.approval_gate(glb, "aaa")["pass"]
    (tmp_path / "preflight").mkdir()
    (tmp_path / "preflight" / "approval.json").write_text(json.dumps({"sha1": "aaa", "approved": True}))
    assert G.approval_gate(glb, "aaa")["approval"] == "match"
    stale = G.approval_gate(glb, "bbb")
    assert stale["approval"] == "stale" and not stale["pass"]
    (tmp_path / "preflight" / "approval.json").write_text(json.dumps({"sha1": "aaa", "approved": False}))
    assert not G.approval_gate(glb, "aaa")["pass"]
    both = G.combine({"a": {"pass": True}, "b": {"pass": False}})
    assert not both["pass"] and both["failed"] == ["b"]


def scene_with_masks(tmp_path, truth, cams, decoy=True):
    """make_scene plus masks-all/: the true object's mask per view and, optionally, a same-label decoy elsewhere."""
    from PIL import Image

    scene = make_scene(tmp_path, truth, cams)
    md = scene / "masks-all"
    md.mkdir()
    dets = []
    for i, cam in enumerate(cams):
        m = render([truth], cam).mask
        Image.fromarray(m.astype(np.uint8) * 255).save(md / f"mask_{i}_stove_0.png")
        dets.append({"view": f"view_{i:02d}.png", "label": "stove", "mask": f"mask_{i}_stove_0.png", "score": 0.9})
        if decoy:
            d = np.zeros_like(m)
            d[:10, :10] = True
            Image.fromarray(d.astype(np.uint8) * 255).save(md / f"mask_{i}_stove_1.png")
            dets.append({"view": f"view_{i:02d}.png", "label": "stove", "mask": f"mask_{i}_stove_1.png", "score": 0.95})
    (md / "detections.json").write_text(json.dumps({"detections": dets}))
    return scene


def test_evaluator_end_to_end(tmp_path):
    tex = checker(256, 16, seed=11)
    truth = cube(half=0.3, image=tex)
    cams = [cam_at((2.0 * np.sin(a), 0.9, 2.0 * np.cos(a)), size=128) for a in np.linspace(0, 2 * np.pi, 5,
                                                                                            endpoint=False)]
    scene = scene_with_masks(tmp_path, truth, cams)
    box = load_objects(scene / "objects-all.json")[0]
    good = scene / "objects" / "stove" / "roblox.glb"
    good.parent.mkdir(parents=True)
    good.write_bytes(write_glb([truth], {}))
    bad = scene / "trial" / "roblox.glb"
    bad.parent.mkdir(parents=True)
    bad.write_bytes(write_glb([cube(centre=(0.18, 0.5, 0.0), half=0.3, image=tex, faces=5)], {}))
    refs = E.held_out_refs(scene / "views", box, scene / "masks-all")
    assert len(refs) == 5 and {s for _, s in refs} == {"mask"}  # the real mask wins over the decoy
    g = E.evaluate_glb(good, refs, CLEAN, tmp_path / "g.jpg")
    b = E.evaluate_glb(bad, refs, CLEAN)
    floor = g["surface"]["samplingFloor"]
    assert g["iou"]["worst"] > 0.97 and g["surface"]["chamfer"] < 1.3 * floor + 0.0005 and g["normalCos"]["mean"] > 0.95
    assert g["mesh"]["watertight"] and g["mesh"]["holesPer1000"] == 0 and g["gates"]["pass"]
    assert b["iou"]["worst"] < g["iou"]["worst"] and b["surface"]["chamfer"] > g["surface"]["chamfer"] + 0.02
    assert b["mesh"]["holesPer1000"] > 0 and b["score"] < g["score"] - 10
    for key in ("iou", "depthMAE", "psnr", "ssim", "normalCos"):
        assert set(g[key]) == {"mean", "median", "worst"}
    assert g["atlas"] == [[256, 256]] and g["bytes"] > 0 and len(g["sha1"]) == 40
    assert (tmp_path / "g.jpg").exists() and len(g["perView"]) == 5
    # the object entry point writes eval.json beside the GLB; without a scan the codes gate fails closed
    res = E.evaluate_object(scene, box, good, scan=False, log=lambda *_: None)
    doc = json.loads((good.parent / "eval.json").read_text())
    assert doc["score"] == res["score"] and not doc["gates"]["pass"] and doc["gates"]["failed"] == ["codes"]
    assert doc["card"]["advisory"] and any("approval: none" in line for line in doc["card"]["lines"])
    assert not (good.parent / "preflight" / "approval.json").exists()  # the evaluator never writes approvals


def test_evaluator_flags_a_changed_approved_file(tmp_path):
    truth = cube(half=0.3)
    cams = [cam_at((0.0, 0.9, 2.0), size=96), cam_at((2.0, 0.9, 0.0), size=96)]
    scene = scene_with_masks(tmp_path, truth, cams, decoy=False)
    glb = scene / "objects" / "stove" / "roblox.glb"
    glb.parent.mkdir(parents=True)
    glb.write_bytes(write_glb([truth], {}))
    (glb.parent / "preflight").mkdir()
    (glb.parent / "preflight" / "approval.json").write_text(json.dumps({"sha1": "0" * 40, "approved": True}))
    res = E.evaluate_glb(glb, E.held_out_refs(scene / "views", load_objects(scene / "objects-all.json")[0],
                                              scene / "masks-all"), CLEAN)
    assert res["gates"]["failed"] == ["approval"] and res["gates"]["approval"]["approval"] == "stale"


def test_judge_parses_caches_and_never_approves(tmp_path):
    sheet = tmp_path / "s.jpg"
    from PIL import Image

    Image.fromarray(checker(32, 4)).save(sheet)
    calls = []

    def fake(prompt, jpeg):
        calls.append(prompt)
        return '```json\n{"shape": 4, "texture": 7, "scale": 5, "artifacts": 2, "verdict": "usable", ' \
               '"problems": ["floating fragment by the handle"], "summary": "close"}\n```'

    j = J.Judge(tmp_path / "cache", transport=fake, model="test")
    a = j(sheet, "stove")
    assert a["ok"] and a["scores"] == {"shape": 4, "texture": 5, "scale": 5, "artifacts": 2}  # clamped to 1-5
    assert a["advisory"] and a["approves"] is False and not a["cached"]
    assert "stove" in calls[0] and "never approve" in calls[0]
    b = j(sheet, "stove")
    assert b["cached"] and len(calls) == 1  # same image, same rubric: free
    j(sheet, "fridge")
    assert len(calls) == 2  # a different prompt is a different key
    broken = J.Judge(tmp_path / "c2", transport=lambda p, i: "no idea", model="test")(sheet, "stove")
    assert broken["ok"] is False and broken["advisory"]
    with pytest.raises(ValueError):
        J.parse('{"shape": 3}')
    assert J.parse('{"shape": 1, "texture": 2, "scale": 3, "artifacts": 3}')["verdict"] == "redo"


def test_card_shows_judge_and_gate_state(tmp_path):
    res = {"score": 71.2, "gates": {"pass": False, "failed": ["codes"], "approval": {"approval": "none"}},
           "iou": {"mean": 0.9, "worst": 0.8}, "ssim": {"mean": 0.7}, "psnr": {"mean": 24.0},
           "surface": {"chamfer": 0.004}, "normalCos": {"mean": 0.9}, "sharpness": 0.8,
           "mesh": {"triangles": 18000, "holesPer1000": 1.2, "watertight": False}, "bytes": 2_000_000,
           "sha1": "ab" * 20, "judge": {"ok": True, "scores": {"shape": 4, "texture": 3, "scale": 5, "artifacts": 4}}}
    c = E.card(res)
    assert c["advisory"] and "BLOCKED: codes" in c["lines"][0] and "judge (advisory)" in c["lines"][-1]
