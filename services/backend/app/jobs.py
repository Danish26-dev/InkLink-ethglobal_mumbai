"""Job lifecycle: operator runs, quotes and the physical-execution gate.

The backend is the single authority for job state. The agent proposes a
validated print configuration; the backend decides when, and whether, the job
may be printed. Physical execution requires ALL of:

  1. a print configuration the agent validated AND the backend re-validated
     with the printer adapter right before submission,
  2. the customer's approval of the current quote (web),
  3. a settled payment — `settled` only ever comes from the verified, signed
     settlement callback, which moves the job to `awaiting_execution`,
  4. the shop's approval (dashboard),
  5. a printable document (the printer adapter accepts PDF only).

Payment settlement authorizes execution; it never marks a job completed.
A spooler acceptance is reported as `executing`, not `completed`.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from . import zerog
from .clients import ServiceError, agent_health, fetch_engine_output, stream_operator_run, submit_print, validate_print_config
from .config import get_settings
from .documents import count_pages
from .events import publish, publish_job_status
from .inference import issue_grant, revoke_grant
from .pricing import inr_price, inr_to_usdc
from .sensitivity import select_trust_mode
from .store import DocumentRecord, JobRecord, QuoteRecord, get_store, iso_from_epoch, new_id, now_iso

_running: set[str] = set()


def add_message(job: JobRecord, role: str, text: str) -> dict[str, Any]:
    msg = {"messageId": new_id("msg"), "jobId": job.job_id, "role": role, "text": text, "createdAt": now_iso()}
    job.messages.append(msg)
    return msg


def contract_print_config(op: dict[str, Any]) -> dict[str, Any]:
    """Map the operator config to Contract 3 `PrintConfig` vocabulary."""
    return {
        "copies": op.get("copies") or 1,
        "pageRange": "all",
        "colourMode": "grayscale" if op.get("colorMode") == "monochrome" else "colour",
        "paperSize": op.get("paperSize") or "A4",
    }


def working_document_path(doc: DocumentRecord) -> Path | None:
    """The file the operator works on: the edited copy unless the customer rejected it."""
    if doc.purged:
        return None
    if doc.edited_path and doc.edit_status in ("pending_review", "approved"):
        return Path(doc.edited_path)
    return Path(doc.original_path)


def printable_document_path(doc: DocumentRecord) -> Path | None:
    """The file that may be priced and printed: an edited copy only after customer approval."""
    if doc.purged:
        return None
    if doc.edited_path and doc.edit_status == "approved":
        return Path(doc.edited_path)
    return Path(doc.original_path)


def job_dir(job_id: str) -> Path:
    d = get_settings().data_dir / "documents" / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# ───────────────────────── operator runs ─────────────────────────

async def _handle_harness_event(job: JobRecord, event: dict[str, Any]) -> None:
    store = get_store()
    etype = event.get("type")
    payload = dict(event.get("payload") or {})

    if etype == "configuration_updated" and isinstance(payload.get("config"), dict):
        with store.lock:
            job.operator_config = {k: payload["config"].get(k) for k in job.operator_config}
            job.config_validated = False
            job.execution_requested = False  # a change invalidates an earlier request
            job.print_config = contract_print_config(job.operator_config)
            store.touch(job)
            store.save()
    elif etype == "tool_succeeded" and payload.get("tool") == "validate_print_config":
        with store.lock:
            job.config_validated = True
            store.touch(job)
            store.save()
    elif etype == "document_processed" and payload.get("engineJobId") and job.document:
        try:
            data = await fetch_engine_output(str(payload["engineJobId"]))
            path = job_dir(job.job_id) / f"edited.{job.document.format}"
            path.write_bytes(data)
            with store.lock:
                # The original stays untouched; the edit waits for customer review.
                job.document.edited_path = str(path)
                job.document.edit_status = "pending_review"
                job.document.review_recommended = bool(payload.get("reviewRecommended"))
                job.document.notes = [str(n) for n in payload.get("notes") or []][:20]
                store.touch(job)
                store.save()
            publish(job.job_id, "approval_required", {"kind": "document_review",
                                                      "reason": "Review the edited document before it can be priced or printed."})
        except ServiceError as exc:
            publish(job.job_id, "tool_failed", {
                "runId": payload.get("runId", ""),
                "toolUseId": "backend_fetch_edited",
                "tool": "execute_operation_plan",
                "error": {"code": exc.code, "message": exc.message},
            })

    if etype == "agent_started" and job.trust_selection:
        # Add the backend's policy decision (labels only) next to the agent's own report.
        sel = job.trust_selection
        payload["trustMode"] = sel.get("effectiveTrustMode", payload.get("trustMode"))
        payload["trustSelection"] = {k: sel.get(k) for k in (
            "requiredTrustMode", "requestedTrustMode", "effectiveTrustMode", "reason", "raisedBy", "documentLevel")}

    publish(job.job_id, etype, payload, source="agent")

    if etype == "agent_finished":
        text = str(payload.get("message") or "")
        with store.lock:
            if text:
                add_message(job, "agent" if payload.get("outcome") != "unavailable" else "system", text)
            store.touch(job)
            store.save()


class RunRefused(Exception):
    """The run must not start (policy or configuration); the message is customer-safe."""


async def prepare_inference(job: JobRecord, run_id: str, instruction: str) -> dict[str, Any] | None:
    """Select the trust mode for this run and issue an inference grant.

    Returns the `inference` descriptor for the agent, or None when the agent is
    explicitly configured for Vertex AI and the document is non-sensitive.
    Raises RunRefused before any document content is sent anywhere.
    """
    store = get_store()
    s = get_settings()
    doc = job.document
    doc_class = doc.classification if doc and not doc.purged else None
    if doc and not doc.purged and doc_class is None:
        doc_class = {"level": "unclassified", "categories": [], "signals": {}, "reason": "The document has not been classified."}
    try:
        selection = select_trust_mode(
            doc_class=doc_class,
            instruction=instruction,
            customer_requested=job.requested_trust_mode,
            shop_minimum=store.shop_config().get("minimumTrustMode"),
        )
    except zerog.ZeroGError as exc:
        raise RunRefused(exc.message) from exc
    mode = selection["effectiveTrustMode"]
    selection["documentLevel"] = doc_class["level"] if doc_class else None
    selection["at"] = now_iso()

    health = await agent_health()
    provider = ((health or {}).get("modelProvider") or {}).get("provider")
    if provider == "vertex-ai":
        selection.update(provider="vertex-ai", model=((health or {}).get("modelProvider") or {}).get("model"))
        with store.lock:
            job.trust_selection = selection
            store.save()
        if mode != "standard":
            raise RunRefused(
                f"This job requires {mode} inference, which only 0G Private Computer provides. The agent is configured "
                "for Vertex AI, so the document was not sent. Switch the agent to 0g-private-computer."
            )
        return None

    try:
        model = await zerog.preflight(mode, needs_tools=True)
    except zerog.ZeroGError as exc:
        selection.update(provider="0g-private-computer", model=zerog.model_for(mode), error=exc.as_dict())
        with store.lock:
            job.trust_selection = selection
            store.save()
        raise RunRefused(exc.message) from exc

    grant = issue_grant(job.job_id, run_id, mode, model)
    selection.update(provider="0g-private-computer", model=model)
    with store.lock:
        job.trust_selection = selection
        store.save()
    return {
        "baseUrl": f"{s.backend_internal_url}/api/v1/internal/inference/v1",
        "token": grant.token,
        "model": model,
        "trustMode": mode,
    }


async def run_operator(job_id: str, instruction: str) -> None:
    """Background task: one print-operator run for a job, relayed as events."""
    store = get_store()
    job = store.jobs[job_id]
    run_id = new_id("run")
    inference: dict[str, Any] | None = None
    try:
        try:
            inference = await prepare_inference(job, run_id, instruction)
        except RunRefused as exc:
            await _handle_harness_event(job, {"type": "agent_finished", "payload": {
                "runId": run_id, "outcome": "unavailable", "message": f"The print operator did not start: {exc}"}})
            return
        doc_tuple = None
        if job.document:
            src = working_document_path(job.document)
            if src and src.exists():
                doc_tuple = (job.document.filename, src.read_bytes())
        defaults = store.shop_config().get("defaults", {})
        finished = False
        async for event in stream_operator_run(
            job_id=job.job_id,
            run_id=run_id,
            instruction=instruction,
            document=doc_tuple,
            defaults=defaults,
            current={k: v for k, v in job.operator_config.items() if v is not None},
            inference=inference,
        ):
            await _handle_harness_event(job, event)
            finished = finished or event.get("type") == "agent_finished"
        if not finished:
            await _handle_harness_event(job, {"type": "agent_finished", "payload": {
                "runId": run_id, "outcome": "failed", "message": "The print operator stopped before finishing."}})
    except ServiceError as exc:
        await _handle_harness_event(job, {"type": "agent_finished", "payload": {
            "runId": run_id,
            "outcome": "unavailable" if exc.code in ("AGENT_UNREACHABLE", "AGENT_NOT_CONFIGURED") or exc.status == 503 else "failed",
            "message": f"The print operator is unavailable: {exc.message}",
        }})
    finally:
        if inference:
            revoke_grant(inference["token"])
        with store.lock:
            job.run_active = False
            store.save()
        _running.discard(job_id)


def start_operator_run(job: JobRecord, instruction: str) -> bool:
    """Start a run unless one is already active for the job."""
    if job.job_id in _running:
        return False
    _running.add(job.job_id)
    job.run_active = True
    asyncio.get_running_loop().create_task(run_operator(job.job_id, instruction))
    return True


# ───────────────────────── quotes ─────────────────────────

class QuoteError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def create_quote(job: JobRecord) -> QuoteRecord:
    s = get_settings()
    store = get_store()
    if not job.document:
        raise QuoteError("UPLOAD_FAILED", "Upload a document before requesting a quote.")
    if not job.config_validated:
        raise QuoteError("POLICY_VIOLATION", "The print configuration has not been validated yet.", 409)
    if job.document.edit_status == "pending_review":
        raise QuoteError("POLICY_VIOLATION", "Review the edited document (approve it or keep the original) before getting a price.", 409)
    path = printable_document_path(job.document)
    if path is None:
        raise QuoteError("UPLOAD_FAILED", "The document was deleted under the retention policy; upload it again.", 410)
    pages = count_pages(path, job.document.format) if path != Path(job.document.original_path) else (
        job.document.page_count or count_pages(path, job.document.format))
    if not pages:
        raise QuoteError(
            "UNSUPPORTED_FORMAT",
            "The page count of this document is not available, so it cannot be priced automatically.",
            422,
        )
    copies = int(job.operator_config.get("copies") or 1)
    color = job.operator_config.get("colorMode") or "monochrome"
    cfg = store.shop_config()
    per_page = cfg["pricePerPageColor"] if color == "color" else cfg["pricePerPageMonochrome"]
    inr = inr_price(pages, copies, per_page)

    now = time.time()
    usdc = inr_to_usdc(inr, s.inr_to_usdc_rate) if s.payments_configured else None
    quote = QuoteRecord(
        quote_id=new_id("quote"),
        job_id=job.job_id,
        merchant_id=job.shop_id,
        inr=inr,
        usdc=usdc,
        rate=s.inr_to_usdc_rate if usdc else None,
        captured_at=iso_from_epoch(now),
        expires_at=iso_from_epoch(now + s.quote_ttl_seconds),
        payment_methods=["hedera_x402"] if usdc else [],
        pages=pages,
        copies=copies,
        color_mode=color,
    )
    with store.lock:
        store.quotes[quote.quote_id] = quote
        job.quote_id = quote.quote_id
        job.customer_approved_quote = False
        job.status = "awaiting_payment"
        store.touch(job)
        store.save()
    publish(job.job_id, "approval_required", {"kind": "customer_quote", "reason": f"Quote {inr} INR is ready for approval."})
    publish_job_status(job)
    return quote


def quote_contract(q: QuoteRecord) -> dict[str, Any]:
    """Contract 4 shape."""
    out: dict[str, Any] = {
        "quoteId": q.quote_id,
        "jobId": q.job_id,
        "merchantId": q.merchant_id,
        "amount": q.inr,
        "asset": "INR",
        "expiresAt": q.expires_at,
        "paymentMethods": q.payment_methods,
    }
    if q.usdc:
        out["settlement"] = {"asset": "HTS-USDC", "amount": q.usdc, "rate": q.rate, "capturedAt": q.captured_at}
    return out


def quote_expired(q: QuoteRecord) -> bool:
    from datetime import datetime

    return datetime.fromisoformat(q.expires_at.replace("Z", "+00:00")).timestamp() <= time.time()


# ───────────────────────── execution gate ─────────────────────────

def pending_gates(job: JobRecord) -> list[str]:
    pending = []
    if not job.config_validated:
        pending.append("print_configuration")
    if not job.customer_approved_quote:
        pending.append("customer_quote")
    if job.payment_status != "settled" or job.status not in ("awaiting_execution",):
        pending.append("payment")
    if not job.shop_approved:
        pending.append("shop")
    return pending


async def try_execute(job_id: str) -> dict[str, Any]:
    """Submit the job to the printer adapter if, and only if, every gate is satisfied."""
    store = get_store()
    job = store.jobs[job_id]
    if job.submission and job.submission.get("ok"):
        return {"state": "already_submitted", "pending": []}
    if not job.execution_requested:
        return {"state": "awaiting_operator", "pending": ["operator_request"]}
    pending = pending_gates(job)
    if pending:
        return {"state": "pending", "pending": pending}
    if not job.document or job.document.format != "pdf":
        msg = "The printer adapter prints PDF only; DOCX printing needs a PDF rendering step that is not available."
        with store.lock:
            job.submission = {"ok": False, "state": "UNSUPPORTED_FORMAT", "message": msg}
            store.save()
        publish(job_id, "printer_readiness_updated", {"printerId": job.operator_config.get("printerId"), "status": "unknown", "available": False})
        return {"state": "blocked", "pending": ["printable_document"], "message": msg}

    # Re-validate against the live printer right before submitting.
    try:
        ok, errors = await validate_print_config(job.operator_config)
    except ServiceError as exc:
        return {"state": "blocked", "pending": ["printer"], "message": exc.message}
    if not ok:
        with store.lock:
            job.config_validated = False
            store.save()
        return {"state": "blocked", "pending": ["print_configuration"], "message": " ".join(errors)}

    path = printable_document_path(job.document)
    if path is None or not path.exists() or job.document.edit_status == "pending_review":
        return {"state": "blocked", "pending": ["printable_document"], "message": "The document to print is not available or awaits review."}
    try:
        result = await submit_print(job.operator_config, path.read_bytes())
    except ServiceError as exc:
        with store.lock:
            job.device_status = "error"
            job.submission = {"ok": False, "state": exc.code, "message": exc.message}
            store.touch(job)
            store.save()
        publish_job_status(job)
        return {"state": "blocked", "pending": ["printer"], "message": exc.message}

    with store.lock:
        job.submission = {k: result.get(k) for k in ("ok", "state", "message", "submissionId")}
        if result.get("ok"):
            job.status = "executing"
            job.device_status = "processing"
        else:
            job.device_status = "error"
        store.touch(job)
        store.save()
    if result.get("ok"):
        publish(job_id, "execution_authorized", {"authorizedBy": "backend", "submissionState": result.get("state")})
    publish_job_status(job)
    return {"state": "submitted" if result.get("ok") else "blocked", "pending": [], "message": result.get("message", "")}
