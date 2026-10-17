"""The reconstruction loop (team/shivin-reconstruction-loop.md, deliverable 2 and 4): configuration space, the
bandit prior, successive halving, patience, the Pareto front, the post-bake steps, the ceiling-free room shell, and
one synthetic stove episode end to end with a fake bake. No GPU, no scene data."""
from __future__ import annotations

import json
import random

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
from objects.detail.glb import Prim, glb_extras, read_glb, write_glb
from objects.loop import bake as B
from objects.loop import room as R
from objects.loop import search as S
from objects.loop.space import SPACE, Config, legal, stage_sizes
from test_object_detail import cam_at, checker, cube
from test_object_eval import scene_with_masks


def test_space_and_stages():
    c = legal(Config(), "flat")
    assert c.ink is True and legal(c, "regular").ink is False  # ink only for signs, always on for them
    with pytest.raises(ValueError):
        legal(Config(voxel=0.02), "regular")
    assert stage_sizes(14) == (8, 4, 2) and stage_sizes(40) == (9, 4, 2) and stage_sizes(3) == (4, 4, 2)
    assert Config().key() != Config(views=48).key()


def test_propose_is_distinct_legal_seeded_and_steered_by_the_prior():
    prior = S.Prior()
    seed = legal(Config(voxel=0.01, views=24, atlas=1024, simplify="none", chunks="floor", maps="off"), "regular")
    a = S.propose(prior, "regular", 8, random.Random(1), seed_configs=[seed])
    b = S.propose(prior, "regular", 8, random.Random(1), seed_configs=[seed])
    assert a == b and a[0] == seed and len({c.key() for c in a}) == 8
    assert all(getattr(c, k) in v for c in a for k, v in SPACE.items())
    for v in SPACE["voxel"]:  # the 5 mm arm keeps winning
        for _ in range(5):
            prior.update("regular", Config(voxel=v), 1.0 if v == 0.005 else 0.2)
    assert S.propose(prior, "regular", 1, random.Random(0))[0].voxel == 0.005
    assert S.propose(prior, "small", 1, random.Random(0))[0].voxel == SPACE["voxel"][0]  # other contexts unaffected
    m = S.mutate(seed, "regular", random.Random(3))
    assert sum(getattr(m, k) != getattr(seed, k) for k in SPACE) == 1


def objective(c: Config, rung: int) -> dict:
    """A synthetic bake: best at 7.5 mm, 48 views, light maps; higher rungs add detail."""
    s = 60 - 400 * abs(c.voxel - 0.0075) * 10 + {12: 0, 24: 4, 48: 8}[c.views] + {"off": 0, "light": 3, "strong": 1}[
        c.maps] + 5 * rung
    return {"score": round(s, 3), "triangles": {"none": 20000, "light": 14000, "strong": 8000}[c.simplify],
            "bytes": c.atlas * 1000, "seconds": 10 + rung * 20, "gates": {"silhouette": {"pass": True}}}


def test_episode_successive_halving_and_pareto():
    prior = S.Prior()
    ep = S.run_episode(objective, "regular", prior, budget=14, seed=4, log=lambda *_: None)
    rungs = [t["rung"] for t in ep["trials"]]
    assert len(ep["trials"]) <= 14 and rungs[0] == 0 and rungs == sorted(rungs)
    assert rungs.count(1) <= 4 and rungs.count(2) <= 2
    best = ep["best"]
    assert best["score"] == max(t["score"] for t in ep["trials"])
    assert best["n"] in ep["pareto"]
    for n in ep["pareto"]:  # nothing on the front is dominated
        t = ep["trials"][n - 1]
        assert not any(o["score"] >= t["score"] and o["triangles"] <= t["triangles"] and o["bytes"] <= t["bytes"]
                       and o["seconds"] <= t["seconds"] and o is not t and (o["score"], -o["triangles"], -o["bytes"],
                       -o["seconds"]) != (t["score"], -t["triangles"], -t["bytes"], -t["seconds"])
                       for o in ep["trials"])
    assert prior.stats["regular"]["voxel"]  # the episode taught the prior
    # a second object starts from what the first learned
    ep2 = S.run_episode(objective, "regular", prior, budget=12, seed=5, log=lambda *_: None)
    assert ep2["trials"][0]["config"]["voxel"] in (0.0075, 0.005, 0.01)


def test_patience_stops_a_flat_search_early():
    ep = S.run_episode(lambda c, r: {"score": 50.0}, "regular", S.Prior(), budget=14, log=lambda *_: None)
    assert ep["stopped"].startswith("patience") and len(ep["trials"]) < 14


def test_broken_silhouette_ranks_below_a_working_mesh():
    good = {"score": 60, "gates": {"silhouette": {"pass": True}}}
    broken = {"score": 90, "gates": {"silhouette": {"pass": False}}}
    assert max([broken, good], key=S.rank_key) is good


def test_taubin_smooths_noise_and_keeps_seams_and_rims():
    rng = np.random.default_rng(0)
    th, ph = np.meshgrid(np.linspace(0.3, np.pi - 0.3, 20), np.linspace(0, 2 * np.pi, 40, endpoint=False),
                         indexing="ij")
    V = np.stack([np.sin(th) * np.cos(ph), np.cos(th), np.sin(th) * np.sin(ph)], -1).reshape(-1, 3)
    F = [[i * 40 + j, (i + 1) * 40 + j, (i + 1) * 40 + (j + 1) % 40] for i in range(19) for j in range(40)] + \
        [[i * 40 + j, (i + 1) * 40 + (j + 1) % 40, i * 40 + (j + 1) % 40] for i in range(19) for j in range(40)]
    F = np.array(F)
    noisy = V * (1 + rng.normal(0, 0.03, (len(V), 1)))
    noisy = np.concatenate([noisy, noisy[:5]])  # five split copies, as at a UV seam
    F2 = np.concatenate([F, [[len(V) + 0, 1, 41]]])
    sm = B.taubin(noisy, F2, 6)
    r0, r1 = np.linalg.norm(noisy[:len(V)], axis=1), np.linalg.norm(sm[:len(V)], axis=1)
    rim = np.r_[0:40, 760:800]
    inner = np.setdiff1d(np.arange(len(V)), rim)
    assert r1[inner].std() < 0.5 * r0[inner].std() and abs(r1[inner].mean() - 1) < 0.03  # no shrinking
    np.testing.assert_allclose(sm[len(V):], sm[:5])  # the seam copies moved together
    np.testing.assert_allclose(sm[rim], noisy[rim])  # rims are held
    assert np.array_equal(B.taubin(noisy, F2, 0), noisy)


def test_finish_applies_chunk_policy_smoothing_and_maps(tmp_path):
    floor = Prim("floor_00", np.array([[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], float),
                 np.array([[0, 2, 1], [0, 3, 2]]), None, np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float),
                 np.full((16, 16, 3), 90, np.uint8))
    room = cube(half=0.3)
    room.name = "room_00"
    glb = tmp_path / "roblox.glb"
    glb.write_bytes(write_glb([room, floor], {"name": "stove", "sceneId": "kitchen"}))
    B.finish(glb, Config(atlas=1024, chunks="one", simplify="light", maps="light"), tmp_path, "regular")
    prims = read_glb(glb)
    assert [p.name for p in prims] == ["room_00"]
    ex = glb_extras(glb)
    assert ex["sceneId"] == "kitchen" and ex["loopConfig"]["chunks"] == "one"
    side = json.loads((tmp_path / "detail-maps.json").read_text())
    assert side["normalStrength"] == 1.0 and side["aoIntoColour"] == 0.3
    glb.write_bytes(write_glb([room, floor], {}))
    B.finish(glb, Config(chunks="floor", simplify="none", maps="off"), tmp_path, "regular")
    assert len(read_glb(glb)) == 2


def room_prims():
    """A 4 x 2.5 x 4 m room: floor, four walls, a ceiling in the room chunk, a separate ceiling chunk and a wall
    cabinet whose underside faces down at 1.5 m."""
    def quad(a, b, c, d):
        return [a, b, c, d], [[0, 1, 2], [0, 2, 3]]

    parts = [quad([-2, 0, -2], [-2, 0, 2], [2, 0, 2], [2, 0, -2]),  # floor, up
             quad([-2, 2.5, -2], [2, 2.5, -2], [2, 2.5, 2], [-2, 2.5, 2]),  # ceiling, down
             quad([-2, 0, -2], [2, 0, -2], [2, 2.5, -2], [-2, 2.5, -2]),  # wall
             quad([-1, 1.5, -2], [1, 1.5, -2], [1, 1.5, -1.6], [-1, 1.5, -1.6])]  # cabinet underside, down
    V, F = [], []
    for v, f in parts:
        F += [[i + len(V) for i in t] for t in f]
        V += v
    V, F = np.array(V, float), np.array(F)
    from objects.loop.room import face_normals

    n = face_normals(V, F)
    assert n[2, 1] < -0.9 and n[0, 1] > 0.9 and n[6, 1] < -0.9  # the fixture really faces as described
    uv = np.zeros((len(V), 2))
    img = np.full((8, 8, 3), 128, np.uint8)
    lid = Prim("ceiling_00", np.array([[-2, 2.6, -2], [2, 2.6, -2], [2, 2.6, 2]], float), np.array([[0, 1, 2]]),
               None, np.zeros((3, 2)), img)
    return [Prim("room_00", V, F, None, uv, img), lid]


def test_room_shell_has_no_ceiling_and_reports_budgets():
    prims = room_prims()
    assert R.ceiling_triangles(prims, 2.5) == 3  # the lid chunk and the room's own ceiling quad
    out, removed = R.strip_ceiling(prims, 2.5)
    assert removed == 3 and R.ceiling_triangles(out, 2.5) == 0
    assert [p.name for p in out] == ["room_00"] and len(out[0].F) == 6  # floor, wall and cabinet underside stay
    assert R.strip_ceiling(prims, None)[1] == 1  # outdoors only the named lid chunk goes
    b = R.budgets(out)
    assert b["triangles"] == 6 and b["drawCalls"] == 1 and b["quest"]["fits"] and b["mobile"]["fits"]
    big = [Prim(f"room_{i:02d}", out[0].V, out[0].F, None, out[0].UV, np.zeros((2048, 2048, 3), np.uint8))
           for i in range(45)]
    assert not R.budgets(big)["quest"]["fits"]


def test_loop_end_to_end_on_a_synthetic_stove(tmp_path, monkeypatch):
    """The acceptance shape: the loop runs on the stove, writes loop.json and the best mesh, and never touches the
    current set or its approval."""
    from objects import scene as obj_scene
    from objects.loop import run as L

    tex = checker(128, 8, seed=2)
    truth = cube(half=0.3, image=tex)
    cams = [cam_at((2.0 * np.sin(a), 0.9, 2.0 * np.cos(a)), size=96) for a in (0.3, 1.9, 3.5, 5.1)]
    scene = scene_with_masks(tmp_path, truth, cams, decoy=False)
    cur = scene / "objects" / "stove"
    cur.mkdir(parents=True)
    (cur / "roblox.glb").write_bytes(write_glb([cube(half=0.36, image=tex, faces=5)], {}))
    (cur / "preflight").mkdir()
    approval = json.dumps({"sha1": "f" * 40, "approved": True})
    (cur / "preflight" / "approval.json").write_text(approval)
    before = (cur / "roblox.glb").read_bytes()

    class Splats:
        means = np.random.default_rng(0).uniform(-0.3, 0.3, (500, 3)) + [0, 0.5, 0]

    monkeypatch.setattr(obj_scene, "load_scene", lambda d: (Splats(), {"id": "kitchen"}))

    def fake_bake(scene_dir, box, c, size, atlas, out, kind, device, splats, sc, log):
        out.mkdir(parents=True, exist_ok=True)
        err = abs(c.voxel - 0.0075) * 6 + {12: 0.03, 24: 0.015, 48: 0.0}[c.views]  # metres of misfit
        (out / "roblox.glb").write_bytes(write_glb([cube(half=0.3 + err, image=tex)], {"loopConfig": c.to_json()}))
        return {"glb": str(out / "roblox.glb"), "bakeSeconds": 0.1}

    monkeypatch.setattr(B, "bake_object", fake_bake)
    box = L.load_objects(scene / "objects-all.json")[0]
    res = L.run_object(str(scene), box, str(scene / "objects-loop"), {}, 12, 0, None, False)
    rec = json.loads((scene / "objects-loop" / "stove" / "loop.json").read_text())
    assert rec == json.loads(json.dumps(res["record"]))
    assert 4 <= len(rec["trials"]) <= 12 and rec["current"]["score"] is not None
    best = rec["best"]
    assert best["score"] >= max(t["score"] for t in rec["trials"] if t["score"] is not None) - 1e-9
    assert best["score"] > rec["current"]["score"]
    assert (scene / "objects-loop" / "stove" / "best" / "roblox.glb").exists()
    assert best["sha1"] in rec["recommendation"] and "approval" in rec["recommendation"]
    assert all({"config", "score", "seconds", "sha1"} <= set(t) for t in rec["trials"])
    assert (cur / "roblox.glb").read_bytes() == before  # the current set is untouched
    assert (cur / "preflight" / "approval.json").read_text() == approval
    assert res["prior"]["regular"]["voxel"]


def test_report_tables_from_a_loop_run(tmp_path, monkeypatch):
    from objects.loop import report

    test_loop_end_to_end_on_a_synthetic_stove(tmp_path, monkeypatch)
    scene = tmp_path / "kitchen"
    body = report.tables(scene)
    assert "| stove | regular |" in body and "★" in body and "Recommendation:" in body
    assert "no eval.json yet" in body  # the evaluator CLI was not run in this test
    doc = tmp_path / "d.md"
    doc.write_text(f"a\n{report.BEGIN}\nx\n{report.END}\nb\n")
    report.write_between(doc, body)
    assert "| stove |" in doc.read_text() and doc.read_text().endswith("b\n")
