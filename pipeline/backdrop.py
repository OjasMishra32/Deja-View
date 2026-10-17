#!/usr/bin/env python3
"""The viewer's backdrop: a scene's Roblox room (roblox.glb v2, photo textures) as a small unlit mesh in metres, and
its six sky faces as one equirectangular image. web/src/viewer/backdrop.ts draws both behind the splats, so wherever
the splat world has no coverage (a ceiling the footage never looked at, the sky over a lawn, a cut-off tree top) a
real surface shows instead of black.

  .venv/bin/python pipeline/backdrop.py the-courts [chess-room ...]     # or --all
        [--triangles 150000] [--error 0.05] [--texture 512] [--quality 72] [--max-bytes 4900000] [--force]

Reads data/scenes/<id>/roblox-model.json (studsPerMeter, floorY, the parts, the sky faces and their orientation) and
the files it lists. Writes, next to them:
  backdrop.glb      the room in metres, room frame (viewer axes, floor at y = 0): every chunk of the Roblox model,
                    simplified (meshoptimizer, UV seams kept), positions and UVs quantized (KHR_mesh_quantization)
                    and compressed (EXT_meshopt_compression; three.js decodes it with its bundled MeshoptDecoder),
                    textures downsized (the size budget picks the largest that fits); materials are
                    KHR_materials_unlit. Under --max-bytes.
  backdrop-sky.jpg  the sky faces resampled to one equirect image in three.js's convention for the same axes:
                    u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5 (image top = up). A night sky's never-seen
                    top (pure black fill) gets a dark blue-grey floor (--sky-floor off to keep it as rendered).
  backdrop.json     what the viewer reads (file, sky, floorY: the scene-frame floor the room frame subtracted) and the
                    inputs it was made from. A scene whose inputs and settings match it is skipped (idempotent).

v1 rooms (no textures from the photos, no sky) are skipped unless --allow-v1. Simplification and compression run in
pipeline/backdrop_mesh.ts with bun: the simplifier three.js ships and the meshoptimizer encoder already in
node_modules (without it the geometry is stored uncompressed and the textures shrink to fit). Nothing new is installed.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pygltflib
from PIL import Image

TOOL_VERSION = 1
ROOT = Path(__file__).resolve().parent.parent
SCENES = ROOT / "data" / "scenes"
HELPER = Path(__file__).resolve().parent / "backdrop_mesh.ts"

GLB_FILE = "backdrop.glb"
SKY_FILE = "backdrop-sky.jpg"
MANIFEST = "backdrop.json"

# Roblox Sky faces in the model's frame (pipeline/roblox_mesh.py SKY_FACES): look direction and image-up. Used when
# roblox-model.json does not list them.
SKY_FACES = {
    "front": ((0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),
    "left": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "back": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    "right": ((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "up": ((0.0, 1.0, 0.0), (1.0, 0.0, 0.0)),
    "down": ((0.0, -1.0, 0.0), (-1.0, 0.0, 0.0)),
}

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def log(msg: str) -> None:
    print(f"[backdrop] {msg}", flush=True)


def sha1_bytes(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def sha1_file(p: Path) -> str:
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ---------------------------------------------------------------- reading the Roblox model


class Chunk:
    def __init__(self, name: str, pos: np.ndarray, uv: np.ndarray, idx: np.ndarray, jpeg: bytes):
        self.name = name
        self.pos = pos  # (n, 3) float32 metres, room frame
        self.uv = uv  # (n, 2) float32
        self.idx = idx  # (m,) uint32
        self.jpeg = jpeg  # the chunk's texture as stored


def node_matrix(node: pygltflib.Node) -> np.ndarray:
    if node.matrix:
        return np.array(node.matrix, np.float64).reshape(4, 4).T
    m = np.eye(4)
    if node.scale:
        m = m @ np.diag([*node.scale, 1.0])
    if node.rotation:
        x, y, z, w = node.rotation
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        rm = np.eye(4)
        rm[:3, :3] = r
        m = rm @ m
    if node.translation:
        t = np.eye(4)
        t[:3, 3] = node.translation
        m = t @ m
    return m


def read_chunks(glb: Path, studs_per_m: float) -> list[Chunk]:
    g = pygltflib.GLTF2().load(str(glb))
    blob = g.binary_blob()

    def accessor(i: int) -> np.ndarray:
        a = g.accessors[i]
        bv = g.bufferViews[a.bufferView]
        dt = np.dtype(COMPONENT[a.componentType])
        n = WIDTH[a.type]
        off = (bv.byteOffset or 0) + (a.byteOffset or 0)
        stride = bv.byteStride or dt.itemsize * n
        raw = np.frombuffer(blob, dtype=np.uint8, count=stride * (a.count - 1) + dt.itemsize * n, offset=off)
        arr = np.lib.stride_tricks.as_strided(raw, shape=(a.count, n * dt.itemsize), strides=(stride, 1))
        out = np.ascontiguousarray(arr).view(dt).reshape(a.count, n)
        if a.normalized and dt.kind in "iu":
            out = out.astype(np.float32) / float(np.iinfo(dt).max)
        return out

    def image_bytes(tex_index: int) -> bytes:
        src = g.textures[tex_index].source
        im = g.images[src]
        bv = g.bufferViews[im.bufferView]
        return bytes(blob[(bv.byteOffset or 0):(bv.byteOffset or 0) + bv.byteLength])

    # world matrices of every node (the parts are flat, but follow children anyway)
    world: dict[int, np.ndarray] = {}

    def walk(i: int, parent: np.ndarray) -> None:
        m = parent @ node_matrix(g.nodes[i])
        world[i] = m
        for c in g.nodes[i].children or []:
            walk(c, m)

    roots = g.scenes[g.scene or 0].nodes if g.scenes else list(range(len(g.nodes)))
    for r in roots:
        walk(r, np.eye(4))

    chunks: list[Chunk] = []
    for ni, m in world.items():
        node = g.nodes[ni]
        if node.mesh is None:
            continue
        mesh = g.meshes[node.mesh]
        for pi, prim in enumerate(mesh.primitives):
            if prim.mode not in (None, 4) or prim.attributes.TEXCOORD_0 is None or prim.indices is None:
                continue
            mat = g.materials[prim.material] if prim.material is not None else None
            tex = mat.pbrMetallicRoughness.baseColorTexture if mat and mat.pbrMetallicRoughness else None
            if tex is None:
                continue
            p = accessor(prim.attributes.POSITION).astype(np.float64)
            p = p @ m[:3, :3].T + m[:3, 3]
            uv = accessor(prim.attributes.TEXCOORD_0).astype(np.float32)
            idx = accessor(prim.indices).reshape(-1).astype(np.uint32)
            name = mesh.name or node.name or f"chunk{ni}"
            chunks.append(Chunk(name if pi == 0 else f"{name}_{pi}", (p / studs_per_m).astype(np.float32), uv, idx,
                                image_bytes(tex.index)))
    return chunks


def weld(c: Chunk) -> Chunk:
    """Merges vertices with the same position and uv (bit for bit): the simplifier finds seams by position."""
    key = np.concatenate([c.pos.view(np.uint32), c.uv.view(np.uint32)], axis=1)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    return Chunk(c.name, c.pos[first], c.uv[first], inv[c.idx].astype(np.uint32), c.jpeg)


def run_helper(cmd: str, d: str) -> dict | None:
    """pipeline/backdrop_mesh.ts <cmd> <d>: its JSON line, or None when the encoder is missing (exit 3)."""
    bun = shutil.which("bun")
    if not bun:
        raise SystemExit("bun is not on PATH: it runs pipeline/backdrop_mesh.ts (meshoptimizer from three.js)")
    r = subprocess.run([bun, str(HELPER), cmd, d], cwd=ROOT, capture_output=True, text=True)
    if r.returncode == 3:
        return None
    if r.returncode != 0:
        raise SystemExit(f"backdrop_mesh.ts {cmd} failed: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def simplify(chunks: list[Chunk], ratio: float, error: float) -> dict:
    """Simplifies every chunk (UV seams kept, absolute error in metres) and drops the vertices no triangle uses; with
    meshoptimizer's encoder at hand the vertices also come back in cache and fetch order."""
    with tempfile.TemporaryDirectory(prefix="backdrop-") as d:
        for i, c in enumerate(chunks):
            c.pos.astype(np.float32).tofile(f"{d}/{i}.pos")
            c.uv.astype(np.float32).tofile(f"{d}/{i}.uv")
            c.idx.astype(np.uint32).tofile(f"{d}/{i}.idx")
        job = {"ratio": ratio, "error": error, "weights": [0.5, 0.5],
               "chunks": [{"nv": len(c.pos), "ni": len(c.idx)} for c in chunks]}
        Path(d, "job.json").write_text(json.dumps(job))
        res = run_helper("simplify", d)
        assert res is not None
        for i, c in enumerate(chunks):
            idx = np.fromfile(f"{d}/{i}.out", dtype=np.uint32)
            remap = np.full(len(c.pos), 0xFFFFFFFF, np.uint64)
            r = np.fromfile(f"{d}/{i}.remap", dtype=np.uint32)
            remap[:len(r)] = r
            n = res["chunks"][i]["vertices"]
            keep = remap != 0xFFFFFFFF
            pos = np.zeros((n, 3), np.float32)
            uv = np.zeros((n, 2), np.float32)
            pos[remap[keep].astype(np.int64)] = c.pos[keep]
            uv[remap[keep].astype(np.int64)] = c.uv[keep]
            c.pos, c.uv, c.idx = pos, uv, idx
    return res


# ---------------------------------------------------------------- writing the backdrop


def shrink_jpeg(data: bytes, size: int, quality: int) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    if img.width != size or img.height != size:
        img = img.resize((size, size), Image.Resampling.BOX if img.width >= 2 * size else Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


class Geometry:
    """A chunk's vertex and index data as stored: positions int16 x3 (+2 pad) around a centre with a uniform scale,
    UVs uint16, both normalized (KHR_mesh_quantization); uint16 indices where they fit. `enc` holds the same buffers
    compressed (EXT_meshopt_compression), when the encoder is installed."""

    def __init__(self, c: Chunk):
        lo, hi = c.pos.min(axis=0).astype(np.float64), c.pos.max(axis=0).astype(np.float64)
        self.centre = (lo + hi) / 2
        self.scale = max(float((hi - lo).max()) / 2, 1e-4)
        q = np.round((c.pos - self.centre) / self.scale * 32767).clip(-32767, 32767).astype(np.int16)
        qp = np.zeros((len(q), 4), np.int16)
        qp[:, :3] = q
        self.count = len(q)
        self.qmin, self.qmax = q.min(axis=0).astype(int).tolist(), q.max(axis=0).astype(int).tolist()
        self.small = self.count < 65536
        self.raw = {
            "pos": (qp.tobytes(), 8, self.count, "ATTRIBUTES"),
            "uv": (np.round(c.uv.clip(0, 1) * 65535).astype(np.uint16).tobytes(), 4, self.count, "ATTRIBUTES"),
            "idx": (c.idx.astype(np.uint16 if self.small else np.uint32).tobytes(), 2 if self.small else 4, len(c.idx),
                    "TRIANGLES"),
        }
        self.enc: dict[str, bytes] | None = None


def encode_all(geos: list[Geometry]) -> bool:
    """Compresses every buffer with meshoptimizer (EXT_meshopt_compression). False when the encoder is missing."""
    with tempfile.TemporaryDirectory(prefix="backdrop-enc-") as d:
        bufs = []
        for i, g in enumerate(geos):
            for k, (data, stride, count, mode) in g.raw.items():
                f = f"{i}.{k}"
                Path(d, f).write_bytes(data)
                bufs.append({"file": f, "count": count, "stride": stride, "mode": mode})
        Path(d, "job.json").write_text(json.dumps({"buffers": bufs}))
        if run_helper("encode", d) is None:
            return False
        for i, g in enumerate(geos):
            g.enc = {k: Path(d, f"{i}.{k}.enc").read_bytes() for k in g.raw}
    return True


def build_glb(chunks: list[Chunk], geos: list[Geometry], textures: list[bytes], name: str) -> bytes:
    """One node per chunk (translation = its centre, scale = its quantization scale), one unlit material and texture
    each. With compressed geometry the raw buffers live in a fallback buffer with no data (buffer 1)."""
    compressed = all(g.enc is not None for g in geos)
    g = pygltflib.GLTF2()
    g.asset = pygltflib.Asset(version="2.0", generator=f"thirdwheel pipeline/backdrop.py v{TOOL_VERSION}")
    g.extensionsUsed = ["KHR_mesh_quantization", "KHR_materials_unlit"]
    g.extensionsRequired = ["KHR_mesh_quantization"]
    if compressed:
        g.extensionsUsed.append("EXT_meshopt_compression")
        g.extensionsRequired.append("EXT_meshopt_compression")
    g.samplers = [pygltflib.Sampler(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071)]
    blob = bytearray()
    fallback = 0  # bytes of the (empty) fallback buffer

    def pad(b: bytearray | int) -> int:
        if isinstance(b, int):
            return (b + 3) & ~3
        while len(b) % 4:
            b.append(0)
        return len(b)

    def view(geo: Geometry | None, key: str | None, data: bytes, target: int | None, stride: int | None) -> int:
        nonlocal fallback
        if geo is not None and geo.enc is not None and key is not None:
            enc = geo.enc[key]
            _, estride, count, mode = geo.raw[key]
            off = pad(blob)
            blob.extend(enc)
            fallback = pad(fallback)
            g.bufferViews.append(pygltflib.BufferView(
                buffer=1, byteOffset=fallback, byteLength=len(data), byteStride=stride, target=target,
                extensions={"EXT_meshopt_compression": {"buffer": 0, "byteOffset": off, "byteLength": len(enc),
                                                        "byteStride": estride, "count": count, "mode": mode}}))
            fallback += len(data)
        else:
            off = pad(blob)
            blob.extend(data)
            g.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off, byteLength=len(data), byteStride=stride,
                                                      target=target))
        return len(g.bufferViews) - 1

    nodes = []
    for c, geo, jpeg in zip(chunks, geos, textures):
        pv = view(geo, "pos", geo.raw["pos"][0], 34962, 8)
        g.accessors.append(pygltflib.Accessor(bufferView=pv, componentType=5122, normalized=True, count=geo.count,
                                              type="VEC3", min=geo.qmin, max=geo.qmax))
        pa = len(g.accessors) - 1
        uvv = view(geo, "uv", geo.raw["uv"][0], 34962, None)
        g.accessors.append(pygltflib.Accessor(bufferView=uvv, componentType=5123, normalized=True, count=geo.count, type="VEC2"))
        ua = len(g.accessors) - 1
        iv = view(geo, "idx", geo.raw["idx"][0], 34963, None)
        g.accessors.append(pygltflib.Accessor(bufferView=iv, componentType=5123 if geo.small else 5125,
                                              count=len(c.idx), type="SCALAR"))
        ia = len(g.accessors) - 1
        imv = view(None, None, jpeg, None, None)
        g.images.append(pygltflib.Image(bufferView=imv, mimeType="image/jpeg", name=c.name))
        g.textures.append(pygltflib.Texture(sampler=0, source=len(g.images) - 1))
        g.materials.append(pygltflib.Material(
            name=c.name,
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(baseColorTexture=pygltflib.TextureInfo(index=len(g.textures) - 1),
                                                                metallicFactor=0.0, roughnessFactor=1.0),
            extensions={"KHR_materials_unlit": {}}, doubleSided=False))
        g.meshes.append(pygltflib.Mesh(name=c.name, primitives=[pygltflib.Primitive(
            attributes=pygltflib.Attributes(POSITION=pa, TEXCOORD_0=ua), indices=ia, material=len(g.materials) - 1, mode=4)]))
        g.nodes.append(pygltflib.Node(name=c.name, mesh=len(g.meshes) - 1, translation=geo.centre.tolist(), scale=[geo.scale] * 3))
        nodes.append(len(g.nodes) - 1)
    g.scenes = [pygltflib.Scene(name=name, nodes=nodes)]
    g.scene = 0
    pad(blob)
    g.buffers = [pygltflib.Buffer(byteLength=len(blob))]
    if compressed:
        g.buffers.append(pygltflib.Buffer(byteLength=pad(fallback), extensions={"EXT_meshopt_compression": {"fallback": True}}))
    return glb_bytes(g, bytes(blob))


def glb_bytes(g: pygltflib.GLTF2, blob: bytes) -> bytes:
    """The GLB container (JSON chunk + BIN chunk), written here: pygltflib's own writer merges every buffer into the
    BIN chunk, which would turn the empty meshopt fallback buffer into a real one."""
    import struct

    def strip(v):
        if isinstance(v, dict):
            return {k: strip(x) for k, x in v.items() if x is not None and not (k in ("extensions", "extras") and not x)}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v

    doc = strip(json.loads(g.to_json()))
    for k in [k for k, v in doc.items() if v == []]:
        del doc[k]
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ = blob + b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(bin_), 0x004E4942) + bin_)


# ---------------------------------------------------------------- the sky


def equirect_sky(scene_dir: Path, sky: dict, faces: dict, width: int) -> Image.Image:
    """Resamples the six faces (each rendered from the eye with a 90 degree pinhole: image right = look x up, image up
    = imageUp) to an equirect image in three.js's convention: column u at azimuth atan2(z, x) = (u - 0.5) 2pi, row 0 =
    straight up."""
    imgs, frames = {}, {}
    for n, info in sky.items():
        f = info["file"] if isinstance(info, dict) else str(info)
        imgs[n] = np.asarray(Image.open(scene_dir / f).convert("RGB"), np.float32)
        look, up = faces.get(n, SKY_FACES[n])
        look, up = np.asarray(look, np.float64), np.asarray(up, np.float64)
        frames[n] = (look, up, np.cross(look, up))
    h = width // 2
    uu = (np.arange(width) + 0.5) / width
    vv = (np.arange(h) + 0.5) / h
    lon = (uu - 0.5) * 2 * math.pi
    lat = (0.5 - vv) * math.pi
    lon, lat = np.meshgrid(lon, lat)
    d = np.stack([np.cos(lat) * np.cos(lon), np.sin(lat), np.cos(lat) * np.sin(lon)], axis=-1)
    out = np.zeros((h, width, 3), np.float32)
    best = np.full((h, width), -np.inf)
    for n, (look, up, right) in frames.items():
        z = d @ look
        sel = (z > best) & (z > 1e-6)
        if not sel.any():
            continue
        best = np.where(sel, z, best)
        img = imgs[n]
        size = img.shape[0]
        x = (d[sel] @ right) / z[sel]
        y = (d[sel] @ up) / z[sel]
        px = (x + 1) * size / 2 - 0.5
        py = (1 - y) * size / 2 - 0.5
        x0 = np.clip(np.floor(px).astype(int), 0, size - 1)
        y0 = np.clip(np.floor(py).astype(int), 0, size - 1)
        x1, y1 = np.minimum(x0 + 1, size - 1), np.minimum(y0 + 1, size - 1)
        fx = np.clip(px - x0, 0, 1)[:, None]
        fy = np.clip(py - y0, 0, 1)[:, None]
        col = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy
               + img[y1, x1] * fx * fy)
        out[sel] = col
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8))


# The skybox fills every pixel no far splat covers with the far splats' colour at that elevation, and above the
# highest one that is whatever the topmost splats were: at night pure black (the-courts: (0, 0, 2) from 45 degrees up),
# which reads as a void, not as a sky. A night sky gets a floor instead: never darker than a dark blue-grey that
# ramps in from SKY_FLOOR_FROM to SKY_FLOOR_FULL degrees of elevation (the horizon, where the footage did see the
# sky, keeps its own colours). Brighter pixels (lit trees, a lamp, a day sky) are left alone. The colour is about
# what the image model painted into this footage's night sky (pipeline/genfill evidence), a little darker.
SKY_FLOOR_ZENITH = (18.0, 22.0, 29.0)  # sRGB 0..255
SKY_FLOOR_FROM = 5.0
SKY_FLOOR_FULL = 35.0
SKY_NIGHT_LUMA = 24.0  # the sky above SKY_FLOOR_FULL darker than this on average: night


def luma(a: np.ndarray) -> np.ndarray:
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def night_floor(img: Image.Image) -> tuple[Image.Image, dict]:
    a = np.asarray(img, np.float32)
    h = a.shape[0]
    elev = (0.5 - (np.arange(h) + 0.5) / h) * 180.0
    upper = a[elev > SKY_FLOOR_FULL]
    mean = float(luma(upper).mean()) if upper.size else 255.0
    info = {"upperLuma": round(mean, 1), "applied": mean < SKY_NIGHT_LUMA}
    if not info["applied"]:
        return img, info
    t = np.clip((elev - SKY_FLOOR_FROM) / (SKY_FLOOR_FULL - SKY_FLOOR_FROM), 0, 1)
    t = t * t * (3 - 2 * t)
    floor = t[:, None, None] * np.asarray(SKY_FLOOR_ZENITH, np.float32)[None, None, :]
    out = np.maximum(a, floor)
    info.update({"zenith": list(SKY_FLOOR_ZENITH), "fromDeg": SKY_FLOOR_FROM, "fullDeg": SKY_FLOOR_FULL,
                 "pixelsRaised": round(float((out > a + 0.5).any(axis=-1).mean()), 3)})
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8)), info


# ---------------------------------------------------------------- one scene


def build(scene_dir: Path, args: argparse.Namespace) -> dict | None:
    sid = scene_dir.name
    model_path = scene_dir / "roblox-model.json"
    if not model_path.exists():
        log(f"{sid}: no roblox-model.json, skipped")
        return None
    model = json.loads(model_path.read_text())
    version = int(model.get("version", 1))
    if version < 2 and not args.allow_v1:
        log(f"{sid}: Roblox room is v{version} (no photo textures yet), skipped (--allow-v1 to build it anyway)")
        return None
    spm = float(model.get("studsPerMeter") or 0)
    if not spm > 0:
        raise SystemExit(f"{sid}: roblox-model.json has no studsPerMeter")
    floor_y = float(model.get("floorY") or 0.0)
    parts = [p["file"] for p in model.get("parts", [])] or [model.get("file", "roblox.glb")]
    missing = [p for p in parts if not (scene_dir / p).exists()]
    if missing:
        raise SystemExit(f"{sid}: missing {', '.join(missing)}")
    sky = model.get("sky") or {}
    sky = {n: v for n, v in sky.items() if n in SKY_FACES and (scene_dir / (v["file"] if isinstance(v, dict) else v)).exists()}
    faces = {n: (tuple(f["look"]), tuple(f["imageUp"])) for n, f in ((model.get("skyInfo") or {}).get("faces") or {}).items()}

    settings = {"triangles": args.triangles, "error": args.error, "texture": args.texture, "quality": args.quality,
                "maxBytes": args.max_bytes, "skyWidth": args.sky_width, "skyQuality": args.sky_quality,
                "skyFloor": args.sky_floor,
                "compress": not args.no_compress}
    inputs = {"tool": TOOL_VERSION, "settings": settings, "studsPerMeter": spm, "floorY": floor_y,
              "parts": {p: sha1_file(scene_dir / p) for p in parts},
              "sky": {n: sha1_file(scene_dir / (v["file"] if isinstance(v, dict) else v)) for n, v in sorted(sky.items())},
              "faces": {n: [list(a), list(b)] for n, (a, b) in sorted(faces.items())}}
    key = sha1_bytes(json.dumps(inputs, sort_keys=True).encode())
    man_path = scene_dir / MANIFEST
    prev: dict = {}
    try:
        prev = json.loads(man_path.read_text()) if man_path.exists() else {}
    except ValueError:
        prev = {}
    if man_path.exists() and not args.force:
        try:
            old = json.loads(man_path.read_text())
            ok = old.get("key") == key and (scene_dir / old["file"]).exists() and sha1_file(scene_dir / old["file"]) == old.get("sha1")
            if ok and old.get("sky"):
                ok = (scene_dir / old["sky"]).exists()
            if ok:
                log(f"{sid}: backdrop is up to date ({old.get('bytes', 0) / 1e6:.2f} MB, {old.get('triangles')} triangles)")
                return old
        except (ValueError, KeyError, OSError):
            pass

    t0 = time.time()
    chunks: list[Chunk] = []
    for p in parts:
        chunks += read_chunks(scene_dir / p, spm)
    tris_in = sum(len(c.idx) // 3 for c in chunks)
    verts_in = sum(len(c.pos) for c in chunks)
    chunks = [weld(c) for c in chunks]
    ratio = min(1.0, args.triangles / max(1, tris_in))
    res = simplify(chunks, ratio, args.error)
    stats = res["chunks"]
    chunks = [c for c in chunks if len(c.idx) >= 3]
    tris = sum(len(c.idx) // 3 for c in chunks)
    verts = sum(len(c.pos) for c in chunks)
    log(f"{sid}: {tris_in} -> {tris} triangles, {verts_in} -> {verts} vertices in {len(chunks)} chunks "
        f"(error <= {args.error} m, {time.time() - t0:.1f} s)")
    geos = [Geometry(c) for c in chunks]
    compressed = encode_all(geos) if not args.no_compress else False
    if not compressed:
        log(f"{sid}: geometry stored uncompressed" + ("" if args.no_compress else " (meshoptimizer encoder not installed)"))
    geo_bytes = sum(len(v) for g in geos for v in (g.enc.values() if g.enc else (x[0] for x in g.raw.values())))

    # textures: as large as the size budget allows
    size, quality = args.texture, args.quality
    while True:
        textures = [shrink_jpeg(c.jpeg, size, quality) for c in chunks]
        glb = build_glb(chunks, geos, textures, model.get("name") or sid)
        if len(glb) <= args.max_bytes:
            break
        if quality > 56:
            quality -= 8
        elif size > 128:
            size //= 2
            quality = args.quality
        else:
            raise SystemExit(f"{sid}: backdrop is {len(glb)} bytes even at {size} px / q{quality}; "
                             f"lower --triangles or raise --error")
        log(f"{sid}: {len(glb) / 1e6:.2f} MB is over {args.max_bytes / 1e6:.2f} MB, trying {size} px at q{quality}")
    write_atomic(scene_dir / GLB_FILE, glb)
    tex_bytes = sum(len(t) for t in textures)

    sky_out = None
    sky_path = scene_dir / SKY_FILE
    kept = None
    built = prev.get("skyBuiltSha1") or prev.get("skySha1")  # what this tool last wrote itself
    if sky and sky_path.exists() and built and not args.force_sky:
        # a sky image put there after this tool wrote its own (another pipeline's candidate) stays
        cur = sky_path.read_bytes()
        if sha1_bytes(cur) != built:
            img0 = Image.open(io.BytesIO(cur))
            kept = {"file": SKY_FILE, "bytes": len(cur), "sha1": sha1_bytes(cur), "size": [img0.width, img0.height],
                    "floor": {"applied": None, "note": "replaced after pipeline/backdrop.py wrote it; kept (--force-sky "
                                                       "to rebuild it from the faces)"}}
            log(f"{sid}: {SKY_FILE} was replaced since this tool wrote it: kept (--force-sky rebuilds it)")
    if kept:
        sky_out = kept
    elif sky:
        img = equirect_sky(scene_dir, sky, faces, args.sky_width)
        floor_info = {"applied": False}
        if args.sky_floor != "off":
            img, floor_info = night_floor(img)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=args.sky_quality, optimize=True)
        write_atomic(scene_dir / SKY_FILE, buf.getvalue())
        built = sha1_bytes(buf.getvalue())
        sky_out = {"file": SKY_FILE, "bytes": len(buf.getvalue()), "sha1": sha1_bytes(buf.getvalue()), "floor": floor_info,
                   "size": [img.width, img.height]}

    manifest = {
        "version": 1,
        "tool": f"pipeline/backdrop.py v{TOOL_VERSION}",
        "sceneId": model.get("sceneId", sid),
        "file": GLB_FILE,
        "bytes": len(glb),
        "sha1": sha1_bytes(glb),
        "sky": sky_out["file"] if sky_out else None,
        "skyBytes": sky_out["bytes"] if sky_out else 0,
        "skySha1": sky_out["sha1"] if sky_out else None,
        "skyBuiltSha1": built if sky_out else None,
        "skySize": sky_out["size"] if sky_out else None,
        "skyMapping": "equirect, three.js convention: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5 (image top = "
                      "up), axes of the viewer frame",
        "skyEye": [round(v / spm, 4) for v in ((model.get("skyInfo") or {}).get("eye") or [0, 0, 0])],
        "skyCoverage": (model.get("skyInfo") or {}).get("coverage"),
        "skyFloor": sky_out["floor"] if sky_out else None,
        "units": "metres",
        "frame": "room frame (roblox-model.json divided by studsPerMeter): viewer axes, floor at y = 0; add floorY to y "
                 "for the viewer frame (scene.json world frame after its transform)",
        "floorY": floor_y,
        "triangles": tris,
        "vertices": verts,
        "chunks": len(chunks),
        "textureSize": size,
        "jpegQuality": quality,
        "textureBytes": tex_bytes,
        "geometryBytes": geo_bytes,
        "compression": "EXT_meshopt_compression" if compressed else None,
        "simplify": {"trianglesIn": tris_in, "verticesIn": verts_in, "ratio": round(ratio, 4), "errorM": args.error,
                     "maxErrorM": max((s.get("error", 0.0) for s in stats), default=0.0)},
        "source": {"model": "roblox-model.json", "modelVersion": version, "studsPerMeter": spm,
                   "parts": inputs["parts"], "sky": inputs["sky"]},
        "settings": settings,
        "key": key,
        "seconds": round(time.time() - t0, 2),
    }
    write_atomic(man_path, (json.dumps(manifest, indent=1) + "\n").encode())
    log(f"{sid}: {GLB_FILE} {len(glb) / 1e6:.2f} MB ({size} px textures at q{quality}: {tex_bytes / 1e6:.2f} MB)"
        + (f", {SKY_FILE} {sky_out['bytes'] / 1e3:.0f} kB {sky_out['size'][0]}x{sky_out['size'][1]}" if sky_out else ", no sky"))
    if args.register:
        register(scene_dir, manifest)
    return manifest


def register(scene_dir: Path, manifest: dict) -> None:
    """Writes world.backdrop into scene.json (the viewer also finds backdrop.json without it)."""
    p = scene_dir / "scene.json"
    if not p.exists():
        return
    scene = json.loads(p.read_text())
    world = scene.get("world")
    if not isinstance(world, dict):
        return
    ref = {"file": manifest["file"], "floorY": manifest["floorY"]}
    if manifest.get("sky"):
        ref["sky"] = manifest["sky"]
    if world.get("backdrop") == ref:
        return
    world["backdrop"] = ref
    write_atomic(p, (json.dumps(scene, indent=2) + "\n").encode())
    log(f"{scene_dir.name}: world.backdrop registered in scene.json")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenes", nargs="*", help="scene ids (folders under data/scenes) or scene directories")
    ap.add_argument("--all", action="store_true", help="every scene with a v2 roblox-model.json")
    ap.add_argument("--triangles", type=int, default=150_000, help="target triangle count (UV seams may keep more)")
    ap.add_argument("--error", type=float, default=0.05, help="largest simplification error (m)")
    ap.add_argument("--texture", type=int, default=512, help="texture size per chunk (px)")
    ap.add_argument("--quality", type=int, default=72, help="JPEG quality of the textures")
    ap.add_argument("--max-bytes", type=int, default=4_900_000, help="backdrop.glb size limit")
    ap.add_argument("--sky-width", type=int, default=2048, help="equirect sky width (px; height is half)")
    ap.add_argument("--sky-quality", type=int, default=85)
    ap.add_argument("--sky-floor", choices=["auto", "off"], default="auto",
                    help="auto: a night sky's black, never-seen top gets a dark blue-grey floor")
    ap.add_argument("--allow-v1", action="store_true", help="also build from a v1 Roblox room")
    ap.add_argument("--no-compress", action="store_true", help="store the geometry without EXT_meshopt_compression")
    ap.add_argument("--register", action="store_true", help="also write world.backdrop into scene.json")
    ap.add_argument("--force", action="store_true", help="rebuild even when backdrop.json is up to date")
    ap.add_argument("--force-sky", action="store_true", help="rewrite backdrop-sky.jpg even when it was replaced")
    args = ap.parse_args()
    dirs: list[Path] = []
    if args.all:
        dirs += sorted(p.parent for p in SCENES.glob("*/roblox-model.json"))
    for s in args.scenes:
        p = Path(s)
        dirs.append(p if p.is_dir() and (p / "scene.json").exists() else SCENES / s)
    if not dirs:
        ap.error("name a scene or pass --all")
    failed = 0
    for d in dict.fromkeys(dirs):
        if not d.is_dir():
            log(f"{d.name}: no such scene")
            failed += 1
            continue
        try:
            build(d, args)
        except SystemExit as e:
            log(str(e))
            failed += 1
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
