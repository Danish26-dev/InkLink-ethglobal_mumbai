"""Shop dashboard routes.

Every route acts on the caller's ACTIVE shop (`auth.active_shop`), which must
be a shop the caller manages: a shopkeeper account's shops, every shop for the
SHOP_ADMIN_TOKEN, or only the demo shop for a jury session. The jury sees only
its own demo jobs and may approve them; it cannot change shop settings.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from . import chain, devices, events, gateway_relay
from .auth import active_shop, api_error, job_for, shop_owner, shop_principal
from .clients import ServiceError, list_printers
from .config import TRUST_MODES, get_settings
from .jobs import add_message, try_execute
from .security import build_qr_payload
from .store import JobRecord, Principal, get_store
from .views import agent_status, job_view

router = APIRouter(prefix="/api/v1/shop")
_MONEY = re.compile(r"^\d{1,6}(\.\d{1,2})?$")


async def _printers() -> dict[str, Any]:
    try:
        body = await list_printers()
        return {"reachable": True, "printers": body.get("printers", []), "defaultPrinter": body.get("defaultPrinter"), "error": None}
    except ServiceError as exc:
        return {"reachable": False, "printers": [], "defaultPrinter": None, "error": exc.message}


def _visible_jobs(principal: Principal, shop_id: str) -> list[JobRecord]:
    jobs = [j for j in get_store().jobs.values() if j.shop_id == shop_id]
    if principal.kind == "jury":
        jobs = [j for j in jobs if j.owner == principal.ref]  # a judge sees only their own demo jobs
    return jobs


@router.get("/overview")
async def overview(request: Request, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    shop_id = active_shop(principal, request)
    cfg = store.shop_config(shop_id)
    today = datetime.now(timezone.utc).date().isoformat()
    jobs = _visible_jobs(principal, shop_id)
    return {
        "shopId": shop_id,
        "name": cfg["name"],
        "demo": cfg["demo"],
        "acceptingOrders": bool(cfg.get("acceptingOrders", True)),
        "agent": await agent_status(),
        "printerAdapter": await _printers(),
        "payments": {"configured": s.payments_configured},
        "stats": {
            "activeJobs": sum(j.status not in ("completed", "cancelled", "failed") for j in jobs),
            "awaitingApproval": sum(j.status == "awaiting_execution" and not j.shop_approved for j in jobs),
            "awaitingExecution": sum(j.status == "awaiting_execution" for j in jobs),
            "completedToday": sum(j.status == "completed" and j.updated_at.startswith(today) for j in jobs),
        },
    }


class AvailabilityIn(BaseModel):
    acceptingOrders: bool


@router.put("/availability")
async def set_availability(body: AvailabilityIn, request: Request, principal: Principal = Depends(shop_owner)) -> dict[str, Any]:
    store = get_store()
    shop_id = active_shop(principal, request)
    with store.lock:
        store.shops.setdefault(shop_id, {})["acceptingOrders"] = body.acceptingOrders
        store.save()
    return {"acceptingOrders": body.acceptingOrders}


@router.get("/jobs")
async def jobs(request: Request, principal: Principal = Depends(shop_principal)) -> list[dict[str, Any]]:
    shop_id = active_shop(principal, request)
    items = sorted(_visible_jobs(principal, shop_id), key=lambda j: j.created_at, reverse=True)
    return [job_view(j) for j in items[:100]]


@router.post("/jobs/{job_id}/approve")
async def approve(job_id: str, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    store = get_store()
    job = job_for(principal, job_id)
    if job.status in ("completed", "cancelled", "failed"):
        raise api_error(409, "POLICY_VIOLATION", "This job is closed.")
    with store.lock:
        job.shop_approved = True
        add_message(job, "system", "The shop approved this job." if principal.kind == "shop" else "Approved in the jury demo (demo shop).")
        store.touch(job)
        store.save()
    events.publish_job_status(job)
    result = await try_execute(job.job_id)
    return {"job": job_view(job), "execution": result}


@router.post("/jobs/{job_id}/complete")
async def complete(job_id: str, principal: Principal = Depends(shop_owner)) -> dict[str, Any]:
    """The shop confirms the pages came out (the printer adapter cannot observe completion)."""
    store = get_store()
    job = job_for(principal, job_id)
    if job.status != "executing":
        raise api_error(409, "POLICY_VIOLATION", "Only a job that is printing can be marked completed.")
    with store.lock:
        job.status = "completed"
        job.device_status = "ready"
        add_message(job, "system", "Your print is ready for collection.")
        store.touch(job)
        store.save()
    events.publish_job_status(job)
    chain.queue("job_completed", job.job_id, {"jobCommitment": chain.commitment(job.job_id, job.shop_id), "confirmedBy": "shop"})
    return job_view(job)


@router.get("/printers")
async def printers(_: Principal = Depends(shop_principal)) -> dict[str, Any]:
    return await _printers()


class ShopConfigIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field("", max_length=280)
    pricePerPageMonochrome: str
    pricePerPageColor: str
    # Shop-wide floor for 0G inference; it can only make runs stricter.
    minimumTrustMode: str | None = None


@router.get("/config")
async def get_config(request: Request, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    cfg = get_store().shop_config(active_shop(principal, request))
    return {k: cfg.get(k) for k in ("shopId", "name", "description", "pricePerPageMonochrome", "pricePerPageColor", "minimumTrustMode", "defaults", "demo")}


@router.put("/config")
async def put_config(body: ShopConfigIn, request: Request, principal: Principal = Depends(shop_owner)) -> dict[str, Any]:
    if not _MONEY.match(body.pricePerPageMonochrome) or not _MONEY.match(body.pricePerPageColor):
        raise api_error(400, "POLICY_VIOLATION", "Prices must be decimal strings like 2.00.")
    if body.minimumTrustMode is not None and body.minimumTrustMode not in TRUST_MODES:
        raise api_error(400, "POLICY_VIOLATION", "minimumTrustMode must be standard, verified, private or null.")
    store = get_store()
    shop_id = active_shop(principal, request)
    with store.lock:
        store.shops.setdefault(shop_id, {}).update(body.model_dump())
        store.save()
    return await get_config(request, principal)


@router.get("/hardware")
async def hardware(request: Request, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    """Gateway, printer adapter, discovered printers, ESP32-S3 devices and jobs at the printer."""
    s = get_settings()
    shop_id = active_shop(principal, request)
    active = [j for j in _visible_jobs(principal, shop_id) if j.status in ("awaiting_execution", "executing")]
    return {
        "gateway": {"gatewayId": s.gateway_id, "fingerprint": request.app.state.identity.fingerprint(), "status": "online"},
        "printerAdapter": {**(await _printers()),
                           "url": "shop gateway relay" if s.printer_mode == "relay" else s.printer_agent_url,
                           "relay": gateway_relay.status()},
        "devices": devices.device_views(shop_id),
        "jobs": [
            {"jobId": j.job_id, "status": j.status, "deviceStatus": j.device_status,
             "printerId": j.operator_config.get("printerId"), "submission": j.submission}
            for j in sorted(active, key=lambda j: j.updated_at, reverse=True)
        ],
    }


@router.get("/payments")
async def payments(request: Request, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    """Payments recorded by this backend. `settled` only ever comes from a verified callback."""
    s = get_settings()
    store = get_store()
    shop_id = active_shop(principal, request)
    visible = {j.job_id for j in _visible_jobs(principal, shop_id)}
    items = []
    for p in store.payments.values():
        if p.job_id not in visible:
            continue
        job = store.jobs.get(p.job_id)
        quote = store.quotes.get(p.quote_id)
        items.append({
            "paymentId": p.payment_id, "jobId": p.job_id, "quoteId": p.quote_id, "status": p.status,
            "amountUsdc": p.amount_usdc, "amountInr": quote.inr if quote else None,
            "transactionId": p.transaction_id, "hashscanUrl": p.hashscan_url,
            "jobStatus": job.status if job else None,
        })
    awaiting = [
        {"jobId": j.job_id, "status": j.status, "paymentStatus": j.payment_status,
         "amountInr": store.quotes[j.quote_id].inr if j.quote_id in store.quotes else None}
        for j in store.jobs.values() if j.job_id in visible and j.status == "awaiting_payment"
    ]
    return {
        "configured": s.payments_configured,
        "network": "hedera_testnet",
        "merchantAccountId": s.merchant_account_id or None,
        "settlementAsset": "HTS-USDC",
        "inrToUsdcRate": s.inr_to_usdc_rate or None,
        "payments": items,
        "awaitingPayment": awaiting,
    }


@router.get("/pairing-qr")
async def pairing_qr(request: Request, principal: Principal = Depends(shop_owner)) -> dict[str, Any]:
    """Signed shop QR for pairing the native Inklink app (valid 1 hour)."""
    s = get_settings()
    payload = build_qr_payload(
        request.app.state.identity,
        shop_id=active_shop(principal, request),
        gateway_id=s.gateway_id,
        mdns=s.gateway_mdns,
        port=s.port,
        ip=s.gateway_ip or None,
        ttl_seconds=3600,
        cloud_origin=s.public_api_origin or None,
    )
    return {"qrText": json.dumps(payload, separators=(",", ":")), "expiresAt": payload["expiresAt"]}
