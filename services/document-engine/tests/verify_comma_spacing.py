"""Regression test for the certificate comma-spacing issue.

Reproduces: a name span immediately followed by a comma span. Replacing the
name with a SHORTER string must NOT leave a visible gap before the comma. The
fix right-anchors a shorter replacement to the original span's right edge when
the following span is immediately adjacent.

Run from the document-engine dir:
    $env:PYTHONPATH="."; .\\venv\\Scripts\\python.exe tests\\verify_comma_spacing.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.editing.pdf_native import apply_plan_native
from app.editing.schema import OperationPlan

failures: list[str] = []


def _fail(msg: str) -> None:
    failures.append(msg)
    print("  FAIL:", msg)


def _spans(path: Path, page_no: int = 0) -> list[dict]:
    doc = pymupdf.open(str(path))
    out: list[dict] = []
    for b in doc[page_no].get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            out.extend(ln.get("spans", []))
    doc.close()
    return out


def _span_with(path: Path, needle: str, page_no: int = 0) -> dict | None:
    for s in _spans(path, page_no):
        if needle in s["text"]:
            return s
    return None


def _build_name_comma_pdf(path: Path) -> None:
    """Build a page where the name is immediately followed by a comma span,
    mirroring the certificate line. We insert the name and the ', bearing the'
    as SEPARATE text so they become adjacent spans with ~0 gap."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    size = 12.0
    font = pymupdf.Font("tiro")  # Times-Roman (what the surrounding text uses)
    boldfont = pymupdf.Font("tibo")
    y = 200.0
    x = 72.0
    # "carried out by Mr. "
    pre = "carried out by Mr. "
    page.insert_text((x, y), pre, fontsize=size, fontname="tiro")
    x += font.text_length(pre, fontsize=size)
    # name (bold) — this is what we will replace
    name = "Jordan Avery Blake"
    page.insert_text((x, y), name, fontsize=size, fontname="tibo")
    x_name_end = x + boldfont.text_length(name, fontsize=size)
    # comma + rest, IMMEDIATELY adjacent (start exactly at name end)
    page.insert_text((x_name_end, y), ", bearing the", fontsize=size, fontname="tiro")
    doc.save(str(path))
    doc.close()


def test_adjacent_comma_shorter(tmp: Path) -> None:
    print("[1] shorter replacement + adjacent comma -> gap closes")
    src = tmp / "cert.pdf"
    _build_name_comma_pdf(src)

    before = _span_with(src, "Jordan Avery Blake")
    comma_before = _span_with(src, ", bearing")
    orig_gap = comma_before["bbox"][0] - before["bbox"][2]
    print(f"    original name.x1={before['bbox'][2]:.2f} comma.x0={comma_before['bbox'][0]:.2f} "
          f"gap={orig_gap:.2f}")
    if orig_gap > 2.0:
        _fail(f"test setup: name and comma not adjacent in original (gap {orig_gap:.2f})")

    out = tmp / "cert_edited.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "Jordan Avery Blake", "replace": "Sam Rivera Lee"},
    ]})
    apply_plan_native(src, out, plan)

    name_after = _span_with(out, "Sam Rivera Lee")
    comma_after = _span_with(out, ", bearing")
    if not name_after or not comma_after:
        _fail("replacement or comma span missing after edit")
        return
    gap = comma_after["bbox"][0] - name_after["bbox"][2]
    print(f"    edited  name.x1={name_after['bbox'][2]:.2f} comma.x0={comma_after['bbox'][0]:.2f} "
          f"gap={gap:.2f}")
    # The fix: replacement right edge should meet the comma (gap ~0), NOT ~25pt.
    if gap > 2.0:
        _fail(f"gap before comma is {gap:.2f}pt (expected <= 2pt after right-anchor)")
    # Comma span itself must NOT have moved.
    if abs(comma_after["bbox"][0] - comma_before["bbox"][0]) > 0.5:
        _fail("comma span moved; neighbouring span must not be touched")
    # No space-before-comma artefact in extracted text.
    doc = pymupdf.open(str(out))
    txt = doc[0].get_text("text")
    doc.close()
    if "Sam Rivera Lee ," in txt or "Lee  ," in txt:
        _fail("space-before-comma artefact present")
    if "Sam Rivera Lee" not in txt:
        _fail("replacement text not present / not searchable")


def test_standalone_left_anchor(tmp: Path) -> None:
    print("[2] standalone shorter replacement stays LEFT-anchored")
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 200), "Jordan Avery Blake", fontsize=12, fontname="tibo")
    src = tmp / "standalone.pdf"
    doc.save(str(src)); doc.close()

    before = _span_with(src, "Jordan Avery Blake")
    out = tmp / "standalone_edited.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "Jordan Avery Blake", "replace": "Sam Rivera Lee"},
    ]})
    apply_plan_native(src, out, plan)
    after = _span_with(out, "Sam Rivera Lee")
    if not after:
        _fail("standalone replacement missing")
        return
    # Left edge should remain at the original x0 (left-anchored, unchanged).
    if abs(after["bbox"][0] - before["bbox"][0]) > 0.5:
        _fail(f"standalone replacement not left-anchored (x0 {before['bbox'][0]:.2f} -> {after['bbox'][0]:.2f})")


def test_longer_still_flagged(tmp: Path) -> None:
    print("[3] longer replacement still flagged (unchanged behaviour)")
    src = tmp / "cert2.pdf"
    _build_name_comma_pdf(src)
    out = tmp / "cert2_edited.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "Jordan Avery Blake",
         "replace": "Jordan Avery Blake The Third Of His Noble And Very Long Name"},
    ]})
    res = apply_plan_native(src, out, plan)
    if not any(r.flagged for r in res.replaces):
        _fail("longer replacement was not flagged")


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        test_adjacent_comma_shorter(tmp)
        test_standalone_left_anchor(tmp)
        test_longer_still_flagged(tmp)
    if failures:
        print(f"\n{len(failures)} FAILURE(S)")
        return 1
    print("\nALL COMMA-SPACING CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
