"""Video probing/decoding through ffmpeg and image I/O."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Iterator

import numpy as np


class MediaError(RuntimeError):
    pass


def require_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise MediaError(f"{tool} is not installed or not on PATH")


@dataclass
class VideoInfo:
    path: Path
    width: int  # display width (after rotation metadata)
    height: int  # display height
    coded_width: int
    coded_height: int
    rotation: int  # degrees, as stored in the file
    fps: float
    fps_fraction: Fraction
    duration: float
    nb_frames: int
    codec: str
    has_audio: bool
    audio_codec: str | None = None
    audio_channels: int | None = None
    audio_rate: int | None = None
    tags: dict = field(default_factory=dict)

    @property
    def focal_35mm(self) -> float | None:
        """35 mm equivalent focal length when the container records it (iPhone QuickTime metadata)."""
        for k, v in self.tags.items():
            kl = k.lower()
            if "focal_length" in kl and "35mm" in kl:
                try:
                    f = float(str(v).split()[0])
                    if 8.0 <= f <= 300.0:
                        return f
                except ValueError:
                    pass
        return None


def _parse_rate(s: str | None) -> Fraction:
    if not s or s in ("0/0", "N/A"):
        return Fraction(0)
    try:
        return Fraction(s)
    except (ValueError, ZeroDivisionError):
        return Fraction(0)


def probe(path: Path | str) -> VideoInfo:
    require_ffmpeg()
    path = Path(path)
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=60).stdout
    except subprocess.CalledProcessError as e:
        raise MediaError(f"ffprobe could not read {path.name}: {e.stderr.strip()[:300]}") from e
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    v = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    if v is None:
        raise MediaError(f"{path.name} has no video stream")
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    rotation = 0
    for sd in v.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                rotation = int(round(float(sd["rotation"])))
            except (TypeError, ValueError):
                pass
    if not rotation and "rotate" in (v.get("tags") or {}):
        try:
            rotation = int(v["tags"]["rotate"])
        except ValueError:
            pass
    cw, ch = int(v.get("width") or 0), int(v.get("height") or 0)
    if cw <= 0 or ch <= 0:
        raise MediaError(f"{path.name}: invalid video size")
    w, h = (ch, cw) if abs(rotation) % 180 == 90 else (cw, ch)

    rate = _parse_rate(v.get("avg_frame_rate"))
    if rate <= 0 or rate > 240:
        rate = _parse_rate(v.get("r_frame_rate"))
    if rate <= 0 or rate > 240:
        rate = Fraction(30)
    duration = 0.0
    for src in (v.get("duration"), fmt.get("duration")):
        try:
            duration = float(src)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue
    nb = 0
    try:
        nb = int(v.get("nb_frames") or 0)
    except ValueError:
        nb = 0
    if nb <= 0 and duration > 0:
        nb = int(round(duration * float(rate)))
    if duration <= 0 and nb > 0:
        duration = nb / float(rate)

    tags = {}
    tags.update(fmt.get("tags") or {})
    tags.update(v.get("tags") or {})
    return VideoInfo(
        path=path,
        width=w,
        height=h,
        coded_width=cw,
        coded_height=ch,
        rotation=rotation,
        fps=float(rate),
        fps_fraction=rate,
        duration=duration,
        nb_frames=nb,
        codec=str(v.get("codec_name") or "?"),
        has_audio=a is not None,
        audio_codec=(a or {}).get("codec_name"),
        audio_channels=int(a["channels"]) if a and a.get("channels") else None,
        audio_rate=int(a["sample_rate"]) if a and a.get("sample_rate") else None,
        tags=tags,
    )


def round_to_multiple(x: float, m: int) -> int:
    return max(m, int(round(x / m)) * m)


def fit_size(w: int, h: int, max_long: int = 1280, multiple: int = 16) -> tuple[int, int]:
    """Scale (w, h) so the long side is at most max_long; both sides become multiples of `multiple`."""
    s = min(1.0, max_long / max(w, h))
    return round_to_multiple(w * s, multiple), round_to_multiple(h * s, multiple)


def output_fps(src: Fraction, cap: float = 30.0) -> Fraction:
    """Source rate when it is at most `cap`, otherwise the cap (60 -> 30, 59.94 -> 29.97)."""
    if float(src) <= cap + 0.01:
        return src
    for div in (2, 3, 4, 5, 6, 8):
        r = src / div
        if float(r) <= cap + 0.01:
            return r
    return Fraction(int(cap))


def iter_frames(
    path: Path | str,
    size: tuple[int, int],
    fps: Fraction | float | None = None,
    start: float = 0.0,
    duration: float | None = None,
    max_frames: int | None = None,
) -> Iterator[np.ndarray]:
    """Decode RGB uint8 frames of exactly `size` (w, h). Rotation metadata is applied by ffmpeg."""
    require_ffmpeg()
    w, h = size
    filters = []
    if fps:
        fr = Fraction(fps).limit_denominator(100000)
        filters.append(f"fps={fr.numerator}/{fr.denominator}")
    filters.append(f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int")
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if start and start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if duration and duration > 0:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-an", "-sn", "-vf", ",".join(filters), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    frame_bytes = w * h * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 2)
    n = 0
    try:
        while True:
            if max_frames is not None and n >= max_frames:
                break
            buf = _read_exact(proc.stdout, frame_bytes)
            if buf is None:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
            n += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
    if n == 0:
        raise MediaError(f"could not decode any frame from {Path(path).name}: {err.strip()[:300]}")


def _read_exact(stream, n: int) -> bytes | None:
    chunks = []
    got = 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks) if len(chunks) > 1 else chunks[0]


def count_frames(path: Path | str, fps: Fraction | None, duration: float) -> int:
    """Expected number of frames after the fps filter."""
    if fps and duration > 0:
        return max(1, int(math.floor(duration * float(fps) + 1e-6)))
    return 0


# ---- images ---------------------------------------------------------------

def load_image(path: Path | str) -> np.ndarray:
    """RGB uint8, EXIF orientation applied. HEIC/HEIF supported through pillow-heif."""
    from PIL import Image, ImageOps

    p = Path(path)
    if p.suffix.lower() in (".heic", ".heif", ".avif"):
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except Exception as e:  # pragma: no cover
            raise MediaError(f"cannot read {p.name}: pillow-heif missing ({e})") from e
    try:
        with Image.open(p) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im)
            return np.asarray(im.convert("RGB")).copy()
    except MediaError:
        raise
    except Exception as e:
        raise MediaError(f"cannot read image {p.name}: {e}") from e


def save_jpg(path: Path | str, rgb: np.ndarray, quality: int = 92) -> None:
    from PIL import Image

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(rgb)).save(str(path), quality=quality, optimize=True, progressive=True)


def save_png(path: Path | str, arr: np.ndarray) -> None:
    from PIL import Image

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(arr)).save(str(path))


def resize_long(rgb: np.ndarray, max_long: int) -> np.ndarray:
    import cv2

    h, w = rgb.shape[:2]
    s = max_long / max(h, w)
    if s >= 1:
        return rgb
    return cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
