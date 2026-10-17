"""Hard gates. Any failure blocks promotion no matter how good the score is (team/shivin-reconstruction-loop.md):
a decodable QR code or link, a missing texture, a broken silhouette, or a file that changed after its approval.
The gates read approval files; they never write one."""
from __future__ import annotations

import json
from pathlib import Path

BROKEN_WORST_IOU = 0.5  # any held-out view below this is a broken silhouette
BROKEN_MEDIAN_IOU = 0.7


def silhouette_gate(ious: list[float]) -> dict:
    if not ious:
        return {"pass": False, "reason": "no held-out view sees the object"}
    worst, med = min(ious), sorted(ious)[len(ious) // 2]
    ok = worst >= BROKEN_WORST_IOU and med >= BROKEN_MEDIAN_IOU
    return {"pass": ok, "worstIoU": round(worst, 4), "medianIoU": round(med, 4),
            "reason": "ok" if ok else f"silhouette broken (worst IoU {worst:.2f}, median {med:.2f})"}


def texture_gate(textures: list) -> dict:
    ok = len(textures) > 0
    return {"pass": ok, "reason": "ok" if ok else "no base colour texture in the GLB"}


def code_gate(scan: dict | None) -> dict:
    """From `preflight.scan_codes`. A payload-carrying QR code or barcode fails; an unavailable scanner fails closed;
    empty-payload pattern hits are listed for the human but pass."""
    if scan is None or scan.get("status") != "ok":
        return {"pass": False, "reason": f"code scan unavailable ({(scan or {}).get('reason', 'not run')}); "
                                         "run preflight.py where OpenCV is installed"}
    hits = [q.get("text") for q in scan.get("qr", [])] + [b.get("text") for b in scan.get("barcodes", [])]
    links = [t for t in hits if t]
    return {"pass": not links, "reason": "ok" if not links else f"decodable code(s): {links[:3]}",
            "candidates": len(scan.get("qrCandidates", []))}


def approval_gate(glb: Path, sha1: str) -> dict:
    """`stale` (approved earlier, file changed since) fails. `none` passes the gate but is not an approval:
    a new file always needs a person to approve it."""
    path = Path(glb).parent / "preflight" / "approval.json"
    if not path.exists():
        return {"pass": True, "approval": "none", "reason": "not approved yet; a person must approve this exact file"}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"pass": False, "approval": "unreadable", "reason": "approval.json is unreadable"}
    if d.get("sha1") == sha1 and d.get("approved") is True:
        return {"pass": True, "approval": "match", "reason": "approved, unchanged"}
    if d.get("sha1") == sha1:
        return {"pass": False, "approval": "denied", "reason": "a person denied this exact file"}
    return {"pass": False, "approval": "stale", "reason": "the GLB changed after its approval; it needs a new one"}


def combine(gates: dict) -> dict:
    failed = [k for k, g in gates.items() if not g["pass"]]
    return {"pass": not failed, "failed": failed, **gates}
