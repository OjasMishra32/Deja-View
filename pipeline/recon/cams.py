"""COLMAP camera models: parameters, projection with distortion, and undistortion to a pinhole camera.

Supported models: SIMPLE_PINHOLE, PINHOLE, SIMPLE_RADIAL, RADIAL, OPENCV. Pixel centres are at +0.5 (COLMAP's
convention, the same as common/camera.py). Poses follow COLMAP: world-to-camera, OpenCV axes (x right, y down,
z forward), quaternions wxyz.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Camera:
    model: str
    width: int
    height: int
    params: np.ndarray

    @property
    def f(self) -> tuple[float, float]:
        p = self.params
        if self.model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"):
            return float(p[0]), float(p[0])
        return float(p[0]), float(p[1])

    @property
    def c(self) -> tuple[float, float]:
        p = self.params
        if self.model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"):
            return float(p[1]), float(p[2])
        return float(p[2]), float(p[3])

    def K(self) -> np.ndarray:
        (fx, fy), (cx, cy) = self.f, self.c
        return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)

    def distortion(self) -> dict:
        p = self.params
        if self.model == "SIMPLE_RADIAL":
            return {"k1": float(p[3])}
        if self.model == "RADIAL":
            return {"k1": float(p[3]), "k2": float(p[4])}
        if self.model == "OPENCV":
            return {"k1": float(p[4]), "k2": float(p[5]), "p1": float(p[6]), "p2": float(p[7])}
        return {}

    def distort(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Normalized undistorted coordinates -> normalized distorted coordinates."""
        d = self.distortion()
        if not d:
            return x, y
        r2 = x * x + y * y
        radial = 1.0 + d.get("k1", 0.0) * r2 + d.get("k2", 0.0) * r2 * r2
        p1, p2 = d.get("p1", 0.0), d.get("p2", 0.0)
        xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        return xd, yd

    def project(self, pts_cam: np.ndarray) -> np.ndarray:
        """Camera-frame points [N,3] -> pixels [N,2] (with distortion)."""
        z = pts_cam[:, 2]
        x, y = pts_cam[:, 0] / z, pts_cam[:, 1] / z
        xd, yd = self.distort(x, y)
        (fx, fy), (cx, cy) = self.f, self.c
        return np.stack([fx * xd + cx, fy * yd + cy], axis=1)

    def is_pinhole(self, tol_px: float = 0.25) -> bool:
        """True when the distortion moves no pixel of the image by more than tol_px."""
        if not self.distortion():
            return True
        (fx, fy), (cx, cy) = self.f, self.c
        u = np.array([0, self.width, 0, self.width, self.width / 2, 0], np.float64)
        v = np.array([0, 0, self.height, self.height, 0, self.height / 2], np.float64)
        x, y = (u - cx) / fx, (v - cy) / fy
        xd, yd = self.distort(x, y)
        return float(np.max(np.hypot((xd - x) * fx, (yd - y) * fy))) <= tol_px

    def undistort_maps(self) -> tuple[np.ndarray, np.ndarray]:
        """cv2.remap maps that resample this camera's image onto a pinhole camera with the same size, focal
        length and principal point. Pixels whose source falls outside the image map to -1 (mask them)."""
        (fx, fy), (cx, cy) = self.f, self.c
        u, v = np.meshgrid(np.arange(self.width, dtype=np.float64) + 0.5, np.arange(self.height, dtype=np.float64) + 0.5)
        x, y = (u - cx) / fx, (v - cy) / fy
        xd, yd = self.distort(x, y)
        mx = (fx * xd + cx - 0.5).astype(np.float32)
        my = (fy * yd + cy - 0.5).astype(np.float32)
        out = (mx < -0.5) | (mx > self.width - 0.5) | (my < -0.5) | (my > self.height - 0.5)
        mx[out] = -1
        my[out] = -1
        return mx, my

    def pinhole(self) -> "Camera":
        (fx, fy), (cx, cy) = self.f, self.c
        return Camera("PINHOLE", self.width, self.height, np.array([fx, fy, cx, cy], np.float64))

    def to_json(self) -> dict:
        (fx, fy), (cx, cy) = self.f, self.c
        return {"model": self.model, "width": int(self.width), "height": int(self.height),
                "params": [float(v) for v in self.params], "fx": fx, "fy": fy, "cx": cx, "cy": cy,
                "distortion": self.distortion()}

    @staticmethod
    def from_json(d: dict) -> "Camera":
        return Camera(d["model"], int(d["width"]), int(d["height"]), np.asarray(d["params"], np.float64))


def qvec_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = np.asarray(q, np.float64) / np.linalg.norm(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def rotmat_to_qvec(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> wxyz quaternion with w >= 0."""
    R = np.asarray(R, np.float64)
    K = np.array(
        [
            [R[0, 0] - R[1, 1] - R[2, 2], 0, 0, 0],
            [R[1, 0] + R[0, 1], R[1, 1] - R[0, 0] - R[2, 2], 0, 0],
            [R[2, 0] + R[0, 2], R[2, 1] + R[1, 2], R[2, 2] - R[0, 0] - R[1, 1], 0],
            [R[1, 2] - R[2, 1], R[2, 0] - R[0, 2], R[0, 1] - R[1, 0], R[0, 0] + R[1, 1] + R[2, 2]],
        ]
    ) / 3.0
    vals, vecs = np.linalg.eigh(K)
    q = vecs[[3, 0, 1, 2], np.argmax(vals)]
    return -q if q[0] < 0 else q


def w2c_matrix(qvec: np.ndarray, tvec: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = qvec_to_rotmat(qvec)
    m[:3, 3] = tvec
    return m
