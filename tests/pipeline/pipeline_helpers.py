"""Helpers shared by the video pipeline tests. Test modules import from here, never from conftest
(tests/gpu has its own conftest.py, and both suites run in one pytest invocation)."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / "pipeline"
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))

os.environ.setdefault("TW_DISABLE_FLASHWORLD", "1")

requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def make_clip(path: Path, seconds: float = 2.0, size=(320, 240), fps: int = 15, audio: bool = True, moving_camera: bool = False) -> Path:
    """Synthetic still-camera clip: a textured room-like background and a moving block 'person'."""
    w, h = size
    rng = np.random.default_rng(3)
    bg = np.zeros((h, w, 3), np.uint8)
    bg[:] = (150, 120, 100)
    bg[: h // 2] = (90, 110, 140)
    for _ in range(60):  # texture so motion tracking has corners
        x, y = rng.integers(0, w - 12), rng.integers(0, h - 12)
        bg[y : y + 10, x : x + 10] = rng.integers(0, 255, 3)
    n = int(seconds * fps)
    raw = path.with_suffix(".rgb")
    with open(raw, "wb") as f:
        for i in range(n):
            fr = bg.copy()
            if moving_camera:
                fr = np.roll(fr, int(6 * np.sin(i / 3.0)), axis=1)
            x = int(40 + (w - 120) * (0.5 + 0.5 * np.sin(i / n * 2 * np.pi)))
            fr[h // 4 : h - 20, x : x + 50] = (200, 60, 60)  # body
            fr[h // 2 : h // 2 + 12, x + 50 : x + 80 + (i % 5) * 4] = (220, 180, 150)  # moving hand
            f.write(fr.tobytes())
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-framerate", str(fps), "-i", str(raw)]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=330:sample_rate=44100:duration={seconds}"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16"]
    if audio:
        cmd += ["-c:a", "aac", "-shortest"]
    cmd += [str(path)]
    subprocess.run(cmd, check=True)
    raw.unlink()
    return path
