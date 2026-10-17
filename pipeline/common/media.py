"""Video probing/decoding through ffmpeg and image I/O.

HDR video (HLG or PQ, e.g. any iPhone 12 or later clip) is tone-mapped to BT.709 SDR when decoded; see hdr.py.
SDR video takes exactly the plain decode path.
"""
from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from .hdr import HdrSource, lut_file, lut_filters, rgb48_to_rgb24, scale_options

log = logging.getLogger(__name__)

# Product sentences for MediaError.user (shown in the app; no tool names).
USER_VIDEO_UNREADABLE = "We couldn't read this video. Export it again and upload it once more."
USER_VIDEO_NO_VIDEO = "This file has no video in it. Pick a video or a photo."
USER_PHOTO_UNREADABLE = "This photo couldn't be opened. Try a JPEG or PNG."
USER_TOOLS_MISSING = "We can't process videos on this machine right now. Try again in a minute."


# Video containers with no seek index (see iter_frames).
UNINDEXED_EXTS = {".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".flv"}


class MediaError(RuntimeError):
    """A file we cannot use. str(e) is the technical cause (for the log); `user`, when set, is one short
    product sentence for the app."""

    def __init__(self, message: str, user: str | None = None):
        super().__init__(message)
        self.user = user


def require_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise MediaError(f"{tool} is not installed or not on PATH", user=USER_TOOLS_MISSING)


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
    pix_fmt: str | None = None
    color_transfer: str | None = None  # ffprobe names: bt709, arib-std-b67 (HLG), smpte2084 (PQ), ...
    color_primaries: str | None = None
    color_space: str | None = None
    color_range: str | None = None
    hdr: str | None = None  # 'hlg' or 'pq' for HDR video (iter_frames tone-maps it to SDR), else None

    @property
    def hdr_source(self) -> HdrSource | None:
        return HdrSource.from_stream(self.color_transfer, self.color_primaries, self.color_space, self.color_range)

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
        raise MediaError(f"ffprobe could not read {path.name}: {e.stderr.strip()[:300]}", user=USER_VIDEO_UNREADABLE) from e
    except subprocess.TimeoutExpired as e:
        raise MediaError(f"ffprobe timed out reading {path.name}", user=USER_VIDEO_UNREADABLE) from e
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError as e:
        raise MediaError(f"ffprobe output for {path.name} is not JSON: {e}", user=USER_VIDEO_UNREADABLE) from e
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    v = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    if v is None:
        raise MediaError(f"{path.name} has no video stream", user=USER_VIDEO_NO_VIDEO)
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
        raise MediaError(f"{path.name}: invalid video size", user=USER_VIDEO_UNREADABLE)
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
    color = _stream_color(v)
    _remember_color(path, color)
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
        **color,
    )


# ---- colour / HDR detection ---------------------------------------------------------------------------------
# probe() records each file's colour description so iter_frames does not have to run ffprobe again.

_COLOR_KEYS = ("pix_fmt", "color_transfer", "color_primaries", "color_space", "color_range")
_color_cache: dict[tuple, dict] = {}


def _stream_color(v: dict) -> dict:
    c = {k: (str(v[k]) if v.get(k) not in (None, "", "unknown") else None) for k in _COLOR_KEYS}
    src = HdrSource.from_stream(c["color_transfer"], c["color_primaries"], c["color_space"], c["color_range"])
    c["hdr"] = src.transfer if src else None
    return c


def _file_key(path: Path | str) -> tuple | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (os.path.realpath(path), st.st_mtime_ns, st.st_size)


def _remember_color(path: Path | str, color: dict) -> None:
    key = _file_key(path)
    if key is None:
        return
    if len(_color_cache) > 256:
        _color_cache.clear()
    _color_cache[key] = color


def video_color(path: Path | str) -> dict:
    """The first video stream's colour description (the VideoInfo colour fields). Cached per file version;
    after probe() this costs nothing. Empty when the file cannot be probed."""
    key = _file_key(path)
    if key is not None and key in _color_cache:
        return dict(_color_cache[key])
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v", "-print_format", "json",
           "-show_entries", "stream=codec_type," + ",".join(_COLOR_KEYS) + ":stream_disposition=attached_pic", str(path)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=60).stdout
        streams = json.loads(out or "{}").get("streams") or []
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {}
    v = next((s for s in streams if not (s.get("disposition") or {}).get("attached_pic")), None)
    if v is None:
        return {}
    color = _stream_color(v)
    _remember_color(path, color)
    return color


def hdr_source(path: Path | str) -> HdrSource | None:
    """How to tone-map this video, or None for SDR (or when it cannot be probed)."""
    c = video_color(path)
    return HdrSource.from_stream(c.get("color_transfer"), c.get("color_primaries"), c.get("color_space"), c.get("color_range"))


def sdr_filters(path: Path | str, scale: str = "scale=flags=accurate_rnd+full_chroma_int", jpeg: bool = False) -> list[str]:
    """ffmpeg filters that turn this video's frames into BT.709 SDR, for code that runs ffmpeg itself
    (`-vf ",".join(["fps=4", *sdr_filters(video, jpeg=True)])`). Empty for SDR video, so its command is unchanged.

    For HDR: `scale` (any size/flags, plus the stream's YCbCr matrix and range), the tone-mapping LUTs, then
    JFIF YCbCr for a JPEG writer (jpeg=True) or rgb24 for anything else."""
    src = hdr_source(path)
    if src is None:
        return []
    out = "scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p" if jpeg else "format=rgb24"
    return [scale + scale_options(src), *lut_filters(src), out]


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
    tonemap: bool = True,
) -> Iterator[np.ndarray]:
    """Decode RGB uint8 frames of exactly `size` (w, h). Rotation metadata is applied by ffmpeg.

    HDR video (HLG or PQ transfer) is tone-mapped to BT.709 SDR unless `tonemap` is False; SDR video is
    decoded exactly as before. The colour check reuses probe()'s result for the same file."""
    require_ffmpeg()
    w, h = size
    filters = []
    if fps:
        fr = Fraction(fps).limit_denominator(100000)
        filters.append(f"fps={fr.numerator}/{fr.denominator}")
    scale = f"scale={w}:{h}:flags=area+accurate_rnd+full_chroma_int"
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    # Containers without a seek index (.ts, .m2ts, .mpg ...) land mid-GOP on an input seek and decode nothing;
    # for them, seek on the output side (decode from the start and drop frames, exact and still fast for clips).
    output_seek = Path(path).suffix.lower() in UNINDEXED_EXTS
    if start and start > 0 and not output_seek:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if start and start > 0 and output_seek:
        cmd += ["-ss", f"{start:.3f}"]
    if duration and duration > 0:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-an", "-sn", "-vf"]
    src = hdr_source(path) if tonemap else None
    if src is not None:
        try:
            hdr_vf = ",".join(filters + [scale + scale_options(src)] + lut_filters(src, lut_file(src.transfer, src.primaries)))
        except (OSError, ValueError) as e:
            log.warning("HDR tone mapping unavailable (%s); decoding %s without it", e, Path(path).name)
            src = None
    if src is not None:
        frames = _decode(cmd + [hdr_vf, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"], path, w * h * 6, max_frames,
                         lambda buf: rgb48_to_rgb24(buf, w, h))
        n = 0
        try:
            for frame in frames:
                n += 1
                yield frame
            return
        except MediaError as e:
            if n:
                raise
            # Nothing decoded through the tone-mapping filters (an ffmpeg without them?): fall back to plain.
            log.warning("HDR (%s) decode of %s failed, decoding without tone mapping: %s", src.transfer, Path(path).name, e)
        finally:
            frames.close()
    yield from _decode(cmd + [",".join(filters + [scale]), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], path, w * h * 3,
                       max_frames, lambda buf: np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3))


def _decode(cmd: list[str], path: Path | str, frame_bytes: int, max_frames: int | None,
            convert: Callable[[bytes], np.ndarray]) -> Iterator[np.ndarray]:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 2)
    n = 0
    try:
        while True:
            if max_frames is not None and n >= max_frames:
                break
            buf = _read_exact(proc.stdout, frame_bytes)
            if buf is None:
                break
            yield convert(buf)
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
        raise MediaError(f"could not decode any frame from {Path(path).name}: {err.strip()[:300]}", user=USER_VIDEO_UNREADABLE)


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
            raise MediaError(f"cannot read {p.name}: pillow-heif missing ({e})", user=USER_PHOTO_UNREADABLE) from e
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
        raise MediaError(f"cannot read image {p.name}: {e}", user=USER_PHOTO_UNREADABLE) from e


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
