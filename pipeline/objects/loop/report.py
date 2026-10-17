#!/usr/bin/env python3
"""Tables for docs/object-reconstruction-loop.md from the evaluator's eval.json files and the loop's loop.json files.

    python pipeline/objects/loop/report.py --scene data/scenes/kitchen
    python pipeline/objects/loop/report.py --scene data/scenes/kitchen --write docs/object-reconstruction-loop.md
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

BEGIN, END = "<!-- loop-tables:begin -->", "<!-- loop-tables:end -->"


def _f(x, fmt="{:.2f}") -> str:
    return "–" if x is None else fmt.format(x)


def _knobs(c: dict) -> str:
    return (f"{c['voxel'] * 1000:g} mm, {c['views']} views, {c['atlas']} atlas, min {c['min_component']} m², "
            f"{c['simplify']}, {c['chunks']}, maps {c['maps']}" + (", ink" if c.get("ink") else ""))


def eval_table(scene: Path, set_name: str = "objects") -> str:
    rows = ["| Object | Score | Gates | IoU mean / worst | Depth MAE worst (m) | Chamfer (m) | Normals | Sharpness | "
            "Tris | Holes/1k | Approval |", "|" + "---|" * 11]
    for p in sorted((scene / set_name).glob("*/eval.json")):
        e = json.loads(p.read_text())
        g = e["gates"]
        rows.append(" | ".join([
            f"| {e['id']}", _f(e["score"], "{:.1f}"), "pass" if g["pass"] else "FAIL " + ", ".join(g["failed"]),
            f"{_f(e['iou']['mean'])} / {_f(e['iou']['worst'])}", _f(e["depthMAE"]["worst"], "{:.3f}"),
            _f(e["surface"].get("chamfer"), "{:.4f}"), _f(e["normalCos"]["mean"]), _f(e["sharpness"]),
            str(e["mesh"]["triangles"]), _f(e["mesh"]["holesPer1000"], "{:.1f}"),
            g["approval"]["approval"]]) + " |")
    return "\n".join(rows) if len(rows) > 2 else "(no eval.json yet: run `loop.sbatch <scene> eval`)"


def loop_table(scene: Path, out: str = "objects-loop") -> str:
    rows = ["| Object | Kind | Current score | Best score | IoU worst cur → best | Chamfer cur → best | Tris best | "
            "Winning configuration | Trials | Stopped | Best passes gates |", "|" + "---|" * 11]
    stove = ""
    for p in sorted((scene / out).glob("*/loop.json")):
        r = json.loads(p.read_text())
        cur, best = r.get("current") or {}, r.get("best") or {}
        rows.append(" | ".join([
            f"| {r['id']}", r["kind"], _f(cur.get("score"), "{:.1f}"), _f(best.get("score"), "{:.1f}"),
            f"{_f((cur.get('iou') or {}).get('worst'))} → {_f((best.get('iou') or {}).get('worst'))}",
            f"{_f((cur.get('surface') or {}).get('chamfer'), '{:.4f}')} → "
            f"{_f((best.get('surface') or {}).get('chamfer'), '{:.4f}')}",
            str(best.get("triangles", "–")), _knobs(best["config"]) if best else "–", str(len(r["trials"])),
            r["stopped"], "yes" if best.get("gatesPass") else "no"]) + " |")
        if r["id"] == "stove" or (not stove and r["kind"] != "room"):
            stove = trial_table(r)
    body = "\n".join(rows) if len(rows) > 2 else "(no loop.json yet: run `loop.sbatch <scene> stove`)"
    return body + ("\n\n" + stove if stove else "")


def trial_table(r: dict) -> str:
    rows = [f"Trials for {r['id']} (Pareto front marked ◆, best ★):", "",
            "| # | Rung | Configuration | Score | IoU worst | Chamfer (m) | Tris | MB | Seconds |", "|" + "---|" * 9]
    best_n = (r.get("best") or {}).get("n")
    for t in r["trials"]:
        mark = ("★ " if t["n"] == best_n else "") + ("◆" if t["n"] in r["pareto"] else "")
        rows.append(" | ".join([
            f"| {t['n']} {mark}".rstrip(), str(t["rung"]), _knobs(t["config"]),
            _f(t.get("score"), "{:.1f}") if not t.get("error") else "error: " + t["error"][:60],
            _f((t.get("iou") or {}).get("worst")), _f((t.get("surface") or {}).get("chamfer"), "{:.4f}"),
            str(t.get("triangles", "–")), _f((t.get("bytes") or 0) / 1e6, "{:.1f}"), _f(t.get("seconds"), "{:.0f}")])
            + " |")
    rows += ["", "Recommendation: " + r["recommendation"]]
    return "\n".join(rows)


def tables(scene: Path) -> str:
    return "### Evaluator, every object\n\n" + eval_table(scene) + "\n\n### Loop, current vs best\n\n" + \
        loop_table(scene)


def write_between(path: Path, body: str) -> None:
    text = path.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        raise SystemExit(f"{path} has no {BEGIN} ... {END} markers")
    path.write_text(re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), lambda _: f"{BEGIN}\n{body}\n{END}", text,
                           flags=re.S), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", required=True)
    ap.add_argument("--write", default=None)
    a = ap.parse_args(argv)
    body = tables(Path(a.scene))
    if a.write:
        write_between(Path(a.write), body)
    else:
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
