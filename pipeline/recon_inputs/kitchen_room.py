"""Shared loading for the kitchen helpers: a pipeline/recon work folder in the room frame.

Reads WORK/poses.json (COLMAP frame, world-to-camera, OpenCV axes), WORK/points.npz and WORK/frame.json
(x_room = scale * R @ x_colmap + t; y up, metres, floor y = 0, spawn at the origin facing -Z) and returns every
registered camera and the sparse points in the room frame. Needs numpy only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


def qvec_to_rotmat(q) -> np.ndarray:
    w, x, y, z = np.asarray(q, np.float64) / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


@dataclass
class Room:
    work: Path
    names: list[str]
    groups: list[str]
    meta: list[dict]
    C: np.ndarray          # (N, 3) camera centres, room frame
    Rc2w: np.ndarray       # (N, 3, 3) camera-to-room rotations (OpenCV camera axes)
    P: np.ndarray          # (M, 3) sparse points, room frame
    rgb: np.ndarray        # (M, 3) uint8
    err: np.ndarray
    track: np.ndarray
    scale: float
    frame: dict = field(default_factory=dict)
    cameras: dict = field(default_factory=dict)

    @property
    def forward(self) -> np.ndarray:
        return self.Rc2w[:, :, 2]

    @property
    def up(self) -> np.ndarray:
        return -self.Rc2w[:, :, 1]

    def index(self, name: str) -> int:
        return self.names.index(name)


def load(work: Path | str, frame_json: Path | str | None = None) -> Room:
    work = Path(work)
    poses = json.loads((work / "poses.json").read_text())
    fr = json.loads(Path(frame_json or work / "frame.json").read_text())
    Rt = fr["colmapToRoom"]
    R, t, s = np.asarray(Rt["R"], np.float64), np.asarray(Rt["t"], np.float64), float(Rt["scale"])
    regs = [im for im in poses["images"] if im.get("registered")]
    C, Rs = [], []
    for im in regs:
        Rw2c = qvec_to_rotmat(im["qvec"])
        c = -Rw2c.T @ np.asarray(im["tvec"], np.float64)
        C.append(s * (R @ c) + t)
        Rs.append(R @ Rw2c.T)
    d = np.load(work / "points.npz")
    P = s * (d["xyz"].astype(np.float64) @ R.T) + t
    return Room(work=work, names=[im["name"] for im in regs], groups=[im.get("group") or "" for im in regs], meta=regs,
                C=np.asarray(C), Rc2w=np.asarray(Rs), P=P, rgb=d["rgb"], err=d["error"], track=d["track"], scale=s,
                frame=fr, cameras=poses["cameras"])


def wall_yaw(P: np.ndarray, lo: float = 0.3, hi: float = 2.2, cell: float = 0.03) -> float:
    """Yaw (radians) that turns the walls onto the x and z axes: the angle in [0, 90) degrees whose x and z
    histograms of the points between lo and hi metres high are the most peaked (sum of squared counts)."""
    Q = P[(P[:, 1] > lo) & (P[:, 1] < hi)][:, [0, 2]]
    best, best_a = -1.0, 0.0
    for a in np.radians(np.arange(0.0, 90.0, 0.5)):
        c, s_ = np.cos(a), np.sin(a)
        u, v = Q[:, 0] * c + Q[:, 1] * s_, -Q[:, 0] * s_ + Q[:, 1] * c
        score = 0.0
        for w in (u, v):
            h, _ = np.histogram(w, bins=np.arange(w.min(), w.max() + cell, cell))
            score += float((h.astype(np.float64) ** 2).sum())
        if score > best:
            best, best_a = score, float(a)
    return best_a


def to_wall_axes(xz: np.ndarray, yaw: float) -> np.ndarray:
    c, s_ = np.cos(yaw), np.sin(yaw)
    return np.stack([xz[:, 0] * c + xz[:, 1] * s_, -xz[:, 0] * s_ + xz[:, 1] * c], axis=1)


def from_wall_axes(uv: np.ndarray, yaw: float) -> np.ndarray:
    c, s_ = np.cos(yaw), np.sin(yaw)
    return np.stack([uv[:, 0] * c - uv[:, 1] * s_, uv[:, 0] * s_ + uv[:, 1] * c], axis=1)
