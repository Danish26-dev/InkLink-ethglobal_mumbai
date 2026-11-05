"""Typed errors for the conversion engine so the API can map them to clear,
user-facing messages instead of leaking stack traces."""

from __future__ import annotations


class ConversionError(Exception):
    """Base class for all conversion failures."""

    #: HTTP status the API layer should use for this error.
    status_code = 500
    #: Stable machine-readable code for the frontend.
    code = "conversion_error"


class ScannedPdfError(ConversionError):
    """Raised when a PDF has no extractable text (scanned / image-based)."""

    status_code = 422
    code = "scanned_pdf"

    def __init__(self) -> None:
        super().__init__(
            "Inklink currently supports editable digital PDFs. "
            "This file appears to be scanned or image-based."
        )


class UnsupportedFormatError(ConversionError):
    status_code = 415
    code = "unsupported_format"


class LibreOfficeUnavailableError(ConversionError):
    """Raised when DOCX -> PDF is requested but LibreOffice is not installed."""

    status_code = 503
    code = "libreoffice_unavailable"

    def __init__(self) -> None:
        super().__init__(
            "PDF output is temporarily unavailable because the conversion "
            "engine (LibreOffice) is not installed on this server."
        )


class OutputFormatMismatchError(ConversionError):
    """Raised when a caller asks for an output format different from the
    uploaded format. Inklink returns documents in the format they arrived in."""

    status_code = 400
    code = "output_format_mismatch"

    def __init__(self, input_format: str, requested: str) -> None:
        super().__init__(
            f"Output format must match the uploaded format ({input_format}); "
            f"'{requested}' was requested."
        )


class FileTooLargeError(ConversionError):
    """Raised when an upload exceeds MAX_UPLOAD_BYTES."""

    status_code = 413
    code = "file_too_large"

    def __init__(self, limit_bytes: int) -> None:
        super().__init__(
            f"The document is larger than the {limit_bytes // (1024 * 1024)} MB limit."
        )


class PageScopeUnsupportedError(ConversionError):
    """Raised when a page-scoped replacement is requested but the engine cannot
    enforce page boundaries for this document.

    Page scoping requires fixed pagination, which only PDFs have. DOCX has no
    fixed pages until rendered, and the conversion pipeline reconstructs the
    document, so a page range cannot be honoured there. We refuse clearly
    rather than silently applying the change to the whole document."""

    status_code = 422
    code = "page_scope_unsupported"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message
            or "Page-specific edits are only supported for digital PDF documents. "
            "This document has no fixed pages, so a page range cannot be applied."
        )
