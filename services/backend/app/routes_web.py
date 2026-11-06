"""Customer-facing routes: web app (no login) and native Contracts 1-4, 8."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Header, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import events
from .auth import (
    any_principal,
    api_error,
    issue_event_ticket,
    issue_session,
    job_for,
    redeem_event_ticket,
    web_customer_reference,
    web_principal,
)
from .config import get_settings
from .documents import count_pages, detect_format, is_valid_docx, safe_filename
from .jobs import QuoteError, add_message, contract_print_config, create_quote, job_dir, quote_contract, quote_expired, start_operator_run
from .security import new_token
from .store import DocumentRecord, HandoffRecord, JobRecord, Principal, get_store, iso_from_epoch, new_id, now_iso
from .views import job_status, job_view, shop_channel, shop_contract

router = APIRouter(prefix="/api/v1")


# ───────────── sessions + shops ─────────────

@router.post("/web/sessions")
async def create_web_session() -> dict[str, Any]:
    """Anonymous, short-lived browser session. No login, no wallet, no PII."""
    s = get_settings()
    ref = web_customer_reference()
    token, expires = issue_session("web", ref, s.web_session_ttl_seconds)
    return {"sessionToken": token, "expiresAt": iso_from_epoch(expires), "customerReference": ref}


@router.get("/shops")
async def list_shops(_: Principal = Depends(any_principal)) -> list[dict[str, Any]]:
    return [await shop_channel()]


@router.get("/shops/{shop_id}")
async def get_shop(shop_id: str, _: Principal = Depends(any_principal)) -> dict[str, Any]:
    if shop_id != get_settings().shop_id:
        raise api_error(404, "SHOP_NOT_FOUND", "Unknown shop.")
    return shop_contract()


# ───────────── Contract 3: create job ─────────────

class PrintConfigIn(BaseModel):
    copies: int = Field(1, ge=1, le=999)
    pageRange: str = "all"
    colourMode: str = "grayscale"
    paperSize: str = "A4"


class CreateJobIn(BaseModel):
    shopId: str
    documentId: str | None = None
    printConfig: PrintConfigIn | None = None


@router.post("/jobs")
async def create_job(body: CreateJobIn, principal: Principal = Depends(any_principal)) -> dict[str, Any]:
    store = get_store()
    s = get_settings()
    if body.shopId != s.shop_id:
        raise api_error(404, "SHOP_NOT_FOUND", "Unknown shop.")
    if not store.shop_config().get("acceptingOrders", True):
        raise api_error(503, "SHOP_UNAVAILABLE", "This shop is not accepting orders right now.")
    now = now_iso()
    job = JobRecord(
        job_id=new_id("job"),
        shop_id=body.shopId,
        owner=principal.ref,
        created_at=now,
        updated_at=now,
        print_config=(body.printConfig or PrintConfigIn()).model_dump(),
    )
    with store.lock:
        store.jobs[job.job_id] = job
        add_message(job, "system", f"Connected to {store.shop_config()['name']}. Upload a PDF or DOCX and tell the print operator what you need.")
        store.save()
    events.publish_job_status(job)
    return {"jobId": job.job_id, "status": "created", "createdAt": job.created_at}


# ───────────── Contract 2: upload ─────────────

@router.post("/documents")
async def upload_document(
    file: UploadFile = File(...),
    jobId: str = Form(...),
    shopId: str = Form(""),
    customerId: str = Form(""),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    principal: Principal = Depends(any_principal),
) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    job = job_for(principal, jobId)
    if idempotency_key and idempotency_key in store.upload_keys:
        return store.upload_keys[idempotency_key]
    data = await file.read(s.max_upload_bytes + 1)
    if len(data) > s.max_upload_bytes:
        raise api_error(413, "DOCUMENT_TOO_LARGE", "Documents are limited to 25 MB.")
    filename = safe_filename(file.filename or "document")
    fmt = detect_format(filename, data[:8])
    if fmt is None or (fmt == "docx" and not is_valid_docx(data)):
        raise api_error(415, "UNSUPPORTED_FORMAT", "Only valid PDF and DOCX files are supported.")
    if job.status not in ("created", "awaiting_payment"):
        raise api_error(409, "UPLOAD_FAILED", "This job can no longer change its document.")

    path = job_dir(job.job_id) / f"original.{fmt}"
    path.write_bytes(data)
    doc = DocumentRecord(
        document_id=new_id("doc"),
        filename=filename,
        format=fmt,
        size=len(data),
        original_path=str(path),
        page_count=count_pages(path, fmt),
    )
    resp = {"documentId": doc.document_id, "jobId": job.job_id, "filename": filename, "format": fmt, "size": len(data), "status": "uploaded"}
    with store.lock:
        job.document = doc
        job.config_validated = False
        job.execution_requested = False
        job.quote_id = None
        job.customer_approved_quote = False
        job.status = "created"
        add_message(job, "system", f"Uploaded {filename} ({fmt.upper()}{f', {doc.page_count} pages' if doc.page_count else ''}).")
        if idempotency_key:
            store.upload_keys[idempotency_key] = resp
        store.touch(job)
        store.save()
    events.publish_job_status(job)
    return resp


# ───────────── job view, conversation, preview ─────────────

@router.get("/jobs/{job_id}")
async def get_job(job_id: str, principal: Principal = Depends(any_principal)) -> dict[str, Any]:
    return job_view(job_for(principal, job_id))


@router.get("/jobs/{job_id}/status")
async def get_job_status(job_id: str, principal: Principal = Depends(any_principal)) -> dict[str, Any]:
    return job_status(job_for(principal, job_id))


@router.get("/jobs/{job_id}/messages")
async def get_messages(job_id: str, principal: Principal = Depends(any_principal)) -> list[dict[str, Any]]:
    return job_for(principal, job_id).messages


class MessageIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


@router.post("/jobs/{job_id}/messages")
async def post_message(job_id: str, body: MessageIn, principal: Principal = Depends(web_principal)) -> dict[str, Any]:
    store = get_store()
    job = job_for(principal, job_id)
    if job.status not in ("created", "awaiting_payment"):
        raise api_error(409, "POLICY_VIOLATION", "This job is already paid or printing; it can no longer be changed.")
    if job.run_active:
        raise api_error(409, "POLICY_VIOLATION", "The print operator is still working on your last message.")
    text = body.text.strip()
    with store.lock:
        msg = add_message(job, "customer", text)
        # A new instruction may change the configuration; any earlier quote is no longer valid.
        if job.quote_id:
            job.quote_id = None
            job.customer_approved_quote = False
            job.status = "created"
        store.touch(job)
        store.save()
    start_operator_run(job, text)
    return msg


@router.post("/jobs/{job_id}/tickets")
async def create_ticket(job_id: str, principal: Principal = Depends(any_principal)) -> dict[str, Any]:
    job_for(principal, job_id)
    return {"ticket": issue_event_ticket(principal, job_id), "expiresInSeconds": 60}


@router.get("/jobs/{job_id}/document")
async def get_document(job_id: str, ticket: str, version: str = "current") -> FileResponse:
    redeem_event_ticket(ticket, job_id)
    job = get_store().jobs.get(job_id)
    if not job or not job.document:
        raise api_error(404, "JOB_NOT_FOUND", "No document for this job.")
    doc = job.document
    chosen = doc.original_path if version == "original" or not doc.edited_path else doc.edited_path
    media = "application/pdf" if doc.format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    disposition = "inline" if doc.format == "pdf" else "attachment"
    return FileResponse(chosen, media_type=media, filename=doc.filename, content_disposition_type=disposition)


# ───────────── Contract 4: quote + customer approval ─────────────

@router.post("/jobs/{job_id}/quote")
async def quote(job_id: str, principal: Principal = Depends(any_principal)) -> dict[str, Any]:
    job = job_for(principal, job_id)
    if job.status not in ("created", "awaiting_payment"):
        raise api_error(409, "POLICY_VIOLATION", "This job can no longer be re-quoted.")
    try:
        return quote_contract(create_quote(job))
    except QuoteError as exc:
        raise api_error(exc.status, exc.code, exc.message) from exc


@router.post("/jobs/{job_id}/quote/approve")
async def approve_quote(job_id: str, principal: Principal = Depends(web_principal)) -> dict[str, Any]:
    """Customer approves the quote in the web app; payment continues in the native app."""
    s = get_settings()
    store = get_store()
    job = job_for(principal, job_id)
    q = store.quotes.get(job.quote_id) if job.quote_id else None
    if not q:
        raise api_error(409, "JOB_NOT_FOUND", "Request a quote first.")
    if quote_expired(q):
        raise api_error(410, "QUOTE_EXPIRED", "The quote has expired; request a new quote.")
    if "hedera_x402" not in q.payment_methods:
        raise api_error(
            409,
            "FACILITATOR_UNSUPPORTED",
            "This shop has no payment method configured yet, so the order cannot be paid.",
        )
    token = new_token()
    exp = time.time() + s.handoff_ttl_seconds
    with store.lock:
        job.customer_approved_quote = True
        store.handoffs[token] = HandoffRecord(token=token, job_id=job.job_id, quote_id=q.quote_id, expires_at=exp)
        add_message(job, "system", "Quote approved. Continue in the Inklink app to authorize payment.")
        store.touch(job)
        store.save()
    events.publish(job.job_id, "approval_required", {"kind": "payment", "reason": "Authorize payment in the Inklink app."})
    deep_link = f"{s.handoff_deep_link_base}?handoff={token}"
    return {
        "jobId": job.job_id,
        "quoteId": q.quote_id,
        "handoffToken": token,
        "deepLink": deep_link,
        "qrText": json.dumps({"type": "inklink_payment_handoff", "version": "1.0", "handoff": token}, separators=(",", ":")),
        "expiresAt": iso_from_epoch(exp),
    }


# ───────────── SSE ─────────────

@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    request: Request,
    ticket: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    after: int = 0,
) -> StreamingResponse:
    redeem_event_ticket(ticket, job_id)
    if job_id not in get_store().jobs:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")
    start = int(last_event_id) if last_event_id and last_event_id.isdigit() else after

    async def stream():
        queue = events.subscribe(job_id)
        try:
            sent = start
            for e in events.history(job_id, start):
                sent = e["seq"]
                yield f"id: {e['seq']}\nevent: {e['type']}\ndata: {json.dumps(e)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    e = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Named, data-carrying heartbeat (not a comment) so browsers can
                    # detect a silently dead connection, e.g. behind a proxy.
                    yield f"event: heartbeat\ndata: {json.dumps({'ts': time.time()})}\n\n"
                    continue
                if e["seq"] <= sent:
                    continue
                sent = e["seq"]
                yield f"id: {e['seq']}\nevent: {e['type']}\ndata: {json.dumps(e)}\n\n"
        finally:
            events.unsubscribe(job_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
    )
