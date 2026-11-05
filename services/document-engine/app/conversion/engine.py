"""Conversion engine facade.

The editing layer only ever works on DOCX. This module handles the edges:
turning whatever the user uploaded into DOCX, and turning the edited DOCX back
into the format the user should receive.

V1 supported input/output formats: DOCX and (digital) PDF.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from .docx_to_pdf import convert_docx_to_pdf
from .errors import UnsupportedFormatError
from .pdf_to_docx import convert_pdf_to_docx


class DocFormat(str, Enum):
    DOCX = "docx"
    PDF = "pdf"


def detect_format(filename: str) -> DocFormat:
    """Determine the format from the file extension. Raises for anything
    outside the V1 supported set."""
    ext = Path(filename).suffix.lower().lstrip(".")
    if ext == "docx":
        return DocFormat.DOCX
    if ext == "pdf":
        return DocFormat.PDF
    raise UnsupportedFormatError(
        f"Unsupported file type '.{ext}'. Inklink supports .docx and digital .pdf files."
    )


def normalize_to_docx(src_path: Path, src_format: DocFormat, work_dir: Path) -> Path:
    """Return a path to a DOCX representation of the source document.

    DOCX passes through unchanged. PDF is converted (with scanned detection).
    """
    if src_format is DocFormat.DOCX:
        return src_path

    if src_format is DocFormat.PDF:
        out = work_dir / (src_path.stem + ".docx")
        return convert_pdf_to_docx(src_path, out)

    raise UnsupportedFormatError(f"Cannot normalize format: {src_format}")


def render_from_docx(docx_path: Path, target_format: DocFormat, work_dir: Path) -> Path:
    """Convert the edited DOCX into the target output format."""
    if target_format is DocFormat.DOCX:
        return docx_path

    if target_format is DocFormat.PDF:
        return convert_docx_to_pdf(docx_path, work_dir)

    raise UnsupportedFormatError(f"Cannot render to format: {target_format}")
