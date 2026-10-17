"""Gaussian splat I/O and geometry shared by the world runners (FlashWorld, AnySplat).

Everything here is numpy only, so it runs on the Mac, in tests and on HiPerGator alike:

- standard 3DGS PLY and SPZ (v1-v3) read/write,
- rotations and the WorldAsset transform (three.js order: world = position + quaternion * (scale * file)),
- floor/up estimation from splat centres and `place_world()`, which levels, scales and places a world so the
  floor is y = 0 and the input camera stands at x = z = 0,
- pruning to a splat budget, robust bounds,
- a CPU point renderer for thumbnails and depth maps, plus `render_gsplat()` (torch + gsplat, imported lazily).

Conventions: quaternions inside `Splats` are wxyz (gsplat order); transform quaternions are xyzw (three.js).
Camera poses are camera-to-world 4x4 matrices in the OpenGL convention (camera looks down -Z, +Y up).

CLI:
  python splat_io.py info  WORLD [--quaternion x,y,z,w] [--scale S] [--position x,y,z]
  python splat_io.py convert SRC DST [--sh-degree N] [--max-splats N]
  python splat_io.py render WORLD OUT.jpg [--width 640] [--fov 60] [--quaternion ...]
"""
from __future__ import annotations

import gzip
import json
import math
import os
import struct
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np

SH_C0 = 0.28209479177387814
SPZ_MAGIC = 0x5053474E
SPZ_COLOR_SCALE = 0.15
_SQRT1_2 = 0.7071067811865476


def sh_dim(degree: int) -> int:
    return (degree + 1) ** 2


def sh_degree_for_dim(k: int) -> int:
    d = int(round(math.sqrt(k))) - 1
    if (d + 1) ** 2 != k or d < 0:
        raise ValueError(f"{k} is not a valid SH coefficient count")
    return d


# --------------------------------------------------------------------------------------------------------------
# Splat container
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Splats:
    """A set of 3D Gaussians with activated parameters.

    means [N,3], scales [N,3] (linear, not log), quats [N,4] wxyz, opacities [N] in 0..1,
    sh_dc [N,3] (SH degree-0 coefficients), sh_rest [N,K-1,3] coefficient-major (or None for degree 0).
    """

    means: np.ndarray
    scales: np.ndarray
    quats: np.ndarray
    opacities: np.ndarray
    sh_dc: np.ndarray
    sh_rest: np.ndarray | None = None

    def __post_init__(self) -> None:
        self.means = np.ascontiguousarray(self.means, dtype=np.float32).reshape(-1, 3)
        n = self.means.shape[0]
        self.scales = np.ascontiguousarray(self.scales, dtype=np.float32).reshape(n, 3)
        self.quats = np.ascontiguousarray(self.quats, dtype=np.float32).reshape(n, 4)
        self.opacities = np.ascontiguousarray(self.opacities, dtype=np.float32).reshape(n)
        self.sh_dc = np.ascontiguousarray(self.sh_dc, dtype=np.float32).reshape(n, 3)
        if self.sh_rest is not None:
            r = np.asarray(self.sh_rest, dtype=np.float32)
            if r.size == 0:
                self.sh_rest = None
            else:
                r = r.reshape(n, -1, 3)
                sh_degree_for_dim(r.shape[1] + 1)
                self.sh_rest = np.ascontiguousarray(r)

    def __len__(self) -> int:
        return int(self.means.shape[0])

    @property
    def sh_degree(self) -> int:
        return 0 if self.sh_rest is None else sh_degree_for_dim(self.sh_rest.shape[1] + 1)

    def subset(self, idx: np.ndarray) -> "Splats":
        return Splats(
            self.means[idx],
            self.scales[idx],
            self.quats[idx],
            self.opacities[idx],
            self.sh_dc[idx],
            None if self.sh_rest is None else self.sh_rest[idx],
        )

    def with_sh_degree(self, degree: int | None) -> "Splats":
        if degree is None or degree >= self.sh_degree:
            return self
        if degree <= 0:
            return Splats(self.means, self.scales, self.quats, self.opacities, self.sh_dc, None)
        return Splats(self.means, self.scales, self.quats, self.opacities, self.sh_dc, self.sh_rest[:, : sh_dim(degree) - 1])

    def rgb(self) -> np.ndarray:
        """Base colour (view-independent) in 0..1."""
        return np.clip(0.5 + SH_C0 * self.sh_dc, 0.0, 1.0)

    def sh_all(self) -> np.ndarray:
        """[N, K, 3] SH coefficients including DC (gsplat's `colors` layout)."""
        if self.sh_rest is None:
            return self.sh_dc[:, None, :]
        return np.concatenate([self.sh_dc[:, None, :], self.sh_rest], axis=1)

    @staticmethod
    def from_rgb(means, rgb, scales, opacities=1.0, quats=None) -> "Splats":
        """Convenience constructor from plain colours (0..1). scales: scalar, [3], [N] or [N,3]."""
        means = np.asarray(means, np.float32).reshape(-1, 3)
        n = len(means)
        rgb = np.broadcast_to(np.asarray(rgb, np.float32), (n, 3))
        sc = np.asarray(scales, np.float32)
        if sc.ndim == 0 or sc.size == 3:
            sc = np.broadcast_to(sc.reshape(-1)[:3] if sc.ndim else sc, (n, 3))
        elif sc.ndim == 1 and sc.size == n:
            sc = np.repeat(sc[:, None], 3, axis=1)
        op = np.broadcast_to(np.asarray(opacities, np.float32), (n,))
        q = np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1)) if quats is None else quats
        return Splats(means, sc, q, op, (rgb - 0.5) / SH_C0, None)


def concat_splats(parts: Sequence[Splats]) -> Splats:
    deg = min(p.sh_degree for p in parts)
    parts = [p.with_sh_degree(deg) for p in parts]
    return Splats(
        np.concatenate([p.means for p in parts]),
        np.concatenate([p.scales for p in parts]),
        np.concatenate([p.quats for p in parts]),
        np.concatenate([p.opacities for p in parts]),
        np.concatenate([p.sh_dc for p in parts]),
        None if deg == 0 else np.concatenate([p.sh_rest for p in parts]),
    )


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return (1.0 / (1.0 + np.exp(-np.clip(x, -60, 60)))).astype(np.float32)


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p.astype(np.float64), 1e-7, 1 - 1e-7)
    return np.log(p / (1 - p)).astype(np.float32)


def _normalize_rows(q: np.ndarray, fallback: Sequence[float]) -> np.ndarray:
    n = np.linalg.norm(q, axis=1, keepdims=True)
    bad = ~np.isfinite(n[:, 0]) | (n[:, 0] < 1e-12)
    out = q / np.where(bad[:, None], 1.0, n)
    if bad.any():
        out[bad] = np.asarray(fallback, np.float32)
    return out.astype(np.float32)


def _atomic_write_bytes(path: Path | str, chunks: Iterable[bytes]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            for c in chunks:
                f.write(c)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


# --------------------------------------------------------------------------------------------------------------
# PLY
# --------------------------------------------------------------------------------------------------------------

_PLY_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
    "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
}


def _read_ply_vertices(path: Path | str) -> np.ndarray:
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError(f"{path}: not a PLY file")
        fmt = None
        elements: list[tuple[str, int, list[tuple[str, str]]]] = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError(f"{path}: truncated PLY header")
            parts = line.decode("ascii", "replace").split()
            if not parts:
                continue
            if parts[0] == "format":
                fmt = parts[1]
            elif parts[0] == "element":
                elements.append((parts[1], int(parts[2]), []))
            elif parts[0] == "property":
                if parts[1] == "list":
                    elements[-1][2].append((parts[-1], "list"))
                else:
                    if parts[1] not in _PLY_TYPES:
                        raise ValueError(f"{path}: unsupported PLY type {parts[1]}")
                    elements[-1][2].append((parts[2], _PLY_TYPES[parts[1]]))
            elif parts[0] == "end_header":
                break
        if fmt not in ("binary_little_endian", "binary_big_endian"):
            raise ValueError(f"{path}: only binary PLY is supported (got {fmt})")
        endian = "<" if fmt == "binary_little_endian" else ">"
        for name, count, props in elements:
            if any(t == "list" for _, t in props):
                raise ValueError(f"{path}: list properties are not supported in element {name}")
            dt = np.dtype([(pn, endian + pt) for pn, pt in props])
            if name == "vertex":
                data = np.frombuffer(f.read(dt.itemsize * count), dtype=dt, count=count)
                return data
            f.seek(dt.itemsize * count, os.SEEK_CUR)
    raise ValueError(f"{path}: no vertex element")


def read_ply(path: Path | str) -> Splats:
    v = _read_ply_vertices(path)
    names = set(v.dtype.names or ())
    n = len(v)

    def col(name: str) -> np.ndarray:
        return v[name].astype(np.float32)

    means = np.stack([col("x"), col("y"), col("z")], axis=1)
    sh_rest = None
    if "f_dc_0" in names:
        n_dc = sum(1 for k in names if k.startswith("f_dc_"))
        if n_dc > 3:
            # Non-standard layout (upstream FlashWorld): every SH coefficient in f_dc_*, coefficient-major.
            allc = np.stack([col(f"f_dc_{i}") for i in range(n_dc)], axis=1).reshape(n, -1, 3)
            sh_dc, sh_rest = allc[:, 0], (allc[:, 1:] if allc.shape[1] > 1 else None)
        else:
            sh_dc = np.stack([col(f"f_dc_{i}") for i in range(3)], axis=1)
            n_rest = sum(1 for k in names if k.startswith("f_rest_"))
            if n_rest:
                rest = np.stack([col(f"f_rest_{i}") for i in range(n_rest)], axis=1)
                kk = n_rest // 3
                sh_rest = rest.reshape(n, 3, kk).transpose(0, 2, 1)
    elif "red" in names:
        rgb = np.stack([col("red"), col("green"), col("blue")], axis=1)
        if v["red"].dtype.kind == "u":
            rgb = rgb / 255.0
        sh_dc = (rgb - 0.5) / SH_C0
    else:
        sh_dc = np.zeros((n, 3), np.float32)
    opac = _sigmoid(col("opacity")) if "opacity" in names else np.ones(n, np.float32)
    if "scale_0" in names:
        scales = np.exp(np.stack([col(f"scale_{i}") for i in range(3)], axis=1))
    else:
        scales = np.full((n, 3), 0.01, np.float32)
    if "rot_0" in names:
        quats = _normalize_rows(np.stack([col(f"rot_{i}") for i in range(4)], axis=1), (1, 0, 0, 0))
    else:
        quats = np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1))
    return Splats(means, scales, quats, opac, sh_dc, sh_rest)


def write_ply(path: Path | str, s: Splats, sh_degree: int | None = None, normals: bool = False) -> None:
    """Standard 3DGS PLY: x y z [nx ny nz] f_dc_0..2 f_rest_* opacity scale_0..2 rot_0..3 (float32, LE)."""
    s = s.with_sh_degree(sh_degree)
    n = len(s)
    cols: list[np.ndarray] = [s.means]
    names = ["x", "y", "z"]
    if normals:
        cols.append(np.zeros((n, 3), np.float32))
        names += ["nx", "ny", "nz"]
    cols.append(s.sh_dc)
    names += [f"f_dc_{i}" for i in range(3)]
    if s.sh_rest is not None:
        rest = s.sh_rest.transpose(0, 2, 1).reshape(n, -1)
        cols.append(rest)
        names += [f"f_rest_{i}" for i in range(rest.shape[1])]
    cols.append(_logit(s.opacities)[:, None])
    names.append("opacity")
    cols.append(np.log(np.maximum(s.scales, 1e-12)).astype(np.float32))
    names += [f"scale_{i}" for i in range(3)]
    cols.append(_normalize_rows(s.quats, (1, 0, 0, 0)))
    names += [f"rot_{i}" for i in range(4)]
    arr = np.ascontiguousarray(np.concatenate(cols, axis=1).astype("<f4"))
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n"
    header += "".join(f"property float {nm}\n" for nm in names) + "end_header\n"
    _atomic_write_bytes(path, [header.encode("ascii"), arr.tobytes()])


# --------------------------------------------------------------------------------------------------------------
# SPZ (gzipped; header + positions, alphas, colors, scales, rotations, sh)
# --------------------------------------------------------------------------------------------------------------


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def _quantize_sh(x: np.ndarray, bucket: int) -> np.ndarray:
    q = np.round(x.astype(np.float64) * 128.0).astype(np.int64) + 128
    q = (q + bucket // 2) // bucket * bucket
    return np.clip(q, 0, 255).astype(np.uint8)


def _pack_rot_v3(q_xyzw: np.ndarray) -> np.ndarray:
    q = _normalize_rows(q_xyzw, (0, 0, 0, 1)).astype(np.float64)
    n = q.shape[0]
    il = np.argmax(np.abs(q), axis=1)
    neg = q[np.arange(n), il] < 0
    comp = il.astype(np.uint32)
    for i in range(4):
        skip = il == i
        negbit = ((q[:, i] < 0) ^ neg).astype(np.uint32)
        mag = np.clip(np.floor(511.0 * (np.abs(q[:, i]) / _SQRT1_2) + 0.5), 0, 511).astype(np.uint32)
        packed = (comp << np.uint32(10)) | (negbit << np.uint32(9)) | mag
        comp = np.where(skip, comp, packed)
    return comp.astype("<u4").view(np.uint8).reshape(n, 4)


def _unpack_rot_v3(b: np.ndarray) -> np.ndarray:
    n = b.shape[0]
    comp = np.ascontiguousarray(b.reshape(n, 4)).view("<u4").reshape(n).astype(np.uint32)
    il = (comp >> np.uint32(30)).astype(np.int64)
    q = np.zeros((n, 4), np.float64)
    for i in (3, 2, 1, 0):
        active = il != i
        mag = (comp & np.uint32(511)).astype(np.float64)
        negbit = (comp >> np.uint32(9)) & np.uint32(1)
        val = _SQRT1_2 * mag / 511.0
        val = np.where(negbit == 1, -val, val)
        q[:, i] = np.where(active, val, 0.0)
        comp = np.where(active, comp >> np.uint32(10), comp)
    q[np.arange(n), il] = np.sqrt(np.maximum(0.0, 1.0 - np.sum(q * q, axis=1)))
    return q.astype(np.float32)


def write_spz(
    path: Path | str,
    s: Splats,
    sh_degree: int | None = None,
    version: int = 3,
    fractional_bits: int = 12,
    antialiased: bool = False,
    compresslevel: int = 6,
) -> None:
    """Writes SPZ v2 or v3. Positions are stored as-is (no axis conversion), like the upstream exporters."""
    if version not in (2, 3):
        raise ValueError("version must be 2 or 3")
    s = s.with_sh_degree(sh_degree)
    s = s.with_sh_degree(min(s.sh_degree, 3))
    n = len(s)
    deg = s.sh_degree
    header = struct.pack("<IIIBBBB", SPZ_MAGIC, version, n, deg, fractional_bits, 1 if antialiased else 0, 0)
    lim = (1 << 23) - 1
    fixed = np.clip(np.round(s.means.astype(np.float64) * (1 << fractional_bits)), -lim - 1, lim).astype(np.int64)
    fixed = (fixed & 0xFFFFFF).astype(np.uint32).reshape(-1)
    pos = np.stack([(fixed & 0xFF), (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=1).astype(np.uint8)
    alphas = _u8(s.opacities * 255.0)
    colors = _u8(s.sh_dc * (SPZ_COLOR_SCALE * 255.0) + 0.5 * 255.0)
    scales = _u8((np.log(np.maximum(s.scales, 1e-30)) + 10.0) * 16.0)
    q_xyzw = s.quats[:, [1, 2, 3, 0]]
    if version == 3:
        rots = _pack_rot_v3(q_xyzw)
    else:
        q = _normalize_rows(q_xyzw, (0, 0, 0, 1))
        q = np.where(q[:, 3:4] < 0, -q, q)
        rots = _u8(q[:, :3] * 127.5 + 127.5)
    chunks = [header, pos.tobytes(), alphas.tobytes(), colors.tobytes(), scales.tobytes(), rots.tobytes()]
    if deg > 0:
        flat = s.sh_rest.reshape(n, -1)
        sh = np.empty(flat.shape, np.uint8)
        k1 = min(9, flat.shape[1])
        sh[:, :k1] = _quantize_sh(flat[:, :k1], 1 << (8 - 5))
        if flat.shape[1] > 9:
            sh[:, 9:] = _quantize_sh(flat[:, 9:], 1 << (8 - 4))
        chunks.append(sh.tobytes())
    raw = b"".join(chunks)
    _atomic_write_bytes(path, [gzip.compress(raw, compresslevel=compresslevel, mtime=0)])


def read_spz_header(path: Path | str) -> dict:
    with gzip.open(path, "rb") as f:
        h = f.read(16)
    magic, version, n, deg, fb, flags, _ = struct.unpack("<IIIBBBB", h)
    if magic != SPZ_MAGIC:
        raise ValueError(f"{path}: not an SPZ file")
    return {"version": version, "numPoints": n, "shDegree": deg, "fractionalBits": fb, "antialiased": bool(flags & 1)}


def read_spz(path: Path | str) -> Splats:
    with gzip.open(path, "rb") as f:
        raw = f.read()
    magic, version, n, deg, fb, flags, _ = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != SPZ_MAGIC:
        raise ValueError(f"{path}: not an SPZ file")
    if version not in (1, 2, 3):
        raise ValueError(f"{path}: unsupported SPZ version {version}")
    off = 16
    buf = np.frombuffer(raw, np.uint8)

    def take(nbytes: int) -> np.ndarray:
        nonlocal off
        out = buf[off : off + nbytes]
        if out.size != nbytes:
            raise ValueError(f"{path}: truncated SPZ data")
        off += nbytes
        return out

    if version == 1:
        means = take(n * 6).view("<f2").astype(np.float32).reshape(n, 3)
    else:
        b = take(n * 9).reshape(n * 3, 3).astype(np.int64)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - (1 << 24), v)
        means = (v.astype(np.float64) / (1 << fb)).astype(np.float32).reshape(n, 3)
    alphas = take(n).astype(np.float32) / 255.0
    colors = ((take(n * 3).astype(np.float32).reshape(n, 3) / 255.0) - 0.5) / SPZ_COLOR_SCALE
    scales = np.exp(take(n * 3).astype(np.float32).reshape(n, 3) / 16.0 - 10.0)
    if version >= 3:
        q_xyzw = _unpack_rot_v3(take(n * 4).reshape(n, 4))
    else:
        xyz = take(n * 3).astype(np.float32).reshape(n, 3) / 127.5 - 1.0
        w = np.sqrt(np.maximum(0.0, 1.0 - np.sum(xyz * xyz, axis=1)))
        q_xyzw = np.concatenate([xyz, w[:, None]], axis=1)
    sh_rest = None
    if deg > 0:
        k = sh_dim(deg) - 1
        sh_rest = ((take(n * k * 3).astype(np.float32) - 128.0) / 128.0).reshape(n, k, 3)
    quats = _normalize_rows(q_xyzw[:, [3, 0, 1, 2]], (1, 0, 0, 0))
    return Splats(means, scales, quats, alphas, colors, sh_rest)


def read_splats(path: Path | str) -> Splats:
    path = Path(path)
    with open(path, "rb") as f:
        head = f.read(4)
    if head[:3] == b"ply":
        return read_ply(path)
    if head[:2] == b"\x1f\x8b":
        return read_spz(path)
    raise ValueError(f"{path}: unknown splat format (expected .ply or .spz)")


def write_splats(path: Path | str, s: Splats, sh_degree: int | None = None) -> None:
    if str(path).lower().endswith(".ply"):
        write_ply(path, s, sh_degree)
    else:
        write_spz(path, s, sh_degree)


def ply_to_spz(src: Path | str, dst: Path | str, sh_degree: int | None = None) -> int:
    """Converts a PLY to SPZ with the pure-numpy writer (no `spz` package needed). Returns the splat count."""
    s = read_ply(src)
    write_spz(dst, s, sh_degree)
    return len(s)


# --------------------------------------------------------------------------------------------------------------
# Rotations and transforms
# --------------------------------------------------------------------------------------------------------------


def quat_xyzw_to_matrix(q: Sequence[float]) -> np.ndarray:
    x, y, z, w = np.asarray(q, np.float64) / max(np.linalg.norm(q), 1e-12)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def quat_wxyz_to_matrix(q: Sequence[float]) -> np.ndarray:
    w, x, y, z = q
    return quat_xyzw_to_matrix([x, y, z, w])


def matrix_to_quat_xyzw(m: np.ndarray) -> list[float]:
    m = np.asarray(m, np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w, x, y, z = (m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w, x, y, z = (m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w, x, y, z = (m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    return [float(round(c, 9)) + 0.0 for c in q]


def matrix_to_quat_wxyz(m: np.ndarray) -> list[float]:
    x, y, z, w = matrix_to_quat_xyzw(m)
    return [w, x, y, z]


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float64)


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], np.float64)


def rotation_between(a: Sequence[float], b: Sequence[float]) -> np.ndarray:
    """Smallest rotation taking direction a onto direction b."""
    a = np.asarray(a, np.float64) / np.linalg.norm(a)
    b = np.asarray(b, np.float64) / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -1 + 1e-9:
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def yaw_of_forward(f: Sequence[float]) -> float:
    """Yaw about +Y (radians) of a forward vector; 0 = looking down -Z, positive = turned left."""
    return float(math.atan2(-f[0], -f[2]))


def transform_dict(R: np.ndarray, t: Sequence[float], s: float) -> dict:
    return {"position": [round(float(v), 6) + 0.0 for v in t], "quaternion": matrix_to_quat_xyzw(R), "scale": round(float(s), 6)}


def transform_parts(transform: dict) -> tuple[np.ndarray, np.ndarray, float]:
    R = quat_xyzw_to_matrix(transform.get("quaternion", [0, 0, 0, 1]))
    t = np.asarray(transform.get("position", [0, 0, 0]), np.float64)
    s = float(transform.get("scale", 1.0))
    return R, t, s


def apply_transform(points: np.ndarray, transform: dict) -> np.ndarray:
    R, t, s = transform_parts(transform)
    return (np.asarray(points, np.float64) * s) @ R.T + t


def quat_wxyz_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product a * b for [..., 4] wxyz arrays."""
    aw, ax, ay, az = np.moveaxis(np.asarray(a, np.float64), -1, 0)
    bw, bx, by, bz = np.moveaxis(np.asarray(b, np.float64), -1, 0)
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        axis=-1,
    )


def transform_splats(s: Splats, R: np.ndarray, t: Sequence[float] = (0, 0, 0), scale: float = 1.0) -> Splats:
    """Bakes x -> scale * R x + t into positions, orientations and sizes. SH coefficients above degree 0 are not
    rotated, so view-dependent colour is only exact for R = identity."""
    q = np.asarray(matrix_to_quat_wxyz(R), np.float64)
    quats = quat_wxyz_multiply(np.broadcast_to(q, s.quats.shape), s.quats.astype(np.float64))
    return Splats(
        (s.means.astype(np.float64) * scale) @ np.asarray(R).T + np.asarray(t, np.float64),
        s.scales * scale,
        _normalize_rows(quats.astype(np.float32), (1, 0, 0, 0)),
        s.opacities,
        s.sh_dc,
        s.sh_rest,
    )


def c2w_cv_to_gl(c2w: np.ndarray) -> np.ndarray:
    """OpenCV camera (x right, y down, z forward) to OpenGL camera (x right, y up, looks down -z)."""
    out = np.array(c2w, np.float64, copy=True)
    out[:3, 1] *= -1
    out[:3, 2] *= -1
    return out


def c2w_gl_to_cv_w2c(c2w_gl: np.ndarray) -> np.ndarray:
    """OpenGL camera-to-world -> OpenCV world-to-camera (what gsplat's viewmats expect)."""
    return np.linalg.inv(c2w_cv_to_gl(c2w_gl))


def pose_matrix(R: np.ndarray, t: Sequence[float]) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = t
    return m


# --------------------------------------------------------------------------------------------------------------
# Floor, placement, bounds, pruning
# --------------------------------------------------------------------------------------------------------------


@dataclass
class FloorFit:
    found: bool
    normal: np.ndarray = field(default_factory=lambda: np.array([0.0, 1.0, 0.0]))
    offset: float = 0.0
    camera_height: float = 0.0
    tilt_deg: float = 0.0
    support: float = 0.0
    below: float = 0.0
    inliers: int = 0
    reason: str = ""

    def to_json(self) -> dict:
        return {
            "found": bool(self.found),
            "normal": [round(float(v), 6) for v in self.normal],
            "offset": round(float(self.offset), 6),
            "cameraHeight": round(float(self.camera_height), 6),
            "tiltDeg": round(float(self.tilt_deg), 3),
            "support": round(float(self.support), 4),
            "below": round(float(self.below), 4),
            "inliers": int(self.inliers),
            "reason": self.reason,
        }


def _plane_lstsq(pts: np.ndarray, up: np.ndarray) -> tuple[np.ndarray, float]:
    c = pts.mean(axis=0)
    _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
    n = vt[-1]
    if np.dot(n, up) < 0:
        n = -n
    return n, -float(np.dot(n, c))


def estimate_floor(
    points: np.ndarray,
    opacities: np.ndarray | None = None,
    camera: Sequence[float] = (0.0, 0.0, 0.0),
    up: Sequence[float] = (0.0, 1.0, 0.0),
    max_tilt_deg: float = 35.0,
    min_opacity: float = 0.35,
    max_points: int = 200_000,
    iters: int = 600,
    seed: int = 0,
) -> FloorFit:
    """Finds the floor: the lowest large plane under the camera, with its normal near `up`.

    RANSAC on opaque splat centres below the camera, scored as inliers minus a heavy penalty for points
    below the plane (so a table top loses to the floor under it), refined by least squares.
    `camera_height` is the camera's distance above the plane, in the input units.
    """
    rng = np.random.default_rng(seed)
    P = np.asarray(points, np.float64)
    keep = np.all(np.isfinite(P), axis=1)
    if opacities is not None:
        keep &= np.asarray(opacities) >= min_opacity
    P = P[keep]
    if len(P) < 500:
        return FloorFit(False, reason=f"only {len(P)} opaque splats")
    if len(P) > max_points:
        P = P[rng.choice(len(P), max_points, replace=False)]
    cam = np.asarray(camera, np.float64)
    u = np.asarray(up, np.float64)
    u /= np.linalg.norm(u)
    rel = P - cam
    dist = np.linalg.norm(rel, axis=1)
    med = float(np.median(dist))
    if not med > 0:
        return FloorFit(False, reason="degenerate point cloud")
    rel = rel[dist < 25 * med]
    hgt = rel @ u
    cand = rel[hgt < -0.12 * med]
    if len(cand) < 300:
        return FloorFit(False, reason="almost nothing below the camera")
    pool = cand[np.argsort(cand @ u)[: max(300, int(0.35 * len(cand)))]]
    ev = rel if len(rel) <= 40_000 else rel[rng.choice(len(rel), 40_000, replace=False)]
    thr = 0.02 * med
    cos_tilt = math.cos(math.radians(max_tilt_deg))
    best = None
    best_score = -np.inf
    tri = rng.integers(0, len(pool), size=(iters, 3))
    for a, b, c in tri:
        n = np.cross(pool[b] - pool[a], pool[c] - pool[a])
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n /= nn
        if np.dot(n, u) < 0:
            n = -n
        if np.dot(n, u) < cos_tilt:
            continue
        d = -float(np.dot(n, pool[a]))
        if d < 0.1 * med:
            continue
        sd = ev @ n + d
        score = np.count_nonzero(np.abs(sd) < thr) - 4.0 * np.count_nonzero(sd < -2.5 * thr)
        if score > best_score:
            best_score, best = score, (n, d)
    if best is None:
        return FloorFit(False, reason="no plane within the tilt limit")
    n, d = best
    for _ in range(3):
        sd = rel @ n + d
        inl = np.abs(sd) < thr
        if np.count_nonzero(inl) < 50:
            break
        n, d = _plane_lstsq(rel[inl], u)
    sd = rel @ n + d
    inl = int(np.count_nonzero(np.abs(sd) < thr))
    support = inl / len(rel)
    below = float(np.count_nonzero(sd < -2.5 * thr)) / len(rel)
    tilt = math.degrees(math.acos(min(1.0, max(-1.0, float(np.dot(n, u))))))
    cam_h = d
    # The plane was fitted relative to the camera; offset is for the input frame (n.x + offset = 0).
    fit = FloorFit(False, n, d - float(np.dot(n, cam)), cam_h, tilt, support, below, inl)
    if tilt > max_tilt_deg:
        fit.reason = f"plane tilt {tilt:.1f} deg exceeds {max_tilt_deg}"
    elif cam_h < 0.1 * med:
        fit.reason = "camera is not above the plane"
    elif support < 0.02 or inl < 300:
        fit.reason = f"weak support ({support:.3f}, {inl} splats)"
    elif below > 0.08:
        fit.reason = f"too much below the plane ({below:.3f})"
    else:
        fit.found = True
        fit.reason = "ok"
    return fit


def robust_bounds(points: np.ndarray, lo: float = 0.5, hi: float = 99.5) -> dict:
    p = np.asarray(points, np.float64)
    p = p[np.all(np.isfinite(p), axis=1)]
    if len(p) == 0:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    a = np.percentile(p, lo, axis=0)
    b = np.percentile(p, hi, axis=0)
    return {"min": [round(float(v), 4) for v in a], "max": [round(float(v), 4) for v in b]}


def place_world(
    means: np.ndarray,
    opacities: np.ndarray | None,
    camera_c2w_gl: np.ndarray | None = None,
    camera_height: float = 1.45,
    scale_limits: tuple[float, float] = (0.3, 3.0),
    fallback_scale: float | None = 1.0,
    fallback_median_distance: float = 2.5,
    max_tilt_deg: float = 35.0,
    seed: int = 0,
) -> dict:
    """Computes the WorldAsset placement for a splat set whose input camera pose (in the file frame) is known.

    The result puts the floor at y = 0 (when found), the input camera at (0, eye, 0) looking where it looked
    (levelled), and scales the world so the camera stands `camera_height` above the floor.
    `fallback_scale=None` means: without a floor, scale so the median camera-to-splat distance is
    `fallback_median_distance` (for sources with arbitrary units).
    Returns {transform, floorY, spawn, bounds, camera: {position, quaternion}, floor, scale, cameraHeightFile}.
    """
    cam = np.eye(4) if camera_c2w_gl is None else np.asarray(camera_c2w_gl, np.float64)
    R0, c0 = cam[:3, :3], cam[:3, 3]
    P = np.asarray(means, np.float64)
    Pb = (P - c0) @ R0  # camera-aligned frame: camera at the origin, looking down -Z
    fit = estimate_floor(Pb, opacities, camera=(0, 0, 0), up=(0, 1, 0), max_tilt_deg=max_tilt_deg, seed=seed)
    if fit.found:
        R_l = rotation_between(fit.normal, [0.0, 1.0, 0.0])
        h = float(fit.camera_height)
        s_raw = camera_height / h
        s = float(np.clip(s_raw, *scale_limits))
        cam_y = s * h
        floor_y: float | None = 0.0
    else:
        R_l = np.eye(3)
        h = None
        if fallback_scale is None:
            ok = np.all(np.isfinite(Pb), axis=1)
            if opacities is not None:
                ok &= np.asarray(opacities) >= 0.35
            med = float(np.median(np.linalg.norm(Pb[ok], axis=1))) if ok.any() else 1.0
            s_raw = fallback_median_distance / max(med, 1e-9)
        else:
            s_raw = float(fallback_scale)
        s = s_raw
        cam_y = camera_height
        floor_y = None
    R = R_l @ R0.T
    t = np.array([0.0, cam_y, 0.0]) - s * (R @ c0)
    transform = transform_dict(R, t, s)
    world = (P * s) @ R.T + t
    opaque = np.ones(len(P), bool) if opacities is None else np.asarray(opacities) >= 0.35
    bounds = robust_bounds(world[opaque] if opaque.any() else world)
    R_cam = R @ R0
    fwd = R_cam @ np.array([0.0, 0.0, -1.0])
    yaw = yaw_of_forward(fwd)
    return {
        "transform": transform,
        "floorY": floor_y,
        "spawn": {"position": [0.0, 0.0, 0.0], "yaw": round(yaw, 6)},
        "bounds": bounds,
        "camera": {"position": [0.0, round(cam_y, 6), 0.0], "quaternion": matrix_to_quat_xyzw(R_cam)},
        "floor": fit.to_json(),
        "scale": s,
        "scaleRaw": s_raw,
        "cameraHeightFile": h,
    }


def prune_indices(
    s: Splats,
    max_count: int | None = 1_000_000,
    min_opacity: float = 0.005,
    cameras: np.ndarray | None = None,
    far_factor: float = 60.0,
    max_angular_size: float = 0.6,
) -> np.ndarray:
    """Indices of the splats to keep, sorted. Drops broken, transparent, far and huge splats, then keeps the
    `max_count` with the largest footprint as seen from the nearest camera (opacity * sqrt(s1 s2) / distance)."""
    m = s.means.astype(np.float64)
    ok = np.all(np.isfinite(m), axis=1) & np.all(np.isfinite(s.scales), axis=1)
    ok &= np.all(np.isfinite(s.quats), axis=1) & np.isfinite(s.opacities) & (s.opacities >= min_opacity)
    cams = np.zeros((1, 3)) if cameras is None or len(cameras) == 0 else np.asarray(cameras, np.float64).reshape(-1, 3)
    d = np.full(len(m), np.inf)
    for c in cams:
        d = np.minimum(d, np.linalg.norm(m - c, axis=1))
    d = np.where(np.isfinite(d), d, np.inf)
    if ok.any():
        med = float(np.median(d[ok]))
        ok &= d < far_factor * max(med, 1e-9)
    else:
        med = 1.0
    sc = np.sort(s.scales.astype(np.float64), axis=1)
    ok &= sc[:, 2] < max_angular_size * np.maximum(d, 1e-9)
    idx = np.nonzero(ok)[0]
    if max_count is not None and len(idx) > max_count:
        foot = np.sqrt(sc[idx, 2] * sc[idx, 1])
        imp = s.opacities[idx] * foot / np.maximum(d[idx], 0.05 * med)
        top = np.argpartition(-imp, max_count - 1)[:max_count]
        idx = idx[top]
    return np.sort(idx)


# --------------------------------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------------------------------


@dataclass
class Render:
    rgb: np.ndarray  # [H,W,3] uint8
    depth: np.ndarray  # [H,W] float32, z-depth; 0 = no data
    alpha: np.ndarray  # [H,W] float32 0..1
    backend: str


def _disc_offsets(r: int) -> np.ndarray:
    ys, xs = np.mgrid[-r : r + 1, -r : r + 1]
    keep = xs * xs + ys * ys <= r * r + 0.5
    return np.stack([xs[keep], ys[keep]], axis=1)


def _fill_holes(img: np.ndarray, valid: np.ndarray, iters: int = 2) -> tuple[np.ndarray, np.ndarray]:
    img = img.copy()
    valid = valid.copy()
    h, w = valid.shape
    for _ in range(iters):
        if valid.all():
            break
        acc = np.zeros(img.shape, np.float64)
        cnt = np.zeros((h, w), np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sv = np.zeros_like(valid)
                si = np.zeros_like(img)
                ys = slice(max(dy, 0), h + min(dy, 0))
                yd = slice(max(-dy, 0), h + min(-dy, 0))
                xs = slice(max(dx, 0), w + min(dx, 0))
                xd = slice(max(-dx, 0), w + min(-dx, 0))
                sv[yd, xd] = valid[ys, xs]
                si[yd, xd] = img[ys, xs]
                if img.ndim == 3:
                    acc += si * sv[..., None]
                else:
                    acc += si * sv
                cnt += sv
        fill = (~valid) & (cnt >= 3)
        if not fill.any():
            break
        if img.ndim == 3:
            img[fill] = (acc[fill] / cnt[fill][:, None]).astype(img.dtype)
        else:
            img[fill] = (acc[fill] / cnt[fill]).astype(img.dtype)
        valid = valid | fill
    return img, valid


def render_points(
    s: Splats,
    c2w_gl: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    width: int,
    height: int,
    min_opacity: float = 0.3,
    max_radius: int = 6,
    background: Sequence[float] = (0.0, 0.0, 0.0),
    fill_holes: bool = True,
) -> Render:
    """CPU z-buffer splatting of Gaussian centres as discs (radius from the projected scale).

    Good enough for gallery thumbnails and for depth maps used in alignment; the GPU path is render_gsplat()."""
    w2c = np.linalg.inv(np.asarray(c2w_gl, np.float64))
    pc = s.means.astype(np.float64) @ w2c[:3, :3].T + w2c[:3, 3]
    z = -pc[:, 2]
    ok = (z > 1e-3) & (s.opacities >= min_opacity) & np.all(np.isfinite(pc), axis=1)
    idx = np.nonzero(ok)[0]
    rgb_img = np.zeros((height, width, 3), np.float32) + np.asarray(background, np.float32)
    depth = np.zeros((height, width), np.float32)
    alpha = np.zeros((height, width), np.float32)
    if len(idx) == 0:
        return Render((rgb_img * 255).astype(np.uint8), depth, alpha, "points")
    zi = z[idx]
    u = cx + fx * pc[idx, 0] / zi
    v = cy - fy * pc[idx, 1] / zi
    sc = np.sort(s.scales[idx].astype(np.float64), axis=1)
    rad = np.clip(np.round(1.3 * fx * np.sqrt(sc[:, 2] * sc[:, 1]) / zi), 0, max_radius).astype(np.int64)
    inview = (u > -max_radius) & (u < width + max_radius) & (v > -max_radius) & (v < height + max_radius)
    idx, zi, u, v, rad = idx[inview], zi[inview], u[inview], v[inview], rad[inview]
    ui = np.floor(u).astype(np.int64)
    vi = np.floor(v).astype(np.int64)
    pix_l, z_l, src_l = [], [], []
    for r in range(max_radius + 1):
        sel = np.nonzero(rad == r)[0]
        if len(sel) == 0:
            continue
        off = _disc_offsets(r)
        px = (ui[sel, None] + off[None, :, 0]).reshape(-1)
        py = (vi[sel, None] + off[None, :, 1]).reshape(-1)
        good = (px >= 0) & (px < width) & (py >= 0) & (py < height)
        pix_l.append((py * width + px)[good])
        z_l.append(np.repeat(zi[sel], len(off))[good])
        src_l.append(np.repeat(idx[sel], len(off))[good])
    pix = np.concatenate(pix_l)
    zz = np.concatenate(z_l)
    src = np.concatenate(src_l)
    order = np.lexsort((zz, pix))
    pix_s = pix[order]
    first = np.ones(len(pix_s), bool)
    first[1:] = pix_s[1:] != pix_s[:-1]
    win = order[first]
    flat_rgb = rgb_img.reshape(-1, 3)
    flat_rgb[pix[win]] = s.rgb()[src[win]]
    depth.reshape(-1)[pix[win]] = zz[win]
    alpha.reshape(-1)[pix[win]] = 1.0
    if fill_holes:
        valid = alpha > 0
        rgb_img, _ = _fill_holes(rgb_img, valid, 2)
        depth, v2 = _fill_holes(depth, valid, 2)
        alpha = v2.astype(np.float32)
    return Render(np.clip(rgb_img * 255 + 0.5, 0, 255).astype(np.uint8), depth.astype(np.float32), alpha, "points")


def gsplat_available() -> bool:
    try:
        import torch  # noqa: F401
        import gsplat  # noqa: F401

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def render_gsplat(
    s: Splats,
    c2w_gl: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    width: int,
    height: int,
    background: Sequence[float] = (0.0, 0.0, 0.0),
    device: str = "cuda",
    tensors: dict | None = None,
) -> Render:
    """Rasterises with gsplat (RGB + expected depth). `tensors` can carry cached device tensors between calls."""
    import torch
    from gsplat import rasterization

    t = tensors if tensors is not None else {}
    if "means" not in t:
        t["means"] = torch.from_numpy(s.means).to(device)
        t["quats"] = torch.from_numpy(s.quats).to(device)
        t["scales"] = torch.from_numpy(s.scales).to(device)
        t["opac"] = torch.from_numpy(s.opacities).to(device)
        t["sh"] = torch.from_numpy(np.ascontiguousarray(s.sh_all())).to(device)
    viewmat = torch.from_numpy(c2w_gl_to_cv_w2c(c2w_gl).astype(np.float32)).to(device)[None]
    K = torch.tensor([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=torch.float32, device=device)[None]
    bg = torch.tensor(list(background), dtype=torch.float32, device=device)[None]
    with torch.no_grad():
        out, alpha, _ = rasterization(
            t["means"], t["quats"], t["scales"], t["opac"], t["sh"], viewmat, K, int(width), int(height),
            sh_degree=s.sh_degree, render_mode="RGB+ED", near_plane=0.01, far_plane=1e4, backgrounds=bg,
        )
    rgb = (out[0, ..., :3].clamp(0, 1) * 255 + 0.5).byte().cpu().numpy()
    depth = out[0, ..., 3].float().cpu().numpy()
    a = alpha[0, ..., 0].float().cpu().numpy()
    depth = np.where(a >= 0.5, depth, 0.0).astype(np.float32)
    return Render(rgb, depth, a.astype(np.float32), "gsplat")


def render(s: Splats, c2w_gl: np.ndarray, fx, fy, cx, cy, width, height, prefer_gpu: bool = True, **kw) -> Render:
    if prefer_gpu and gsplat_available():
        try:
            return render_gsplat(s, c2w_gl, fx, fy, cx, cy, width, height, **kw)
        except Exception as e:  # fall back to the CPU renderer rather than failing the job
            print(f"[splat_io] gsplat render failed ({e}); using the CPU renderer", file=sys.stderr)
    kw.pop("tensors", None)
    kw.pop("device", None)
    return render_points(s, c2w_gl, fx, fy, cx, cy, width, height, **kw)


def save_jpeg(path: Path | str, rgb: np.ndarray, quality: int = 88) -> None:
    from PIL import Image

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    Image.fromarray(np.asarray(rgb, np.uint8)).save(tmp, format="JPEG", quality=quality, optimize=True)
    os.replace(tmp, path)


def contact_sheet(images: Sequence[np.ndarray], cols: int = 4, pad: int = 4) -> np.ndarray:
    h = max(i.shape[0] for i in images)
    w = max(i.shape[1] for i in images)
    rows = (len(images) + cols - 1) // cols
    sheet = np.full((rows * (h + pad) + pad, cols * (w + pad) + pad, 3), 24, np.uint8)
    for k, img in enumerate(images):
        r, c = divmod(k, cols)
        y, x = pad + r * (h + pad), pad + c * (w + pad)
        sheet[y : y + img.shape[0], x : x + img.shape[1]] = img
    return sheet


def viewer_camera_in_file(transform: dict, c2w_viewer: np.ndarray) -> np.ndarray:
    """A camera pose given in the viewer frame, expressed in the splat file's frame (rotation kept orthonormal)."""
    R, t, s = transform_parts(transform)
    m = np.linalg.inv(pose_matrix(R * s, t)) @ np.asarray(c2w_viewer, np.float64)
    m[:3, :3] /= np.cbrt(np.linalg.det(m[:3, :3]))
    return m


def look_around(
    s: Splats,
    transform: dict,
    eye: Sequence[float] = (0.0, 1.6, 0.0),
    views: int = 12,
    width: int = 256,
    height: int = 192,
    hfov_deg: float = 90.0,
    pitch_deg: float = 0.0,
    prefer_gpu: bool = True,
) -> dict:
    """Renders `views` directions while turning on the spot at `eye` (viewer frame) and measures the fraction of
    empty pixels (alpha < 0.5). Lower `meanHoles` = a more complete world around the spawn."""
    f = 0.5 * width / math.tan(math.radians(hfov_deg) / 2)
    holes, imgs = [], []
    tensors: dict = {}
    for k in range(views):
        c2w_v = pose_matrix(rot_y(2 * math.pi * k / views) @ rot_x(math.radians(pitch_deg)), eye)
        c2w = viewer_camera_in_file(transform, c2w_v)
        r = render(s, c2w, f, f, width / 2, height / 2, width, height, prefer_gpu=prefer_gpu, tensors=tensors)
        holes.append(float(np.mean(r.alpha < 0.5)))
        imgs.append(r.rgb)
    return {"holes": holes, "meanHoles": float(np.mean(holes)), "images": imgs}


# --------------------------------------------------------------------------------------------------------------
# JSON and progress
# --------------------------------------------------------------------------------------------------------------


def jsonable(x: Any) -> Any:
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, np.ndarray):
        return jsonable(x.tolist())
    if isinstance(x, (np.floating,)):
        x = float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, float) and not math.isfinite(x):
        return None
    if isinstance(x, Path):
        return str(x)
    return x


def write_json_atomic(path: Path | str, obj: Any) -> None:
    data = json.dumps(jsonable(obj), indent=2).encode("utf-8") + b"\n"
    _atomic_write_bytes(path, [data])


def read_json(path: Path | str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


class Progress:
    """Progress sink: a progress.json path, a callable(stage, fraction) or nothing.

    Fractions given to a Progress are local (0..1) and mapped into [lo, hi]. Writes are monotonic."""

    def __init__(self, target: "str | Path | Callable | Progress | None" = None, lo: float = 0.0, hi: float = 1.0):
        self.lo, self.hi = float(lo), float(hi)
        self._parent: Progress | None = target if isinstance(target, Progress) else None
        self._fn: Callable | None = target if callable(target) and not isinstance(target, Progress) else None
        self._path: Path | None = Path(target) if isinstance(target, (str, Path)) else None
        self._state = {"stage": "Starting", "progress": 0.0}

    def __call__(self, stage: str | None = None, frac: float | None = None) -> None:
        value = None if frac is None else self.lo + (self.hi - self.lo) * min(max(float(frac), 0.0), 1.0)
        self._emit(stage, value)

    def _emit(self, stage: str | None, value: float | None) -> None:
        if self._parent is not None:
            self._parent._emit(stage, value)
            return
        if stage is not None:
            self._state["stage"] = stage
        if value is not None:
            self._state["progress"] = max(self._state.get("progress", 0.0), round(min(max(value, 0.0), 1.0), 4))
        if self._fn is not None:
            try:
                self._fn(self._state["stage"], self._state["progress"])
            except Exception:
                pass
        elif self._path is not None:
            try:
                write_json_atomic(self._path, self._state)
            except OSError:
                pass

    def sub(self, lo: float, hi: float) -> "Progress":
        """A child Progress whose 0..1 maps into [lo, hi] of this one."""
        child = Progress(None, self.lo + (self.hi - self.lo) * lo, self.lo + (self.hi - self.lo) * hi)
        child._parent = self
        return child

    def done(self, stage: str = "Done") -> None:
        if self._parent is not None:
            return
        self._state = {"stage": stage, "progress": 1.0, "done": True}
        if self._fn is not None:
            try:
                self._fn(stage, 1.0)
            except Exception:
                pass
        elif self._path is not None:
            write_json_atomic(self._path, self._state)

    def fail(self, error: str) -> None:
        if self._parent is not None:
            self._parent.fail(error)
            return
        self._state = {**self._state, "error": error, "done": True}
        if self._path is not None:
            write_json_atomic(self._path, self._state)


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------


def _parse_floats(s: str | None, n: int) -> list[float] | None:
    if not s:
        return None
    v = [float(x) for x in s.split(",")]
    if len(v) != n:
        raise SystemExit(f"expected {n} comma-separated numbers, got {s!r}")
    return v


def _cli(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Splat file utilities")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("info", help="count, SH degree, bounds and floor fit")
    a.add_argument("path")
    a.add_argument("--quaternion", help="file-to-viewer quaternion x,y,z,w (e.g. 1,0,0,0 for OpenCV files)")
    a.add_argument("--position")
    a.add_argument("--scale", type=float, default=1.0)
    c = sub.add_parser("convert", help="PLY <-> SPZ")
    c.add_argument("src")
    c.add_argument("dst")
    c.add_argument("--sh-degree", type=int)
    c.add_argument("--max-splats", type=int)
    r = sub.add_parser("render", help="CPU render from the viewer origin looking down -Z")
    r.add_argument("path")
    r.add_argument("out")
    r.add_argument("--width", type=int, default=640)
    r.add_argument("--height", type=int, default=400)
    r.add_argument("--fov", type=float, default=70.0, help="vertical FOV in degrees")
    r.add_argument("--quaternion")
    r.add_argument("--position")
    r.add_argument("--scale", type=float, default=1.0)
    r.add_argument("--eye", default="0,1.5,0", help="camera position in the viewer frame")
    r.add_argument("--yaw", type=float, default=0.0, help="degrees")
    args = ap.parse_args(argv)

    if args.cmd == "info":
        t0 = time.time()
        s = read_splats(args.path)
        q = _parse_floats(args.quaternion, 4) or [0, 0, 0, 1]
        tr = {"position": _parse_floats(args.position, 3) or [0, 0, 0], "quaternion": q, "scale": args.scale}
        world = apply_transform(s.means, tr)
        op = s.opacities
        info = {
            "file": args.path,
            "splats": len(s),
            "shDegree": s.sh_degree,
            "readSeconds": round(time.time() - t0, 2),
            "opacity": {"mean": float(op.mean()), "opaqueFraction": float(np.mean(op >= 0.35))},
            "boundsViewer": robust_bounds(world[op >= 0.35]),
            "floorViewer": estimate_floor(world, op, camera=np.array(tr["position"], np.float64)).to_json(),
        }
        if args.path.lower().endswith(".spz"):
            info["header"] = read_spz_header(args.path)
        print(json.dumps(jsonable(info), indent=2))
        return 0
    if args.cmd == "convert":
        s = read_splats(args.src)
        if args.max_splats:
            s = s.subset(prune_indices(s, args.max_splats))
        write_splats(args.dst, s, args.sh_degree)
        print(f"wrote {args.dst}: {len(s)} splats")
        return 0
    if args.cmd == "render":
        s = read_splats(args.path)
        q = _parse_floats(args.quaternion, 4) or [0, 0, 0, 1]
        tr = {"position": _parse_floats(args.position, 3) or [0, 0, 0], "quaternion": q, "scale": args.scale}
        eye = np.asarray(_parse_floats(args.eye, 3), np.float64)
        c2w_file = viewer_camera_in_file(tr, pose_matrix(rot_y(math.radians(args.yaw)), eye))
        f = 0.5 * args.height / math.tan(math.radians(args.fov) / 2)
        out = render(s, c2w_file, f, f, args.width / 2, args.height / 2, args.width, args.height)
        save_jpeg(args.out, out.rgb)
        print(f"wrote {args.out} ({out.backend}), holes {float(np.mean(out.alpha < 0.5)):.3f}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
