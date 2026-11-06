"""Hardware devices: ESP32-S3 controllers and gateways.

Devices authenticate with `Authorization: Bearer <DEVICE_TOKEN>`.

POST /api/v1/devices/heartbeat  {deviceId, shopId, type, firmware?, state, printerId?, detail?}
POST /api/v1/devices/events     {deviceId, jobId, type, detail?}
    type: print_started | print_completed | print_failed | paper_out | jam | door_open

Status shown to the shop is derived only from what devices actually reported:
  not_configured  DEVICE_TOKEN is not set (no device can report)
  never_seen      configured, but this device has not reported yet
  online/offline  by time since the last heartbeat
A job becomes `completed` only from a real `print_completed` event for a job
that the backend submitted (`executing`) — never for demo jobs.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from . import events
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
