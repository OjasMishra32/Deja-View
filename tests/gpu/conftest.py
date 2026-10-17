"""Fixtures for the world-generation tests. Shared helpers live in gpu_helpers.py (import them from there)."""
from __future__ import annotations

import numpy as np
import pytest

import gpu_helpers  # noqa: F401  (puts pipeline/ and hpg/ on sys.path)


@pytest.fixture
def rng():
    return np.random.default_rng(1234)
