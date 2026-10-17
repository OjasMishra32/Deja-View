"""Read and write the glTF binaries the room baker makes (`pipeline/roblox_mesh.py` `glb_bytes`).

Layout: one node + mesh + material per chunk; POSITION in studs relative to the node translation; NORMAL; TEXCOORD_0
and a JPEG base colour texture, or COLOR_0 vertex colours. `read_glb` returns every chunk in room-frame metres.
"""
from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

STUDS_PER_METER = 3.57
_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
_DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


@dataclass
class Prim:
    name: str
    V: np.ndarray  # [n, 3] float64, room-frame metres
    F: np.ndarray  # [m, 3] int64
    N: np.ndarray | None = None  # [n, 3]
    UV: np.ndarray | None = None  # [n, 2], glTF convention (v down from the top of the image)
    image: np.ndarray | None = None  # [h, w, 3] uint8 base colour
    colours: np.ndarray | None = None  # [n, 3] float 0..1 vertex colours (COLOR_0)


def _chunks(data: bytes) -> tuple[dict, bytes]:
    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError("not a glTF 2.0 binary")
    off, js, binary = 12, None, b""
    while off < min(total, len(data)):
        length, kind = struct.unpack_from("<II", data, off)
        body = data[off + 8: off + 8 + length]
        if kind == 0x4E4F534A:
            js = json.loads(body.decode("utf-8"))
        elif kind == 0x004E4942:
            binary = body
        off += 8 + length
    if js is None:
        raise ValueError("glTF binary has no JSON chunk")
    return js, binary


def _accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = _DTYPES[acc["componentType"]]
    comps = _COMPONENTS[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"] * comps
    arr = np.frombuffer(binary, dtype=dtype, count=count, offset=start)
    return arr.reshape(acc["count"], comps) if comps > 1 else arr


def _image(gltf: dict, binary: bytes, texture_index: int) -> np.ndarray:
    from PIL import Image

    src = gltf["images"][gltf["textures"][texture_index]["source"]]
    view = gltf["bufferViews"][src["bufferView"]]
    start = view.get("byteOffset", 0)
    raw = binary[start: start + view["byteLength"]]
    return np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), np.uint8)


def read_glb(path: str | Path | bytes) -> list[Prim]:
    data = path if isinstance(path, (bytes, bytearray)) else Path(path).read_bytes()
    gltf, binary = _chunks(bytes(data))
    prims: list[Prim] = []
    for node in gltf.get("nodes", []):
        if "mesh" not in node:
            continue
        t = np.asarray(node.get("translation", [0, 0, 0]), np.float64)
        mesh = gltf["meshes"][node["mesh"]]
        for p in mesh["primitives"]:
            a = p["attributes"]
            V = (_accessor(gltf, binary, a["POSITION"]).astype(np.float64) + t) / STUDS_PER_METER
            F = _accessor(gltf, binary, p["indices"]).astype(np.int64).reshape(-1, 3)
            N = _accessor(gltf, binary, a["NORMAL"]).astype(np.float64) if "NORMAL" in a else None
            UV = _accessor(gltf, binary, a["TEXCOORD_0"]).astype(np.float64) if "TEXCOORD_0" in a else None
            col = _accessor(gltf, binary, a["COLOR_0"]).astype(np.float64)[:, :3] if "COLOR_0" in a else None
            image = None
            mat = gltf.get("materials", [])[p["material"]] if "material" in p else {}
            tex = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
            if tex is not None:
                image = _image(gltf, binary, tex["index"])
            prims.append(Prim(node.get("name") or mesh.get("name", ""), V, F, N, UV, image, col))
    if not prims:
        raise ValueError("glTF binary has no meshes")
    return prims


def glb_extras(path: str | Path) -> dict:
    gltf, _ = _chunks(Path(path).read_bytes())
    return dict(gltf.get("asset", {}).get("extras") or {})


def merged(prims: list[Prim]) -> tuple[np.ndarray, np.ndarray]:
    """All chunks as one (V, F) in metres, for geometry metrics."""
    Vs, Fs, base = [], [], 0
    for p in prims:
        Vs.append(p.V)
        Fs.append(p.F + base)
        base += len(p.V)
    return np.concatenate(Vs), np.concatenate(Fs)


def glb_info(prims: list[Prim]) -> dict:
    return {
        "chunks": len(prims),
        "triangles": int(sum(len(p.F) for p in prims)),
        "vertices": int(sum(len(p.V) for p in prims)),
        "textures": [list(p.image.shape[1::-1]) for p in prims if p.image is not None],
    }


def write_glb(prims: list[Prim], extras: dict | None = None, jpeg_quality: int = 90) -> bytes:
    """The same layout as the room baker: studs relative to each chunk's centre, one JPEG atlas per chunk."""
    from PIL import Image

    S = STUDS_PER_METER
    extras = extras or {}
    parts: list[bytes] = []
    offset = 0
    views, accessors, meshes, nodes, materials, textures, images = [], [], [], [], [], [], []

    def add_view(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        pad = (-offset) % 4
        if pad:
            parts.append(b"\0" * pad)
            offset += pad
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        views.append(bv)
        parts.append(data)
        offset += len(data)
        return len(views) - 1

    def add_accessor(arr: np.ndarray, ctype: int, kind: str, target: int, minmax: bool = False) -> int:
        acc = {"bufferView": add_view(arr.tobytes(), target), "componentType": ctype, "count": int(len(arr)), "type": kind}
        if minmax:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    for k, p in enumerate(prims):
        centre = (p.V.min(axis=0) + p.V.max(axis=0)) / 2.0 * S
        pos = (p.V * S - centre).astype(np.float32)
        N = p.N if p.N is not None else vertex_normals(p.V, p.F)
        attrs = {"POSITION": add_accessor(pos, 5126, "VEC3", 34962, minmax=True),
                 "NORMAL": add_accessor(N.astype(np.float32), 5126, "VEC3", 34962)}
        mat: dict = {"name": p.name, "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0}}
        if p.image is not None and p.UV is not None:
            attrs["TEXCOORD_0"] = add_accessor(p.UV.astype(np.float32), 5126, "VEC2", 34962)
            buf = io.BytesIO()
            Image.fromarray(np.asarray(p.image, np.uint8)).save(buf, "JPEG", quality=jpeg_quality)
            images.append({"bufferView": add_view(buf.getvalue()), "mimeType": "image/jpeg", "name": p.name})
            textures.append({"sampler": 0, "source": len(images) - 1})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
        elif p.colours is not None:
            attrs["COLOR_0"] = add_accessor(p.colours.astype(np.float32), 5126, "VEC3", 34962)
        materials.append(mat)
        idx = p.F.reshape(-1)
        ia = add_accessor(idx.astype(np.uint16 if len(p.V) < 65536 else np.uint32),
                          5123 if len(p.V) < 65536 else 5125, "SCALAR", 34963)
        meshes.append({"name": p.name, "primitives": [{"attributes": attrs, "indices": ia, "material": k, "mode": 4}]})
        nodes.append({"name": p.name, "mesh": k, "translation": [round(float(c), 4) for c in centre]})
    gltf: dict = {
        "asset": {"version": "2.0", "generator": "Déjà View objects/detail", "extras": extras},
        "scene": 0,
        "scenes": [{"name": extras.get("name", "object"), "nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "materials": materials, "accessors": accessors,
        "bufferViews": views, "buffers": [{"byteLength": offset}],
    }
    if images:
        gltf["images"], gltf["textures"] = images, textures
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    js = json.dumps(gltf, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(parts)
    binary += b"\0" * ((-len(binary)) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def vertex_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    N = np.zeros_like(V, dtype=np.float64)
    for i in range(3):
        np.add.at(N, F[:, i], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def read_mesh(path: str | Path) -> list[Prim]:
    """A GLB from our bakers, or an OBJ / binary PLY from an external method (SuGaR, 2DGS, GOF): geometry only."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in (".glb", ".gltf"):
        return read_glb(path)
    if suffix == ".obj":
        return [_read_obj(path)]
    if suffix == ".ply":
        return [_read_ply(path)]
    raise ValueError(f"unsupported mesh format: {path.name}")


def _read_obj(path: Path) -> Prim:
    V, F = [], []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("v "):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            idx = [int(tok.split("/")[0]) for tok in line.split()[1:]]
            idx = [i - 1 if i > 0 else len(V) + i for i in idx]
            for j in range(1, len(idx) - 1):  # fan-triangulate polygons
                F.append([idx[0], idx[j], idx[j + 1]])
    return Prim(path.stem, np.asarray(V, np.float64), np.asarray(F, np.int64).reshape(-1, 3))


def _read_ply(path: Path) -> Prim:
    data = path.read_bytes()
    end = data.index(b"end_header") + len(b"end_header")
    while data[end:end + 1] in (b"\r", b"\n"):
        end += 1
    header = data[:end].decode("ascii", errors="replace").splitlines()
    fmt = next(h.split()[1] for h in header if h.startswith("format"))
    elements: list[tuple[str, int, list]] = []
    for h in header:
        t = h.split()
        if t and t[0] == "element":
            elements.append((t[1], int(t[2]), []))
        elif t and t[0] == "property":
            elements[-1][2].append(t[1:])
    types = {"char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1", "short": "i2", "ushort": "u2", "int16": "i2",
             "uint16": "u2", "int": "i4", "uint": "u4", "int32": "i4", "uint32": "u4", "float": "f4", "float32": "f4",
             "double": "f8", "float64": "f8"}
    if fmt == "ascii":
        rows = data[end:].decode("ascii").split("\n")
        r = 0
        V = F = None
        for name, count, props in elements:
            if name == "vertex":
                names = [p[-1] for p in props]
                arr = np.asarray([[float(x) for x in rows[r + i].split()] for i in range(count)])
                V = arr[:, [names.index("x"), names.index("y"), names.index("z")]]
            elif name == "face":
                F = np.asarray([[int(x) for x in rows[r + i].split()[1:4]] for i in range(count)], np.int64)
            r += count
        return Prim(path.stem, V, F if F is not None else np.zeros((0, 3), np.int64))
    order = "<" if fmt == "binary_little_endian" else ">"
    off = end
    V = F = None
    for name, count, props in elements:
        if props and props[0][0] == "list":
            ctype, itype = types[props[0][1]], types[props[0][2]]
            faces = []
            for _ in range(count):
                n = int(np.frombuffer(data, order + ctype, 1, off)[0])
                off += np.dtype(ctype).itemsize
                idx = np.frombuffer(data, order + itype, n, off)
                off += n * np.dtype(itype).itemsize
                for j in range(1, n - 1):
                    faces.append([idx[0], idx[j], idx[j + 1]])
            if name == "face":
                F = np.asarray(faces, np.int64).reshape(-1, 3)
        else:
            dt = np.dtype([(p[-1], order + types[p[0]]) for p in props])
            arr = np.frombuffer(data, dt, count, off)
            off += count * dt.itemsize
            if name == "vertex":
                V = np.stack([arr["x"], arr["y"], arr["z"]], axis=1).astype(np.float64)
    if V is None:
        raise ValueError(f"{path.name} has no vertices")
    return Prim(path.stem, V, F if F is not None else np.zeros((0, 3), np.int64))
