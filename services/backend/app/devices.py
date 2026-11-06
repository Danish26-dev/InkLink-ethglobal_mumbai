"""Hardware devices: ESP32-S3 controllers and gateways.

Devices authenticate with `Authorization: Bearer <DEVICE_TOKEN>`.

POST /api/v1/devices/heartbeat  {deviceId, shopId, type, firmware?, state, printerId?, detail?}
POST /api/v1/devices/events     {deviceId, jobId, type, detail?}
    type: print_started | print_completed | print_failed | paper_out | jam | door_open
GET  /api/v1/devices/display?deviceId=…   read-only job/payment status for the device's shop
    (cloud equivalent of the shop gateway's /display, built from backend records)

Status shown to the shop is derived only from what devices actually reported:
  not_configured  DEVICE_TOKEN is not set (no device can report)
  never_seen      configured, but this device has not reported yet
  online/offline  by time since the last heartbeat
A job becomes `completed` only from a real `print_completed` event for a job
that the backend submitted (`executing`) — never for demo jobs.
"""

from __future__ import annotations

import re
import time
from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from . import events, gateway_relay
from .auth import api_error, require_service_token
from .config import get_settings
from .store import get_store, iso_from_epoch, now_iso

router = APIRouter(prefix="/api/v1/devices")

DEVICE_TYPES = {"esp32-s3", "gateway"}
EVENT_TYPES = {"print_started", "print_completed", "print_failed", "paper_out", "jam", "door_open"}
_DEVICE_STATUS = {"print_failed": "error", "paper_out": "paper_unavailable", "jam": "jam", "door_open": "error",
                  "print_started": "processing", "print_completed": "ready"}


def device_views(shop_id: str) -> dict[str, Any]:
    s = get_settings()
    store = get_store()
    now = time.time()
    items = []
    for d in store.devices.values():
        if d.get("shopId") != shop_id:
            continue
        age = now - float(d.get("lastSeen", 0))
        items.append({**{k: d.get(k) for k in ("deviceId", "type", "firmware", "state", "printerId", "detail")},
                      "lastSeenAt": iso_from_epoch(float(d.get("lastSeen", 0))),
                      "status": "online" if age <= s.device_offline_after_seconds else "offline"})
    return {
        "configured": bool(s.device_token),
        "status": "not_configured" if not s.device_token else ("never_seen" if not items else
                  ("online" if any(i["status"] == "online" for i in items) else "offline")),
        "items": items,
    }


class HeartbeatIn(BaseModel):
    deviceId: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    shopId: str
    type: str = "esp32-s3"
    firmware: str | None = Field(None, max_length=64)
    state: str = Field("idle", max_length=32)
    printerId: str | None = Field(None, max_length=256)
    detail: str | None = Field(None, max_length=280)


@router.post("/heartbeat")
async def heartbeat(body: HeartbeatIn, request: Request) -> dict[str, Any]:
    require_service_token(request, get_settings().device_token, "DEVICE_TOKEN")
    store = get_store()
    if body.type not in DEVICE_TYPES:
        raise api_error(400, "POLICY_VIOLATION", f"type must be one of {sorted(DEVICE_TYPES)}.")
    if body.shopId not in store.shop_ids():
        raise api_error(404, "SHOP_NOT_FOUND", "Unknown shop.")
    with store.lock:
        store.devices[body.deviceId] = {**body.model_dump(), "lastSeen": time.time()}
        store.save()
    return {"ok": True, "serverTime": now_iso()}


class DeviceEventIn(BaseModel):
    deviceId: str = Field(..., min_length=1, max_length=64)
    jobId: str
    type: str
    detail: str | None = Field(None, max_length=280)


# ───────────── GET /api/v1/devices/display: what a shop device may show ─────────────

_CLOSED_JOB_STATES = ("completed", "cancelled", "failed")
_HEDERA_TX_ID = re.compile(r"^\d+\.\d+\.\d+@\d+\.\d+$")
DISPLAY_MAX_JOBS = 10


def _verification_status(rec) -> str:
    """Backend view only. `verified` requires the record the HMAC-verified settlement callback
    wrote (status settled + a Hedera tx id + the backend's verification time); the agent sends
    that callback only after its mirror-node check. Nothing a device sends can change this."""
    if rec is None:
        return "not_started"
    if rec.status == "settled":
        ok = bool(rec.transaction_id and _HEDERA_TX_ID.match(rec.transaction_id) and rec.verified_at)
        return "verified" if ok else "unverified"
    return {"processing": "pending", "failed": "failed", "expired": "expired"}.get(rec.status, "pending")


def _device_job(job) -> dict[str, Any]:
    store = get_store()
    rec = store.payments.get(job.payment_id) if job.payment_id else None
    quote = store.quotes.get(rec.quote_id if rec else job.quote_id) if (rec or job.quote_id) else None
    verification = _verification_status(rec)
    verified = verification == "verified"
    # Backend's own decision: published only when it submitted the job after every gate passed.
    authorized = any(e.get("type") == "execution_authorized" for e in store.events.get(job.job_id, []))
    amount = rec.amount_usdc if rec else (quote.usdc if quote else None)
    return {
        "job_id": job.job_id,
        "job_state": job.status,
        "payment_status": rec.status if rec else job.payment_status,
        "payment_id": rec.payment_id if rec else None,
        "amount": amount,
        "asset": "HTS_USDC" if amount else None,
        "network": "hedera:testnet" if amount else None,
        "transaction_id": rec.transaction_id if verified else None,
        "verification_status": verification,
        "verified_at": rec.verified_at if verified else None,
        "settled_at": rec.settled_at if verified else None,
        "hashscan_url": rec.hashscan_url if verified else None,
        "execution_authorized": authorized,
        "device_status": job.device_status,
        "updated_at": job.updated_at,
    }


@router.get("/display")
async def device_display(request: Request, deviceId: str = Query(..., min_length=1, max_length=64,
                                                                  pattern=r"^[A-Za-z0-9_.-]+$")) -> dict[str, Any]:
    """Status for a shop display (ESP32-S3), read-only, from the backend's own records.

    The device must have reported a heartbeat; it sees only its own shop's real jobs. It
    receives status only: never documents, file names, prices in INR or customer data."""
    require_service_token(request, get_settings().device_token, "DEVICE_TOKEN")
    s = get_settings()
    store = get_store()
    device = store.devices.get(deviceId)
    if not device:
        raise api_error(404, "DEVICE_NOT_FOUND", "Unknown device. Send a heartbeat first.")
    shop_id = device.get("shopId")
    if store.is_demo_shop(shop_id):
        raise api_error(409, "POLICY_VIOLATION", "The demo shop has no real payments to display.")
    with store.lock:
        active = sorted((j for j in store.jobs.values() if j.shop_id == shop_id and j.status not in _CLOSED_JOB_STATES),
                        key=lambda j: j.updated_at, reverse=True)[:DISPLAY_MAX_JOBS]
        jobs = [_device_job(j) for j in active]
        cfg = store.shop_config(shop_id)
    age = time.time() - float(device.get("lastSeen", 0))
    relay = gateway_relay.status()
    return {
        "ok": True,
        "server_time": now_iso(),
        "device": {"device_id": deviceId, "shop_id": shop_id,
                   "status": "online" if age <= s.device_offline_after_seconds else "offline",
                   "last_seen_at": iso_from_epoch(float(device.get("lastSeen", 0)))},
        "shop": {"shop_id": shop_id, "name": cfg.get("name"), "accepting_orders": bool(cfg.get("acceptingOrders", True))},
        "printer": {"mode": relay.get("mode"), "gateway_connected": relay.get("connected")},
        "active_job": jobs[0] if jobs else None,
        "jobs": jobs,
    }


@router.post("/events")
async def device_event(body: DeviceEventIn, request: Request) -> dict[str, Any]:
    require_service_token(request, get_settings().device_token, "DEVICE_TOKEN")
    store = get_store()
    if body.type not in EVENT_TYPES:
        raise api_error(400, "POLICY_VIOLATION", f"type must be one of {sorted(EVENT_TYPES)}.")
    device = store.devices.get(body.deviceId)
    job = store.jobs.get(body.jobId)
    if not device or not job or device.get("shopId") != job.shop_id:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown device or job.")
    if store.is_demo_shop(job.shop_id):
        raise api_error(409, "POLICY_VIOLATION", "Demo jobs are never printed physically.")
    entry = {"at": now_iso(), "deviceId": body.deviceId, "type": body.type, "detail": body.detail}
    with store.lock:
        job.device_events = (job.device_events + [entry])[-50:]
        job.device_status = _DEVICE_STATUS.get(body.type, job.device_status)
        # Completion only for a job the backend actually submitted to the printer.
        if body.type == "print_completed" and job.status == "executing":
            job.status = "completed"
        store.touch(job)
        store.save()
    events.publish(job.job_id, "printer_readiness_updated", {
        "printerId": job.operator_config.get("printerId"),
        "status": "online" if body.type in ("print_started", "print_completed") else "unknown",
        "available": body.type in ("print_started", "print_completed"),
    }, source="device")
    events.publish_job_status(job)
    return {"ok": True, "jobStatus": job.status, "deviceStatus": job.device_status}
