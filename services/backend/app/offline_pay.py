"""OfflinePay on the backend: accept a device-signed voucher, then settle it through x402.

A voucher is the customer's signed PROMISE to pay one job's backend-quoted USDC amount. It is
not a payment. The backend verifies it and records it in a persistent ledger (a Python port of
packages/shared-schemas/src/offline-pay.ts: same checks, same codes, same limits), then asks
the payment agent to settle it (POST /api/v1/offline-payments/settle). The job stays
`awaiting_payment` / payment `processing` and nothing prints until the normal HMAC-signed
settlement callback, which the agent sends only after its mirror-node check, marks the
payment settled. Only then does the voucher become SETTLED.

  AUTHORIZED_OFFLINE -> PENDING_SETTLEMENT -> SETTLED
                             |      ^
                             v      | retry (new paymentId)
                       SETTLEMENT_FAILED

Endpoints (native session, the paired app):
  POST /api/v1/offline-payments            {voucher}  -> accept (idempotent) and start settlement
  GET  /api/v1/offline-payments/{voucherId}           -> the backend's ledger record

Test vector and rules: docs/API_CONTRACTS.md -> OfflinePay.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import events
from .auth import api_error, job_for, native_principal
from .clients import ServiceError, call_payment_agent
from .config import get_settings
from .jobs import quote_expired
from .security import b64url_decode, canonical_json
from .store import PaymentRecord, Principal, get_store, now_iso

log = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api/v1/offline-payments")

# Agreed policy (docs/API_CONTRACTS.md): 2.00 / 5.00 USDC, 2 h validity, 5 min skew.
MAX_PER_VOUCHER = "2.00"
MAX_OUTSTANDING = "5.00"
MAX_VALIDITY_MS = 2 * 60 * 60 * 1000
CLOCK_SKEW_MS = 5 * 60 * 1000
USDC_DECIMALS = 6
MAX_SETTLE_ATTEMPTS = 3
SYNC_INTERVAL_SECONDS = 30.0

OFFLINE_TYPE = "inklink_offline_payment"
OFFLINE_VERSION = "1.0"
_AMOUNT = re.compile(r"^\d{1,12}(\.\d{1,6})?$")
_HEDERA_TX_ID = re.compile(r"^\d+\.\d+\.\d+@\d+\.\d+$")
_FIELDS = {"type", "version", "voucherId", "jobId", "quoteId", "merchantId", "amount", "asset",
           "devicePublicKey", "customerReference", "issuedAt", "expiresAt", "signature"}

# Same codes as the TypeScript ledger, mapped to HTTP like the payment agent does.
_HTTP = {"INVALID_VOUCHER": 400, "AMOUNT_INVALID": 400, "EXPIRED": 400, "NOT_YET_VALID": 400, "VALIDITY_TOO_LONG": 400,
         "SIGNATURE_INVALID": 403, "WRONG_MERCHANT": 403, "OVER_VOUCHER_LIMIT": 403, "OVER_OUTSTANDING_LIMIT": 403,
         "REPLAYED": 409, "DUPLICATE_JOB": 409, "UNKNOWN_VOUCHER": 404, "SETTLEMENT_MISMATCH": 409,
         "INVALID_TRANSITION": 409}

_settling: set[str] = set()


class OfflinePayError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message

    def http(self):
        return api_error(_HTTP.get(self.code, 400), self.code, self.message)


# ───────────── money and time (no floats) ─────────────

def to_micros(amount: str) -> int:
    if not isinstance(amount, str) or not _AMOUNT.match(amount):
        raise OfflinePayError("AMOUNT_INVALID", f'Invalid USDC amount "{amount}"')
    whole, _, frac = amount.partition(".")
    return int(whole) * 10**USDC_DECIMALS + int(frac.ljust(USDC_DECIMALS, "0"))


def from_micros(units: int) -> str:
    return f"{units // 10**USDC_DECIMALS}.{units % 10**USDC_DECIMALS:0{USDC_DECIMALS}d}"


def _ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def customer_reference_for(device_public_key: str) -> str:
    return f"dev_{device_public_key[:22]}"


# ───────────── voucher verification ─────────────

def _decoded_len(value: Any) -> int:
    try:
        return len(b64url_decode(value)) if isinstance(value, str) else -1
    except Exception:  # noqa: BLE001
        return -1


def _short(v: Any, limit: int = 128) -> bool:
    return isinstance(v, str) and 0 < len(v) <= limit


def _shape(raw: Any) -> dict[str, Any]:
    bad = lambda m: OfflinePayError("INVALID_VOUCHER", m)  # noqa: E731
    if not isinstance(raw, dict):
        raise bad("Voucher must be an object")
    if raw.get("type") != OFFLINE_TYPE or raw.get("version") != OFFLINE_VERSION:
        raise bad("Not an Inklink offline payment voucher")
    for k in ("jobId", "quoteId", "merchantId", "customerReference"):
        if not _short(raw.get(k)):
            raise bad(f"Missing or invalid {k}")
    if _decoded_len(raw.get("voucherId")) != 16:
        raise bad("voucherId must be 16 random bytes (Base64URL)")
    if _decoded_len(raw.get("devicePublicKey")) != 32:
        raise bad("devicePublicKey is not an Ed25519 key")
    if _decoded_len(raw.get("signature")) != 64:
        raise bad("signature is malformed")
    if raw.get("asset") != "USDC":
        raise bad("asset must be USDC")
    if not isinstance(raw.get("amount"), str):
        raise bad("amount must be a decimal string")
    for k in ("issuedAt", "expiresAt"):
        try:
            _ts(raw[k])
        except Exception:  # noqa: BLE001
            raise bad(f"{k} is not a timestamp") from None
    extra = set(raw) - _FIELDS
    if extra:
        raise bad(f"Unexpected field {sorted(extra)[0]}")
    return raw


def signing_text(voucher: dict[str, Any]) -> str:
    return canonical_json({k: v for k, v in voucher.items() if k != "signature"})


def _signature_ok(voucher: dict[str, Any]) -> bool:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        Ed25519PublicKey.from_public_bytes(b64url_decode(voucher["devicePublicKey"])).verify(
            b64url_decode(voucher["signature"]), signing_text(voucher).encode("utf-8"))
        return True
    except Exception:  # noqa: BLE001
        return False


def verify_voucher(raw: Any, *, merchant_id: str | None = None, now: float | None = None) -> dict[str, Any]:
    """Structure -> signature -> customer binding -> amount -> merchant -> time window."""
    now = time.time() if now is None else now
    v = _shape(raw)
    if not _signature_ok(v):
        raise OfflinePayError("SIGNATURE_INVALID", "The device signature on this voucher did not verify")
    if v["customerReference"] != customer_reference_for(v["devicePublicKey"]):
        raise OfflinePayError("INVALID_VOUCHER", "customerReference does not belong to the signing device")
    amount = to_micros(v["amount"])
    if amount <= 0:
        raise OfflinePayError("AMOUNT_INVALID", "Amount must be positive")
    if amount > to_micros(MAX_PER_VOUCHER):
        raise OfflinePayError("OVER_VOUCHER_LIMIT", f"Offline vouchers are limited to {MAX_PER_VOUCHER} USDC")
    if merchant_id is not None and v["merchantId"] != merchant_id:
        raise OfflinePayError("WRONG_MERCHANT", "This voucher is for a different shop")
    issued, expires = _ts(v["issuedAt"]) * 1000, _ts(v["expiresAt"]) * 1000
    if expires <= issued:
        raise OfflinePayError("INVALID_VOUCHER", "expiresAt must be after issuedAt")
    if expires - issued > MAX_VALIDITY_MS:
        raise OfflinePayError("VALIDITY_TOO_LONG", "Voucher is valid for longer than the offline policy allows")
    if issued > now * 1000 + CLOCK_SKEW_MS:
        raise OfflinePayError("NOT_YET_VALID", "Voucher is issued in the future")
    if expires <= now * 1000:
        raise OfflinePayError("EXPIRED", "Voucher has expired")
    return v


# ───────────── ledger (persisted in the store) ─────────────

def outstanding(device_public_key: str) -> str:
    """Unsettled total for a device. Failed settlements still count: the shop is unpaid."""
    total = sum(to_micros(r["voucher"]["amount"]) for r in get_store().offline_vouchers.values()
                if r["voucher"]["devicePublicKey"] == device_public_key and r["state"] != "SETTLED")
    return from_micros(total)


def accept(raw: Any, *, merchant_id: str) -> tuple[dict[str, Any], bool]:
    """Verify and record a voucher. The identical voucher again is idempotent."""
    store = get_store()
    v = verify_voucher(raw, merchant_id=merchant_id)
    with store.lock:
        existing = store.offline_vouchers.get(v["voucherId"])
        if existing:
            if canonical_json(existing["voucher"]) == canonical_json(v):
                return existing, True
            raise OfflinePayError("REPLAYED", "This voucher id was already used with different content")
        for r in store.offline_vouchers.values():
            if r["voucher"]["jobId"] == v["jobId"] and r["voucher"]["merchantId"] == v["merchantId"]:
                raise OfflinePayError("DUPLICATE_JOB", "This job already has an offline authorization")
        if to_micros(outstanding(v["devicePublicKey"])) + to_micros(v["amount"]) > to_micros(MAX_OUTSTANDING):
            raise OfflinePayError("OVER_OUTSTANDING_LIMIT",
                                  f"Unsettled offline payments would exceed {MAX_OUTSTANDING} USDC for this device")
        ts = now_iso()
        record = {"voucher": v, "state": "AUTHORIZED_OFFLINE", "acceptedAt": ts, "updatedAt": ts, "settlementAttempts": 0}
        store.offline_vouchers[v["voucherId"]] = record
        store.save()
        return record, False


def _touch(record: dict[str, Any], **changes: Any) -> None:
    store = get_store()
    with store.lock:
        for k, val in changes.items():
            if val is None:
                record.pop(k, None)
            else:
                record[k] = val
        record["updatedAt"] = now_iso()
        store.save()


def mark_pending(record: dict[str, Any], payment_id: str) -> None:
    if record["state"] not in ("AUTHORIZED_OFFLINE", "SETTLEMENT_FAILED", "PENDING_SETTLEMENT"):
        raise OfflinePayError("INVALID_TRANSITION", f"Cannot start settlement from {record['state']}")
    _touch(record, state="PENDING_SETTLEMENT", paymentId=payment_id, failureReason=None, blocked=None,
           settlementAttempts=record["settlementAttempts"] + (0 if record["state"] == "PENDING_SETTLEMENT" else 1))


def reconcile_settled(record: dict[str, Any], *, payment_id: str, job_id: str, amount: str, transaction_id: str,
                      verified_at: str | None) -> None:
    """SETTLED only for a verified Hedera transaction, for this job, at exactly the voucher amount."""
    mismatch = lambda m: OfflinePayError("SETTLEMENT_MISMATCH", m)  # noqa: E731
    v = record["voucher"]
    if job_id != v["jobId"]:
        raise mismatch("Settlement is for a different job")
    if record["state"] == "SETTLED":
        if transaction_id == record.get("transactionId"):
            return
        raise mismatch("Voucher is already settled by a different transaction")
    if record["state"] != "PENDING_SETTLEMENT":
        raise OfflinePayError("INVALID_TRANSITION", f"Cannot reconcile from {record['state']}; start settlement first")
    if record.get("paymentId") and payment_id != record["paymentId"]:
        raise mismatch("Settlement is for a different payment")
    if not verified_at:
        raise mismatch("Settlement is not verified")
    if not _HEDERA_TX_ID.match(transaction_id or ""):
        raise mismatch("Settlement has no valid Hedera transaction id")
    if to_micros(amount) != to_micros(v["amount"]):
        raise mismatch("Settled amount differs from the authorized amount")
    _touch(record, state="SETTLED", transactionId=transaction_id, verifiedAt=verified_at, failureReason=None)


def _voucher_for_payment(payment_id: str) -> dict[str, Any] | None:
    return next((r for r in get_store().offline_vouchers.values() if r.get("paymentId") == payment_id), None)


def on_payment_settled(rec: PaymentRecord) -> None:
    """Called by the verified settlement callback (routes_native.payment_settled)."""
    record = _voucher_for_payment(rec.payment_id)
    if record is None:
        return
    try:
        reconcile_settled(record, payment_id=rec.payment_id, job_id=rec.job_id, amount=rec.amount_usdc,
                          transaction_id=rec.transaction_id or "", verified_at=rec.verified_at)
    except OfflinePayError as exc:
        log.warning("OfflinePay: voucher %s not reconciled: %s", record["voucher"]["voucherId"], exc.message)


def on_payment_ended(payment_id: str, status: str) -> None:
    """The payment failed or expired: the promise stands, the settlement must be retried."""
    record = _voucher_for_payment(payment_id)
    if record is not None and record["state"] == "PENDING_SETTLEMENT":
        _touch(record, state="SETTLEMENT_FAILED", failureReason=f"payment {status}"[:200])


# ───────────── settlement through the payment agent ─────────────

def _new_payment_id() -> str:
    return "offpay_" + secrets.token_hex(12)   # never the agent's own `payment_` prefix


async def settle(record: dict[str, Any]) -> str:
    """Ask the payment agent to settle this voucher once. Returns a short outcome string."""
    store = get_store()
    s = get_settings()
    v = record["voucher"]
    vid = v["voucherId"]
    if vid in _settling:
        return "in_progress"
    if record["state"] not in ("AUTHORIZED_OFFLINE", "SETTLEMENT_FAILED") or record.get("blocked"):
        return "skipped"
    job = store.jobs.get(v["jobId"])
    q = store.quotes.get(v["quoteId"])
    if not job or not q or job.quote_id != q.quote_id or q.usdc != v["amount"] or not s.payments_configured:
        return "not_payable"
    if job.status != "awaiting_payment" or job.payment_status == "settled":
        return "not_payable"
    _settling.add(vid)
    payment_id = _new_payment_id()
    try:
        with store.lock:   # known to the callback handler before the agent can possibly answer
            store.payments[payment_id] = PaymentRecord(payment_id=payment_id, job_id=job.job_id, quote_id=q.quote_id,
                                                       merchant_id=q.merchant_id, amount_usdc=q.usdc, status="processing")
            store.save()
        try:
            status, payload = await call_payment_agent("POST", "/api/v1/offline-payments/settle", {
                "paymentId": payment_id, "jobId": job.job_id, "quoteId": q.quote_id, "merchantId": q.merchant_id,
                "settlementAmount": q.usdc, "resourceUrl": f"{s.gate_url}/api/v1/jobs/{job.job_id}/execute",
                "voucher": v})
        except ServiceError as exc:
            _drop_payment(payment_id)
            _touch(record, lastError=exc.message[:200])
            return "retry_later"
        err = (payload or {}).get("error", {}) if isinstance(payload, dict) else {}
        code = err.get("code", "")
        if status == 200 and isinstance(payload, dict):
            mark_pending(record, payment_id)
            with store.lock:
                job.payment_id = payment_id
                job.payment_status = "processing"
                job.customer_approved_quote = True
                store.touch(job)
                store.save()
            events.publish(job.job_id, "payment_status_updated",
                           {"paymentId": payment_id, "status": "processing", "transactionId": None, "hashscanUrl": None,
                            "amount": q.usdc, "asset": "HTS_USDC", "network": "hedera:testnet"}, source="payment")
            events.publish_job_status(job)
            return "started"
        _drop_payment(payment_id)
        if code == "VOUCHER_SETTLEMENT_IN_PROGRESS":
            return "in_progress"      # funds may have moved: only mirror-node re-verification resolves it
        if status >= 500 or code in ("PAYMENT_ID_CONFLICT", "FACILITATOR_UNAVAILABLE"):
            _touch(record, lastError=(err.get("message") or f"agent returned {status}")[:200])
            return "retry_later"
        # A definitive refusal (signature, limits, mismatch, too old): do not loop.
        _touch(record, lastError=(err.get("message") or code or f"agent returned {status}")[:200], blocked=True)
        return "refused"
    finally:
        _settling.discard(vid)


def _drop_payment(payment_id: str) -> None:
    store = get_store()
    with store.lock:
        if (p := store.payments.get(payment_id)) and p.status == "processing":
            del store.payments[payment_id]
            store.save()


async def sync_once() -> int:
    """Start settlement for vouchers that still need one. Failed ones retry with a new paymentId."""
    started = 0
    for record in list(get_store().offline_vouchers.values()):
        if record["state"] in ("AUTHORIZED_OFFLINE", "SETTLEMENT_FAILED") and not record.get("blocked") \
                and record["settlementAttempts"] < MAX_SETTLE_ATTEMPTS:
            started += (await settle(record)) == "started"
    return started


async def sync_loop() -> None:
    while True:
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)
        try:
            await sync_once()
        except Exception as exc:  # noqa: BLE001 - logged, retried next tick
            log.warning("OfflinePay sync: %s", str(exc)[:200])


# ───────────── HTTP ─────────────

class VoucherIn(BaseModel):
    voucher: dict[str, Any]


def public_record(record: dict[str, Any]) -> dict[str, Any]:
    v = {k: val for k, val in record["voucher"].items() if k != "signature"}
    out = {"voucher": v, "state": record["state"], "acceptedAt": record["acceptedAt"], "updatedAt": record["updatedAt"],
           "settlementAttempts": record["settlementAttempts"]}
    for k in ("paymentId", "transactionId", "verifiedAt", "failureReason"):
        if record.get(k):
            out[k] = record[k]
    if record.get("blocked") and record.get("lastError"):
        out["failureReason"] = record["lastError"]
    return out


def _bound_to_paired_device(principal: Principal, voucher: dict[str, Any]) -> bool:
    """A paired app that proved its device key may only submit vouchers signed by that key."""
    if not principal.ref.startswith("native_dev_"):
        return True   # legacy pairing without a device proof: nothing to bind to
    try:
        raw = b64url_decode(str(voucher.get("devicePublicKey", "")))
    except Exception:  # noqa: BLE001
        return True   # undecodable: accept() reports the precise INVALID_VOUCHER error
    return principal.ref == "native_dev_" + hashlib.sha256(raw).hexdigest()[:24]


@router.post("")
async def submit_voucher(body: VoucherIn, principal: Principal = Depends(native_principal)) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    if not s.payments_configured:
        raise api_error(503, "INTERNAL_ERROR", "Payments are not configured on this backend.")
    voucher = body.voucher
    job = job_for(principal, str(voucher.get("jobId", "")))     # 404 unless this app owns/claimed the job
    q = store.quotes.get(job.quote_id) if job.quote_id else None
    if not q or q.quote_id != voucher.get("quoteId") or not q.usdc:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job or quote.")
    if job.owner != principal.ref and not job.customer_approved_quote:
        raise api_error(403, "POLICY_VIOLATION", "The customer has not approved this quote in the web app.")
    if q.usdc != voucher.get("amount"):
        raise api_error(400, "AMOUNT_INVALID", "The voucher amount must equal the quoted settlement amount.")
    if job.status != "awaiting_payment" or job.payment_status in ("processing", "settled"):
        raise api_error(409, "POLICY_VIOLATION", "This job is not waiting for payment.")
    if quote_expired(q):
        raise api_error(410, "QUOTE_EXPIRED", "The quote has expired; request a new quote.")
    if not _bound_to_paired_device(principal, voucher):
        # Checked BEFORE the ledger: a voucher from another device is never recorded.
        raise api_error(403, "SIGNATURE_INVALID", "This voucher was not signed by the device paired with this session.")
    try:
        record, duplicate = accept(voucher, merchant_id=q.merchant_id)
    except OfflinePayError as exc:
        raise exc.http() from exc
    if not duplicate:
        with store.lock:
            job.customer_approved_quote = True   # the signed promise is the customer's approval of this quote
            store.touch(job)
            store.save()
    outcome = await settle(record)
    return {**public_record(record), "duplicate": duplicate, "settlement": outcome, "jobId": job.job_id}


@router.get("/{voucher_id}")
async def get_voucher(voucher_id: str, principal: Principal = Depends(native_principal)) -> dict[str, Any]:
    record = get_store().offline_vouchers.get(voucher_id)
    if not record:
        raise api_error(404, "UNKNOWN_VOUCHER", "Unknown voucherId")
    job_for(principal, record["voucher"]["jobId"])
    return public_record(record)


def job_offline_view(job_id: str) -> dict[str, Any] | None:
    """For the job view: the voucher covering this job, if any (no signature)."""
    record = next((r for r in get_store().offline_vouchers.values() if r["voucher"]["jobId"] == job_id), None)
    if record is None:
        return None
    return {k: v for k, v in public_record(record).items() if k != "voucher"} | {"voucherId": record["voucher"]["voucherId"]}
