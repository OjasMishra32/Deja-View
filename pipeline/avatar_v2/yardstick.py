"""The people yardstick: every variant of the video people is measured the same way, on frames it never saw.

    python -m pipeline.avatar_v2.yardstick prepare --work WORK --poses POSES [--world WORLD] --eval EVAL
    python -m pipeline.avatar_v2.yardstick measure --eval EVAL --glb-dir DIR --variant NAME --out OUT [--atlas]

Held-out frames: every 10th frame the pose step used (hmr.npz used_frames[::10]; for IMG_7373 frames 0, 20, ...,
740, 38 frames). A prototype must not fit or texture from them; EVAL/heldout.json lists them.

prepare (once per clip; every variant then uses the same masks):
  - the person mask (the pose step's half-size person probability, bilinear to full size, > 0.5) is split between
    everyone the pose network found in that frame: a pixel covered by a body goes to the front-most body there
    (ray cast), any other mask pixel to the nearest body silhouette within `reach` (0.30 m at that body's depth:
    backpacks, hoods, hair), else to nobody;
  - M: person k's share; every other mask pixel (the other player, bystanders) is left out of every number;
  - the table: pixels outside the person mask where world splats below 1.05 m (pipeline/avatar/world.py) stand more
    than 10 cm in front of the person's body (dilated 4 px) are left out of the silhouette numbers, so legs drawn
    behind the table are not counted against a variant (inside the mask the segmenter already left the table out);
  - E: M eroded by 3 px (away from the table, the other people and the background); the pixels the colour numbers
    use.
  Identity comes from the baseline's tracks.npz (person-<k>/det per frame), so person k is the same player for
  every variant.
measure (per variant, CPU): each avatar-<k>.glb is skinned at the frame's media time (its own animation, linear
  keys), seen from that frame's camera (the clip's camera track), ray cast at full resolution (Open3D) and
  textured with trilinear mip sampling (one level per triangle from its texel / pixel area ratio, close to the
  viewer's LINEAR_MIPMAP_LINEAR), unlit, over neutral grey (128). Per held-out frame and person:
    psnr    masked PSNR over E (RGB, 0-255);
    ssim    masked SSIM over E (Gaussian 11 x 11, sigma 1.5, per channel; outside E both images hold the same flat
            colour so a window only compares the person). LPIPS needs AlexNet weights that HiPerGator does not
            hold offline, so SSIM stands in;
    iou     silhouette IoU of the render vs M (uneroded), both minus the other people's mask pixels and the table,
            with precision and recall;
    cover   the fraction of E the render covers.
  The GLBs are matched to the masks' people by silhouette IoU, so a variant may order its files differently.
  Also an 8-view turntable at t = 6.0 s per person (yaw 0 = in front of the person), and per person a 2 x 4 sheet:
  4 held-out frames, the real crop above, the render below. --atlas adds where on each texture the held-out
  colour error lands (error-atlas-<k>.jpg).

Writes OUT/metrics.json, OUT/sheet-person-<k>.jpg, OUT/turntable-t6.00.jpg (and OUT/error-atlas-<k>.jpg).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

from pipeline.avatar.util import log, read_json, write_json

EVERY = 10
GREY = 128.0
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


# ------------------------------------------------------------------------------------------------- glTF


def quat_mat(q: np.ndarray) -> np.ndarray:
    """xyzw quaternions (..., 4) -> rotation matrices (..., 3, 3)."""
    q = np.asarray(q, np.float64)
    q = q / np.maximum(np.linalg.norm(q, axis=-1, keepdims=True), 1e-12)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    R = np.empty(q.shape[:-1] + (3, 3))
    R[..., 0, 0] = 1 - 2 * (y * y + z * z)
    R[..., 0, 1] = 2 * (x * y - z * w)
    R[..., 0, 2] = 2 * (x * z + y * w)
    R[..., 1, 0] = 2 * (x * y + z * w)
    R[..., 1, 1] = 1 - 2 * (x * x + z * z)
    R[..., 1, 2] = 2 * (y * z - x * w)
    R[..., 2, 0] = 2 * (x * z - y * w)
    R[..., 2, 1] = 2 * (y * z + x * w)
    R[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return R


def slerp(a: np.ndarray, b: np.ndarray, u: float) -> np.ndarray:
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + u * (b - a)
    else:
        th = np.arccos(np.clip(d, -1, 1))
        q = (np.sin((1 - u) * th) * a + np.sin(u * th) * b) / np.sin(th)
    return q / np.linalg.norm(q)


class Glb:
    """A skinned, textured glTF binary: the skinned mesh, its skin, the first animation, the base colour image."""

    def __init__(self, path: Path):
        import cv2

        raw = Path(path).read_bytes()
        magic, ver, _ = struct.unpack_from("<III", raw, 0)
        if magic != 0x46546C67 or ver != 2:
            raise ValueError(f"{path}: not a glTF 2 binary")
        o, js, blob = 12, None, None
        while o < len(raw):
            cl, ct = struct.unpack_from("<II", raw, o)
            chunk = raw[o + 8:o + 8 + cl]
            o += 8 + cl
            if ct == 0x4E4F534A:
                js = json.loads(chunk)
            elif ct == 0x004E4942:
                blob = chunk
        self.path, self.js, self.blob = Path(path), js, blob
        nodes = js["nodes"]
        self.parent = np.full(len(nodes), -1, np.int64)
        for i, nd in enumerate(nodes):
            for c in nd.get("children", []):
                self.parent[c] = i
        self.order = []
        stack = [i for i in range(len(nodes)) if self.parent[i] < 0]
        while stack:
            i = stack.pop(0)
            self.order.append(i)
            stack.extend(nodes[i].get("children", []))
        mesh_node = next(i for i, nd in enumerate(nodes) if "mesh" in nd and "skin" in nd)
        prim = js["meshes"][nodes[mesh_node]["mesh"]]["primitives"][0]
        at = prim["attributes"]
        self.P = self.acc(at["POSITION"]).astype(np.float64)
        self.uv = self.acc(at["TEXCOORD_0"]).astype(np.float64)
        self.J = self.acc(at["JOINTS_0"]).astype(np.int64)
        self.W = self.acc(at["WEIGHTS_0"]).astype(np.float64)
        self.W /= np.maximum(self.W.sum(1, keepdims=True), 1e-12)
        self.F = self.acc(prim["indices"]).reshape(-1, 3).astype(np.int64)
        skin = js["skins"][nodes[mesh_node]["skin"]]
        self.joints = np.asarray(skin["joints"], np.int64)
        self.ibm = self.acc(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)  # stored column-major
        self.names = [nd.get("name", "") for nd in nodes]
        self.T0 = np.array([nd.get("translation", [0, 0, 0]) for nd in nodes], np.float64)
        self.R0 = np.array([nd.get("rotation", [0, 0, 0, 1]) for nd in nodes], np.float64)
        self.S0 = np.array([nd.get("scale", [1, 1, 1]) for nd in nodes], np.float64)
        self.M0 = {i: np.array(nd["matrix"], np.float64).reshape(4, 4).T for i, nd in enumerate(nodes) if "matrix" in nd}
        anim = (js.get("animations") or [{"channels": [], "samplers": []}])[0]
        self.channels = []
        for ch in anim["channels"]:
            s = anim["samplers"][ch["sampler"]]
            self.channels.append((ch["target"]["node"], ch["target"]["path"], self.acc(s["input"]).astype(np.float64).reshape(-1),
                                  self.acc(s["output"]).astype(np.float64), s.get("interpolation", "LINEAR")))
        mat = js["materials"][prim.get("material", 0)]
        tex = js["textures"][mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
        img = js["images"][tex["source"]]
        bv = js["bufferViews"][img["bufferView"]]
        data = np.frombuffer(blob, np.uint8, bv["byteLength"], bv.get("byteOffset", 0))
        self.tex = cv2.imdecode(data, cv2.IMREAD_COLOR)[:, :, ::-1].copy()

    def acc(self, i: int) -> np.ndarray:
        a = self.js["accessors"][i]
        bv = self.js["bufferViews"][a["bufferView"]]
        dt, n = CT[a["componentType"]], NC[a["type"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        isz = np.dtype(dt).itemsize * n
        stride = bv.get("byteStride") or isz
        if stride != isz:
            raw = np.frombuffer(self.blob, np.uint8, a["count"] * stride, off).reshape(a["count"], stride)[:, :isz]
            arr = raw.copy().view(dt).reshape(a["count"], n)
        else:
            arr = np.frombuffer(self.blob, dt, a["count"] * n, off).reshape(a["count"], n)
        if a.get("normalized"):
            arr = arr.astype(np.float32) / np.iinfo(dt).max
        return arr[:, 0] if n == 1 else arr

    def node_world(self, t: float) -> np.ndarray:
        """World matrices (nodes, 4, 4) at time t (seconds of the animation)."""
        T, R, S = self.T0.copy(), self.R0.copy(), self.S0.copy()
        for node, path, ti, vals, interp in self.channels:
            if interp == "CUBICSPLINE":
                vals = vals.reshape(len(ti), 3, -1)[:, 1]
            j = int(np.clip(np.searchsorted(ti, t, side="right") - 1, 0, len(ti) - 1))
            j2 = min(j + 1, len(ti) - 1)
            u = 0.0 if j2 == j or interp == "STEP" else float(np.clip((t - ti[j]) / max(ti[j2] - ti[j], 1e-9), 0, 1))
            if path == "rotation":
                R[node] = slerp(vals[j], vals[j2], u)
            elif path == "translation":
                T[node] = (1 - u) * vals[j] + u * vals[j2]
            elif path == "scale":
                S[node] = (1 - u) * vals[j] + u * vals[j2]
        loc = np.tile(np.eye(4), (len(T), 1, 1))
        loc[:, :3, :3] = quat_mat(R) * S[:, None, :]
        loc[:, :3, 3] = T
        for i, M in self.M0.items():
            loc[i] = M
        world = np.zeros_like(loc)
        for i in self.order:
            p = self.parent[i]
            world[i] = loc[i] if p < 0 else world[p] @ loc[i]
        return world

    def pose(self, t: float) -> tuple[np.ndarray, np.ndarray]:
        """Skinned vertices (V, 3) in the glTF world at time t, and the node world matrices."""
        world = self.node_world(t)
        Jm = world[self.joints] @ self.ibm
        M = np.einsum("vk,vkij->vij", self.W, Jm[self.J])
        return np.einsum("vij,vj->vi", M[:, :3, :3], self.P) + M[:, :3, 3], world

    def node(self, prefix: str) -> int:
        return next(i for i, n in enumerate(self.names) if n.startswith(prefix))


# ---------------------------------------------------------------------------------------------- rendering


def to_camera(Vw: np.ndarray, T_view_cv: np.ndarray) -> np.ndarray:
    return (Vw - T_view_cv[:3, 3]) @ T_view_cv[:3, :3]


def mip_pyramid(tex: np.ndarray) -> list[np.ndarray]:
    import cv2

    lv = [tex.astype(np.float32)]
    while min(lv[-1].shape[:2]) > 1:
        h, w = lv[-1].shape[:2]
        lv.append(cv2.resize(lv[-1], (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA))
    return lv


def bilinear_uv(img: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Clamp-to-edge bilinear samples of img (h, w, C) at glTF UVs (N, 2) ((0, 0) = the image's top-left)."""
    h, w = img.shape[:2]
    x = np.clip(uv[:, 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
    x0 = np.minimum(np.floor(x).astype(np.int64), max(w - 2, 0))
    y0 = np.minimum(np.floor(y).astype(np.int64), max(h - 2, 0))
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy) + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy


class TexRenderer:
    """Ray casts one textured mesh from a pinhole camera (cv convention): colour, hit mask, UV, triangle, depth."""

    def __init__(self, K: np.ndarray, width: int, height: int):
        self.K = np.asarray(K, np.float64)
        self.w, self.h = int(width), int(height)
        u, v = np.meshgrid(np.arange(self.w) + 0.5, np.arange(self.h) + 0.5)
        d = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
        self.rays = np.concatenate([np.zeros_like(d), d], -1).reshape(-1, 6).astype(np.float32)
        self.bary_checked = False

    def cast(self, V: np.ndarray, F: np.ndarray):
        import open3d as o3d

        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.core.Tensor(np.ascontiguousarray(V, np.float32)), o3d.core.Tensor(np.ascontiguousarray(F, np.uint32)))
        ans = scene.cast_rays(o3d.core.Tensor(self.rays))
        t = ans["t_hit"].numpy().reshape(self.h, self.w)
        prim = ans["primitive_ids"].numpy().astype(np.int64).reshape(self.h, self.w)
        b = ans["primitive_uvs"].numpy().reshape(self.h, self.w, 2).astype(np.float64)
        hit = np.isfinite(t)
        prim[~hit] = -1
        if not self.bary_checked and hit.any():
            ys, xs = np.nonzero(hit)
            s = slice(None, None, max(1, len(ys) // 2000))
            ys, xs = ys[s], xs[s]
            p = prim[ys, xs]
            X = self.rays[ys * self.w + xs, 3:] * t[ys, xs, None]
            w1, w2 = b[ys, xs, 0:1], b[ys, xs, 1:2]
            Xb = (1 - w1 - w2) * V[F[p, 0]] + w1 * V[F[p, 1]] + w2 * V[F[p, 2]]
            err = float(np.abs(X - Xb).max())
            if err > 2e-3:
                raise RuntimeError(f"Open3D barycentric convention differs from (1-u-v, u, v): {err:.4f} m")
            self.bary_checked = True
        return t, hit, prim, b

    def render(self, V: np.ndarray, F: np.ndarray, uv: np.ndarray, pyr: list[np.ndarray] | None, bg: float = GREY):
        """V (cv camera, metres). Returns rgb float32 (h, w, 3) over `bg`, hit (h, w), uv image (h, w, 2), triangle
        (h, w) (-1 = miss), depth (h, w)."""
        t, hit, prim, b = self.cast(V, F)
        uvi = np.zeros((self.h, self.w, 2))
        rgb = np.full((self.h, self.w, 3), bg, np.float32)
        if not hit.any():
            return rgb, hit, uvi, prim, t
        p = prim[hit]
        w1, w2 = b[hit, 0:1], b[hit, 1:2]
        uvh = (1 - w1 - w2) * uv[F[p, 0]] + w1 * uv[F[p, 1]] + w2 * uv[F[p, 2]]
        uvi[hit] = uvh
        if pyr is not None:
            # one mip level per triangle: sqrt(texel area / pixel area) texels per pixel
            z = np.maximum(V[:, 2], 1e-6)
            px = np.stack([self.K[0, 0] * V[:, 0] / z, self.K[1, 1] * V[:, 1] / z], 1)
            a_px = 0.5 * np.abs(np.cross(px[F[:, 1]] - px[F[:, 0]], px[F[:, 2]] - px[F[:, 0]]))
            S = pyr[0].shape[0] * pyr[0].shape[1]
            a_uv = 0.5 * np.abs(np.cross(uv[F[:, 1]] - uv[F[:, 0]], uv[F[:, 2]] - uv[F[:, 0]])) * S
            lev = 0.5 * np.log2(np.maximum(a_uv / np.maximum(a_px, 1e-9), 1.0))
            L = np.clip(lev[p], 0, len(pyr) - 1)
            l0 = np.floor(L).astype(np.int64)
            fr = (L - l0)[:, None]
            col = np.zeros((len(p), 3), np.float32)
            for lv in np.unique(l0):
                s = l0 == lv
                c0 = bilinear_uv(pyr[lv], uvh[s])
                c1 = bilinear_uv(pyr[min(lv + 1, len(pyr) - 1)], uvh[s])
                col[s] = c0 * (1 - fr[s]) + c1 * fr[s]
            rgb[hit] = col
        return rgb, hit, uvi, prim, t


def ssim_masked(a: np.ndarray, b: np.ndarray, E: np.ndarray) -> float:
    """Mean SSIM over E of two RGB float images; outside E both hold E's mean real colour."""
    import cv2

    if not E.any():
        return float("nan")
    fill = a[E].mean(0)
    A = np.where(E[..., None], a, fill).astype(np.float64)
    B = np.where(E[..., None], b, fill).astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    vals = []
    for c in range(3):
        x, y = A[..., c], B[..., c]
        g = lambda im: cv2.GaussianBlur(im, (11, 11), 1.5)  # noqa: E731
        mx, my = g(x), g(y)
        sxx, syy, sxy = g(x * x) - mx * mx, g(y * y) - my * my, g(x * y) - mx * my
        m = ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx * mx + my * my + C1) * (sxx + syy + C2))
        vals.append(m[E].mean())
    return float(np.mean(vals))


def score(real: np.ndarray, rgb: np.ndarray, hit: np.ndarray, M: np.ndarray, E: np.ndarray, Vd: np.ndarray) -> dict:
    """The yardstick's numbers for one person in one frame (see the module docstring)."""
    mse = float(((rgb - real)[E] ** 2).mean())
    inter = np.count_nonzero(hit & M & Vd)
    return {"evalPx": int(E.sum()), "psnr": round(10 * np.log10(255.0 ** 2 / max(mse, 1e-6)), 3), "mse": round(mse, 2),
            "ssim": round(ssim_masked(real, rgb, E), 4),
            "iou": round(inter / max(1, np.count_nonzero((hit | M) & Vd)), 4),
            "precision": round(inter / max(1, np.count_nonzero(hit & Vd)), 4),
            "recall": round(inter / max(1, np.count_nonzero(M & Vd)), 4),
            "cover": round(np.count_nonzero(hit & E) / max(1, E.sum()), 4)}


def box_of(m: np.ndarray, pad: float = 0.08, aspect: float | None = None, hw: tuple[int, int] | None = None):
    ys, xs = np.nonzero(m)
    if len(ys) == 0:
        return None
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    p = int(pad * max(y1 - y0, x1 - x0))
    y0, y1, x0, x1 = y0 - p, y1 + p, x0 - p, x1 + p
    if aspect:  # width / height
        cy, cx, hh, ww = (y0 + y1) / 2, (x0 + x1) / 2, y1 - y0, x1 - x0
        if ww / hh < aspect:
            ww = hh * aspect
        else:
            hh = ww / aspect
        y0, y1, x0, x1 = int(cy - hh / 2), int(cy + hh / 2), int(cx - ww / 2), int(cx + ww / 2)
    return int(y0), int(y1), int(x0), int(x1)


def crop(img: np.ndarray, box, size: tuple[int, int], fill=GREY) -> np.ndarray:
    """img[box] with out-of-frame parts filled, resized to size (w, h)."""
    import cv2

    y0, y1, x0, x1 = box
    h, w = img.shape[:2]
    out = np.full((y1 - y0, x1 - x0) + img.shape[2:], fill, img.dtype)
    sy0, sy1, sx0, sx1 = max(0, y0), min(h, y1), max(0, x0), min(w, x1)
    if sy1 > sy0 and sx1 > sx0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
    return cv2.resize(out, size, interpolation=cv2.INTER_AREA)


def label(img: np.ndarray, text: str, y: int = 18, scale: float = 0.5) -> np.ndarray:
    import cv2

    cv2.putText(img, text, (6, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, (6, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def look_at(eye: np.ndarray, target: np.ndarray, up=np.array([0.0, 1.0, 0.0])) -> np.ndarray:
    """T_view_cv (camera-to-world, cv axes: x right, y down, z forward)."""
    z = target - eye
    z /= np.linalg.norm(z)
    x = np.cross(-up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    T = np.eye(4)
    T[:3, :3] = np.stack([x, y, z], 1)
    T[:3, 3] = eye
    return T


def facing(g: Glb, world: np.ndarray) -> np.ndarray:
    """The person's forward direction on the floor (glTF: +x is the body's left, y up, so forward = left x up)."""
    try:
        L, R = world[g.node("upperarm01.L"), :3, 3], world[g.node("upperarm01.R"), :3, 3]
    except StopIteration:
        return np.array([0.0, 0.0, 1.0])
    f = np.cross(L - R, [0.0, 1.0, 0.0])
    f[1] = 0
    return f / max(np.linalg.norm(f), 1e-9)


def turntable(glbs: list[Glb], t: float, views: int = 8, size: tuple[int, int] = (360, 540), dist: float = 3.0,
              textures: list[np.ndarray] | None = None, names: list[str] | None = None) -> np.ndarray:
    """Rows = people, columns = yaw 0, 45, ... (yaw 0 in front of the person), over neutral grey."""
    w, h = size
    fx = 0.9 * h * dist / 2.0
    K = np.array([[fx, 0, w / 2], [0, fx, h / 2], [0, 0, 1.0]])
    r = TexRenderer(K, w, h)
    rows = []
    for k, g in enumerate(glbs):
        Vw, world = g.pose(t)
        c = 0.5 * (Vw.min(0) + Vw.max(0))
        fwd = facing(g, world)
        pyr = mip_pyramid(textures[k] if textures is not None else g.tex)
        row = []
        for i in range(views):
            a = 2 * np.pi * i / views
            d = np.cos(a) * fwd + np.sin(a) * np.cross([0.0, 1.0, 0.0], fwd)
            eye = c + dist * d + np.array([0, 0.35, 0])
            T = look_at(eye, c)
            rgb, *_ = r.render(to_camera(Vw, T), g.F, g.uv, pyr)
            im = np.clip(rgb + 0.5, 0, 255).astype(np.uint8)[:, :, ::-1].copy()
            row.append(label(im, f"{(names or [g.path.stem] * len(glbs))[k]} yaw {int(round(np.degrees(a)))} t={t:.2f}s", scale=0.45))
        rows.append(np.concatenate(row, 1))
    return np.concatenate(rows, 0)


# ------------------------------------------------------------------------------------------------ prepare


def partition(U: np.ndarray, Vs: list[np.ndarray], tris: np.ndarray, K: np.ndarray, rend, reach_m: float = 0.30) -> np.ndarray:
    """Owner (index into Vs, -1 = nobody) of every pixel: a pixel a body covers belongs to the front-most body there
    (ray cast with rend, a raster.DepthRenderer at full size); any other mask pixel (U) to the nearest body
    silhouette within reach_m at that body's depth."""
    import cv2

    from pipeline.avatar import raster

    H, W = U.shape
    owner = np.full((H, W), -1, np.int64)
    if not Vs:
        return owner
    _, mid, _, _ = rend.render([(V, tris) for V in Vs])
    owner[mid >= 0] = mid[mid >= 0]
    D = np.full((len(Vs), H, W), np.inf, np.float32)
    for i, V in enumerate(Vs):
        S = raster.silhouette(V, tris, K, (H, W))
        dt = cv2.distanceTransform((~S).astype(np.uint8), cv2.DIST_L2, 5)
        reach = reach_m * K[0, 0] / max(float(np.median(V[:, 2])), 0.3)
        D[i] = np.where(dt <= reach, dt, np.inf)
    rest = U & (owner < 0) & np.isfinite(D.min(0))
    owner[rest] = np.argmin(D, 0)[rest]
    return owner


def prepare(work: Path, poses: Path, world: Path | None, out: Path, every: int = EVERY, reach_m: float = 0.30,
            erode_px: int = 3, table_margin: float = 0.10) -> dict:
    import cv2

    from pipeline.avatar import raster
    from pipeline.avatar.body import Asset
    from pipeline.avatar.ground import camera_track

    out.mkdir(parents=True, exist_ok=True)
    (out / "evidence").mkdir(exist_ok=True)
    h = np.load(work / "hmr.npz")
    tr = np.load(work / "tracks.npz")
    K, v3d, det_frame = h["K"], h["v3d"], h["frame"]
    used, all_t = h["used_frames"], h["all_times"]
    held = used[::every]
    n_people = sum(1 for k in tr.files if k.endswith("/rest_vertices"))
    a0 = Asset.load(work / "asset-0.npz")
    tris = a0.src_vertex[a0.tris]
    cams = camera_track(read_json(poses))
    occ = None
    if world is not None and Path(world).exists():
        from pipeline.avatar.world import Occluders

        occ = Occluders(Path(world))
    sigma = [float(tr.get(f"person-{k}/body_scale", 1.0)) for k in range(n_people)]
    start = float(read_json(work / "inputs.json", {}).get("start", 0.0))
    arrays: dict[str, np.ndarray] = {"K": K, "frames": held}
    rows = []
    se_d = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * erode_px + 1, 2 * erode_px + 1))
    se_t = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    rend = None
    for n, f in enumerate(held):
        f = int(f)
        img = cv2.imread(str(work / "frames" / f"f{f:06d}.jpg"))
        prob = cv2.imread(str(work / "masks" / f"f{f:06d}.png"), cv2.IMREAD_GRAYSCALE)
        H, W = img.shape[:2]
        if rend is None:
            rend = raster.DepthRenderer(K, W, H, scale=1.0)
        U = cv2.resize(prob, (W, H), interpolation=cv2.INTER_LINEAR) > 127
        dets = np.nonzero(det_frame == f)[0]
        Vs = [v3d[d].astype(np.float64) for d in dets]
        owner = partition(U, Vs, tris, K, rend, reach_m)
        furn = None
        if occ is not None and f in cams:
            Tf = cams[f]
            sig_of = {}
            for k in range(n_people):
                i = np.nonzero(tr[f"person-{k}/frames"] == f)[0]
                if len(i) and tr[f"person-{k}/det"][i[0]] >= 0:
                    sig_of[int(tr[f"person-{k}/det"][i[0]])] = sigma[k]
            bodies = [(sig_of.get(int(o), 1.0) * v3d[o][::4].astype(np.float64)) @ Tf[:3, :3].T + Tf[:3, 3] for o in dets]
            furn = cv2.resize(occ.depth(Tf, K, (H, W), bodies, scale=0.25), (W, H), interpolation=cv2.INTER_NEAREST)
        row = {"frame": f, "time": round(float(all_t[f] - start), 6), "detections": int(len(dets)), "people": {}}
        vis = cv2.resize(img, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
        over = vis.copy()
        mine = np.zeros((H, W), bool)
        for k in range(n_people):
            i = np.nonzero(tr[f"person-{k}/frames"] == f)[0]
            d = int(tr[f"person-{k}/det"][i[0]]) if len(i) else -1
            if d < 0 or d not in set(dets.tolist()):
                row["people"][str(k)] = None
                continue
            ik = int(np.nonzero(dets == d)[0][0])
            M = U & (owner == ik)
            mine |= M
            others = U & ~M
            Vk = Vs[ik]
            T = np.zeros((H, W), bool)
            if furn is not None:
                dk, _, _, _ = rend.render([(Vk, tris)])
                zmap = np.where(np.isfinite(dk), dk, float(np.median(Vk[:, 2])))
                # only where the person mask says 'not a person': the world also holds faint copies of the people
                # (a backpack more than 10 cm off the body survives the body gap), which must not hide the person
                T = (cv2.dilate((furn < sigma[k] * zmap - table_margin).astype(np.uint8), se_t) > 0) & ~U
            E = (cv2.erode(M.astype(np.uint8), se_d) > 0) & ~T
            valid = ~others & ~T
            box = box_of(M | E)
            uvd = raster.project(K, Vk[::4])
            in_frame = float(((uvd[:, 0] >= 0) & (uvd[:, 0] < W) & (uvd[:, 1] >= 0) & (uvd[:, 1] < H)).mean())
            pre = f"f{f}/p{k}/"
            arrays[pre + "M"] = np.packbits(M)
            arrays[pre + "E"] = np.packbits(E)
            arrays[pre + "V"] = np.packbits(valid)
            row["people"][str(k)] = {"det": d, "maskPx": int(M.sum()), "evalPx": int(E.sum()), "tablePx": int((T & U).sum()),
                                     "inFrame": round(in_frame, 3), "box": list(box) if box else None}
            col = np.array([(0, 170, 255), (255, 140, 0)][k % 2], np.uint8)
            small = cv2.resize(E.astype(np.uint8), (W // 2, H // 2), interpolation=cv2.INTER_NEAREST) > 0
            over[small] = col
            st = cv2.resize(T.astype(np.uint8), (W // 2, H // 2), interpolation=cv2.INTER_NEAREST) > 0
            over[st & ~small] = (90, 90, 90)
        rest_small = cv2.resize((U & ~mine).astype(np.uint8), (W // 2, H // 2), interpolation=cv2.INTER_NEAREST) > 0
        over[rest_small] = (40, 40, 220)
        if n % 6 == 0:
            ev = cv2.addWeighted(vis, 0.45, over, 0.55, 0)
            label(ev, f"frame {f}: E person 0 orange, person 1 blue; other people red; table grey")
            cv2.imwrite(str(out / "evidence" / f"partition-f{f:06d}.jpg"), ev, [cv2.IMWRITE_JPEG_QUALITY, 85])
        rows.append(row)
        log("yardstick", f"held-out frame {f} ({n + 1}/{len(held)}): {row['people']}")
    np.savez_compressed(out / "heldout.npz", **arrays)
    meta = {"work": str(work), "poses": str(poses), "world": str(world) if world else None, "every": every,
            "frames": [int(f) for f in held], "people": n_people, "width": int(W), "height": int(H),
            "reachM": reach_m, "erodePx": erode_px, "tableMarginM": table_margin, "rows": rows,
            "cameras": {str(int(f)): cams[int(f)].tolist() for f in held if int(f) in cams}}
    write_json(out / "heldout.json", meta)
    return meta


# ------------------------------------------------------------------------------------------------ measure


def load_masks(eval_dir: Path):
    meta = read_json(eval_dir / "heldout.json")
    data = np.load(eval_dir / "heldout.npz")
    H, W = meta["height"], meta["width"]

    def get(f: int, k: int, name: str):
        key = f"f{f}/p{k}/{name}"
        if key not in data.files:
            return None
        return np.unpackbits(data[key])[: H * W].reshape(H, W).astype(bool)

    return meta, data, get


def match_people(glbs: list[Glb], meta: dict, get, rend: TexRenderer, n_try: int = 6) -> list[int]:
    """For every eval person, the GLB whose silhouette agrees with its masks best (Hungarian on mean IoU)."""
    from scipy.optimize import linear_sum_assignment

    n_people = meta["people"]
    frames = [r["frame"] for r in meta["rows"] if all(r["people"].get(str(k)) for k in range(n_people))]
    frames = frames[:: max(1, len(frames) // n_try)][:n_try]
    C = np.zeros((n_people, len(glbs)))
    for f in frames:
        T = np.asarray(meta["cameras"][str(f)])
        t = next(r["time"] for r in meta["rows"] if r["frame"] == f)
        sils = []
        for g in glbs:
            Vw, _ = g.pose(t)
            sils.append(rend.cast(to_camera(Vw, T), g.F)[1])
        for k in range(n_people):
            M, Vd = get(f, k, "M"), get(f, k, "V")
            for j, S in enumerate(sils):
                C[k, j] += np.count_nonzero(S & M & Vd) / max(1, np.count_nonzero((S | M) & Vd))
    r, c = linear_sum_assignment(-C)
    out = [-1] * n_people
    for a, b in zip(r, c):
        out[a] = int(b)
    return out


def measure(eval_dir: Path, glb_dir: Path, variant: str, out: Path, atlas: bool = False, t_turn: float = 6.0,
            frames_dir: Path | None = None, textures: dict | None = None) -> dict:
    """`textures` {glb index: (S, S, 3) uint8} replaces a GLB's own texture (diagnostic renders)."""
    import cv2

    out.mkdir(parents=True, exist_ok=True)
    meta, data, get = load_masks(eval_dir)
    frames_dir = Path(frames_dir or Path(meta["work"]) / "frames")
    files = sorted(Path(glb_dir).glob("avatar-*.glb"), key=lambda p: int(p.stem.split("-")[-1]))
    glbs = [Glb(p) for p in files]
    texs = [(textures or {}).get(j, g.tex) for j, g in enumerate(glbs)]
    pyrs = [mip_pyramid(t) for t in texs]
    K = np.asarray(data["K"], np.float64)
    W, H = meta["width"], meta["height"]
    rend = TexRenderer(K, W, H)
    which = match_people(glbs, meta, get, rend)
    log("yardstick", f"{variant}: eval person -> glb {[files[j].name if j >= 0 else None for j in which]}")
    n_people = meta["people"]
    per: list[list[dict]] = [[] for _ in range(n_people)]
    crops: list[list] = [[] for _ in range(n_people)]
    A = 512
    err_sum = [np.zeros((A, A), np.float64) for _ in range(n_people)]
    err_n = [np.zeros((A, A), np.float64) for _ in range(n_people)]
    for row in meta["rows"]:
        f, t = row["frame"], row["time"]
        real = cv2.imread(str(frames_dir / f"f{f:06d}.jpg"))[:, :, ::-1].astype(np.float32)
        T = np.asarray(meta["cameras"][str(f)])
        for k in range(n_people):
            if not row["people"].get(str(k)) or which[k] < 0:
                continue
            g = glbs[which[k]]
            M, E, Vd = get(f, k, "M"), get(f, k, "E"), get(f, k, "V")
            Vw, _ = g.pose(t)
            rgb, hit, uvi, _, _ = rend.render(to_camera(Vw, T), g.F, g.uv, pyrs[which[k]])
            if E.sum() < 200:
                continue
            d = rgb - real
            r = dict({"frame": f, "time": t}, **score(real, rgb, hit, M, E, Vd))
            per[k].append(r)
            box = box_of(M | (hit & Vd), pad=0.06, aspect=0.75)
            if box:
                crops[k].append((r, crop(real, box, (300, 400)), crop(rgb, box, (300, 400))))
            if atlas:
                s = E & hit
                u = np.clip((uvi[s, 0] * A).astype(np.int64), 0, A - 1)
                v = np.clip((uvi[s, 1] * A).astype(np.int64), 0, A - 1)
                np.add.at(err_sum[k], (v, u), np.abs(d[s]).mean(1))
                np.add.at(err_n[k], (v, u), 1)
        log("yardstick", f"{variant} frame {f}: " + "; ".join(f"p{k} {per[k][-1]['psnr']} dB iou {per[k][-1]['iou']}"
                                                              for k in range(n_people) if per[k] and per[k][-1]["frame"] == f))
    summary = {}
    for k in range(n_people):
        rs = per[k]
        if not rs:
            continue
        mse_pool = sum(r["mse"] * r["evalPx"] for r in rs) / sum(r["evalPx"] for r in rs)
        summary[f"person-{k}"] = {
            "glb": files[which[k]].name, "frames": len(rs),
            "psnr": round(float(np.mean([r["psnr"] for r in rs])), 3),
            "psnrPooled": round(10 * np.log10(255.0 ** 2 / mse_pool), 3),
            "ssim": round(float(np.mean([r["ssim"] for r in rs])), 4),
            "iou": round(float(np.mean([r["iou"] for r in rs])), 4),
            "iouMedian": round(float(np.median([r["iou"] for r in rs])), 4),
            "precision": round(float(np.mean([r["precision"] for r in rs])), 4),
            "recall": round(float(np.mean([r["recall"] for r in rs])), 4),
            "cover": round(float(np.mean([r["cover"] for r in rs])), 4),
            "lpips": None,
        }
    doc = {"variant": variant, "glbDir": str(glb_dir), "eval": str(eval_dir), "heldOutFrames": meta["frames"],
           "perceptual": "SSIM (LPIPS AlexNet weights not available offline on HiPerGator)", "summary": summary,
           "perFrame": {f"person-{k}": per[k] for k in range(n_people)}}
    write_json(out / "metrics.json", doc)
    # sheets: 4 held-out frames spread over the clip, among those that show most of the person
    for k in range(n_people):
        cs = crops[k]
        if not cs:
            continue
        big = max(c[0]["evalPx"] for c in cs)
        good = [c for c in cs if c[0]["evalPx"] >= 0.3 * big]
        pick = [good[int(round(i))] for i in np.linspace(0, len(good) - 1, 4)] if len(good) >= 4 else good
        top, bot = [], []
        for r, a, b in pick:
            a = a.astype(np.uint8)[:, :, ::-1].copy()
            b = np.clip(b + 0.5, 0, 255).astype(np.uint8)[:, :, ::-1].copy()
            label(a, f"real f{r['frame']} t={r['time']:.2f}s")
            label(b, f"{variant}: {r['psnr']:.1f} dB ssim {r['ssim']:.2f} iou {r['iou']:.2f}", scale=0.42)
            top.append(a)
            bot.append(b)
        sheet = np.concatenate([np.concatenate(top, 1), np.concatenate(bot, 1)], 0)
        cv2.imwrite(str(out / f"sheet-person-{k}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    order = [which[k] for k in range(n_people) if which[k] >= 0]
    tt = turntable([glbs[j] for j in order], t_turn, textures=[texs[j] for j in order],
                   names=[f"person-{k}" for k in range(n_people) if which[k] >= 0])
    cv2.imwrite(str(out / f"turntable-t{t_turn:.2f}.jpg"), tt, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if atlas:
        for k in range(n_people):
            if which[k] < 0:
                continue
            m = err_sum[k] / np.maximum(err_n[k], 1)
            heat = cv2.applyColorMap(np.clip(m * 255 / 80.0, 0, 255).astype(np.uint8), cv2.COLORMAP_TURBO)
            base = cv2.resize(texs[which[k]], (A, A), interpolation=cv2.INTER_AREA)[:, :, ::-1]
            img = np.where((err_n[k] > 0)[..., None], cv2.addWeighted(base, 0.35, heat, 0.65, 0), (base * 0.3).astype(np.uint8))
            img = np.concatenate([base, img], 1)
            label(img, f"person-{k} texture | held-out mean abs error per texel (0-80, turbo)")
            cv2.imwrite(str(out / f"error-atlas-{k}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
            np.savez_compressed(out / f"error-atlas-{k}.npz", sum=err_sum[k].astype(np.float32), n=err_n[k].astype(np.float32))
    log("yardstick", f"{variant}: {summary}")
    return doc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--work", required=True)
    p.add_argument("--poses", required=True)
    p.add_argument("--world", default=None)
    p.add_argument("--eval", required=True)
    p.add_argument("--every", type=int, default=EVERY)
    m = sub.add_parser("measure")
    m.add_argument("--eval", required=True)
    m.add_argument("--glb-dir", required=True)
    m.add_argument("--variant", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--frames", default=None, help="frames folder (default: the prepare step's WORK/frames)")
    m.add_argument("--atlas", action="store_true")
    m.add_argument("--turntable-t", type=float, default=6.0)
    a = ap.parse_args(argv)
    if a.cmd == "prepare":
        prepare(Path(a.work), Path(a.poses), Path(a.world) if a.world else None, Path(a.eval), a.every)
    else:
        measure(Path(a.eval), Path(a.glb_dir), a.variant, Path(a.out), a.atlas, a.turntable_t,
                Path(a.frames) if a.frames else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
