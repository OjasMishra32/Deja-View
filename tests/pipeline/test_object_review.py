"""Approval is bound to the exact file bytes."""
import pipeline_helpers  # noqa: F401
from objects import review


def test_approval_records_the_hash_and_invalidates_after_a_change(tmp_path):
    glb = tmp_path / "x.glb"
    glb.write_bytes(b"first bytes")
    data = review.record(glb, True, "looked at the sheet", "tester")
    assert data["approved"] is True
    assert data["sha1"] == review.sha1_file(glb)
    ok, why = review.approval_matches(glb, tmp_path / "preflight" / review.APPROVAL_FILE)
    assert ok, why
    glb.write_bytes(b"changed bytes")
    ok, why = review.approval_matches(glb, tmp_path / "preflight" / review.APPROVAL_FILE)
    assert not ok and "changed" in why


def test_denial_is_not_approval(tmp_path):
    glb = tmp_path / "x.glb"
    glb.write_bytes(b"bytes")
    review.record(glb, False, "poster with QR, do not upload", "tester")
    ok, why = review.approval_matches(glb, tmp_path / "preflight" / review.APPROVAL_FILE)
    assert not ok and "not approved" in why
