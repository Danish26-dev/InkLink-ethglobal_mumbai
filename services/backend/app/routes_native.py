"""Native-app pairing, payment handoff and Contracts 5-7; internal service routes."""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from . import chain, events
from .auth import api_error, issue_session, job_for, native_principal, require_service_token
from .clients import ServiceError, call_payment_agent, validate_print_config
from .config import get_settings
from .jobs import add_message, pending_gates, quote_contract, quote_expired, try_execute
from .security import b64url_decode, hashscan_for, verify_callback
from .store import PaymentRecord, Principal, get_store, iso_from_epoch, new_id, now_iso

router = APIRouter(prefix="/api/v1")
_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")


# ───────────── pairing (native app) ─────────────

class PairingIn(BaseModel):
    challenge: str
    # Optional, recommended: the app's anonymous Ed25519 device key (Base64URL, raw 32 bytes)
    # and its signature over the UTF-8 challenge. Proves the same install across pairings, so
    # jobs the app created stay reachable after its short session is renewed.
    devicePublicKey: str | None = None
    deviceSignature: str | None = None


def _native_ref(body: PairingIn) -> str:
    """Stable `native_dev_<fingerprint>` for a proven device key, else a one-off id."""
    if body.devicePublicKey is None and body.deviceSignature is None:
        return new_id("native")
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        raw = b64url_decode(body.devicePublicKey or "")
        sig = b64url_decode(body.deviceSignature or "")
        if len(raw) != 32 or len(sig) != 64:
            raise ValueError("length")
        Ed25519PublicKey.from_public_bytes(raw).verify(sig, body.challenge.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - any decode/verify failure is the same answer
        raise api_error(401, "SIGNATURE_INVALID", "The device signature over the challenge did not verify.") from exc
    return "native_dev_" + hashlib.sha256(raw).hexdigest()[:24]


@router.post("/pairing/verify")
async def pairing_verify(body: PairingIn, request: Request) -> dict[str, Any]:
    c = body.challenge
    if not (16 <= len(c) <= 256) or not _B64URL.match(c):
        raise api_error(400, "PAIRING_FAILED", "challenge must be a Base64URL string (16-256 chars)")
    s = get_settings()
    identity = request.app.state.identity
    ref = _native_ref(body)
    token, expires = issue_session("native", ref, s.native_session_ttl_seconds)
    return {
        "signedChallenge": identity.sign(c),
        "gatewayId": s.gateway_id,
        "sessionToken": token,
        "sessionExpiresAt": iso_from_epoch(expires),
        # Present only when the device key was proven (never a secret).
        **({"customerReference": ref} if ref.startswith("native_dev_") else {}),
    }


# ───────────── web -> native payment handoff ─────────────

class ClaimIn(BaseModel):
    handoffToken: str


@router.post("/payment-handoffs/claim")
async def claim_handoff(body: ClaimIn, principal: Principal = Depends(native_principal)) -> dict[str, Any]:
    store = get_store()
    h = store.handoffs.get(body.handoffToken)
    if not h or h.expires_at <= time.time():
        raise api_error(410, "QUOTE_EXPIRED", "This payment link has expired. Approve the quote again in the web app.")
    if h.claimed_by and h.claimed_by != principal.ref:
        raise api_error(409, "AUTHORIZATION_REPLAYED", "This payment link was already used on another device.")
    job = store.jobs.get(h.job_id)
    q = store.quotes.get(h.quote_id)
    if not job or not q or job.quote_id != q.quote_id:
        raise api_error(410, "QUOTE_EXPIRED", "The quote changed. Approve the new quote in the web app.")
    with store.lock:
        h.claimed_by = principal.ref
        job.claimed_by = principal.ref
        store.save()
    return {"jobId": job.job_id, "quoteId": q.quote_id, "shopId": job.shop_id, "quote": quote_contract(q)}


# ───────────── Contract 5: authorization (forwarded, verified by the payment agent) ─────────────

@router.post("/payments/authorizations")
async def payment_authorization(request: Request, _: Principal = Depends(native_principal)) -> Any:
    if not get_settings().payments_configured:
        raise api_error(503, "INTERNAL_ERROR", "Payments are not configured on this backend.")
    body = await request.json()
    try:
        status, payload = await call_payment_agent("POST", "/api/v1/payments/authorizations", body)
    except ServiceError as exc:
        raise api_error(503, "INTERNAL_ERROR", exc.message) from exc
    if status != 200:
        raise api_error(status, (payload or {}).get("error", {}).get("code", "INTERNAL_ERROR"),
                        (payload or {}).get("error", {}).get("message", "Payment service error"))
    return payload


# ───────────── Contract 6: initiate payment (backend decides amount) ─────────────

class PaymentIn(BaseModel):
    jobId: str
    quoteId: str
    authorizationId: str
    paymentMethod: str


@router.post("/payments")
async def initiate_payment(body: PaymentIn, principal: Principal = Depends(native_principal)) -> Any:
    s = get_settings()
    store = get_store()
    if not s.payments_configured:
        raise api_error(503, "INTERNAL_ERROR", "Payments are not configured on this backend.")
    if body.paymentMethod != "hedera_x402":
        raise api_error(400, "PAYMENT_FAILED", "paymentMethod must be hedera_x402.")
    job = job_for(principal, body.jobId)
    q = store.quotes.get(body.quoteId)
    if not q or q.job_id != job.job_id or job.quote_id != q.quote_id or not q.usdc:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job or quote.")
    if job.owner == principal.ref:
        # Native-only flow (Contracts 1-8): the app's explicit, device-signed payment
        # request IS the customer's approval of this quote.
        job.customer_approved_quote = True
    elif not job.customer_approved_quote:
        raise api_error(403, "POLICY_VIOLATION", "The customer has not approved this quote in the web app.")
    if quote_expired(q):
        raise api_error(410, "QUOTE_EXPIRED", "The quote has expired; request a new quote.")
    try:
        status, payload = await call_payment_agent("POST", "/api/v1/payments", {
            "jobId": job.job_id,
            "quoteId": q.quote_id,
            "authorizationId": body.authorizationId,
            "paymentMethod": "hedera_x402",
            "merchantId": q.merchant_id,
            "settlementAmount": q.usdc,  # authoritative: computed here, never by the app
            "resourceUrl": f"{s.gate_url}/api/v1/jobs/{job.job_id}/execute",
            "quoteExpiresAt": q.expires_at,
        })
    except ServiceError as exc:
        raise api_error(503, "INTERNAL_ERROR", exc.message) from exc
    if status != 200 or not isinstance(payload, dict) or "paymentId" not in payload:
        err = (payload or {}).get("error", {}) if isinstance(payload, dict) else {}
        raise api_error(status if status >= 400 else 502, err.get("code", "PAYMENT_FAILED"), err.get("message", "Payment service error"))
    pid = payload["paymentId"]
    with store.lock:
        if pid not in store.payments:
            store.payments[pid] = PaymentRecord(payment_id=pid, job_id=job.job_id, quote_id=q.quote_id,
                                                merchant_id=q.merchant_id, amount_usdc=q.usdc, status="processing")
        job.payment_id = pid
        job.payment_status = "processing"
        store.touch(job)
        store.save()
    events.publish(job.job_id, "payment_status_updated", {"paymentId": pid, "status": "processing", "transactionId": None, "hashscanUrl": None}, source="payment")
    events.publish_job_status(job)
    return payload


# ───────────── Contract 7: payment status (what THIS backend verified) ─────────────

@router.get("/payments/{payment_id}")
async def payment_status(payment_id: str, principal: Principal = Depends(native_principal)) -> dict[str, Any]:
    store = get_store()
    rec = store.payments.get(payment_id)
    if not rec:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown paymentId.")
    job = job_for(principal, rec.job_id)
    if rec.status == "processing" and get_settings().payments_configured:
        # Learn about FAILURES from the agent; `settled` only comes from the signed callback.
        try:
            status, payload = await call_payment_agent("GET", f"/api/v1/payments/{payment_id}")
            if status == 200 and isinstance(payload, dict) and payload.get("status") in ("failed", "expired"):
                with store.lock:
                    rec.status = payload["status"]
                    job.payment_status = rec.status
                    store.touch(job)
                    store.save()
                events.publish(job.job_id, "payment_status_updated", {"paymentId": payment_id, "status": rec.status, "transactionId": None, "hashscanUrl": None}, source="payment")
                events.publish_job_status(job)
        except ServiceError:
            pass
    return {
        "paymentId": rec.payment_id,
        "jobId": rec.job_id,
        "status": rec.status,
        "network": "hedera_testnet",
        "transactionId": rec.transaction_id if rec.status == "settled" else None,
        "amount": rec.amount_usdc,
        "asset": "USDC",
        "merchantId": rec.merchant_id,
    }


# ───────────── internal: signed settlement callback (payment agent -> backend) ─────────────

@router.post("/internal/payment-settled")
async def payment_settled(request: Request) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    if not s.payments_configured:
        raise api_error(503, "INTERNAL_ERROR", "Payments are not configured on this backend.")
    raw = await request.body()
    reason = verify_callback(raw, {k.lower(): v for k, v in request.headers.items()}, s.payment_event_signing_secret)
    if reason:
        raise api_error(401, "UNAUTHORIZED", "Invalid callback signature")
    try:
        e = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise api_error(400, "SETTLEMENT_UNVERIFIED", "Body is not JSON") from exc
    rec = store.payments.get(e.get("paymentId"))
    if not rec:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown paymentId")

    def bad(m: str):
        return api_error(422, "SETTLEMENT_UNVERIFIED", m)

    tx = e.get("transactionId")
    if e.get("status") != "settled" or e.get("network") != "hedera:testnet" or e.get("asset") != "HTS_USDC":
        raise bad("unexpected status/network/asset")
    if e.get("jobId") != rec.job_id:
        raise bad("jobId does not match the payment")
    if e.get("amount") != rec.amount_usdc:
        raise bad("amount does not match the quote")
    if e.get("merchantAccountId") != s.merchant_account_id:
        raise bad("merchant account does not match")
    if not isinstance(tx, str) or not re.fullmatch(r"\d+\.\d+\.\d+@\d+\.\d+", tx):
        raise bad("malformed transactionId")
    if e.get("hashscanUrl") != hashscan_for(tx):
        raise bad("hashscanUrl is not derived from the transaction id")
    if rec.status == "settled":  # idempotent on paymentId
        if rec.transaction_id == tx:
            return {"ok": True, "duplicate": True}
        raise bad("payment already settled with a different transaction")

    job = store.jobs.get(rec.job_id)
    with store.lock:
        rec.status = "settled"
        rec.transaction_id = tx
        rec.hashscan_url = e["hashscanUrl"]
        if job:
            job.payment_status = "settled"
            job.status = "awaiting_execution"  # payment authorizes execution; it does NOT complete the job
            add_message(job, "system", "Payment verified on Hedera. Waiting for the shop to print.")
            store.touch(job)
        store.save()
    if job:
        # Only verified values: the callback was HMAC-checked and every field matched above.
        events.publish(job.job_id, "payment_status_updated",
                       {"paymentId": rec.payment_id, "status": "settled", "transactionId": tx, "hashscanUrl": rec.hashscan_url,
                        "network": "hedera:testnet", "amount": rec.amount_usdc, "asset": "HTS_USDC",
                        # settledAt: consensus time the agent verified on the mirror node;
                        # verifiedAt: when this backend verified the signed callback.
                        "settledAt": e.get("settlementTimestamp") if isinstance(e.get("settlementTimestamp"), str) else None,
                        "verifiedAt": now_iso()},
                       source="payment")
        events.publish_job_status(job)
        # Queued only now, after the signed settlement was verified. Reference by hash only.
        chain.queue("payment_verified", job.job_id, {"hederaTxCommitment": chain.commitment(tx), "network": "hedera:testnet"})
        if not job.shop_approved:
            events.publish(job.job_id, "approval_required", {"kind": "shop", "reason": "Payment verified; the shop must approve printing."})
        await try_execute(job.job_id)
    return {"ok": True}


# ───────────── internal: x402 gate price lookup ─────────────

@router.get("/internal/jobs/{job_id}/payment-requirements")
async def payment_requirements(job_id: str, request: Request) -> dict[str, Any]:
    s = get_settings()
    require_service_token(request, s.backend_api_token, "BACKEND_API_TOKEN")
    store = get_store()
    job = store.jobs.get(job_id)
    q = store.quotes.get(job.quote_id) if job and job.quote_id else None
    if not job or not q or not q.usdc:
        raise api_error(404, "JOB_NOT_FOUND", "No quote for this job")
    return {"jobId": job.job_id, "merchantAccountId": s.merchant_account_id, "amount": q.usdc, "expiresAt": q.expires_at}


# ───────────── internal: operator execution request (agent -> backend) ─────────────

class ExecutionRequestIn(BaseModel):
    runId: str
    config: dict[str, Any]


@router.post("/internal/jobs/{job_id}/execution-requests")
async def execution_request(job_id: str, body: ExecutionRequestIn, request: Request) -> dict[str, Any]:
    s = get_settings()
    require_service_token(request, s.agent_service_token, "AGENT_SERVICE_TOKEN")
    store = get_store()
    job = store.jobs.get(job_id)
    if not job:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")
    fields = ("printerId", "paperSize", "colorMode", "copies", "orientation", "sides")
    config = {k: body.config.get(k) for k in fields}
    if any(config[k] is None for k in fields):
        return {"accepted": False, "state": "rejected", "pending": ["print_configuration"], "message": "The configuration is incomplete."}
    # Never trust the caller: validate against the real printer ourselves.
    try:
        ok, errors = await validate_print_config(config)
    except ServiceError as exc:
        return {"accepted": False, "state": "printer_unreachable", "pending": ["printer"], "message": exc.message}
    if not ok:
        return {"accepted": False, "state": "rejected", "pending": ["print_configuration"], "message": " ".join(errors)}
    with store.lock:
        job.operator_config = config
        job.config_validated = True
        job.execution_requested = True
        store.touch(job)
        store.save()
    pending = pending_gates(job)
    for gate in pending:
        if gate in ("customer_quote", "payment", "shop"):
            kind = {"customer_quote": "customer_quote", "payment": "payment", "shop": "shop"}[gate]
            reason = {
                "customer_quote": "The customer must review and approve the quote.",
                "payment": "Payment must be authorized in the Inklink app and verified.",
                "shop": "The shop must approve the job.",
            }[gate]
            events.publish(job.job_id, "approval_required", {"kind": kind, "reason": reason})
    result = await try_execute(job.job_id)
    if result["state"] == "submitted":
        return {"accepted": True, "state": "authorized", "pending": [], "message": "Printing was authorized by the backend."}
    return {
        "accepted": True,
        "state": "awaiting_" + (result["pending"][0] if result.get("pending") else "authorization"),
        "pending": result.get("pending", pending),
        "message": "Execution request recorded. Printing starts only after: " + ", ".join(result.get("pending", pending)) + ".",
    }
