"""genfill without a GPU: the model-worker queue (fake models), caption parsing, anchor planning, depth alignment,
and the scene loader."""
import json
import threading
import time

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
from genfill import geom as G
from genfill.fill import FillConfig, align_fill_depth, choose_sequences, parse_caption, sequence_views
from genfill.gaps import GapConfig, Gaps, worst_views
from genfill.models import Client, WorkerError, serve


@pytest.fixture()
def worker(tmp_path):
    q = tmp_path / "queue"
    th = threading.Thread(target=serve, args=(q, [], None, True, 0.0), daemon=True)
    th.start()
    client = Client(q, timeout=20)
    t0 = time.time()
    while not client.alive() and time.time() - t0 < 10:
        time.sleep(0.05)
    yield client
    client.stop()
    th.join(5)


def test_queue_round_trip_with_fake_models(worker, tmp_path):
    from PIL import Image

    assert worker.wait_ready(["caption", "edit", "depth", "lama"], timeout=5)
    img = np.full((48, 64, 3), 90, np.uint8)
    img[10:30, 20:40] = (255, 0, 255)
    Image.fromarray(img).save(tmp_path / "in.png")
    cap = worker.call("caption", images=[str(tmp_path / "in.png")], prompt="what?")
    assert parse_caption(cap["text"]) == ("a plain grey surface", False)
    worker.call("edit", image=str(tmp_path / "in.png"), prompt="fill", out=str(tmp_path / "out.png"))
    out = np.asarray(Image.open(tmp_path / "out.png"))
    m = np.zeros((48, 64), bool)
    m[10:30, 20:40] = True
    assert G.magenta_fraction(out, m) == 0.0
    worker.call("depth", image=str(tmp_path / "in.png"), out=str(tmp_path / "d.npy"))
    assert np.load(tmp_path / "d.npy").shape == (48, 64)
    assert worker.call("ping")["loaded"]
    with pytest.raises(WorkerError):
        worker.call("nonsense")


def test_parse_caption_variants():
    assert parse_caption('{"fill": "palm fronds against the night sky", "sky_only": false}') == ("palm fronds against the night sky", False)
    assert parse_caption('```json\n{"fill": "dark night sky", "sky_only": true}\n```') == ("dark night sky", True)
    assert parse_caption('{"fill": "a white ceiling", "sky_only": "false"}') == ("a white ceiling", False)
    assert parse_caption('{"fill": "a white ceiling with tube lights", "sky_only": false')[0] == "a white ceiling with tube lights"
    fill, sky = parse_caption("A white ceiling with fluorescent lights.")
    assert fill.startswith("A white ceiling") and sky is False


def _synthetic_gaps():
    cfg = GapConfig()
    views = []
    for s, x in enumerate([0.0, 3.0]):
        for p in (0.0, 40.0, 75.0):
            for yaw in range(0, 360, 45):
                views.append({"spot": s, "position": [x, 1.6, 0.0], "yaw": float(yaw), "pitch": p, "hole": 0.0, "low": 0.0, "bad": 0.0})
    rng = np.random.default_rng(0)
    pts = rng.normal([1.5, 4.0, -1.0], [0.6, 0.1, 0.6], (400, 3))  # a ceiling patch
    pv = np.array([i for i, v in enumerate(views) if v["pitch"] == 75.0 and v["yaw"] in (0.0, 45.0)] * 100)[:400]
    for i in set(pv.tolist()):
        views[i]["bad"] = 0.3
    labels, regions = G.voxel_regions(pts, np.full(len(pts), 16.0), 0.6, 10)
    for r in regions:
        m = labels == r["id"]
        vids, cnt = np.unique(pv[m], return_counts=True)
        r["views"] = [{"view": int(v), "px": int(c) * 16} for v, c in sorted(zip(vids, cnt), key=lambda t: -t[1])]
        r["kind"] = "overhead"
    return Gaps(cfg, views, regions, pts, pv, np.zeros(len(pts), np.int8), labels, np.array([[0.0, 0.0], [3.0, 0.0]]))


def test_anchor_sequences_spread_and_tilt_up():
    cands = [{"spot": sp, "position": [x, 1.6, 0.0], "yaw": float(yaw), "bad": 0.6 - 0.1 * sp - 0.001 * yaw}
             for sp, x in enumerate([0.0, 1.0, 5.0]) for yaw in range(0, 360, 45)]
    cfg = FillConfig(sequences=4, spot_gap=2.0, tilts=(30.0, 55.0, 80.0))
    chosen = choose_sequences(cands, cfg)
    assert len(chosen) == 4 and chosen[0]["spot"] == 0 and chosen[0]["yaw"] == 0.0
    for a in range(4):  # spread out: far apart, or yaws at least 90 degrees apart
        for b in range(a):
            near = np.linalg.norm(np.subtract(chosen[a]["position"], chosen[b]["position"])) < 2.0
            dy = abs(((chosen[a]["yaw"] - chosen[b]["yaw"] + 180) % 360) - 180)
            assert not near or dy >= 90
    seq = sequence_views(chosen, cfg)
    assert [v["pitch"] for v in seq] == [30.0] * 4 + [55.0] * 4 + [80.0] * 4
    assert seq[4]["position"] == seq[0]["position"] and seq[4]["yaw"] == seq[0]["yaw"]


def test_worst_views_skip_blocked():
    gaps = _synthetic_gaps()
    for i, v in enumerate(gaps.views):
        v["bad"], v["near"] = (0.9, 0.8) if i == 0 else (0.5 if v["pitch"] > 30 else 0.0, 0.0)
    ids = worst_views(gaps, 3, pitch_min=30)
    assert 0 not in ids and len(ids) >= 1


def test_align_fill_depth_meets_the_rim():
    k = G.intrinsics(160, 120, 90)
    depth = np.full((120, 160), 4.0)
    depth[:, 80:] = 6.0
    alpha = np.ones((120, 160))
    mask = np.zeros((120, 160), bool)
    mask[40:80, 60:100] = True
    hole = mask.copy()
    alpha[hole] = 0
    depth_r = np.where(hole, 0.0, depth)
    pred = (depth - 1.0) / 2.0  # monocular depth with another scale and shift
    aligned, fit = align_fill_depth(pred, depth_r, alpha, hole, np.zeros_like(hole), mask)
    assert fit["ok"]
    np.testing.assert_allclose(aligned[mask], depth[mask], rtol=0.02)


def test_world_loader(tmp_path):
    import splat_io as sio
    from genfill.world import load

    rng = np.random.default_rng(4)
    s = sio.Splats.from_rgb(rng.uniform(-2, 2, (300, 3)), rng.uniform(0, 1, (300, 3)), 0.02, 0.8)
    sio.write_spz(tmp_path / "world.spz", s)
    (tmp_path / "scene.json").write_text(json.dumps({"id": "t", "world": {"file": "world.spz", "bounds": {"min": [-2, 0, -2], "max": [2, 3, 2]}}}))
    c2w = G.yaw_pitch_c2w([0, 1.5, 0], 30, 0)
    (tmp_path / "cameras.json").write_text(json.dumps({"cameras": [{"name": "photo/a.jpg", "group": "photo", "c2w": c2w.tolist(),
                                                                       "intrinsics": {"fx": 100, "fy": 100, "cx": 64, "cy": 48, "width": 128, "height": 96},
                                                                       "distortion": {}}]}))
    w = load(tmp_path)
    assert len(w.splats) == 300 and len(w.cams) == 1 and w.cams[0].intr.width == 128
    np.testing.assert_allclose(w.cams[0].position, [0, 1.5, 0])
    assert w.bounds[1][1] == 3 and len(w.digest) == 16


def test_footage_elevation_limit():
    from genfill.gaps import max_camera_elevation, pixel_elevation
    from genfill.world import TrainCam

    k = G.intrinsics(400, 300, 90)  # vertical half-angle atan(150/200) = 36.87 deg
    cams = [TrainCam("a", "photo", G.yaw_pitch_c2w([0, 1.4, 0], 30, 10), k), TrainCam("b", "photo", G.yaw_pitch_c2w([1, 1.4, 0], 0, -5), k)]
    assert abs(max_camera_elevation(cams) - (10 + 36.87)) < 0.3
    e = pixel_elevation(G.yaw_pitch_c2w([0, 1.6, 0], 0, 75), k)
    assert e.shape == (300, 400) and e.max() > 85 and abs(e[150, 200] - 75) < 0.5


def test_night_sky_keeps_fronds_and_lit_surfaces():
    from genfill.fill import night_sky

    k = G.intrinsics(160, 120, 90)
    c2w = G.yaw_pitch_c2w([0, 1.6, 0], 0, 45)  # looking up: most of the frame is above the horizon
    rgb = np.full((120, 160, 3), 12, np.uint8)  # black night sky
    rng = np.random.default_rng(5)
    rgb[20:60, 20:70] = rng.integers(20, 160, (40, 50, 3))  # textured fronds
    rgb[70:120, 90:160] = 225  # a lit white roof
    rgb[0:15, 100:160] = (40, 70, 140)  # a strip of twilight blue the editor slipped in
    sky = night_sky(rgb, c2w, k, 0.13)
    assert sky[5:15, 0:15].all() and sky[2:12, 110:150].all()
    assert sky[25:55, 25:65].mean() < 0.05
    assert not sky[80:115, 100:155].any()
