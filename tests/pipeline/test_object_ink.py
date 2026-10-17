"""The ink pass keeps the colours but removes the high-frequency detail."""
import numpy as np

import pipeline_helpers  # noqa: F401
from objects import ink


def _high_frequency_image():
    rng = np.random.default_rng(3)
    return rng.integers(0, 256, (64, 64, 3), np.uint8)


def test_ink_keeps_shape_and_reduces_high_frequency_energy():
    src = _high_frequency_image()
    out = ink.ink_array(src, strength=1.4)
    assert out.shape == src.shape and out.dtype == np.uint8
    assert not np.array_equal(out, src)
    src_energy = np.abs(np.diff(src.astype(np.float32), axis=0)).mean()
    out_energy = np.abs(np.diff(out.astype(np.float32), axis=0)).mean()
    assert out_energy < src_energy * 0.6
