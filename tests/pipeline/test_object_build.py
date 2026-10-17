"""Object build: candidate clustering and box overlap, with known synthetic answers."""
import numpy as np

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
