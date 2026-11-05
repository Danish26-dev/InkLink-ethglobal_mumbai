"""Deterministic executors for validated operations.

No LLM calls happen here. Given a validated `OperationPlan` and a DOCX file,
this module applies each operation with plain Python (python-docx) and reports
exactly what changed. Same input always produces the same output.

Design notes:
  - Text replacement preserves formatting. python-docx often splits a single
    visible word across multiple "runs" (formatting spans). We handle both the
    easy case (target within one run) and the hard case (target spans runs).
  - We walk paragraphs in the body, every table cell, and every header/footer
    so replacements are complete across the whole document.
  - Copy count is print configuration, not a document edit, and is not handled
    here (see schema.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from docx import Document
from docx.document import Document as DocxDocument
from docx.table import Table
from docx.text.paragraph import Paragraph

from .schema import OperationPlan, ReplaceTextOperation


@dataclass
class OperationResult:
    """What a single operation did, for verification/preview."""

    type: str
    description: str
    details: dict = field(default_factory=dict)


@dataclass
class ExecutionResult:
    """Aggregate outcome of applying a plan to a document."""

    results: list[OperationResult] = field(default_factory=list)
    total_replacements: int = 0

    def as_dict(self) -> dict:
        return {
            "total_replacements": self.total_replacements,
            "operations": [
                {"type": r.type, "description": r.description, "details": r.details}
                for r in self.results
            ],
        }


def _replace_in_paragraph(paragraph: Paragraph, target: str, value: str) -> int:
    """Replace `target` with `value` in one paragraph. Returns match count.

    Preserves the formatting of the first run in the paragraph. Handles the
    common python-docx case where a word is split across multiple runs.
    """
    if target not in paragraph.text:
        return 0

    count = paragraph.text.count(target)

    # Fast path: target lives entirely within individual runs.
    if any(target in run.text for run in paragraph.runs):
        for run in paragraph.runs:
            if target in run.text:
                run.text = run.text.replace(target, value)
        # After per-run replacement, if the target no longer appears anywhere,
        # we are done. Otherwise it spanned runs and we fall through.
        if target not in paragraph.text:
            return count

    # Slow path: target spans multiple runs. Collapse text into the first run,
    # clear the rest. This preserves the first run's formatting.
    if not paragraph.runs:
        return 0

    full_text = "".join(run.text for run in paragraph.runs)
    full_text = full_text.replace(target, value)
    paragraph.runs[0].text = full_text
    for run in paragraph.runs[1:]:
        run.text = ""
    return count


def _iter_tables_paragraphs(table: Table):
    """Yield every paragraph inside a table, recursing into nested tables."""
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                yield paragraph
            for nested in cell.tables:
                yield from _iter_tables_paragraphs(nested)


def _all_body_paragraphs(doc: DocxDocument):
    """Yield paragraphs from the body and all tables."""
    for paragraph in doc.paragraphs:
        yield paragraph
    for table in doc.tables:
        yield from _iter_tables_paragraphs(table)


def _all_header_footer_paragraphs(doc: DocxDocument):
    """Yield paragraphs from every section's headers and footers."""
    for section in doc.sections:
        for container in (section.header, section.footer,
                          section.first_page_header, section.first_page_footer,
                          section.even_page_header, section.even_page_footer):
            for paragraph in container.paragraphs:
                yield paragraph
            for table in container.tables:
                yield from _iter_tables_paragraphs(table)


def _apply_replace(doc: DocxDocument, op: ReplaceTextOperation) -> int:
    total = 0
    for paragraph in _all_body_paragraphs(doc):
        total += _replace_in_paragraph(paragraph, op.find, op.replace)
    for paragraph in _all_header_footer_paragraphs(doc):
        total += _replace_in_paragraph(paragraph, op.find, op.replace)
    return total


def apply_plan(docx_path: Path, plan: OperationPlan) -> ExecutionResult:
    """Apply a validated plan to the DOCX at `docx_path`, saving in place.

    Returns an ExecutionResult describing exactly what changed. Content is only
    ever modified through the specific operations below; nothing else in the
    document is regenerated or touched.
    """
    doc = Document(str(docx_path))
    result = ExecutionResult()
    content_changed = False

    for op in plan.operations:
        if isinstance(op, ReplaceTextOperation):
            count = _apply_replace(doc, op)
            result.total_replacements += count
            content_changed = content_changed or count > 0
            result.results.append(
                OperationResult(
                    type="replace_text",
                    description=(
                        f'Replaced "{op.find}" with "{op.replace}" '
                        f"({count} occurrence{'s' if count != 1 else ''})"
                    ),
                    details={
                        "find": op.find,
                        "replace": op.replace,
                        "occurrences": count,
                    },
                )
            )

    if content_changed:
        doc.save(str(docx_path))

    return result
