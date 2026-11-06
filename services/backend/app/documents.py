"""Upload validation and page counting for quotes.

PDF pages are counted with pypdf. DOCX has no fixed pagination; the page
count Word last saved in docProps/app.xml is used when present. If neither is
available the backend refuses to quote rather than guessing a price.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path


def detect_format(filename: str, head: bytes) -> str | None:
    name = filename.lower()
    if name.endswith(".pdf") and head[:5] == b"%PDF-":
        return "pdf"
    if name.endswith(".docx") and head[:2] == b"PK":
        return "docx"
    return None


def count_pages(path: Path, fmt: str) -> int | None:
    try:
        if fmt == "pdf":
            from pypdf import PdfReader

            return len(PdfReader(str(path)).pages) or None
        if fmt == "docx":
            with zipfile.ZipFile(path) as zf:
                if "docProps/app.xml" not in zf.namelist():
                    return None
                xml = zf.read("docProps/app.xml").decode("utf-8", "ignore")
            m = re.search(r"<Pages>(\d+)</Pages>", xml)
            return int(m.group(1)) if m and int(m.group(1)) > 0 else None
    except Exception:  # noqa: BLE001 - a broken file simply has no countable pages
        return None
    return None


def safe_filename(name: str) -> str:
    base = Path(name).name or "document"
    return re.sub(r"[^A-Za-z0-9._ -]", "_", base)[:120]


def is_valid_docx(data: bytes) -> bool:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return "word/document.xml" in zf.namelist()
    except zipfile.BadZipFile:
        return False
