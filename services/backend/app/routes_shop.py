"""Shop dashboard routes (SHOP_ADMIN_TOKEN)."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from . import events
from .auth import api_error, job_for, shop_principal
from .clients import ServiceError, list_printers
from .config import get_settings
from .jobs import add_message, try_execute
from .security import build_qr_payload
from .store import Principal, get_store
from .views import agent_status, job_view

router = APIRouter(prefix="/api/v1/shop")
_MONEY = re.compile(r"^\d{1,6}(\.\d{1,2})?$")


async def _printers() -> dict[str, Any]:
    try:
        body = await list_printers()
        return {"reachable": True, "printers": body.get("printers", []), "defaultPrinter": body.get("defaultPrinter"), "error": None}
    except ServiceError as exc:
        return {"reachable": False, "printers": [], "defaultPrinter": None, "error": exc.message}


@router.get("/overview")
async def overview(_: Principal = Depends(shop_principal)) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    cfg = store.shop_config()
    today = datetime.now(timezone.utc).date().isoformat()
    jobs = list(store.jobs.values())
    return {
        "shopId": s.shop_id,
        "name": cfg["name"],
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
async def set_availability(body: AvailabilityIn, _: Principal = Depends(shop_principal)) -> dict[str, Any]:
    store = get_store()
    with store.lock:
        store.shop["acceptingOrders"] = body.acceptingOrders
        store.save()
    return {"acceptingOrders": body.acceptingOrders}


@router.get("/jobs")
async def jobs(_: Principal = Depends(shop_principal)) -> list[dict[str, Any]]:
    items = sorted(get_store().jobs.values(), key=lambda j: j.created_at, reverse=True)
    return [job_view(j) for j in items[:100]]


@router.post("/jobs/{job_id}/approve")
async def approve(job_id: str, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    store = get_store()
    job = job_for(principal, job_id)
    if job.status in ("completed", "cancelled", "failed"):
        raise api_error(409, "POLICY_VIOLATION", "This job is closed.")
    with store.lock:
        job.shop_approved = True
        add_message(job, "system", "The shop approved this job.")
        store.touch(job)
        store.save()
    events.publish_job_status(job)
    result = await try_execute(job.job_id)
    return {"job": job_view(job), "execution": result}


@router.post("/jobs/{job_id}/complete")
async def complete(job_id: str, principal: Principal = Depends(shop_principal)) -> dict[str, Any]:
    """The shop confirms the pages came out. The printer adapter cannot observe completion."""
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
    return job_view(job)


@router.get("/printers")
async def printers(_: Principal = Depends(shop_principal)) -> dict[str, Any]:
    return await _printers()


class ShopConfigIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field("", max_length=280)
    pricePerPageMonochrome: str
    pricePerPageColor: str


@router.get("/config")
async def get_config(_: Principal = Depends(shop_principal)) -> dict[str, Any]:
    cfg = get_store().shop_config()
    return {k: cfg[k] for k in ("name", "description", "pricePerPageMonochrome", "pricePerPageColor", "defaults")}


@router.put("/config")
async def put_config(body: ShopConfigIn, _: Principal = Depends(shop_principal)) -> dict[str, Any]:
    if not _MONEY.match(body.pricePerPageMonochrome) or not _MONEY.match(body.pricePerPageColor):
        raise api_error(400, "POLICY_VIOLATION", "Prices must be decimal strings like 2.00.")
    store = get_store()
    with store.lock:
        store.shop.update(body.model_dump())
        store.save()
    return await get_config()


@router.get("/pairing-qr")
async def pairing_qr(request: Request, _: Principal = Depends(shop_principal)) -> dict[str, Any]:
    """Signed shop QR for pairing the native Inklink app (valid 1 hour)."""
    s = get_settings()
    payload = build_qr_payload(
        request.app.state.identity,
        shop_id=s.shop_id,
        gateway_id=s.gateway_id,
        mdns=s.gateway_mdns,
        port=s.port,
        ip=s.gateway_ip or None,
        ttl_seconds=3600,
    )
    return {"qrText": json.dumps(payload, separators=(",", ":")), "expiresAt": payload["expiresAt"]}
