"""Inklink Document Engine — FastAPI service.

Deterministic document processing service. It applies a validated operation
plan to a PDF or DOCX and returns the edited file in the SAME format. It never
calls an LLM; the plan is produced upstream by the agent layer and is
re-validated here against the closed operation schema.

Endpoints:
  GET  /health              service + LibreOffice availability
  GET  /operations          list supported operation types (for prompts/help)
  POST /inspect             extract plain text from an uploaded doc
  POST /process             file + operation plan -> edited file (job created)
  GET  /jobs/{id}/download  download the edited output for a job
  DELETE /jobs/{id}         permanently delete a job's files (privacy)

This service is a deterministic executor, not a system of record. The Inklink
backend owns authoritative job and payment status.
"""

from __future__ import annotations

import json
import logging
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError

from .config import get_settings
from .conversion.engine import DocFormat, detect_format
from .conversion.errors import ConversionError, FileTooLargeError
from .editing.schema import OperationPlan, supported_operations
from .validation import OutputValidationError
from .inspect import extract_text
from .service import process_document
from .storage.files import cleanup_expired, create_job, delete_job, get_job, save_upload

logger = logging.getLogger("inklink.document_engine")

app = FastAPI(title="Inklink Document Engine", version="1.0.0")

# CORS is OFF unless explicitly configured. The engine is called server-side by
# the agent layer / Inklink backend; browsers should never talk to it directly.
_settings = get_settings()
if _settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_settings.allowed_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )


@app.exception_handler(ConversionError)
async def _conversion_error_handler(_request, exc: ConversionError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": str(exc)}},
    )


@app.exception_handler(OutputValidationError)
async def _output_validation_error_handler(_request, exc: OutputValidationError):
    # The produced document failed validation; fail clearly rather than return
    # a possibly-corrupted file.
    return JSONResponse(
        status_code=422,
        content={"error": {"code": exc.code, "message": "The edited document failed validation."}},
    )


async def _read_bounded(file: UploadFile) -> bytes:
    """Read an upload, refusing anything above MAX_UPLOAD_BYTES."""
    limit = get_settings().max_upload_bytes
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise FileTooLargeError(limit)
    return content


def _expire_old_jobs() -> None:
    """Best-effort removal of abandoned job directories. Never fails a request."""
    try:
        cleanup_expired(get_settings().job_ttl_seconds)
    except OSError as exc:  # pragma: no cover - filesystem dependent
        logger.warning("job cleanup skipped: %s", exc.__class__.__name__)


@app.get("/health")
async def health():
    settings = get_settings()
    return {
        "status": "healthy",
        "service": "inklink-document-engine",
        "libreoffice_available": settings.resolve_soffice() is not None,
    }


@app.get("/operations")
async def operations():
    """Expose the closed set of supported operations, for the agent's prompt
    and for client-side help."""
    return {"supported_operations": supported_operations()}


@app.post("/inspect")
async def inspect(file: UploadFile = File(...)):
    """Return plain-text content of the uploaded document so the agent can
    reason about it. Read-only: no files are retained."""
    filename = file.filename or "upload"
    detect_format(filename)  # reject unsupported formats before touching disk
    content = await _read_bounded(file)
    job = create_job()
    try:
        src = save_upload(job, filename, content)
        text = extract_text(job, src, filename)
        return {"job_id": job.job_id, "text": text, "chars": len(text)}
    finally:
        delete_job(job.job_id)


def _parse_plan(plan_raw: str) -> OperationPlan:
    """Parse and validate an incoming operation plan (untrusted input)."""
    try:
        data = json.loads(plan_raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_plan_json", "message": f"Plan is not valid JSON: {exc}"},
        )
    if isinstance(data, list):
        data = {"operations": data}
    try:
        return OperationPlan.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_plan",
                "message": "Operation plan failed validation against the supported schema.",
                "errors": json.loads(exc.json()),
            },
        )


@app.post("/process")
async def process(
    file: UploadFile = File(...),
    plan: str = Form(..., description="JSON operation plan (validated server-side)"),
    output_format: str | None = Form(
        None,
        description="Optional; if sent it must equal the uploaded format (docx|pdf).",
    ),
):
    """Apply a validated operation plan to the uploaded document and return a
    job id + change summary. The edited file is fetched via /jobs/{id}/download.
    """
    filename = file.filename or "upload"
    detect_format(filename)
    content = await _read_bounded(file)
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_file", "message": "Uploaded file is empty."},
        )

    validated_plan = _parse_plan(plan)

    out_fmt: DocFormat | None = None
    if output_format:
        of = output_format.strip().lower()
        if of not in ("docx", "pdf"):
            raise HTTPException(
                status_code=400,
                detail={"code": "bad_output_format", "message": "output_format must be 'docx' or 'pdf'."},
            )
        out_fmt = DocFormat(of)

    _expire_old_jobs()
    job = create_job()
    try:
        src = save_upload(job, filename, content)
        outcome = process_document(
            job=job,
            source_path=src,
            filename=filename,
            plan=validated_plan,
            output_format=out_fmt,
        )
    except BaseException:
        # A failed job must not leave the uploaded document on disk.
        delete_job(job.job_id)
        raise

    return {
        "job_id": job.job_id,
        "input_format": outcome.input_format.value,
        "output_format": outcome.output_format.value,
        "output_filename": outcome.output_path.name,
        "changes": outcome.change_summary,
        "validation": outcome.validation,
        "download_url": f"/jobs/{job.job_id}/download",
    }


@app.get("/jobs/{job_id}/download")
async def download(job_id: str, filename: str | None = None):
    """Download an output file from a job directory."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "Unknown job."})

    target = None
    if filename:
        candidate = job.path(filename)
        if candidate.exists():
            target = candidate
    else:
        # The newest file in the job directory is the edited output.
        files = [p for p in job.dir.iterdir() if p.is_file()]
        if files:
            target = max(files, key=lambda p: p.stat().st_mtime)

    if target is None or not target.exists():
        raise HTTPException(status_code=404, detail={"code": "file_not_found", "message": "No output file."})

    return FileResponse(path=str(target), filename=target.name)


@app.delete("/jobs/{job_id}")
async def delete(job_id: str):
    """Permanently delete a job's files (privacy cleanup)."""
    ok = delete_job(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "Unknown job."})
    return {"deleted": True, "job_id": job_id}


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    # Bind to loopback by default; containers set HOST=0.0.0.0 explicitly.
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=settings.port)
