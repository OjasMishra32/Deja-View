"""The giant chess board through time: which square held what, when, and masks for a static scene.

The four chess videos cover about five and a half minutes of one game. Pieces move every 20 s or so, and
captured pieces are carried off. A static splat trained on every frame would try to show a square both with
and without its piece and end up with half-transparent pieces that appear and vanish as the viewer walks
round. This module finds the board, reads every square's occupant in every frame, cuts each square's
timeline into stretches with one occupant, and writes a second work folder whose masks also hide, in each
frame, the squares whose occupant differs from one reference moment. Trained on that folder, every square
shows the board as it stood at the reference moment, from every view that saw it that way.

Stages (BOARD defaults to WORK/../board):
  grid    the room frame of pipeline/recon/frame.py pre (run on a copy in BOARD/level), a median orthophoto
          of the floor from the solved poses, and the 8x8 grid fitted to it by edge alignment
          -> BOARD/board.json (grid in the room frame and in COLMAP coordinates), BOARD/ortho-grid.jpg
  states  the sparse COLMAP points standing on each square (0.06-1.1 m up; also a two-square ring round the
          board, where captured pieces are put down) and the views that observed them. Points are fixed in
          3D, so a piece behind an empty square never counts for it, and a piece that has left stops being
          observed. The piece standing on a square at --ref-time (points seen then, or seen before and after
          it, and points seen together with those) and the stays of other pieces give, per square, the times
          at which it differs from the reference moment -> BOARD/states.json, BOARD/timeline.png
  masks   for each view, the squares that differ at its time are hidden as a prism over the square up to
          --height m, joined with the person mask -> WORK/static/ (masks/, a poses.json without the
          clip-only frames, symlinks to the rest, static-masks.json)

  python pipeline/recon_inputs/chess_board.py grid   --work data/tmp/chess/recon
  python pipeline/recon_inputs/chess_board.py states --work data/tmp/chess/recon --ref-time 208
  python pipeline/recon_inputs/chess_board.py masks  --work data/tmp/chess/recon

The reference moment (T 208 s from the first video's start) is just after the knight move in the players
clip (IMG_9291 169-189 s, T 187-207 s), so the static board matches the board the players stand at.
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RECON = HERE.parent / "recon"
if str(RECON) not in sys.path:
    sys.path.insert(0, str(RECON))

from cams import qvec_to_rotmat  # noqa: E402
from util import log, read_json, write_json  # noqa: E402

RING = 2  # squares round the board that are read too (captured pieces stand there)


def say(msg: str) -> None:
    log("chess", msg)


# --------------------------------------------------------------------------------------------------------------
# Shared geometry
# --------------------------------------------------------------------------------------------------------------


def recording_starts(frames: dict, videos: Path) -> dict[str, float]:
    """Seconds from the first video's start to each video's start (QuickTime creation dates)."""
    out = {}
    for g, info in frames["groups"].items():
        src = videos / info["source"]
        tag = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=creation_time", "-of",
                              "default=nw=1:nk=1", str(src)], capture_output=True, text=True).stdout.strip()
        out[g] = datetime.fromisoformat(tag.replace("Z", "+00:00")).timestamp()
    t0 = min(out.values())
    return {g: round(t - t0, 3) for g, t in out.items()}


class Scene:
    """Registered views in the levelled room frame of frame.py pre (y up, floor y = 0, eye-height metres)."""

    def __init__(self, work: Path, board: Path, poses_name: str = "poses.json"):
        self.work = work
        self.frame = read_json(board / "level" / "frame.json")
        if not self.frame:
            raise SystemExit(f"{board / 'level' / 'frame.json'} missing: run the grid stage first")
        t = self.frame["colmapToRoom"]
        self.Rs, self.ts, self.s = np.asarray(t["R"]), np.asarray(t["t"]), float(t["scale"])
        self.poses = read_json(work / poses_name)
        self.cams = self.poses["cameras"]
        self.frames = read_json(work / "frames.json")
        self.starts = read_json(board / "starts.json")
        self.views = sorted((im for im in self.poses["images"] if im.get("registered")),
                            key=lambda im: self.starts[im["group"]] + im["time"])
        for im in self.views:
            im["T"] = self.starts[im["group"]] + im["time"]

    def to_colmap(self, P: np.ndarray) -> np.ndarray:
        return ((np.asarray(P, np.float64) - self.ts) @ self.Rs) / self.s

    def centre(self, im: dict) -> np.ndarray:
        R = qvec_to_rotmat(im["qvec"])
        return self.s * (self.Rs @ (-R.T @ np.asarray(im["tvec"]))) + self.ts

    def project(self, im: dict, P_room: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Room-frame points -> pixel coordinates (with the solved lens distortion) and depth."""
        R = qvec_to_rotmat(im["qvec"])
        Xc = self.to_colmap(P_room) @ R.T + np.asarray(im["tvec"])
        z = Xc[:, 2]
        zs = np.where(np.abs(z) < 1e-6, 1e-6, z)
        x, y = Xc[:, 0] / zs, Xc[:, 1] / zs
        c = self.cams[im["camera"]]
        d = c.get("distortion") or {}
        r2 = x * x + y * y
        f = 1 + d.get("k1", 0.0) * r2 + d.get("k2", 0.0) * r2 * r2
        return np.stack([c["fx"] * x * f + c["cx"], c["fy"] * y * f + c["cy"]], 1), z


def board_cells(b: dict) -> tuple[np.ndarray, np.ndarray]:
    """Cell indices (i, j) in -RING..7+RING and their centres in the room frame (x, z)."""
    rng = np.arange(-RING, 8 + RING)
    I, J = np.meshgrid(rng, rng, indexing="ij")
    ij = np.stack([I.ravel(), J.ravel()], 1)
    o, u, v, a = np.asarray(b["origin"]), np.asarray(b["u"]), np.asarray(b["v"]), b["square"]
    cen = o + (ij[:, :1] + 0.5) * a * u + (ij[:, 1:] + 0.5) * a * v
    return ij, cen


# --------------------------------------------------------------------------------------------------------------
# grid
# --------------------------------------------------------------------------------------------------------------


def orthophoto(sc: Scene, lo: np.ndarray, hi: np.ndarray, res: float, step: int) -> np.ndarray:
    """Per-pixel median of every step-th view projected onto the floor (people masked). Rows run along +z."""
    import cv2

    xs, zs = np.arange(lo[0], hi[0], res), np.arange(lo[1], hi[1], res)
    GX, GZ = np.meshgrid(xs, zs)
    P = np.stack([GX, np.zeros_like(GX), GZ], -1).reshape(-1, 3)
    acc = []
    for im in sc.views[::step]:
        uv, z = sc.project(im, P)
        c = sc.cams[im["camera"]]
        ok = (z > 0.1) & (uv[:, 0] >= 0) & (uv[:, 0] < c["width"] - 1) & (uv[:, 1] >= 0) & (uv[:, 1] < c["height"] - 1)
        mu = np.where(ok, uv[:, 0], -1).reshape(GX.shape).astype(np.float32)
        mv = np.where(ok, uv[:, 1], -1).reshape(GX.shape).astype(np.float32)
        img = cv2.imread(str(sc.work / "images" / im["name"]))
        m = cv2.imread(str(sc.work / "masks" / f"{im['name']}.png"), cv2.IMREAD_GRAYSCALE)
        o = cv2.remap(img, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).astype(np.float32)
        keep = (cv2.remap(m, mu, mv, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT) > 127) & ok.reshape(GX.shape)
        o[~keep] = np.nan
        acc.append(o)
    with np.errstate(all="ignore"):
        import warnings

        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(np.stack(acc), axis=0)
    return np.nan_to_num(med).astype(np.uint8)


def fit_grid(ortho: np.ndarray, lo: np.ndarray, res: float) -> dict:
    """8x8 grid whose 9 + 9 lines sit on the strongest luminance edges (median along each line, so pieces
    standing on a line do not count). Searched coarse to fine over angle, square size and corner."""
    import cv2

    L = cv2.GaussianBlur(cv2.cvtColor(ortho, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.0)
    gx, gy = cv2.Sobel(L, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(L, cv2.CV_32F, 0, 1, ksize=3)
    H, Wd = L.shape
    t = np.linspace(0.04, 7.96, 160)
    k = np.arange(9)

    def score(th, a, ox, oz):
        u = np.array([math.cos(th), math.sin(th)])
        v = np.array([-u[1], u[0]])
        tot = 0.0
        for along, across in ((u, v), (v, u)):
            A, B = t[None, :] * a, k[:, None] * a
            X = ox + A * along[0] + B * across[0]
            Z = oz + A * along[1] + B * across[1]
            ix = np.clip(np.rint((X - lo[0]) / res).astype(int), 0, Wd - 1)
            iz = np.clip(np.rint((Z - lo[1]) / res).astype(int), 0, H - 1)
            g = np.abs(gx[iz, ix] * across[0] + gy[iz, ix] * across[1])
            tot += float(np.median(g, axis=1).sum())
        return tot

    # coarse: around the dark floor (the black squares), the edge energy across each grid direction summed
    # into a 1 cm profile; nine equally spaced lines should land on its peaks
    dark = (L < 90) & (L > 0)
    zz, xx = np.nonzero(dark)
    x0, x1 = np.percentile(xx, [5, 95]) + np.array([-50, 50])
    z0, z1 = np.percentile(zz, [5, 95]) + np.array([-50, 50])
    zg, xg = np.mgrid[int(max(z0, 0)):int(min(z1, H)), int(max(x0, 0)):int(min(x1, Wd))]
    X, Z = lo[0] + xg.ravel() * res, lo[1] + zg.ravel() * res
    GX, GZ = gx[zg, xg].ravel(), gy[zg, xg].ravel()
    best = None
    for th in np.radians(np.arange(-45.0, 45.0, 0.25)):
        u = np.array([math.cos(th), math.sin(th)])
        v = np.array([-u[1], u[0]])
        fits = []
        for axis in (u, v):
            p = X * axis[0] + Z * axis[1]
            e = np.abs(GX * axis[0] + GZ * axis[1])
            lo_p = p.min()
            prof = np.bincount(((p - lo_p) / res).astype(int), weights=e)
            prof = np.convolve(prof, [0.25, 0.5, 0.25], mode="same")
            top = None
            for a in np.arange(0.30, 0.6001, 0.001):
                span = int(round(8 * a / res))
                if span + 1 >= len(prof):
                    break
                offs = np.arange(0, len(prof) - span - 1)
                idx = offs[:, None] + np.rint(np.arange(9) * a / res).astype(int)[None, :]
                val = prof[idx].min(1) * 9  # every line must sit on an edge
                kb = int(np.argmax(val))
                if top is None or val[kb] > top[0]:
                    top = (float(val[kb]), a, lo_p + offs[kb] * res)
            fits.append(top)
        if fits[0] is None or fits[1] is None:
            continue
        s = fits[0][0] + fits[1][0]
        a = 0.5 * (fits[0][1] + fits[1][1])
        o = fits[0][2] * u + fits[1][2] * v
        if best is None or s > best[0]:
            best = (s, th, a, o[0], o[1])
    best = (score(*best[1:]),) + best[1:]
    for span, n in ((1.0, 0.25), (0.3, 0.05)):
        for _ in range(3):
            s0, th, a, ox, oz = best
            for th2 in th + np.radians(np.arange(-span, span + 1e-9, n)):
                for a2 in a + np.arange(-0.01, 0.01001, 0.0025) * span:
                    for ox2 in ox + np.arange(-0.04, 0.0401, 0.01) * span:
                        for oz2 in oz + np.arange(-0.04, 0.0401, 0.01) * span:
                            s = score(th2, a2, ox2, oz2)
                            if s > best[0]:
                                best = (s, th2, a2, ox2, oz2)
    s, th, a, ox, oz = best
    u = np.array([math.cos(th), math.sin(th)])
    return {"angleDeg": math.degrees(th), "square": float(a), "origin": [float(ox), float(oz)], "u": u.tolist(),
            "v": [-float(u[1]), float(u[0])], "edgeScore": float(s)}


def stage_grid(a) -> None:
    import cv2

    from frame import frame_pre
    from util import Work

    work, board = a.work, a.out
    lvl = board / "level"
    lvl.mkdir(parents=True, exist_ok=True)
    for f in ("poses.json", "points.npz", "frames.json"):
        link = lvl / f
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(os.path.relpath(work / f, lvl))
    frame_pre(Work(lvl), None, a.eye, None)
    frames = read_json(work / "frames.json")
    write_json(board / "starts.json", recording_starts(frames, a.videos))
    sc = Scene(work, board)
    d = np.load(work / "points.npz")
    keep = (d["track"] >= 3) & (d["error"] < 2.0)
    P = sc.s * (d["xyz"][keep].astype(np.float64) @ sc.Rs.T) + sc.ts
    fl = P[np.abs(P[:, 1]) < 0.05][:, [0, 2]]
    lo, hi = np.percentile(fl, 2, axis=0) - 1.0, np.percentile(fl, 98, axis=0) + 1.0
    res = 0.01
    ortho = orthophoto(sc, lo, hi, res, a.step)
    say(f"orthophoto {ortho.shape[1]}x{ortho.shape[0]} px at {res * 100:.0f} cm from {len(sc.views[::a.step])} views")
    g = fit_grid(ortho, lo, res)
    corners = [np.asarray(g["origin"]) + p * 8 * g["square"] * np.asarray(g["u"]) + q * 8 * g["square"] * np.asarray(g["v"])
               for p, q in ((0, 0), (1, 0), (1, 1), (0, 1))]
    g["cornersRoom"] = [[float(c[0]), 0.0, float(c[1])] for c in corners]
    g["cornersColmap"] = sc.to_colmap(np.array(g["cornersRoom"])).tolist()
    g["frame"] = "room frame of frame.py pre run on BOARD/level (y up, floor y = 0, eye-height scale); cell (i, j) " \
                 "spans origin + [i, i+1] * square * u + [j, j+1] * square * v in (x, z)"
    g["ortho"] = {"lo": lo.tolist(), "res": res}
    write_json(board / "board.json", g)
    say(f"grid: angle {g['angleDeg']:.2f} deg, square {g['square']:.4f} m (eye-height scale), corner {g['origin']}")
    o = ortho.copy()
    sh = 4
    for k in range(9):
        for p0, p1 in (((k, 0), (k, 8)), ((0, k), (8, k))):
            pa = np.asarray(g["origin"]) + g["square"] * (p0[0] * np.asarray(g["u"]) + p0[1] * np.asarray(g["v"]))
            pb = np.asarray(g["origin"]) + g["square"] * (p1[0] * np.asarray(g["u"]) + p1[1] * np.asarray(g["v"]))
            qa, qb = (pa - lo) / res, (pb - lo) / res
            cv2.line(o, tuple(int(round(x * 2 ** sh)) for x in qa), tuple(int(round(x * 2 ** sh)) for x in qb), (0, 0, 255), 1,
                     cv2.LINE_AA, sh)
    cv2.imwrite(str(board / "ortho-grid.jpg"), o[::-1], [cv2.IMWRITE_JPEG_QUALITY, 92])


# --------------------------------------------------------------------------------------------------------------
# states
# --------------------------------------------------------------------------------------------------------------

# a sparse point counts as a piece point between these heights (m, eye-height scale) over a square's inner part
PIECE_Y = (0.06, 1.10)
INNER = 0.42  # half-width of the inner part, in squares (keeps a neighbour's overhang out)
MIN_POINTS = 25  # a piece has more points than this (pieces here have 50-900; strays, wall and floor edges < 25)
MIN_OBS = 60  # ... and more observations
RANK = 5  # a stay runs from its RANK-th earliest to its RANK-th latest observation (one stray view is not a stay)


def piece_points(sc: Scene, b: dict) -> tuple[np.ndarray, list[np.ndarray], np.ndarray]:
    """Sparse points standing on a cell: cell index per point (-1 = none), the times (T) of the views that
    observed each point, and its mean colour."""
    from poses import read_text_model

    _, images, pts = read_text_model(sc.work / "colmap" / "model_txt")
    pid = np.array(sorted(pts))
    X = np.array([pts[p][:3] for p in pid], np.float64)
    rgb = np.array([pts[p][3:6] for p in pid], np.float64)
    P = sc.s * (X @ sc.Rs.T) + sc.ts
    q = P[:, [0, 2]] - np.asarray(b["origin"])
    fi, fj = q @ np.asarray(b["u"]) / b["square"], q @ np.asarray(b["v"]) / b["square"]
    ci, cj = np.floor(fi).astype(int), np.floor(fj).astype(int)
    on = ((P[:, 1] > PIECE_Y[0]) & (P[:, 1] < PIECE_Y[1]) & (np.abs(fi - ci - 0.5) < INNER) & (np.abs(fj - cj - 0.5) < INNER)
          & (ci >= -RING) & (ci < 8 + RING) & (cj >= -RING) & (cj < 8 + RING))
    cell_of = np.full(len(pid), -1)
    cell_of[on] = (ci[on] + RING) * (8 + 2 * RING) + (cj[on] + RING)  # same order as board_cells
    index = {p: k for k, p in enumerate(pid)}
    T_of = {v["name"]: v["T"] for v in sc.views}
    seen: list[list[float]] = [[] for _ in pid]
    for im in images.values():
        t = T_of.get(im["name"])
        if t is None:
            continue
        for p in im["pid"][im["pid"] >= 0]:
            k = index[p]
            if cell_of[k] >= 0:
                seen[k].append(t)
    return cell_of, [np.sort(np.array(s)) for s in seen], rgb.mean(1)


def nth(values: list[float] | np.ndarray, k: int, largest: bool = False) -> float:
    v = np.sort(np.asarray(values, np.float64))
    k = min(k, len(v)) - 1
    return float(v[::-1][k] if largest else v[k])


def colour(lum: np.ndarray) -> str:
    w, b = int((lum > 150).sum()), int((lum < 70).sum())
    return "white" if w > 2 * b else ("black" if b > 2 * w else "mixed")


def cell_history(times: list[np.ndarray], lum: np.ndarray, t_ref: float, window: float, guard: float,
                 span: tuple[float, float], edge: float = 8.0) -> dict:
    """One square from its piece points and the views that observed them.

    The reference piece: points seen within `window` s of t_ref or seen both before and after it (a piece that
    stood still through the reference moment while the camera looked elsewhere), plus every point observed in at
    least two views together with three or more of those (two pieces never share a square at one moment, so
    points seen with the reference piece belong to it: its other side, seen from another part of the arc).
    It stood there from its RANK-th earliest to its RANK-th latest observation. The remaining points
    belong to pieces that stood there at other times; points whose spans overlap are grouped, and a group with
    at least MIN_POINTS points and MIN_OBS observations is a stay. The square differs from the reference outside
    the reference piece's stay and during every other stay, widened by `guard` s (a piece is not seen in every
    view). Strays (a few points from a neighbour's edge or a shadow) fall below the thresholds. A reference piece
    first seen within `edge` s of the first view (last seen within `edge` s of the last view) was there from the
    start (to the end): `span` is (first view, last view)."""
    if not times:
        return {"points": 0, "ref": None, "others": [], "hide": []}
    first = np.array([t[0] for t in times])
    last = np.array([t[-1] for t in times])
    nobs = np.array([len(t) for t in times])
    near = np.array([bool(np.any(np.abs(t - t_ref) <= window)) for t in times])
    member = near | ((first <= t_ref) & (last >= t_ref))
    if member.any():
        views: dict[float, int] = {}
        for k in np.nonzero(member)[0]:
            for t in times[k]:
                views[float(t)] = views.get(float(t), 0) + 1
        busy = {t for t, n in views.items() if n >= 3}
        joined = np.array([not m and sum(float(t) in busy for t in times[k]) >= 2 for k, m in enumerate(member)])
        member |= joined
    ref = None
    hide: list[list[float]] = []
    if member.sum() >= MIN_POINTS and nobs[member].sum() >= MIN_OBS:
        obs = np.concatenate([times[k] for k in np.nonzero(member)[0]])
        A, D = nth(obs, RANK), nth(obs, RANK, largest=True)
        A = -1e9 if A - span[0] < edge else A
        D = 1e9 if span[1] - D < edge else D
        ref = {"from": round(A, 2), "to": round(D, 2), "points": int(member.sum()), "observations": int(nobs[member].sum()),
               "colour": colour(lum[member])}
        hide += [h for h in ([-1e9, A], [D, 1e9]) if h[1] > h[0]]
    others = []
    idx = np.nonzero(~member)[0]
    idx = idx[np.argsort(first[idx])]
    groups: list[list[int]] = []
    for k in idx:
        if groups and first[k] <= max(last[g] for g in groups[-1]):
            groups[-1].append(k)
        else:
            groups.append([k])
    for g in groups:
        if len(g) < MIN_POINTS or nobs[g].sum() < MIN_OBS:
            continue
        obs = np.concatenate([times[k] for k in g])
        a, d = nth(obs, RANK), nth(obs, RANK, largest=True)
        others.append({"from": round(a, 2), "to": round(d, 2), "points": len(g), "observations": int(nobs[g].sum()),
                       "colour": colour(lum[g])})
        hide.append([a - guard, d + guard])
    hide.sort()
    merged: list[list[float]] = []
    for lo, hi in hide:
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return {"points": len(times), "ref": ref, "others": others, "hide": [[round(x, 2) for x in h] for h in merged]}


def stage_states(a) -> None:
    board = a.out
    sc = Scene(a.work, board)
    b = read_json(board / "board.json")
    ij, _ = board_cells(b)
    T = np.array([im["T"] for im in sc.views])
    cell_of, seen, lum = piece_points(sc, b)
    say(f"{int((cell_of >= 0).sum())} sparse points stand on the board or the two-square ring round it")
    cells = []
    for c, (i, j) in enumerate(ij):
        k = np.nonzero(cell_of == c)[0]
        k = k[[len(seen[x]) >= 2 for x in k]] if len(k) else k
        h = cell_history([seen[x] for x in k], lum[k], a.ref_time, a.window, a.guard, (float(T.min()), float(T.max())))
        h.update({"i": int(i), "j": int(j), "onBoard": bool(0 <= i < 8 and 0 <= j < 8)})
        h["hiddenViews"] = int(sum(any(lo <= t <= hi for lo, hi in h["hide"]) for t in T))
        cells.append(h)
    write_json(board / "states.json", {
        "refTime": a.ref_time, "window": a.window, "guard": a.guard,
        "views": [{"name": im["name"], "T": round(float(im["T"]), 3)} for im in sc.views],
        "cells": cells,
        "settings": {"pieceHeights": PIECE_Y, "inner": INNER, "minPoints": MIN_POINTS, "minObservations": MIN_OBS, "rank": RANK},
        "note": "T = seconds since the first video began (QuickTime creation dates). Per cell: ref = the piece standing "
                "there at refTime (its first and last observation), others = pieces seen there at other times, "
                "hide = the times at which the cell differs from refTime (masks hide it in those views).",
    })
    busy = [c for c in cells if c["hide"]]
    say(f"{len(busy)} squares differ from the reference moment (T {a.ref_time:.0f}s) in some views:")

    def when(t: float) -> str:
        return "the start" if t < -1e8 else ("the end" if t > 1e8 else f"{t:.0f}s")

    for c in busy:
        r = c["ref"]
        at_ref = f"{r['colour']} piece from {when(r['from'])} to {when(r['to'])} ({r['points']} pts)" if r else "empty"
        say(f"  ({c['i']},{c['j']}) at ref: {at_ref}"
            + "".join(f"; {o['colour']} piece {o['from']:.0f}-{o['to']:.0f}s ({o['points']} pts)" for o in c["others"])
            + f"; hidden in {c['hiddenViews']} views")
    timeline_png(board / "timeline.png", T, cells, seen, cell_of, lum)


def timeline_png(path: Path, T: np.ndarray, cells: list[dict], seen: list[np.ndarray], cell_of: np.ndarray, lum: np.ndarray) -> None:
    """One row per square with a hidden stretch: red = hidden, ticks = observations of its piece points
    (upper half white-coloured points, lower half black ones)."""
    import cv2

    rows = [c for c, h in enumerate(cells) if h["hide"]]
    W, rh, left = 1500, 24, 70
    tmax = float(T.max()) + 5
    img = np.full((rh * (len(rows) + 2), W, 3), 255, np.uint8)
    X = lambda t: left + int(max(0.0, min(t, tmax)) / tmax * (W - left - 10))  # noqa: E731
    for r, c in enumerate(rows):
        y = rh * (r + 1)
        h = cells[c]
        cv2.putText(img, f"({h['i']},{h['j']})", (6, y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
        cv2.rectangle(img, (left, y + 2), (W - 10, y + rh - 2), (225, 225, 225), -1)
        for lo, hi in h["hide"]:
            cv2.rectangle(img, (X(lo), y + 2), (max(X(lo) + 1, X(hi)), y + rh - 2), (150, 150, 255), -1)
        for k in np.nonzero(cell_of == c)[0]:
            up = lum[k] > 110
            for t in seen[k]:
                cv2.line(img, (X(t), y + (4 if up else 13)), (X(t), y + (10 if up else 20)), (60, 60, 60) if up else (0, 0, 0), 1)
    for t in range(0, int(tmax), 30):
        cv2.putText(img, f"{t}s", (X(t), rh * (len(rows) + 1) + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)
    cv2.imwrite(str(path), img)


# --------------------------------------------------------------------------------------------------------------
# masks
# --------------------------------------------------------------------------------------------------------------


def stage_masks(a) -> None:
    import cv2

    work, board = a.work, a.out
    sc = Scene(work, board)
    b = read_json(board / "board.json")
    stj = read_json(board / "states.json")
    ij, cen = board_cells(b)
    names = [v["name"] for v in stj["views"]]
    T = np.array([v["T"] for v in stj["views"]])
    hide_of = [h["hide"] for h in stj["cells"]]
    sq = b["square"]
    u, v = np.asarray(b["u"]), np.asarray(b["v"])
    grow = 0.5 * sq * (1 + a.grow)
    out_dir = work / "static"
    (out_dir / "masks").mkdir(parents=True, exist_ok=True)
    clip_only = {im["name"] for im in sc.frames["images"] if im.get("roles") == ["clip"]}
    per_view = []
    view_by_name = {im["name"]: im for im in sc.views}
    for f, name in enumerate(names):
        im = view_by_name[name]
        hide = [c for c in range(len(ij)) if any(lo <= T[f] <= hi for lo, hi in hide_of[c])]
        person = cv2.imread(str(work / "masks" / f"{name}.png"), cv2.IMREAD_GRAYSCALE)
        h, w = person.shape
        piece = np.zeros((h, w), np.uint8)
        for c in hide:
            corners = [cen[c] + su * grow * u + sv * grow * v for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            P = np.array([[x, y, z] for x, z in corners for y in (0.0, a.height)])
            uv, z = sc.project(im, P)
            if (z <= 0.05).any():
                continue  # the prism reaches behind the camera: never on a square in front of these views
            hull = cv2.convexHull(np.round(uv).astype(np.int32))
            cv2.fillConvexPoly(piece, hull, 255)
        if a.dilate > 0 and piece.any():
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * a.dilate + 1, 2 * a.dilate + 1))
            piece = cv2.dilate(piece, k)
        use = np.where((person > 127) & (piece == 0), 255, 0).astype(np.uint8)
        dst = out_dir / "masks" / f"{name}.png"
        dst.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(dst), use)
        per_view.append({"name": name, "T": round(float(T[f]), 3), "squaresHidden": [[int(ij[c][0]), int(ij[c][1])] for c in hide],
                         "pieceFraction": round(float((piece > 0).mean()), 4), "usedFraction": round(float((use > 0).mean()), 4),
                         "clipOnly": name in clip_only})
    # links to everything else, and a poses.json without the clip-only frames (unless --keep-clip)
    for f in ["images", "frames.json", "points.npz"] + sorted(p.name for p in work.glob("*-times.npy")):
        link = out_dir / f
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(os.path.join("..", f))
    poses = read_json(work / "poses.json")
    if not a.keep_clip:
        poses["images"] = [im for im in poses["images"] if im["name"] not in clip_only]
        poses["note"] = (f"chess_board.py masks: the {len(clip_only)} clip-only frames (IMG_9291 169-189 s, every 4th frame) "
                         f"are left out for training; ../poses.json has all of them")
    write_json(out_dir / "poses.json", poses)
    write_json(out_dir / "static-masks.json", {
        "refTime": stj["refTime"], "guardSeconds": stj["guard"], "prismHeight": a.height,
        "grow": a.grow, "dilate": a.dilate, "board": b,
        "trainViews": len([im for im in poses["images"] if im.get("registered")]),
        "views": per_view,
        "convention": "masks/NAME.png: 255 = use, 0 = person or a square whose occupant differs from the reference",
    })
    pf = np.array([p["pieceFraction"] for p in per_view if not p["clipOnly"] or a.keep_clip])
    say(f"static masks for {len(per_view)} views in {out_dir}: reference T {stj['refTime']:.0f}s; "
        f"extra masked area mean {pf.mean() * 100:.1f}%, max {pf.max() * 100:.1f}%, none in {int((pf == 0).sum())} views")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["grid", "states", "masks"])
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None, help="board folder (default WORK/../board)")
    ap.add_argument("--videos", type=Path, default=Path("data/test-media/chess/video"))
    ap.add_argument("--eye", type=float, default=1.45, help="grid: camera height for frame.py pre's scale")
    ap.add_argument("--step", type=int, default=12, help="grid: every n-th view goes into the orthophoto")
    ap.add_argument("--window", type=float, default=6.0, help="states: points seen this close to --ref-time stand there then")
    ap.add_argument("--ref-time", type=float, default=208.0, help="states: the board moment to keep (s since the first video began)")
    ap.add_argument("--guard", type=float, default=10.0, help="states: widen another piece's stay by this many s")
    ap.add_argument("--height", type=float, default=1.0, help="masks: prism height over a square (m, eye-height scale)")
    ap.add_argument("--grow", type=float, default=0.15, help="masks: prism footprint = square * (1 + grow)")
    ap.add_argument("--dilate", type=int, default=12, help="masks: pixels")
    ap.add_argument("--keep-clip", action="store_true", help="masks: keep the clip-only frames in static/poses.json")
    a = ap.parse_args(argv)
    a.work = a.work.resolve()
    a.out = (a.out or a.work.parent / "board").resolve()
    a.out.mkdir(parents=True, exist_ok=True)
    {"grid": stage_grid, "states": stage_states, "masks": stage_masks}[a.stage](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
