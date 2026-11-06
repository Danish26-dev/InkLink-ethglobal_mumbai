"""ETHGlobal jury demo orchestration (prefix /api/v1/jury).

A jury session is a customer of the isolated demo shop and a viewer/approver
of ITS OWN demo jobs. It reuses the real backend job system, Document Engine,
Strands agent, printer adapter and quote/handoff code. What cannot be real in
a demo is labelled SIMULATED and kept in `job.simulation`, separate from the
authoritative `status` / `payment_status`:

  - simulated payment: never sets payment_status=settled, never a tx id or
    HashScan link, never a customer signature;
  - simulated execution: the backend checks the real gates and validates the
    configuration against the REAL printer adapter, then records a simulated
    submission. The demo shop can never reach a physical printer.
  - deterministic fallback operator: the real tools with rule-based planning
    and no model, labelled as such.

POST /sessions                        start a jury session (no credentials needed)
GET  /status                          live / configured / not_configured per integration
GET  /state                           this session's demo jobs
POST /jobs/{id}/run-fallback          deterministic operator run (no AI), labelled
POST /jobs/{id}/approve-quote         customer approval; real handoff when payments are configured
GET  /jobs/{id}/payment               quote, USDC, x402 requirements, payment state
POST /jobs/{id}/simulate-payment      SIMULATED settlement (only when no real one exists)
POST /jobs/{id}/simulate-execution    real gate + printer validation, SIMULATED submission
GET  /jobs/{id}/lifecycle             end-to-end stages with real/simulated labels
POST /reset                           delete this session's demo jobs only
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from . import chain, devices, events, zerog
from .auth import api_error, issue_session, job_for, resolve_principal
from .clients import ServiceError, agent_health, engine_health, list_printers, validate_print_config
from .config import get_settings
from .jobs import add_message, quote_expired, start_operator_run
from .security import new_token
from .store import HandoffRecord, JobRecord, Principal, get_store, iso_from_epoch, now_iso
from .views import job_view

router = APIRouter(prefix="/api/v1/jury")


async def jury_principal(request: Request) -> Principal:
    if not get_settings().jury_demo_enabled:
        raise api_error(404, "NOT_FOUND", "The jury demo is disabled on this backend.")
    p = resolve_principal(request, request.headers.get("authorization"))
    if p.kind != "jury":
        raise api_error(403, "UNAUTHORIZED", "Jury session required.")
    return p


def _demo_job(principal: Principal, job_id: str) -> JobRecord:
    job = job_for(principal, job_id)  # own demo jobs only
    return job


@router.post("/sessions")
async def create_session() -> dict[str, Any]:
    s = get_settings()
    if not s.jury_demo_enabled:
        raise api_error(404, "NOT_FOUND", "The jury demo is disabled on this backend.")
    ref = "jury_" + new_token()[:20]
    token, expires = issue_session("jury", ref, s.jury_session_ttl_seconds, shops=[s.demo_shop_id], role="jury")
    return {"sessionToken": token, "juryRef": ref, "demoShopId": s.demo_shop_id, "expiresAt": iso_from_epoch(expires)}


# ───────────── integration status (honest labels) ─────────────

async def integration_status() -> list[dict[str, Any]]:
    s = get_settings()
    out: list[dict[str, Any]] = [{"id": "backend", "label": "Inklink backend (FastAPI)", "state": "live", "detail": "Authoritative job state, SSE events."}]
    health = await agent_health()
    mp = (health or {}).get("modelProvider") or {}
    out.append({"id": "agent", "label": "Strands print operator", "state": "live" if health else "unavailable",
                "detail": f"provider {mp.get('provider')}" if health else "The agent service is not reachable."})
    zg = zerog.status()
    configured = [m for m, v in zg["modes"].items() if v["configured"]]
    out.append({"id": "zerog", "label": "0G Private Computer", "state": "configured" if configured else "not_configured",
                "detail": f"keys: {', '.join(configured) or 'none'} · model {zg['modes'][zg['defaultTrustMode']]['model']}"
                          + ("" if configured else " · the demo can use the labelled deterministic fallback operator")})
    engine_ok = await engine_health()
    out.append({"id": "engine", "label": "Document Engine", "state": "live" if engine_ok else "unavailable",
                "detail": "Deterministic document operations." if engine_ok else "Not reachable."})
    try:
        body = await list_printers()
        printers = body.get("printers", [])
        out.append({"id": "printer", "label": "Local printer adapter", "state": "live",
                    "detail": f"{len(printers)} printer(s), {sum(p.get('status') == 'online' for p in printers)} online · demo jobs are validated, never printed"})
    except ServiceError as exc:
        out.append({"id": "printer", "label": "Local printer adapter", "state": "unavailable", "detail": exc.message})
    out.append({"id": "payments", "label": "Hedera x402 payments", "state": "configured" if s.payments_configured else "simulated",
                "detail": "Real handoff to the Inklink app; settlement only from the verified callback." if s.payments_configured
                else "Not configured here: the demo offers a clearly labelled simulated settlement (no transaction)."})
    dv = devices.device_views(s.demo_shop_id) if s.jury_demo_enabled else {"status": "not_configured"}
    out.append({"id": "esp32", "label": "ESP32-S3 controller", "state": dv["status"] if dv["status"] != "never_seen" else "not_configured",
                "detail": "Reports via /api/v1/devices/heartbeat." if s.device_token else "DEVICE_TOKEN is not configured; no device has reported."})
    cs = chain.status()
    out.append({"id": "galileo", "label": "0G Galileo registries", "state": cs["status"], "detail": cs["note"]})
    out.append({"id": "storage", "label": "0G Storage", "state": "configured" if s.zero_g_storage_indexer_url else "not_configured",
                "detail": "Documents stay on the shop backend; only hashes are prepared for on-chain records."})
    return out


@router.get("/status")
async def status(_: Principal = Depends(jury_principal)) -> dict[str, Any]:
    return {"integrations": await integration_status(), "demoShopId": get_settings().demo_shop_id}


@router.get("/state")
async def state(principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    store = get_store()
    jobs = sorted((j for j in store.jobs.values() if j.owner == principal.ref and store.is_demo_shop(j.shop_id)),
                  key=lambda j: j.created_at, reverse=True)
    return {"demoShopId": get_settings().demo_shop_id, "currentJobId": jobs[0].job_id if jobs else None,
            "jobs": [{"jobId": j.job_id, "status": j.status, "filename": j.document.filename if j.document else None,
                      "createdAt": j.created_at} for j in jobs]}


# ───────────── deterministic fallback operator ─────────────

class FallbackIn(BaseModel):
    instruction: str | None = Field(None, max_length=2000)


@router.post("/jobs/{job_id}/run-fallback")
async def run_fallback(job_id: str, body: FallbackIn, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    store = get_store()
    job = _demo_job(principal, job_id)
    if not job.document:
        raise api_error(409, "UPLOAD_FAILED", "Upload a document first.")
    if job.status not in ("created", "awaiting_payment"):
        raise api_error(409, "POLICY_VIOLATION", "This demo job can no longer be reconfigured.")
    instruction = (body.instruction or next((m["text"] for m in reversed(job.messages) if m["role"] == "customer"), "")).strip()
    if not instruction:
        raise api_error(400, "POLICY_VIOLATION", "Enter printing instructions first.")
    if job.run_active:
        raise api_error(409, "POLICY_VIOLATION", "The operator is already running.")
    with store.lock:
        add_message(job, "system", "Running the deterministic demo operator (SIMULATED planning, no AI; real tools and real printer checks).")
        if job.quote_id:
            job.quote_id, job.customer_approved_quote, job.status = None, False, "created"
        store.touch(job)
        store.save()
    start_operator_run(job, instruction, mode="deterministic")
    return {"started": True, "mode": "deterministic"}


# ───────────── quote approval and payment ─────────────

@router.post("/jobs/{job_id}/approve-quote")
async def approve_quote(job_id: str, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    job = _demo_job(principal, job_id)
    q = store.quotes.get(job.quote_id) if job.quote_id else None
    if not q:
        raise api_error(409, "JOB_NOT_FOUND", "Request a quote first.")
    if quote_expired(q):
        raise api_error(410, "QUOTE_EXPIRED", "The quote has expired; request a new quote.")
    handoff = None
    with store.lock:
        job.customer_approved_quote = True
        if "hedera_x402" in q.payment_methods:
            token = new_token()
            exp = time.time() + s.handoff_ttl_seconds
            store.handoffs[token] = HandoffRecord(token=token, job_id=job.job_id, quote_id=q.quote_id, expires_at=exp)
            handoff = {"handoffToken": token, "deepLink": f"{s.handoff_deep_link_base}?handoff={token}",
                       "qrText": f'{{"type":"inklink_payment_handoff","version":"1.0","handoff":"{token}"}}',
                       "expiresAt": iso_from_epoch(exp)}
        add_message(job, "system", "Quote approved in the jury demo." + ("" if handoff else " Payments are not configured, so a simulated settlement is available."))
        store.touch(job)
        store.save()
    events.publish(job.job_id, "approval_required", {"kind": "payment", "reason": "Authorize payment in the Inklink app."})
    return {"approved": True, "handoff": handoff, "paymentsConfigured": s.payments_configured}


@router.get("/jobs/{job_id}/payment")
async def payment(job_id: str, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    job = _demo_job(principal, job_id)
    q = store.quotes.get(job.quote_id) if job.quote_id else None
    rec = store.payments.get(job.payment_id) if job.payment_id else None
    return {
        "quote": None if not q else {"quoteId": q.quote_id, "amountInr": q.inr, "amountUsdc": q.usdc, "rate": q.rate,
                                     "capturedAt": q.captured_at, "expiresAt": q.expires_at, "paymentMethods": q.payment_methods},
        "customerApproved": job.customer_approved_quote,
        "paymentsConfigured": s.payments_configured,
        # What the x402 gate will demand (public data: payee account, asset, amount).
        "x402Requirement": None if not (q and q.usdc) else {"network": "hedera:testnet", "asset": "HTS-USDC", "amount": q.usdc,
                                                            "payTo": s.merchant_account_id, "resource": f"/api/v1/jobs/{job.job_id}/execute"},
        "realPayment": None if not rec else {"paymentId": rec.payment_id, "status": rec.status, "transactionId": rec.transaction_id,
                                            "hashscanUrl": rec.hashscan_url},
        "paymentStatus": job.payment_status,
        "simulated": job.simulation.get("payment"),
    }


@router.post("/jobs/{job_id}/simulate-payment")
async def simulate_payment(job_id: str, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    store = get_store()
    job = _demo_job(principal, job_id)
    if not job.customer_approved_quote:
        raise api_error(409, "POLICY_VIOLATION", "Approve the quote first.")
    if job.payment_status == "settled":
        raise api_error(409, "POLICY_VIOLATION", "A real settlement exists; nothing to simulate.")
    with store.lock:
        job.simulation["payment"] = {
            "state": "SIMULATED_SETTLED",
            "at": now_iso(),
            "note": "Simulated for the jury demo. No Hedera transaction, no transaction id, no customer signature.",
        }
        add_message(job, "system", "SIMULATED payment recorded for the demo (no blockchain transaction).")
        store.touch(job)
        store.save()
    return job_view(job)


# ───────────── execution ─────────────

@router.post("/jobs/{job_id}/simulate-execution")
async def simulate_execution(job_id: str, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    store = get_store()
    job = _demo_job(principal, job_id)
    paid = job.payment_status == "settled" or bool(job.simulation.get("payment"))
    pending = [name for name, ok in (
        ("print_configuration", job.config_validated),
        ("customer_quote", job.customer_approved_quote),
        ("payment", paid),
        ("shop", job.shop_approved),
        ("operator_request", job.execution_requested),
    ) if not ok]
    if pending:
        raise api_error(409, "POLICY_VIOLATION", f"Execution is not authorized yet. Pending: {', '.join(pending)}.")
    # Real re-validation against the live printer adapter, exactly as for a real job.
    try:
        ok, errors = await validate_print_config(job.operator_config)
        printer_state = "validated" if ok else "rejected"
    except ServiceError as exc:
        ok, errors, printer_state = False, [exc.message], "adapter_unavailable"
    with store.lock:
        job.simulation["execution"] = {
            "state": "SIMULATED_SUBMISSION" if ok else "BLOCKED",
            "printerValidation": printer_state,
            "errors": errors,
            "printerId": job.operator_config.get("printerId"),
            "at": now_iso(),
            "note": "Demo shop: the backend authorized execution and the real printer accepted the configuration; "
                    "no job was sent to the printer and nothing was printed.",
        }
        add_message(job, "system", "SIMULATED execution: configuration accepted by the real printer adapter; nothing was printed."
                    if ok else f"Execution blocked: {' '.join(errors)}")
        store.touch(job)
        store.save()
    return job_view(job)


# ───────────── lifecycle and reset ─────────────

@router.get("/jobs/{job_id}/lifecycle")
async def lifecycle(job_id: str, principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    store = get_store()
    job = _demo_job(principal, job_id)
    hist = events.history(job.job_id, 0)
    types = [e["type"] for e in hist]
    started = next((e for e in hist if e["type"] == "agent_started"), None)
    finished = [e for e in hist if e["type"] == "agent_finished"]
    sim = job.simulation
    provider = (started or {}).get("payload", {}).get("provider")
    stages = [
        {"id": "request", "label": "Customer request", "state": "done" if job.document and any(m["role"] == "customer" for m in job.messages) else "pending", "mode": "real"},
        {"id": "processing", "label": "Document processing", "state": "done" if job.document and job.document.classification else "pending", "mode": "real",
         "detail": (job.document.classification or {}).get("level") if job.document else None},
        {"id": "agent", "label": "Agent configuration", "state": "done" if job.config_validated else ("failed" if finished and finished[-1]["payload"].get("outcome") in ("failed", "unavailable") else "pending"),
         "mode": "simulated" if provider == "deterministic-fallback" else "real", "detail": provider},
        {"id": "quote", "label": "Quote approval", "state": "done" if job.customer_approved_quote else "pending", "mode": "real"},
        {"id": "payment", "label": "Payment verification", "state": "done" if job.payment_status == "settled" or sim.get("payment") else "pending",
         "mode": "real" if job.payment_status == "settled" else ("simulated" if sim.get("payment") else "real")},
        {"id": "authorization", "label": "Execution authorization", "state": "done" if sim.get("execution", {}).get("state") == "SIMULATED_SUBMISSION" or "execution_authorized" in types else "pending",
         "mode": "real" if "execution_authorized" in types else "simulated" if sim.get("execution") else "real"},
        {"id": "physical", "label": "Physical execution", "state": "simulated" if sim.get("execution", {}).get("state") == "SIMULATED_SUBMISSION" else "pending",
         "mode": "simulated", "detail": "Demo shop never prints physically."},
        {"id": "completion", "label": "Completion", "state": "not_applicable", "mode": "simulated",
         "detail": "Only a real completion event (shop or device) completes a job; demo jobs are never marked completed."},
    ]
    return {"jobId": job.job_id, "stages": stages, "events": len(hist), "chainRecords": chain.records_for(job.job_id)}


@router.post("/reset")
async def reset(principal: Principal = Depends(jury_principal)) -> dict[str, Any]:
    """Delete this jury session's demo jobs (files, quotes, events). Never touches other shops or sessions."""
    s = get_settings()
    store = get_store()
    removed = []
    with store.lock:
        for job in [j for j in store.jobs.values() if j.owner == principal.ref and store.is_demo_shop(j.shop_id)]:
            if job.run_active:
                continue
            shutil.rmtree(Path(s.data_dir) / "documents" / job.job_id, ignore_errors=True)
            if job.quote_id:
                store.quotes.pop(job.quote_id, None)
            for token, h in list(store.handoffs.items()):
                if h.job_id == job.job_id:
                    store.handoffs.pop(token, None)
            store.events.pop(job.job_id, None)
            store.jobs.pop(job.job_id, None)
            removed.append(job.job_id)
        store.save()
    return {"removed": removed}
