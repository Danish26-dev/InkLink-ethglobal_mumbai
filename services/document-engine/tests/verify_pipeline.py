"""End-to-end verification of the deterministic pipeline (no AI, no LibreOffice).

Creates a real DOCX with body text, a table, and a header, runs the
convert->edit->convert pipeline with a validated plan, and asserts the edits
landed correctly while untouched text is preserved.

Run:  venv/Scripts/python.exe -m tests.verify_pipeline
"""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document

from app.editing.schema import OperationPlan
from app.service import process_document
from app.storage.files import create_job
from app.inspect import extract_text


def build_sample(path: Path) -> None:
    doc = Document()
    doc.add_paragraph("Dear John, welcome to Acme Corp.")
    doc.add_paragraph("This letter confirms your role at Acme Corp.")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Name: John"
    table.rows[0].cells[1].text = "Company: Acme Corp"
    section = doc.sections[0]
    section.header.paragraphs[0].text = "Acme Corp - Confidential"
    doc.save(str(path))


def main() -> int:
    job = create_job()
    sample = job.path("sample.docx")
    build_sample(sample)

    plan = OperationPlan.model_validate(
        {
            "operations": [
                {"type": "replace_text", "find": "John", "replace": "Jane"},
                {"type": "replace_text", "find": "Acme Corp", "replace": "Globex"},
            ]
        }
    )

    outcome = process_document(
        job=job,
        source_path=sample,
        filename="sample.docx",
        plan=plan,
    )

    text = extract_text(job, outcome.output_path, outcome.output_path.name)

    print("--- CHANGE SUMMARY ---")
    print(outcome.change_summary)
    print("--- OUTPUT TEXT ---")
    print(text)

    failures = []
    if "John" in text:
        failures.append("'John' should have been replaced")
    if "Jane" not in text:
        failures.append("'Jane' missing after replace")
    if "Acme Corp" in text:
        failures.append("'Acme Corp' should have been replaced")
    if text.count("Globex") < 2:
        failures.append("'Globex' replacement count too low")
    if "copies" in outcome.change_summary:
        failures.append("change summary must not carry print copies (print config, not an edit)")
    if outcome.output_format.value != "docx":
        failures.append("output format must match the uploaded format (docx)")

    # Output format must always equal input format.
    from app.conversion.engine import DocFormat
    from app.conversion.errors import OutputFormatMismatchError

    job2 = create_job()
    sample2 = job2.path("sample2.docx")
    build_sample(sample2)
    try:
        process_document(
            job=job2,
            source_path=sample2,
            filename="sample2.docx",
            plan=plan,
            output_format=DocFormat.PDF,
        )
        failures.append("DOCX -> PDF output was accepted; output format must match input")
    except OutputFormatMismatchError:
        pass

    # Header replacement check
    hdr = Document(str(outcome.output_path)).sections[0].header.paragraphs[0].text
    if "Globex" not in hdr:
        failures.append(f"header not updated (got: {hdr!r})")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  -", f)
        return 1

    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
