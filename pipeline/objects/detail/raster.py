"""A small numpy z-buffer rasteriser: render a textured mesh from the same pinhole cameras the splats were rendered
from (`views.json`: OpenGL camera-to-world, fx fy cx cy, width height). No GPU, no OpenGL, so it runs in tests and on
any PACE node. Projection matches `splat_io.render_points`: u = cx + fx x/z, v = cy - fy y/z, z = -camera z.

Fully vectorised: every triangle's bounding box is expanded into candidate pixels in batches, barycentrics are
tested at pixel centres and the nearest hit per pixel wins. Fine for the 20k-triangle objects at 512-1024 px.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from objects.detail.glb import Prim

NEAR = 1e-3


@dataclass
class Camera:
    c2w: np.ndarray  # 4x4 OpenGL camera-to-world
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    name: str = ""

    @classmethod
    def from_view(cls, v: dict, name: str = "") -> "Camera":
        return cls(np.asarray(v["c2w"], np.float64), float(v["fx"]), float(v["fy"]), float(v["cx"]), float(v["cy"]),
                   int(v["width"]), int(v["height"]), name or str(v.get("file", v.get("image", v.get("name", "")))))

    def scaled(self, width: int) -> "Camera":
        s = width / self.width
        return Camera(self.c2w, self.fx * s, self.fy * s, self.cx * s, self.cy * s, width,
                      int(round(self.height * s)), self.name)


@dataclass
class Frame:
    rgb: np.ndarray  # [h, w, 3] float 0..1
    depth: np.ndarray  # [h, w] z metres, 0 where empty
    mask: np.ndarray  # [h, w] bool
    normal: np.ndarray  # [h, w, 3] world-space shading normal, 0 where empty


def look_at(eye, target, up=(0.0, 1.0, 0.0)) -> np.ndarray:
    eye = np.asarray(eye, np.float64)
    f = np.asarray(target, np.float64) - eye
    f /= max(np.linalg.norm(f), 1e-12)
    up = np.asarray(up, np.float64)
    if abs(f @ up) > 0.98:
        up = np.array([0.0, 0.0, -1.0])
    x = np.cross(f, up)
    x /= np.linalg.norm(x)
    y = np.cross(x, f)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, -f, eye
    return m


def project(P: np.ndarray, cam: Camera) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    R, t = cam.c2w[:3, :3], cam.c2w[:3, 3]
    pc = (np.asarray(P, np.float64) - t) @ R
    z = -pc[:, 2]
    zs = np.where(z > NEAR, z, 1.0)
    return cam.cx + cam.fx * pc[:, 0] / zs, cam.cy - cam.fy * pc[:, 1] / zs, z


def _sample(image: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Bilinear sample with clamp (the GLB sampler is clamp-to-edge); glTF uv has v down from the top row."""
    h, w = image.shape[:2]
    x = np.clip(uv[:, 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    ax, ay = (x - x0)[:, None], (y - y0)[:, None]
    img = image.astype(np.float64) / (255.0 if image.dtype == np.uint8 else 1.0)
    top = img[y0, x0] * (1 - ax) + img[y0, x1] * ax
    bot = img[y1, x0] * (1 - ax) + img[y1, x1] * ax
    return top * (1 - ay) + bot * ay


def render(prims: list[Prim], cam: Camera, background: float = 0.0, batch: int = 4_000_000) -> Frame:
    W, H = cam.width, cam.height
    zbuf = np.full(H * W, np.inf)
    owner_prim = np.full(H * W, -1, np.int64)
    owner_face = np.zeros(H * W, np.int64)
    bary = np.zeros((H * W, 3))
    for pi, p in enumerate(prims):
        if len(p.F) == 0:
            continue
        u, v, z = project(p.V, cam)
        F = p.F
        tz = z[F]
        keep = (tz > NEAR).all(axis=1)  # objects are viewed from outside; drop triangles crossing the near plane
        tu, tv = u[F], v[F]
        x0 = np.clip(np.floor(tu.min(axis=1) - 0.5), 0, W).astype(np.int64)
        x1 = np.clip(np.ceil(tu.max(axis=1) - 0.5), -1, W - 1).astype(np.int64)
        y0 = np.clip(np.floor(tv.min(axis=1) - 0.5), 0, H).astype(np.int64)
        y1 = np.clip(np.ceil(tv.max(axis=1) - 0.5), -1, H - 1).astype(np.int64)
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        keep &= (bw > 0) & (bh > 0)
        area = (tu[:, 1] - tu[:, 0]) * (tv[:, 2] - tv[:, 0]) - (tu[:, 2] - tu[:, 0]) * (tv[:, 1] - tv[:, 0])
        keep &= np.abs(area) > 1e-12
        faces = np.nonzero(keep)[0]
        counts = (bw * bh)[faces]
        start = 0
        while start < len(faces):
            cum = np.cumsum(counts[start:])
            stop = start + max(1, int(np.searchsorted(cum, batch, side="right")))
            fs, cn = faces[start:stop], counts[start:stop]
            start = stop
            fi = np.repeat(fs, cn)
            local = np.arange(cn.sum()) - np.repeat(np.cumsum(cn) - cn, cn)
            px = x0[fi] + local % bw[fi]
            py = y0[fi] + local // bw[fi]
            sx, sy = px + 0.5, py + 0.5
            U, Vv, A = tu[fi], tv[fi], area[fi]
            w0 = ((U[:, 1] - sx) * (Vv[:, 2] - sy) - (U[:, 2] - sx) * (Vv[:, 1] - sy)) / A
            w1 = ((U[:, 2] - sx) * (Vv[:, 0] - sy) - (U[:, 0] - sx) * (Vv[:, 2] - sy)) / A
            w2 = 1.0 - w0 - w1
            inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
            if not inside.any():
                continue
            fi, px, py = fi[inside], px[inside], py[inside]
            b = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
            iz = 1.0 / tz[fi]  # perspective-correct: interpolate 1/z
            invz = (b * iz).sum(axis=1)
            depth = 1.0 / invz
            pix = py * W + px
            order = np.lexsort((depth, pix))
            pix, depth = pix[order], depth[order]
            first = np.ones(len(pix), bool)
            first[1:] = pix[1:] != pix[:-1]
            sel = order[first]
            pix, depth = pix[first], depth[first]
            better = depth < zbuf[pix]
            pix, sel = pix[better], sel[better]
            zbuf[pix] = depth[better]
            owner_prim[pix] = pi
            owner_face[pix] = fi[sel]
            pb = b[sel] * iz[sel]
            bary[pix] = pb / pb.sum(axis=1, keepdims=True)
    mask = owner_prim >= 0
    rgb = np.full((H * W, 3), float(background))
    normal = np.zeros((H * W, 3))
    for pi, p in enumerate(prims):
        hit = np.nonzero(owner_prim == pi)[0]
        if len(hit) == 0:
            continue
        tri = p.F[owner_face[hit]]
        b = bary[hit][:, :, None]
        if p.image is not None and p.UV is not None:
            rgb[hit] = _sample(p.image, (p.UV[tri] * b).sum(axis=1))
        elif p.colours is not None:
            rgb[hit] = (p.colours[tri] * b).sum(axis=1)
        else:
            rgb[hit] = 0.7
        if p.N is not None:
            n = (p.N[tri] * b).sum(axis=1)
        else:
            e1, e2 = p.V[tri[:, 1]] - p.V[tri[:, 0]], p.V[tri[:, 2]] - p.V[tri[:, 0]]
            n = np.cross(e1, e2)
        normal[hit] = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    depth = np.where(mask, zbuf, 0.0)
    return Frame(rgb.reshape(H, W, 3), depth.reshape(H, W), mask.reshape(H, W), normal.reshape(H, W, 3))


def orbit_cameras(centre, extent: float, count: int = 12, size: int = 1024, fov_deg: float = 50.0,
                  elevations=(0.0, 25.0, 50.0), top: bool = True) -> list[Camera]:
    """Object-centric cameras on rings around a box, like `objects.mesh.orbit_views` but as plain pinholes."""
    centre = np.asarray(centre, np.float64)
    radius = extent * 1.7 + 0.4
    f = (size / 2.0) / np.tan(np.deg2rad(fov_deg) / 2.0)
    cams: list[Camera] = []
    per = max(1, count // len(elevations))
    for ei, el in enumerate(elevations):
        for k in range(per):
            az = 2 * np.pi * (k + 0.5 * (ei % 2)) / per
            e = np.deg2rad(el)
            eye = centre + radius * np.array([np.cos(e) * np.sin(az), np.sin(e), np.cos(e) * np.cos(az)])
            cams.append(Camera(look_at(eye, centre), f, f, size / 2.0, size / 2.0, size, size, f"orbit_{len(cams):02d}"))
    if top:
        eye = centre + np.array([0.0, radius, 0.0])
        cams.append(Camera(look_at(eye, centre), f, f, size / 2.0, size / 2.0, size, size, f"orbit_{len(cams):02d}"))
    return cams
