"""tw-pack-v1: RGB + inverse depth + mask in one H.264 frame (shared/types.ts VideoLayer).

  full frame = width x (height * 1.5)
  rows [0, height)             RGB, width x height
  rows [height, 1.5 * height)  left half: depth (gray, width/2 x height/2)
                               right half: mask (gray, width/2 x height/2, white = moving foreground)
  depth: v = gray / 255,  1/d = 1/far + v * (1/near - 1/far)

Gray pixels are written as R = G = B, so they survive any BT.601/BT.709 matrix mismatch in the
decoder: only luma carries them. width and height are multiples of 16 so the band boundaries sit
on macroblock rows/columns where possible.
"""
from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np

LAYOUT = "tw-pack-v1"


def check_dims(width: int, height: int) -> None:
    if width % 4 or height % 4:
        raise ValueError(f"tw-pack-v1 needs width and height divisible by 4, got {width}x{height}")


def packed_size(width: int, height: int) -> tuple[int, int]:
    check_dims(width, height)
    return width, height * 3 // 2


def encode_inverse_depth(depth: np.ndarray, near: float, far: float) -> np.ndarray:
    """z-depth in metres -> uint8 code (0 = far or beyond, 255 = near or closer)."""
    if not (0 < near < far):
        raise ValueError(f"need 0 < near < far, got near={near} far={far}")
    d = np.asarray(depth, np.float32)
    inv = np.where(d > 0, 1.0 / np.maximum(d, 1e-6), 0.0)
    v = (inv - 1.0 / far) / (1.0 / near - 1.0 / far)
    return np.clip(np.rint(v * 255.0), 0, 255).astype(np.uint8)


def encode_inverse(inv: np.ndarray, near: float, far: float) -> np.ndarray:
    """Inverse depth (1/m) -> uint8 code."""
    v = (np.asarray(inv, np.float32) - 1.0 / far) / (1.0 / near - 1.0 / far)
    return np.clip(np.rint(v * 255.0), 0, 255).astype(np.uint8)


def decode_inverse_depth(code: np.ndarray, near: float, far: float) -> np.ndarray:
    """uint8 code (or float gray 0..255) -> z-depth in metres, exactly as the viewer decodes it."""
    v = np.asarray(code, np.float32) / 255.0
    inv = 1.0 / far + v * (1.0 / near - 1.0 / far)
    return 1.0 / inv


def pack_frame(rgb: np.ndarray, depth_code: np.ndarray, mask: np.ndarray, out: np.ndarray | None = None) -> np.ndarray:
    """Assemble one packed frame (1.5H, W, 3) uint8."""
    h, w = rgb.shape[:2]
    check_dims(w, h)
    h2, w2 = h // 2, w // 2
    if depth_code.shape != (h2, w2) or mask.shape != (h2, w2):
        raise ValueError(f"depth/mask must be {(h2, w2)}, got {depth_code.shape} and {mask.shape}")
    if out is None:
        out = np.empty((h + h2, w, 3), np.uint8)
    out[:h] = rgb
    out[h:, :w2] = depth_code[..., None]
    out[h:, w2:] = mask[..., None]
    return out


LUMA_709 = np.array([0.2126, 0.7152, 0.0722], np.float32)


def unpack_frame(packed: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split a decoded packed frame into (rgb, depth gray, mask gray).

    The gray value is read as BT.709 luma (0.2126 R + 0.7152 G + 0.0722 B), which cancels the
    chroma that 4:2:0 subsampling smears across the RGB/band boundary; a plain channel mean
    would not. Decoders should read the bands the same way.
    """
    h2, w2 = height // 2, width // 2
    rgb = packed[:height, :width]
    band = packed[height : height + h2].astype(np.float32) @ LUMA_709
    return rgb, band[:, :w2], band[:, w2:width]


class PackWriter:
    """Streams packed frames into ffmpeg (libx264, yuv420p, +faststart), muxing the source audio."""

    def __init__(
        self,
        out_path: Path | str,
        width: int,
        height: int,
        fps: Fraction | float,
        audio_src: Path | str | None = None,
        audio_start: float = 0.0,
        duration: float | None = None,
        crf: int = 18,
        preset: str = "medium",
        gop_seconds: float = 1.0,
    ):
        self.width, self.height = width, height
        self.pw, self.ph = packed_size(width, height)
        self.out_path = Path(out_path)
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        fr = Fraction(fps).limit_denominator(100000)
        gop = max(1, int(round(float(fr) * gop_seconds)))
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-nostdin",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{self.pw}x{self.ph}",
            "-framerate", f"{fr.numerator}/{fr.denominator}", "-i", "-",
        ]
        if audio_src is not None:
            if audio_start > 0:
                cmd += ["-ss", f"{audio_start:.3f}"]
            if duration:
                cmd += ["-t", f"{duration:.3f}"]
            cmd += ["-i", str(audio_src), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]
        else:
            cmd += ["-map", "0:v:0"]
        cmd += [
            "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p",
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
            "-movflags", "+faststart",
        ]
        if duration:
            cmd += ["-t", f"{duration:.3f}"]
        cmd += [str(self.out_path)]
        self.cmd = cmd
        self.frames = 0
        self._err_path = self.out_path.with_suffix(".ffmpeg.log")
        self._err = open(self._err_path, "wb")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=self._err)

    def write(self, packed: np.ndarray) -> None:
        if packed.shape != (self.ph, self.pw, 3) or packed.dtype != np.uint8:
            raise ValueError(f"packed frame must be {(self.ph, self.pw, 3)} uint8, got {packed.shape} {packed.dtype}")
        try:
            self.proc.stdin.write(np.ascontiguousarray(packed).tobytes())
        except BrokenPipeError as e:
            raise RuntimeError(f"ffmpeg encoder exited early: {self._read_err()}") from e
        self.frames += 1

    def _read_err(self) -> str:
        try:
            self._err.flush()
            return self._err_path.read_text(errors="replace").strip()[-800:]
        except OSError:
            return ""

    def close(self) -> None:
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        rc = self.proc.wait()
        self._err.close()
        if rc != 0:
            raise RuntimeError(f"ffmpeg encoder failed ({rc}): {self._err_path.read_text(errors='replace').strip()[-800:]}")
        try:
            self._err_path.unlink()
        except OSError:
            pass

    def abort(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        self._err.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.close()
        else:
            self.abort()
