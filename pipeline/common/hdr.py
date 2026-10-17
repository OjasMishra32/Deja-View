"""HDR (HLG and PQ) to SDR tone mapping for decoding phone video.

iPhone 12 and later record HDR video by default: HEVC 10-bit, BT.2020 primaries, HLG transfer. Decoded with a
plain scale to RGB, those frames come out dim and flat (diffuse white lands at 75% instead of 100%, colours are
squeezed into the wider BT.2020 gamut). This ffmpeg build has neither zscale nor libplacebo, so the conversion
is done with LUTs that ffmpeg applies after converting the YCbCr frames to 16-bit non-linear RGB:

    scale=...:in_color_matrix=bt2020:in_range=tv,format=gbrp16le,lut3d=file=<tone cube>,lut1d=file=<toe cube>

The maths, per pixel:

    HDR R'G'B' (HLG or PQ signal, BT.2020 or BT.709 primaries)
      -> display light in nits (HLG: inverse OETF + OOTF for a 1000 nit display; PQ: EOTF)
      -> divide by the reference (diffuse) white, 203 nits (HLG 75%, PQ 58%, per ITU-R BT.2408)
      -> BT.2020 to BT.709 primaries (linear light)
      -> soft highlight roll-off on max(R, G, B): identity below KNEE, then a smooth curve that reaches 1.0 at
         the 1000 nit peak; all three channels are scaled together, so hue and saturation are kept.
         Reference white ends at 0.95 (8-bit 250), leaving the top of the range for highlights.
      -> BT.709 / BT.1886 encoding (gamma 2.4)

How the LUTs carry it:
  - Colours outside BT.709 come out of the matrix with a negative channel. The 3D LUT keeps those values signed
    and ffmpeg clips them to 0 after interpolating (the usual hard gamut clip). Colours just inside the BT.709
    boundary (saturated primaries) stay accurate that way.
  - Gamma 2.4 is very steep near 0, so interpolating gamma-encoded corners is inaccurate for any colour with one
    weak channel. The 3D LUT therefore stores linear light (times a constant) below TOE and gamma above it; the
    1D LUT, one entry per 16-bit code, turns the linear part back into gamma and leaves the rest alone.
  - ffmpeg truncates LUT outputs to 16 bits; every entry carries half a 16-bit step so that rounds instead.

server/hdr.ts implements the same maths and writes byte-identical .cube text, so thumbnails and frames the server
extracts match what the Python pipeline decodes. Keep the two in step (tests compare them).
"""
from __future__ import annotations

import atexit
import os
import shutil
import stat
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

LUT_VERSION = 1
LUT_SIZE = 65  # 3D LUT points per axis
TOE_SIZE = 65536  # 1D LUT entries: one per 16-bit code
REF_WHITE_NITS = 203.0
PEAK_NITS = 1000.0  # HLG nominal display peak; the assumed mastering peak for PQ
KNEE = 0.9  # roll-off starts at 90% of reference white (linear light)
SDR_GAMMA = 2.4
TOE = 0.1  # linear light below which the 3D LUT stores linear values (see above)

_TOE_V = TOE ** (1.0 / SDR_GAMMA)  # gamma-encoded TOE
_TOE_SLOPE = _TOE_V / TOE  # linear values are stored times this, so the stored curve is continuous at TOE
_HALF_STEP = 0.5 / 65535.0

# ffprobe color_transfer -> our name
TRANSFERS = {"arib-std-b67": "hlg", "smpte2084": "pq"}

_HLG_A = 0.17883277
_HLG_B = 0.28466892
_HLG_C = 0.55991073
_HLG_GAMMA = 1.2  # system gamma for a 1000 nit display

_PQ_M1 = 2610.0 / 16384.0
_PQ_M2 = 2523.0 / 4096.0 * 128.0
_PQ_C1 = 3424.0 / 4096.0
_PQ_C2 = 2413.0 / 4096.0 * 32.0
_PQ_C3 = 2392.0 / 4096.0 * 32.0

_Y2020 = (0.2627, 0.6780, 0.0593)
_Y709 = (0.2126, 0.7152, 0.0722)
# Linear BT.2020 RGB to linear BT.709 RGB (ITU-R BT.2087). Rows sum to 1, so white stays white.
_M2020_TO_709 = (
    (1.6604910, -0.5876411, -0.0728499),
    (-0.1245505, 1.1328999, -0.0083494),
    (-0.0181508, -0.1005789, 1.1187297),
)


def hdr_transfer(color_transfer: str | None) -> str | None:
    """'hlg' or 'pq' for an HDR ffprobe color_transfer, otherwise None (SDR)."""
    return TRANSFERS.get(str(color_transfer or "").strip().lower())


@dataclass(frozen=True)
class HdrSource:
    """How an HDR video stream is encoded, as far as the tone mapping needs to know."""

    transfer: str  # 'hlg' | 'pq'
    primaries: str = "bt2020"  # 'bt2020' | 'bt709'
    matrix: str = "bt2020"  # ffmpeg scale in_color_matrix
    range: str = "tv"  # ffmpeg scale in_range: 'tv' (limited) or 'pc' (full)

    @staticmethod
    def from_stream(color_transfer, color_primaries=None, color_space=None, color_range=None) -> "HdrSource | None":
        """From ffprobe's stream fields; None for SDR. Untagged primaries/matrix/range mean BT.2020 limited range."""
        t = hdr_transfer(color_transfer)
        if t is None:
            return None
        prim = "bt709" if str(color_primaries or "").lower() == "bt709" else "bt2020"
        cs = str(color_space or "").lower()
        matrix = "bt709" if cs == "bt709" else "bt601" if cs in ("smpte170m", "bt470bg") else "bt2020"
        rng = "pc" if str(color_range or "").lower() in ("pc", "jpeg", "full") else "tv"
        return HdrSource(t, prim, matrix, rng)


# ---- the maths -------------------------------------------------------------------------------------------------


def tonemap(rgb: np.ndarray, transfer: str, primaries: str = "bt2020") -> np.ndarray:
    """Non-linear HDR R'G'B' in [0, 1] (shape (..., 3)) to non-linear SDR BT.709 R'G'B' in [0, 1] (float64).

    The exact per-pixel answer the LUTs approximate."""
    return np.clip(tonemap_signed(rgb, transfer, primaries), 0.0, 1.0)


def tonemap_signed(rgb: np.ndarray, transfer: str, primaries: str = "bt2020") -> np.ndarray:
    """tonemap() before the final clip: colours outside BT.709 keep a negative (sign-preserving encoded) channel."""
    r, g, b = _linear(rgb, transfer, primaries)
    return np.stack([_encode(r), _encode(g), _encode(b)], axis=-1) + 0.0  # + 0.0: no negative zeros


def _linear(rgb, transfer, primaries):
    """Linear BT.709 light relative to SDR white, after the roll-off (may be negative outside BT.709)."""
    if transfer not in ("hlg", "pq"):
        raise ValueError(f"unknown HDR transfer {transfer!r}")
    e = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
    r, g, b = e[..., 0], e[..., 1], e[..., 2]
    if transfer == "hlg":
        r, g, b = _hlg_display(r, g, b, _Y709 if primaries == "bt709" else _Y2020)
    else:
        r, g, b = _pq_eotf(r), _pq_eotf(g), _pq_eotf(b)
    # Display light relative to reference white.
    r, g, b = r / REF_WHITE_NITS, g / REF_WHITE_NITS, b / REF_WHITE_NITS
    if primaries != "bt709":
        m = _M2020_TO_709
        r, g, b = (
            m[0][0] * r + m[0][1] * g + m[0][2] * b,
            m[1][0] * r + m[1][1] * g + m[1][2] * b,
            m[2][0] * r + m[2][1] * g + m[2][2] * b,
        )
    return _rolloff(r, g, b)


def _hlg_display(r, g, b, ycoef):
    """HLG signal to display light in nits on a 1000 nit display (inverse OETF, then the OOTF)."""

    def inv_oetf(x):
        hi = (np.exp((np.maximum(x, 0.5) - _HLG_C) / _HLG_A) + _HLG_B) / 12.0
        return np.where(x <= 0.5, x * x / 3.0, hi)

    r, g, b = inv_oetf(r), inv_oetf(g), inv_oetf(b)
    ys = ycoef[0] * r + ycoef[1] * g + ycoef[2] * b
    k = PEAK_NITS * np.power(ys, _HLG_GAMMA - 1.0)
    return k * r, k * g, k * b


def _pq_eotf(x):
    p = np.power(x, 1.0 / _PQ_M2)
    return 10000.0 * np.power(np.maximum(p - _PQ_C1, 0.0) / (_PQ_C2 - _PQ_C3 * p), 1.0 / _PQ_M1)


def _rolloff(r, g, b):
    """Identity up to KNEE, then u * (1 + u / U^2) / (1 + u) on the excess: slope 1 at the knee, 1.0 at the peak."""
    peak = PEAK_NITS / REF_WHITE_NITS
    span = 1.0 - KNEE
    big_u = (peak - KNEE) / span
    mx = np.maximum(np.maximum(r, g), b)
    over = mx > KNEE
    u = np.where(over, mx - KNEE, 0.0) / span
    mapped = np.minimum(KNEE + span * (u * (1.0 + u / (big_u * big_u)) / (1.0 + u)), 1.0)
    s = np.where(over, mapped / np.where(over, mx, 1.0), 1.0)
    return r * s, g * s, b * s


def _encode(x):
    """BT.1886 inverse (gamma 2.4), sign-preserving."""
    return np.sign(x) * np.power(np.minimum(np.abs(x), 1.0), 1.0 / SDR_GAMMA)


def _toe_encode(x):
    """What the 3D LUT stores: TOE_SLOPE * x below TOE (negative values too), gamma 2.4 above."""
    return np.where(x < TOE, x * _TOE_SLOPE, np.power(np.minimum(np.maximum(x, TOE), 1.0), 1.0 / SDR_GAMMA))


def toe_decode(y):
    """The 1D LUT: stored value back to gamma 2.4 (identity at and above the encoded TOE)."""
    y = np.asarray(y, dtype=np.float64)
    return np.where(y < _TOE_V, np.power(np.maximum(y, 0.0) / _TOE_SLOPE, 1.0 / SDR_GAMMA), y)


def lut_values(rgb: np.ndarray, transfer: str, primaries: str = "bt2020") -> np.ndarray:
    """The 3D LUT entries for these HDR R'G'B' inputs (half a 16-bit step added: ffmpeg truncates)."""
    r, g, b = _linear(rgb, transfer, primaries)
    return np.stack([_toe_encode(r), _toe_encode(g), _toe_encode(b)], axis=-1) + _HALF_STEP


# ---- the LUT files ---------------------------------------------------------------------------------------------


def _header(kind: str, what: str) -> list[str]:
    return [
        f"# Deja View HDR to SDR tone mapping v{LUT_VERSION}: {what}",
        f"# reference white {REF_WHITE_NITS:g} nits, peak {PEAK_NITS:g} nits, knee {KNEE:g}, gamma {SDR_GAMMA:g}, toe {TOE:g}",
        f'TITLE "dejaview-{kind}-v{LUT_VERSION}"',
    ]


def cube_text(transfer: str, primaries: str = "bt2020", size: int = LUT_SIZE) -> str:
    """The 3D .cube LUT (red index fastest) from HDR R'G'B'. Byte-identical to server/hdr.ts cubeText()."""
    axis = np.arange(size, dtype=np.float64) / (size - 1)
    bb, gg, rr = np.meshgrid(axis, axis, axis, indexing="ij")
    out = lut_values(np.stack([rr.ravel(), gg.ravel(), bb.ravel()], axis=-1), transfer, primaries)
    head = _header(f"{transfer}-{primaries}", f"{transfer} {primaries} to BT.709, then the toe LUT") + [f"LUT_3D_SIZE {size}"]
    return "\n".join(head + [f"{x:.6f} {y:.6f} {z:.6f}" for x, y, z in out.tolist()]) + "\n"


def toe_text(size: int = TOE_SIZE) -> str:
    """The 1D .cube LUT applied after the 3D one. Byte-identical to server/hdr.ts toeText()."""
    v = (toe_decode(np.arange(size, dtype=np.float64) / (size - 1)) + _HALF_STEP).tolist()
    head = _header("toe", "linear toe back to gamma 2.4") + [f"LUT_1D_SIZE {size}"]
    return "\n".join(head + [f"{x:.6f} {x:.6f} {x:.6f}" for x in v]) + "\n"


_lock = threading.Lock()
_luts: dict[str, Path] = {}
_private_dir: Path | None = None


def lut_dir() -> Path:
    """DEJAVIEW_HDR_DIR, else <tmp>/dejaview-hdr-<uid> when it is ours and private, else a per-process temp dir."""
    global _private_dir
    env = os.environ.get("DEJAVIEW_HDR_DIR")
    if env:
        d = Path(env)
        d.mkdir(parents=True, exist_ok=True)
        return d
    uid = os.getuid() if hasattr(os, "getuid") else None
    d = Path(tempfile.gettempdir()) / f"dejaview-hdr-{uid if uid is not None else 'user'}"
    try:
        d.mkdir(mode=0o700, exist_ok=True)
        st = os.lstat(d)
        if stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o022:
            return d
    except OSError:
        pass
    if _private_dir is None:
        _private_dir = Path(tempfile.mkdtemp(prefix="dejaview-hdr-"))
        atexit.register(shutil.rmtree, _private_dir, True)
    return _private_dir


def _written(name: str, make_text) -> Path:
    """lut_dir()/name with make_text() in it, written atomically once per process, then reused."""
    with _lock:
        p = _luts.get(name)
        if p is not None and p.exists():
            return p
        d = lut_dir()
        p = d / name
        fd, tmp = tempfile.mkstemp(dir=d, prefix=name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(make_text())
            os.replace(tmp, p)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        _luts[name] = p
        return p


def lut_file(transfer: str, primaries: str = "bt2020", size: int = LUT_SIZE) -> Path:
    """The 3D LUT file for this source."""
    return _written(f"{transfer}-{primaries}-{size}-v{LUT_VERSION}.cube", lambda: cube_text(transfer, primaries, size))


def toe_file() -> Path:
    """The 1D LUT file (the same for every source)."""
    return _written(f"toe-{TOE_SIZE}-v{LUT_VERSION}.cube", toe_text)


# ---- ffmpeg filters --------------------------------------------------------------------------------------------


def filter_path(p: Path | str) -> str:
    """A file path as a quoted ffmpeg filter option value."""
    s = str(p)
    if "'" in s or "\\" in s:
        raise ValueError(f"unsupported character in LUT path: {s}")
    return f"'{s}'"


def scale_options(src: HdrSource) -> str:
    """Extra `scale` options that turn the stream's YCbCr into full-range non-linear RGB."""
    return f":in_color_matrix={src.matrix}:in_range={src.range}"


def lut_filters(src: HdrSource, lut: Path | str | None = None, toe: Path | str | None = None) -> list[str]:
    """Filters after the `scale` (with scale_options); they end in SDR gbrp16le.

    The intermediate is planar gbrp16le on purpose: ffmpeg 8.1 converts yuv420p10le straight to packed rgb48le
    with wrong green and blue when the scale flags include area, accurate_rnd or full_chroma_int."""
    lut = lut or lut_file(src.transfer, src.primaries)
    toe = toe or toe_file()
    return ["format=gbrp16le", f"lut3d=file={filter_path(lut)}:interp=tetrahedral", f"lut1d=file={filter_path(toe)}"]


def rgb48_to_rgb24(buf: bytes, w: int, h: int) -> np.ndarray:
    """rgb48le bytes to an (h, w, 3) uint8 array, rounded to nearest (x / 257)."""
    x = np.frombuffer(buf, dtype="<u2").reshape(h, w, 3)
    return ((x.astype(np.uint32) + 128) // 257).astype(np.uint8)
