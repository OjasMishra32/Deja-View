#!/usr/bin/env python3
"""Turn `detail-summary.json` (and the per-object `detail.json`) into the markdown table for docs/object-detail.md
and team/detail-report.md (task 6).

    python pipeline/objects/detail/report.py --eval data/scenes/kitchen/detail-eval > /tmp/table.md
    python pipeline/objects/detail/report.py --eval ... --write team/detail-report.md   # between the markers
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

BEGIN, END = "<!-- detail-table:begin -->", "<!-- detail-table:end -->"


def _f(x, fmt="{:.2f}") -> str:
    return "–" if x is None else fmt.format(x)


def table(eval_dir: Path) -> str:
    summary = json.loads((eval_dir / "detail-summary.json").read_text())
    sets = list(summary["sets"])
    head = ["Object", "Kind"] + [f"{s} score" for s in sets] + ["IoU cur→new", "SSIM cur→new", "Sharp cur→new",
                                                                  "Holes cur→new", "Tris new", "Maps new", "Best"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    failures = []
    for o in summary["objects"]:
        rec = json.loads((eval_dir / o["id"] / "detail.json").read_text())
        m = rec["meshes"]
        cur, new = m.get("current", {}), m.get("new", {})
        kind = "–"
        model = Path(new.get("file", "")).parent / "detail-model.json" if new.get("file") else None
        if model and model.exists():
            kind = json.loads(model.read_text()).get("kind", "–")
        maps = new.get("maps") or {}
        row = [o["id"], kind] + [_f(m.get(s, {}).get("score"), "{:.1f}") for s in sets] + [
            f"{_f(cur.get('iou'))}→{_f(new.get('iou'))}", f"{_f(cur.get('ssim'))}→{_f(new.get('ssim'))}",
            f"{_f(cur.get('sharpness'))}→{_f(new.get('sharpness'))}",
            f"{cur.get('mesh', {}).get('holes', '–')}→{new.get('mesh', {}).get('holes', '–')}",
            str(new.get("mesh", {}).get("triangles", "–")),
            "".join(k[0].upper() for k in ("normal", "ao", "roughness") if maps.get(k)) or "–", o.get("best") or "–"]
        lines.append("| " + " | ".join(row) + " |")
        for s, v in m.items():
            if v.get("error") or v.get("missing"):
                failures.append(f"- {o['id']} / {s}: {v.get('error') or 'missing'}")
            elif v.get("score") is not None and v["score"] < 60:
                failures.append(f"- {o['id']} / {s}: score {v['score']} ({v.get('grade')}), IoU {_f(v.get('iou'))}, "
                                f"holes {v.get('mesh', {}).get('holes')}")
    out = "\n".join(lines)
    if failures:
        out += "\n\nRemaining failures (score < 60, errors, missing):\n\n" + "\n".join(failures)
    return out


def write_between(path: Path, body: str) -> None:
    text = path.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        raise SystemExit(f"{path} has no {BEGIN} ... {END} markers")
    new = re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), lambda _: f"{BEGIN}\n{body}\n{END}", text, flags=re.S)
    path.write_text(new, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--eval", required=True)
    ap.add_argument("--write", default=None)
    a = ap.parse_args(argv)
    body = table(Path(a.eval))
    if a.write:
        write_between(Path(a.write), body)
    else:
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
