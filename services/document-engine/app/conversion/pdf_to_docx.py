"""PDF -> DOCX conversion with scanned-PDF detection.

We only support editable digital PDFs. Before converting we check whether the
PDF actually contains extractable text. If it does not (a scanned image), we
raise ScannedPdfError so the caller can return a clear message rather than
producing an empty or garbage document.
"""

from __future__ import annotations

from pathlib import Path

from .errors import ScannedPdfError

# Minimum number of non-whitespace characters across the document for us to
# treat a PDF as "text-based" rather than scanned.
_MIN_TEXT_CHARS = 10


def pdf_has_extractable_text(pdf_path: Path) -> bool:
    """Return True if the PDF contains a meaningful amount of extractable text.

    Uses pdf2docx's bundled PyMuPDF (fitz). Scanned PDFs are images and yield
    little or no text.
    """
    import fitz  # PyMuPDF, a dependency of pdf2docx

    char_count = 0
    with fitz.open(str(pdf_path)) as doc:
        for page in doc:
            char_count += len(page.get_text("text").strip())
            if char_count >= _MIN_TEXT_CHARS:
                return True
    return char_count >= _MIN_TEXT_CHARS


def convert_pdf_to_docx(pdf_path: Path, out_docx_path: Path) -> Path:
    """Convert a digital PDF to DOCX. Raises ScannedPdfError for scanned PDFs."""
    if not pdf_has_extractable_text(pdf_path):
        raise ScannedPdfError()

    from pdf2docx import Converter

    out_docx_path.parent.mkdir(parents=True, exist_ok=True)
    converter = Converter(str(pdf_path))
    try:
        converter.convert(str(out_docx_path), start=0, end=None)
    finally:
        converter.close()

    return out_docx_path
