"""Regression tests for page-scoped PDF editing + typography.

Run from the document-engine dir:
    $env:PYTHONPATH="."; .\\venv\\Scripts\\python.exe tests\\verify_page_scope.py

Covers:
  A. Same match text on pages 1-4 -> replaced only on 1-3; page 4 unchanged.
  B. Global (no page range) -> replaced on all pages.
  C. Typography: no space before comma/period, no double spaces.
  D. Longer replacement is flagged (not silently shrunk).
  E. Invalid page range is rejected.
  F. Page-scoped op on a DOCX is rejected (page scope is PDF-only).
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pymupdf
from docx import Document as Docx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.editing.pdf_native import apply_plan_native, NativeEditUnsupported
from app.editing.schema import OperationPlan
from app.service import process_document
from app.conversion.engine import DocFormat
from app.conversion.errors import PageScopeUnsupportedError
from app.storage.files import create_job, save_upload

failures: list[str] = []


def _fail(msg: str) -> None:
    failures.append(msg)
    print("  FAIL:", msg)


def _four_page_pdf(path: Path) -> None:
    d = pymupdf.open()
    for pg in range(4):
        p = d.new_page(width=595, height=842)
        p.insert_text((72, 120), "Name: Jordan Avery Blake, student", fontsize=12)
        p.insert_text((72, 150), "USN is REG23AB136.", fontsize=12)
        p.insert_text((72, 190), "Unrelated content stays.", fontsize=12)
    d.save(str(path))
    d.close()


def _texts(path: Path) -> list[str]:
    with pymupdf.open(str(path)) as doc:
        return [p.get_text("text") for p in doc]


def test_page_scope(tmp: Path) -> None:
    print("[A/C] page-scoped 1-3 + typography")
    src = tmp / "four.pdf"
    _four_page_pdf(src)
    out = tmp / "scoped.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "Jordan Avery Blake", "replace": "Sam Rivera Lee",
         "pages": {"from": 1, "to": 3}},
        {"type": "replace_text", "find": "REG23AB136", "replace": "REG23AB117",
         "pages": {"from": 1, "to": 3}},
    ]})
    res = apply_plan_native(src, out, plan)
    t = _texts(out)
    if len(t) != 4:
        _fail(f"page count changed: {len(t)}")
    for i in range(3):
        if "Sam Rivera Lee" not in t[i] or "REG23AB117" not in t[i]:
            _fail(f"page {i+1} missing replacement")
        if "Jordan Avery Blake" in t[i] or "REG23AB136" in t[i]:
            _fail(f"page {i+1} still has original")
    # page 4 unchanged
    if "Jordan Avery Blake" not in t[3] or "REG23AB136" not in t[3]:
        _fail("page 4 was changed but should not be")
    if "Sam Rivera Lee" in t[3] or "REG23AB117" in t[3]:
        _fail("page 4 contains a replacement but should not")
    # typography: no space before comma/period, no double space
    for i in range(3):
        if "Sam Rivera Lee ," in t[i] or "Lee  " in t[i]:
            _fail(f"page {i+1} space-before-comma / double space")
        if "REG23AB117 ." in t[i]:
            _fail(f"page {i+1} space-before-period")
    # reported pages are 1-based and correct
    pages_reported = sorted({pg for r in res.replaces for pg in r.pages})
    if pages_reported != [1, 2, 3]:
        _fail(f"reported pages wrong: {pages_reported}")
    print("    ok" if not failures else "    (see failures)")


def test_global(tmp: Path) -> None:
    print("[B] global (no page range)")
    src = tmp / "four2.pdf"
    _four_page_pdf(src)
    out = tmp / "global.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "REG23AB136", "replace": "REG23AB117"},
    ]})
    res = apply_plan_native(src, out, plan)
    t = _texts(out)
    if not all("REG23AB117" in t[i] and "REG23AB136" not in t[i] for i in range(4)):
        _fail("global replacement did not cover all 4 pages")
    if res.total_replacements != 4:
        _fail(f"expected 4 replacements, got {res.total_replacements}")


def test_longer_flagged(tmp: Path) -> None:
    print("[D] longer replacement flagged")
    src = tmp / "four3.pdf"
    _four_page_pdf(src)
    out = tmp / "longer.pdf"
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "REG23AB136",
         "replace": "REG23AB136-MUCH-LONGER-OVERFLOWING-REGISTRATION",
         "pages": {"from": 1, "to": 1}},
    ]})
    res = apply_plan_native(src, out, plan)
    if not any(r.flagged for r in res.replaces):
        _fail("longer replacement was not flagged")


def test_invalid_range(tmp: Path) -> None:
    print("[E] invalid page range rejected")
    src = tmp / "four4.pdf"
    _four_page_pdf(src)
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "REG23AB136", "replace": "X",
         "pages": {"from": 99, "to": 100}},
    ]})
    try:
        apply_plan_native(src, tmp / "bad.pdf", plan)
        _fail("invalid range did not raise")
    except NativeEditUnsupported:
        pass


def test_docx_page_scope_rejected(tmp: Path) -> None:
    print("[F] page-scoped op on DOCX rejected")
    docx = tmp / "d.docx"
    doc = Docx()
    doc.add_paragraph("Name: Jordan Avery Blake")
    doc.save(str(docx))
    job = create_job()
    sp = save_upload(job, "d.docx", docx.read_bytes())
    plan = OperationPlan.model_validate({"operations": [
        {"type": "replace_text", "find": "Jordan Avery Blake", "replace": "Sam Rivera Lee",
         "pages": {"from": 1, "to": 1}},
    ]})
    try:
        process_document(job=job, source_path=sp, filename="d.docx", plan=plan,
                         output_format=DocFormat.DOCX)
        _fail("DOCX page-scoped op was NOT rejected")
    except PageScopeUnsupportedError:
        pass


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        test_page_scope(tmp)
        test_global(tmp)
        test_longer_flagged(tmp)
        test_invalid_range(tmp)
        test_docx_page_scope_rejected(tmp)
    if failures:
        print(f"\n{len(failures)} FAILURE(S)")
        return 1
    print("\nALL PAGE-SCOPE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
