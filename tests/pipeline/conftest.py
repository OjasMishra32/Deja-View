"""Fixtures for the video pipeline tests. Shared helpers live in pipeline_helpers.py (import them from there)."""
import shutil
from pathlib import Path

import pytest

from pipeline_helpers import make_clip  # also puts pipeline/ on sys.path and sets TW_DISABLE_FLASHWORLD=1


@pytest.fixture(scope="session")
def synthetic_clip(tmp_path_factory) -> Path:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    return make_clip(tmp_path_factory.mktemp("media") / "clip.mp4")
