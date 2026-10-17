"""Your old home from listing photos (team/shivin.md Update 19, job 2): watermark and logo detection, crop or inpaint,
and the listing reconstruct job end to end with the rebuild stubbed (a synthetic room stands in for its world)."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
import listing as L

pytest.importorskip("cv2")


def room_photo(seed: int, w: int = 960, h: int = 640) -> np.ndarray:
    """A photo-like scene that differs per seed: soft light, walls and cabinets as shaded boxes, a little noise."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w] / max(w, h)
    base = np.stack([0.55 + 0.25 * np.sin(3 * x + seed) * y, 0.5 + 0.2 * y, 0.45 + 0.2 * x], -1)
    img = base.copy()
    for _ in range(9):
        x0, y0 = rng.integers(0, w - 80), rng.integers(0, h - 120)
        bw, bh = rng.integers(60, 300), rng.integers(60, 260)
        img[y0:y0 + bh, x0:x0 + bw] = rng.uniform(0.2, 0.85, 3) * (0.85 + 0.15 * y[y0:y0 + bh, x0:x0 + bw, None])
    img += rng.normal(0, 0.012, img.shape)
    return np.clip(img * 255, 0, 255).astype(np.uint8)


def stamp(img: np.ndarray, text: str, where: str = "bottom-right", alpha: float = 1.0, scale: int = 2) -> tuple:
    """Draws listing-style text (white with a dark outline) and returns its box."""
    from PIL import Image, ImageDraw, ImageFont

    im = Image.fromarray(img)
    over = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    font = ImageFont.load_default(size=18 * scale) if hasattr(ImageFont, "load_default") else None
    tw, th = d.textbbox((0, 0), text, font=font)[2:]
    W, H = im.size
    pos = {"bottom-right": (W - tw - 20, H - th - 18), "bottom-left": (20, H - th - 18),
           "center": ((W - tw) // 2, (H - th) // 2), "top-left": (20, 16)}[where]
    a = int(255 * alpha)
    d.text(pos, text, font=font, fill=(255, 255, 255, a), stroke_width=2, stroke_fill=(20, 20, 20, a))
    out = Image.alpha_composite(im.convert("RGBA"), over).convert("RGB")
    return np.asarray(out), (pos[0] - 3, pos[1] - 3, pos[0] + tw + 3, pos[1] + th + 6)


def box_recall(mask: np.ndarray, box) -> float:
    x0, y0, x1, y1 = box
    return float(mask[y0:y1, x0:x1].mean())


def outside(mask: np.ndarray, box, pad: int = 30) -> float:
    m = mask.copy()
    x0, y0, x1, y1 = box
    m[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = False
    return float(m.mean())


def test_shared_corner_watermark_is_found_on_every_photo_and_cropped():
    photos, boxes = zip(*[stamp(room_photo(s), "ACME REALTY  MLS# 4421907") for s in range(4)])
    ovs = L.detect(list(photos))
    for ov, box in zip(ovs, boxes):
        assert "shared" in ov.source
        assert box_recall(ov.mask, box) > 0.5 and outside(ov.mask, box) < 0.01
    clean, act = L.remove(photos[0], ovs[0])
    assert act["action"] == "crop" and act["side"] == "bottom"
    assert clean.shape[0] < photos[0].shape[0] and clean.shape[0] <= boxes[0][1]  # the stamp is gone with its band
    assert clean.shape[1] == photos[0].shape[1]
    np.testing.assert_array_equal(clean, photos[0][:clean.shape[0]])  # real pixels untouched


def test_translucent_mark_across_the_middle_is_inpainted():
    pairs = [stamp(room_photo(s), "Zillowish", "center", alpha=0.55, scale=4) for s in range(10, 14)]
    photos, boxes = zip(*pairs)
    ovs = L.detect(list(photos))
    assert box_recall(ovs[1].mask, boxes[1]) > 0.3
    clean, act = L.remove(photos[1], ovs[1])
    assert act["action"] == "inpaint" and clean.shape == photos[1].shape
    plain = room_photo(11)
    x0, y0, x1, y1 = boxes[1]
    before = np.abs(photos[1][y0:y1, x0:x1].astype(int) - plain[y0:y1, x0:x1]).mean()
    after = np.abs(clean[y0:y1, x0:x1].astype(int) - plain[y0:y1, x0:x1]).mean()
    assert after < 0.6 * before  # most of the mark is gone


def test_a_lone_photo_with_a_corner_logo_is_caught_by_the_corner_check():
    photo, box = stamp(room_photo(21), "Keller & Co. Realty", "bottom-left")
    ov = L.detect([photo])[0]
    assert ov.source == ["corner"] and box_recall(ov.mask, box) > 0.4
    assert L.remove(photo, ov)[1]["action"] == "crop"


def test_clean_photos_are_left_alone():
    photos = [room_photo(s) for s in range(30, 35)]
    ovs = L.detect(photos)
    assert all(ov.box is None for ov in ovs), [ov.source for ov in ovs]
    assert all(L.remove(p, o)[1]["action"] == "none" for p, o in zip(photos, ovs))


@pytest.mark.parametrize("width,colour", [(2, 0), (3, 255), (4, 0), (5, 255)])
def test_a_thin_frame_on_every_photo_is_not_a_mark(width, colour):
    photos = []
    for s in range(60, 64):
        p = room_photo(s)
        p[:width] = p[-width:] = colour
        p[:, :width] = p[:, -width:] = colour
        photos.append(p)
    assert all(ov.box is None for ov in L.detect(photos)), "a clean photo would lose a strip or get inpainted"
    assert L.detect(photos[:1])[0].box is None  # nor in the corner check alone
    marked, box = stamp(photos[0], "ACME REALTY  MLS# 4421907")
    clean, act = L.remove(marked, L.detect([marked] + photos[1:])[0])
    assert act["action"] == "crop" and act["side"] == "bottom" and box[1] - 30 < clean.shape[0] <= box[1]


def test_a_photo_of_another_shape_does_not_hide_the_mark_the_others_share():
    pairs = [stamp(room_photo(s), "Zillowish", "center", alpha=0.55, scale=4) for s in range(10, 13)]
    pairs.append(stamp(room_photo(13, w=640, h=960), "Zillowish", "center", alpha=0.55, scale=4))  # one portrait
    photos, boxes = zip(*pairs)
    assert L.size_groups(list(photos)) == [[0, 1, 2], [3]]
    ovs = L.detect(list(photos))
    for ov, box in zip(ovs[:3], boxes[:3]):
        assert ov.source == ["shared"] and box_recall(ov.mask, box) > 0.3
    assert outside(ovs[3].mask, boxes[3]) < 0.01  # nothing from the landscape photos' mask lands on the portrait one


def test_inpainting_keeps_the_photo_s_channels():
    photos, boxes = zip(*[stamp(room_photo(s), "Zillowish", "center", alpha=0.55, scale=4) for s in range(10, 14)])
    ov = L.detect(list(photos))[0]
    grey = photos[0].mean(-1).astype(np.uint8)
    clean, act = L.remove(grey, ov)
    assert act["action"] == "inpaint" and clean.shape == grey.shape
    rgba = np.dstack([photos[0], np.full(grey.shape, 200, np.uint8)])
    clean, act = L.remove(rgba, ov)
    assert act["action"] == "inpaint" and clean.shape == rgba.shape and (clean[..., 3] == 200).all()


def test_clean_photos_reads_photos_as_the_job_does(tmp_path):
    """EXIF orientation applied and transparency on white, as run_job's normalising step does, so the preview makes
    the same decisions as the job."""
    from PIL import Image

    src = tmp_path / "in"
    src.mkdir()
    shown, _ = stamp(room_photo(7, w=640, h=960), "ACME REALTY  MLS# 4421907")  # portrait, as a viewer shows it
    exif = Image.Exif()
    exif[0x0112] = 6  # stored on its side, shown rotated
    Image.fromarray(shown).transpose(Image.Transpose.ROTATE_90).save(src / "portrait.jpg", quality=95, exif=exif)
    rgba = np.dstack([room_photo(8), np.full((640, 960), 255, np.uint8)])
    rgba[:40] = 0  # a transparent top strip whose hidden colour is black
    Image.fromarray(rgba, "RGBA").save(src / "alpha.png")
    rep = L.clean_photos(sorted(src.iterdir()), tmp_path / "out")
    by = {e["file"]: e for e in rep["photos"]}
    assert by["portrait.jpg"]["size"] == [640, 960]
    assert by["portrait.jpg"]["action"] == "crop" and by["portrait.jpg"]["side"] == "bottom"
    w, h = Image.open(tmp_path / "out" / "portrait.jpg").size
    assert w == 640 and h < 960
    top = np.asarray(Image.open(tmp_path / "out" / "alpha.jpg"))[:30]
    assert top.min() > 240


def test_clean_photos_writes_files_report_and_previews(tmp_path):
    from PIL import Image

    src = tmp_path / "in"
    src.mkdir()
    for s in range(4):
        Image.fromarray(stamp(room_photo(s), "ACME REALTY  MLS# 4421907")[0]).save(src / f"{s:03d}.jpg", quality=95)
    rep = L.clean_photos(sorted(src.glob("*.jpg")), tmp_path / "out", tmp_path / "masks", tmp_path / "rep.json")
    assert rep["cleaned"] == 4 and json.loads((tmp_path / "rep.json").read_text()) == json.loads(json.dumps(rep))
    assert not (tmp_path / "out" / "listing.json").exists()  # kept out of the folder the rebuild reads
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == [f"{s:03d}.jpg" for s in range(4)]
    assert all((tmp_path / "masks" / e["preview"]).exists() for e in rep["photos"])


# --- the job ---------------------------------------------------------------------------------------------------------

def test_listing_job_end_to_end_with_a_stand_in_rebuild(tmp_path, monkeypatch):
    """mode reconstruct + listing: true. The rebuild is stubbed with the synthetic room from the walk-zone tests;
    everything else runs for real: clean-up, walk zone, collider, spawn facing the photographed side, caption."""
    from PIL import Image

    import run_job
    import splat_io as sio
    import walkzone_auto as W
    from common.jobio import Job
    from test_walkzone_auto import make_room

    jd = tmp_path / "job"
    (jd / "input").mkdir(parents=True)
    for s in range(4):
        Image.fromarray(stamp(room_photo(s), "ACME REALTY  MLS# 4421907")[0]).save(jd / "input" / f"p{s}.jpg")
    (jd / "job.json").write_text(json.dumps({"id": "old-house", "mode": "reconstruct", "params": {"listing": True}}))
    seen = {}

    def fake_rebuild(job, name, args, lo, hi, stage, progress_file=None):
        img_dir = __import__("pathlib").Path(args[args.index("--images") + 1])
        seen["heights"] = [Image.open(p).size[1] for p in sorted(img_dir.glob("*.jpg"))]
        seen["files"] = sorted(p.name for p in img_dir.iterdir())
        out = job.out_dir
        sio.write_spz(out / "world.spz", make_room(floaters=False, opening=False))
        cams = []
        for i, yaw in enumerate([math.radians(a) for a in (-30, 0, 30)]):  # the photos all look at the back wall
            m = W.view_c2w(-0.5 + 0.4 * i, 0.6, yaw)
            cams.append({"file": f"{i:03d}.jpg", "position": m[:3, 3].tolist(),
                         "quaternion": list(sio.matrix_to_quat_xyzw(m[:3, :3]))})
        (out / "cameras.json").write_text(json.dumps({"convention": "OpenGL cameras in the viewer frame",
                                                       "cameras": cams}))
        (out / "scene.json").write_text(json.dumps({"world": {
            "file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
            "floorY": 0.0, "spawn": {"position": [0, 0, 0], "yaw": 0.0}, "source": "anysplat",
            "bounds": {"min": [-2, 0, -1.5], "max": [2, 2.5, 1.5]}}}))
        (out / "thumb.jpg").write_bytes((jd / "input" / "p0.jpg").read_bytes())

    monkeypatch.setattr(run_job, "runner_available", lambda name: (True, ""))
    monkeypatch.setattr(run_job, "run_runner", fake_rebuild)
    job = Job(jd, echo=False)
    res = run_job.run_reconstruct(job)
    assert seen["files"] == ["000.jpg", "001.jpg", "002.jpg", "003.jpg"]  # only photos reach the rebuild
    assert all(h < 640 for h in seen["heights"])  # every watermark band was cropped before the rebuild
    report = json.loads((job.work_dir / "listing.json").read_text())
    assert report["cleaned"] == 4
    assert res["caption"] == "Rebuilt from 4 listing photos."
    w = res["world"]
    assert w["collider"] == "collider.glb" and set(w) <= {"file", "transform", "floorY", "spawn", "bounds",
                                                          "source", "collider", "splatCount", "topdown", "backdrop"}
    for f in ("collider.glb", "walkzone.json", "walkzone-topdown.png"):
        assert (job.out_dir / f).exists()  # top level: the server copies these
    yaw = w["spawn"]["yaw"]
    assert min(abs((yaw - math.radians(a) + math.pi) % (2 * math.pi) - math.pi) for a in (-30, 0, 30)) <= math.radians(23)
    x, _, z = w["spawn"]["position"]
    assert -2 < x < 2 and -1.5 < z < 1.5
    log = (jd / "log.txt").read_text()
    assert "listing: 4 of 4 photos" in log and "walk zone" in log


def _listing_job(tmp_path, monkeypatch, clean_error: BaseException):
    """A listing job whose clean-up raises `clean_error`; the rebuild is stubbed and records the photos it gets."""
    from PIL import Image

    import listing as Lmod
    import run_job

    jd = tmp_path / "job"
    (jd / "input").mkdir(parents=True)
    for s in range(4):
        Image.fromarray(stamp(room_photo(s), "ACME REALTY  MLS# 4421907")[0]).save(jd / "input" / f"p{s}.jpg")
    (jd / "job.json").write_text(json.dumps({"id": "old-house", "mode": "reconstruct", "params": {"listing": True}}))
    seen = {}

    def broken_clean(*a, **k):
        raise clean_error

    def fake_rebuild(job, name, args, lo, hi, stage, progress_file=None):
        img_dir = __import__("pathlib").Path(args[args.index("--images") + 1])
        seen["heights"] = [Image.open(p).size[1] for p in sorted(img_dir.glob("*.jpg"))]
        (job.out_dir / "scene.json").write_text(json.dumps({"world": {
            "file": "world.spz", "transform": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "scale": 1},
            "floorY": 0.0, "spawn": {"position": [0, 0, 0], "yaw": 0.0}, "source": "anysplat"}}))
        (job.out_dir / "world.spz").write_bytes(b"not a splat file")  # the walk zone fails on it too
        (job.out_dir / "thumb.jpg").write_bytes((jd / "input" / "p0.jpg").read_bytes())

    monkeypatch.setattr(Lmod, "clean_photos", broken_clean)
    monkeypatch.setattr(run_job, "runner_available", lambda name: (True, ""))
    monkeypatch.setattr(run_job, "run_runner", fake_rebuild)
    return jd, seen


def test_a_failed_clean_up_still_ships_the_world_from_the_original_photos(tmp_path, monkeypatch):
    """Removing watermarks is an extra: when it fails, the rebuild gets the photos as uploaded and the job finishes
    with a notice, the same way a failed walk zone keeps the rebuild's own spawn."""
    import run_job

    jd, seen = _listing_job(tmp_path, monkeypatch, RuntimeError("cv2.inpaint failed"))
    assert run_job.run(jd) == 0 and (jd / "DONE").exists() and not (jd / "FAILED").exists()
    assert seen["heights"] == [640] * 4  # every photo reached the rebuild, uncropped
    res = json.loads((jd / "out" / "scene.json").read_text())
    assert res["caption"].startswith("Rebuilt from 4 listing photos.") and "watermarks" in res["caption"]
    assert "collider" not in res["world"] and res["world"]["spawn"] == {"position": [0, 0, 0], "yaw": 0.0}
    assert "listing clean-up failed: RuntimeError: cv2.inpaint failed" in (jd / "log.txt").read_text()


def test_a_cancel_during_the_clean_up_still_cancels_the_job(tmp_path, monkeypatch):
    import run_job

    jd, _ = _listing_job(tmp_path, monkeypatch, run_job.Cancelled("cancelled (signal 15)"))
    assert run_job.run(jd) == 1 and (jd / "FAILED").exists()
    assert json.loads((jd / "progress.json").read_text())["error"] == "Cancelled."


def test_listing_job_keeps_the_rebuild_spawn_when_no_zone_is_found(tmp_path):
    res = {"world": {"spawn": {"position": [0, 0, 0], "yaw": 0.0}}}
    out = tmp_path / "out"
    out.mkdir()
    r = L.add_walk_zone(out, res, tmp_path / "work", log=lambda *_: None)  # no world at all
    assert r["ok"] is False and res["world"] == {"spawn": {"position": [0, 0, 0], "yaw": 0.0}}


def test_a_cancel_during_the_walk_zone_is_not_a_failed_zone(tmp_path, monkeypatch):
    """The walk zone can take minutes on the CPU renderer: a job cancelled then must stop, not write DONE."""
    import run_job
    from objects import scene as obj_scene

    def cancelled(*_a, **_k):
        raise run_job.Cancelled("cancelled (signal 15)")

    monkeypatch.setattr(obj_scene, "load_scene", cancelled)
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(run_job.Cancelled):
        L.add_walk_zone(out, {"world": {}}, tmp_path / "work", log=lambda *_: None, reraise=(run_job.Cancelled,))
    r = L.add_walk_zone(out, {"world": {}}, tmp_path / "work", log=lambda *_: None)  # without it: a failed zone
    assert r["ok"] is False and "Cancelled" in r["reason"]
