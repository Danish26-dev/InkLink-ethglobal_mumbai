"""DOCX -> PDF conversion via LibreOffice headless.

LibreOffice produces high-fidelity PDFs from DOCX and is the reliable choice
for production. We invoke `soffice --headless --convert-to pdf`. If LibreOffice
is not installed we raise LibreOfficeUnavailableError so the caller can degrade
gracefully (e.g. return the DOCX) instead of crashing.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from ..config import get_settings
from .errors import ConversionError, LibreOfficeUnavailableError


def convert_docx_to_pdf(docx_path: Path, out_dir: Path) -> Path:
    """Convert `docx_path` to PDF inside `out_dir`. Returns the PDF path.

    LibreOffice names the output after the input stem with a .pdf extension,
    written into `out_dir`.
    """
    settings = get_settings()
    soffice = settings.resolve_soffice()
    if not soffice:
        raise LibreOfficeUnavailableError()

    out_dir.mkdir(parents=True, exist_ok=True)
    expected_pdf = out_dir / (docx_path.stem + ".pdf")

    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        str(out_dir),
        str(docx_path),
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=settings.convert_timeout,
        )
    except subprocess.TimeoutExpired as exc:  # pragma: no cover - env dependent
        raise ConversionError(
            f"PDF conversion timed out after {settings.convert_timeout}s"
        ) from exc

    if proc.returncode != 0 or not expected_pdf.exists():
        raise ConversionError(
            "LibreOffice failed to convert the document to PDF. "
            f"stderr: {proc.stderr.strip()[:500]}"
        )

    return expected_pdf
