"""The convert -> edit -> convert pipeline.

This is the deterministic heart of the Document Engine. It takes an uploaded
file plus an already-validated OperationPlan and produces an edited file in the
requested output format, reporting exactly what changed.

Flow:
  1. Detect input format (docx | digital pdf).
  2. Normalize to DOCX (pdf -> docx, with scanned detection).
  3. Apply the validated plan deterministically (python-docx).
  4. Render to the target output format (default: same as input).
  5. Return the output path + a change summary.

No LLM calls occur here. The plan is produced upstream (the agent layer) and is
re-validated against the closed schema before it ever reaches this module.
The output format always equals the input format.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .config import get_settings
from .conversion.engine import (
    DocFormat,
    detect_format,
    normalize_to_docx,
    render_from_docx,
)
from .conversion.errors import (
    LibreOfficeUnavailableError,
    OutputFormatMismatchError,
    PageScopeUnsupportedError,
)
from .editing.operations import apply_plan
from .editing.pdf_native import (
    NativeEditUnsupported,
    apply_plan_native,
    can_handle as native_can_handle,
)
from .editing.schema import OperationPlan, ReplaceTextOperation
from .storage.files import Job
from .validation import validate_output

logger = logging.getLogger("inklink.document_engine")


def _plan_has_page_scope(plan: OperationPlan) -> bool:
    """True if any replace_text operation restricts itself to a page range."""
    return any(
        isinstance(op, ReplaceTextOperation) and op.pages is not None
        for op in plan.operations
    )


@dataclass
class ProcessOutcome:
    output_path: Path
    output_format: DocFormat
    input_format: DocFormat
    change_summary: dict
    validation: dict


def process_document(
    job: Job,
    source_path: Path,
    filename: str,
    plan: OperationPlan,
    output_format: DocFormat | None = None,
) -> ProcessOutcome:
    """Run the full pipeline for one document within a job directory.

    `output_format` is accepted for backward compatibility with callers that
    send it explicitly, but it must equal the input format: Inklink returns a
    document in the same format it was uploaded in.
    """
    input_format = detect_format(filename)
    if output_format is not None and output_format is not input_format:
        raise OutputFormatMismatchError(input_format.value, output_format.value)
    target_format = input_format

    work_dir = job.dir

    # ------------------------------------------------------------------
    # FAST PATH: native, layout-preserving in-place PDF editing.
    #
    # When the input is a PDF, the output is a PDF, and the plan only uses
    # operations native editing supports, we edit the PDF IN PLACE instead of
    # round-tripping through DOCX. The round-trip (pdf2docx + LibreOffice)
    # reconstructs the document and can inflate pagination on real reports
    # (measured 22 -> 32..44 pages). Native editing preserves page count, page
    # dimensions, images, and all unaffected content.
    #
    # This is a HYBRID: if native editing cannot safely handle an occurrence it
    # raises NativeEditUnsupported and we fall back to the conversion pipeline.
    # We NEVER silently change the output format.
    # ------------------------------------------------------------------
    if (
        input_format is DocFormat.PDF
        and target_format is DocFormat.PDF
        and native_can_handle(plan)
    ):
        native_out = work_dir / ("edited_native_" + source_path.name)
        try:
            native = apply_plan_native(source_path, native_out, plan)
            report = validate_output(
                native_out,
                target_format.value,
                plan,
                executed_replacements=native.total_replacements,
                original_pdf=source_path,
                strategy="native_pdf",
            )
            return ProcessOutcome(
                output_path=native_out,
                output_format=target_format,
                input_format=input_format,
                change_summary=native.as_dict(),
                validation=report.as_dict(),
            )
        except NativeEditUnsupported as exc:
            # Honest fallback: native editing could not be applied safely, so we
            # use the conversion pipeline. Logged (code only) for observability.
            logger.info("native PDF edit not applicable; falling back to conversion: %s", exc)

    # PAGE-SCOPE GUARD: a page range can ONLY be enforced by the native PDF
    # path (which has fixed pages). If we reach here with a page-scoped plan,
    # we are about to use the DOCX/conversion pipeline, which reconstructs the
    # document and cannot honour page boundaries. Refuse clearly rather than
    # silently applying the replacement to the whole document.
    if _plan_has_page_scope(plan):
        raise PageScopeUnsupportedError(
            "Page-specific edits are only supported for digital PDF documents "
            "edited in place. This request could not be handled that way, so the "
            "page range cannot be enforced. Try without a page restriction, or "
            "use a digital PDF."
        )

    # FAIL FAST: if the target output is PDF but the PDF renderer (LibreOffice)
    # is unavailable on this host, do NOT perform the expensive PDF->DOCX->edit
    # work only to fail at the final render. Raise immediately with a clear,
    # actionable error so the caller (and the agent) can stop without looping.
    if target_format is DocFormat.PDF and get_settings().resolve_soffice() is None:
        raise LibreOfficeUnavailableError()

    # 1 + 2: normalize to DOCX (pass-through for docx, convert for pdf).
    docx_path = normalize_to_docx(source_path, input_format, work_dir)

    # If the source was already a DOCX, edit a copy so we never mutate the
    # original upload in place (keeps the raw upload available if needed).
    if input_format is DocFormat.DOCX:
        edited_docx = work_dir / ("edited_" + docx_path.name)
        edited_docx.write_bytes(docx_path.read_bytes())
        docx_path = edited_docx

    # 3: apply the validated plan deterministically.
    execution = apply_plan(docx_path, plan)

    # 4: render to the requested output format.
    output_path = render_from_docx(docx_path, target_format, work_dir)

    # The conversion pipeline reconstructs PDFs, so pass the original PDF for a
    # structural comparison (page-count/dimension deltas are FLAGGED, not
    # forbidden — some legitimate edits reflow).
    original_pdf = source_path if input_format is DocFormat.PDF else None
    strategy = "conversion" if input_format is DocFormat.PDF else "docx_direct"

    # 5: validate the produced output before reporting success. Raises
    # OutputValidationError (mapped to a clean API error) on hard failures.
    report = validate_output(
        output_path,
        target_format.value,
        plan,
        executed_replacements=execution.total_replacements,
        original_pdf=original_pdf,
        strategy=strategy,
    )

    return ProcessOutcome(
        output_path=output_path,
        output_format=target_format,
        input_format=input_format,
        change_summary=execution.as_dict(),
        validation=report.as_dict(),
    )
