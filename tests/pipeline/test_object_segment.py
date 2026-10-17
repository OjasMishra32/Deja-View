"""Small pure checks for the segmentation helpers. The models run on PACE, not in CI."""
import numpy as np

import pipeline_helpers  # noqa: F401
from objects import segment


def test_vocabulary_is_ordered_and_deduplicated():
    assert segment.vocabulary(" Fridge, cabinet,\nfridge , counter ") == ["fridge", "cabinet", "counter"]


def test_match_label_finds_the_vocabulary_word_in_a_phrase():
    vocab = ["fridge", "counter"]
    assert segment.match_label("a stainless steel fridge", vocab) == "fridge"
    assert segment.match_label("wooden counter top", vocab) == "counter"
    assert segment.match_label("a chair", vocab) is None


def test_select_mask_picks_the_best_iou_from_4d():
    masks = np.zeros((3, 1, 4, 4), np.float32)
    masks[2, 0, 1, 1] = 1.0
    best = segment.select_mask(masks, np.array([0.1, 0.2, 0.9]))
    assert best.dtype == bool
    assert best[1, 1]
    assert best.sum() == 1


def test_select_mask_handles_a_3d_stack():
    masks = np.zeros((2, 3, 3), np.float32)
    masks[1, 2, 2] = 1.0
    best = segment.select_mask(masks, np.array([0.2, 0.8]))
    assert best[2, 2]
    assert best.sum() == 1
