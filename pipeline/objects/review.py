#!/usr/bin/env python3
"""Record a human decision about one exact object asset.

    python pipeline/objects/review.py --glb data/scenes/kitchen/objects/fridge/roblox.glb \
        --approve --note "no poster, only atlas noise"

Writes preflight/approval.json next to the GLB with the file's SHA1. The upload gate
requires an approval whose SHA1 matches the file, so any change needs a new review.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

APPROVAL_FILE = "approval.json"


def sha1_file(path: str | Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def record(glb: str | Path, approved: bool, note: str, reviewer: str | None = None) -> dict:
    glb = Path(glb)
    out_dir = glb.parent / "preflight"
    out_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "version": 1,
        "glb": str(glb),
        "sha1": sha1_file(glb),
        "bytes": glb.stat().st_size,
        "approved": bool(approved),
        "reviewer": reviewer or getpass.getuser(),
        "at": datetime.now(timezone.utc).isoformat(),
        "note": note,
    }
    (out_dir / APPROVAL_FILE).write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def approval_matches(glb: str | Path, approval: str | Path) -> tuple[bool, str]:
    try:
        d = json.loads(Path(approval).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False, "approval file is missing or unreadable"
    if d.get("approved") is not True:
        return False, "the asset is not approved"
    if d.get("sha1") != sha1_file(glb):
        return False, "the file changed since it was approved"
    return True, "approved"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--glb", required=True)
    ap.add_argument("--approve", action="store_true")
    ap.add_argument("--deny", action="store_true")
    ap.add_argument("--note", default="")
    args = ap.parse_args(argv)
    glb = Path(args.glb)
    pre = glb.parent / "preflight"
    report = pre / "preflight.json"
    if report.exists():
        d = json.loads(report.read_text(encoding="utf-8"))
        print(f"sheet: {d.get('sheet')}  clear={d.get('clear')}  scan={d.get('scan', {}).get('status')}")
        print(f"qr={len(d.get('scan', {}).get('qr', []))} candidates={len(d.get('scan', {}).get('qrCandidates', []))} barcodes={len(d.get('scan', {}).get('barcodes', []))}")
    else:
        print("No preflight report. Run pipeline/objects/preflight.py first.")
    if args.approve and args.deny:
        raise SystemExit("choose --approve or --deny, not both")
    approved = args.approve
    if not args.approve and not args.deny:
        answer = input("Approve this exact file for upload? [y/N] ").strip().lower()
        approved = answer in ("y", "yes")
    if not approved and not args.deny:
        print("Not approved. Nothing written.")
        return 1
    data = record(glb, approved, args.note)
    print(f"{'approved' if approved else 'denied'} {data['sha1'][:12]} by {data['reviewer']}")
    return 0 if approved else 1


if __name__ == "__main__":
    raise SystemExit(main())
