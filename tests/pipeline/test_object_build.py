"""Object build: candidate clustering and box overlap, with known synthetic answers."""
import numpy as np
import pytest

import pipeline_helpers  # noqa: F401
from objects import build


def _item(x, y, z, size=0.4):
    c = np.array([x, y, z], float)
    return {"centroid": c, "bounds": (c - size / 2, c + size / 2)}


def test_bbox_iou_of_identical_and_disjoint_boxes():
    a = (np.array([0, 0, 0]), np.array([1, 1, 1]))
    assert build.bbox_iou(a, a) == 1.0
    b = (np.array([2, 2, 2]), np.array([3, 3, 3]))
    assert build.bbox_iou(a, b) == 0.0


def test_cluster_keeps_two_objects_apart():
    items = [_item(0, 0, 0), _item(0.05, 0, 0), _item(1.5, 0, 0), _item(1.55, 0, 0)]
    clusters = build.cluster_candidates(items, centroid_dist=0.35)
    assert len(clusters) == 2
    assert len(clusters[0]) == 2
    assert len(clusters[1]) == 2


def test_cluster_merges_views_of_one_object():
    items = [_item(0, 0, 0, 1.0), _item(0.1, 0, 0.1, 1.0), _item(-0.1, 0, 0, 1.0)]
    clusters = build.cluster_candidates(items, centroid_dist=0.35)
    assert len(clusters) == 1
    assert len(clusters[0]) == 3


def test_cluster_does_not_move_the_first_candidate():
    items = [_item(0, 0, 0), _item(0.2, 0, 0)]
    build.cluster_candidates(items, centroid_dist=0.35)
    assert items[0]["centroid"].tolist() == [0.0, 0.0, 0.0]


W, H, F = 160, 120, 120.0


def _box_scene(tmp_path, detections):
    """A box of splats 2 m in front of two cameras, full-frame masks, and the given detections."""
    import json

    from PIL import Image

    import splat_io as sio
    from objects import scene as obj_scene

    d = tmp_path / "scene"
    (d / "views").mkdir(parents=True)
    (d / "masks").mkdir()
    g = np.arange(-0.3, 0.3001, 0.05)
    xx, yy, zz = np.meshgrid(g, g + 1.0, g - 2.0)
    pts = np.stack([xx.ravel(), yy.ravel(), zz.ravel()], axis=1)
    sio.write_spz(d / "world.spz", sio.Splats.from_rgb(pts, [0.8, 0.8, 0.8], 0.02), sh_degree=0)
    (d / "scene.json").write_text(json.dumps({"id": "box", "world": {"file": "world.spz", "floorY": 0}}))
    views = []
    for i, x in enumerate((0.0, 0.4)):
        c2w = obj_scene.look_at(np.array([x, 1.0, 0.0]), np.array([0.0, 1.0, -2.0]))
        views.append({"file": f"view_{i:02d}.png", "width": W, "height": H, "fx": F, "fy": F,
                      "cx": W / 2, "cy": H / 2, "c2w": c2w.tolist()})
    (d / "views" / "views.json").write_text(json.dumps({"views": views}))
    for det in detections:
        Image.fromarray(np.full((H, W), 255, np.uint8)).save(d / "masks" / det["mask"])
    (d / "masks" / "detections.json").write_text(json.dumps({"detections": detections}))
    return d


def _det(view, mask):
    return {"view": view, "label": "box", "score": 0.9, "mask": mask}


def test_duplicate_boxes_in_one_view_are_not_two_views(tmp_path):
    d = _box_scene(tmp_path, [_det("view_00.png", "a.png"), _det("view_00.png", "b.png")])
    doc = build.build(d, d / "views", d / "masks", min_splats=50, log=lambda *_: None)
    assert doc["objects"] == []


def test_two_views_of_one_box_make_one_object(tmp_path):
    d = _box_scene(tmp_path, [_det("view_00.png", "a.png"), _det("view_01.png", "b.png")])
    doc = build.build(d, d / "views", d / "masks", min_splats=50, log=lambda *_: None)
    assert len(doc["objects"]) == 1
    obj = doc["objects"][0]
    assert obj["id"] == "box"
    assert obj["source"]["views"] == 2
    assert obj["center"][2] == pytest.approx(-2.0 * build.DEFAULT_STUDS, abs=0.2)
