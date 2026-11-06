"""Printer relay: lets a cloud-hosted backend reach the printer on the shop LAN.

A Cloud Run backend cannot open connections into a shop network, and the local
printer adapter / ESP32 must never be exposed publicly. With PRINTER_MODE=relay the
shop gateway connector (services/shop-gateway) runs on the shop computer and opens
OUTBOUND HTTPS requests to this backend:

  POST /api/v1/gateway/poll              long-poll (<= 25 s) -> {requests, events}
  POST /api/v1/gateway/results           {results: [{id, status, body}]}
  GET  /api/v1/gateway/documents/{token} the PDF of a print request (short-lived)

All three require `Authorization: Bearer <GATEWAY_TOKEN>`.

A printer call (discovery, availability, validation, print) is queued here, picked
up by the connector, executed against the local adapter and answered via /results.
Print requests carry a one-time document reference instead of the file itself, so
request bodies stay small (Cloud Run limits request size to 32 MiB).

The strands-agent reaches the printer through this backend as well:

  GET|POST /api/v1/internal/printer/{path}   header x-printer-agent-token

which only allows the read/validate calls (never /print: only the backend prints,
after authorization).

The queue lives in memory: the backend runs as a single instance (see
DEPLOYMENT_ARCHITECTURE.md). It is loop-agnostic on purpose (plain locks and short
sleeps), so it works the same under uvicorn and in tests.
"""

from __future__ import annotations

import asyncio
import secrets
import threading
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .auth import api_error, require_service_token
from .config import get_settings
from .security import tokens_equal
from .store import get_store, now_iso

router = APIRouter()

POLL_MAX_WAIT_SECONDS = 25.0
CONNECTED_WINDOW_SECONDS = 75.0
DOCUMENT_TTL_SECONDS = 600.0
_TICK = 0.1

# Only these job events reach the shop gateway (for the ESP32 status display), and only
# these payload fields: status values, never documents, prices or customer data.
FORWARDED_EVENTS = {"job_status_updated", "payment_status_updated", "execution_authorized"}
_FORWARDED_FIELDS = ("status", "paymentStatus", "deviceStatus", "state")
# Backend-authoritative quote facts, on every payment event (pending, processing, failed...).
_PAYMENT_FIELDS = ("paymentId", "amount", "asset", "network")
# Settlement proof for the display, forwarded ONLY once the backend verified the signed
# callback (payment_status_updated with status "settled"). Public on HashScan anyway.
_SETTLED_FIELDS = ("transactionId", "settledAt", "verifiedAt", "hashscanUrl")

# The agent may call these printer adapter endpoints through the backend (never /print).
_AGENT_ALLOWED = (
    ("GET", ("printers",)),
    ("GET", ("printers", "*", "availability")),
    ("POST", ("validate",)),
)


class _Relay:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pending: deque[dict[str, Any]] = deque()
        self.results: dict[str, tuple[int, Any]] = {}
        self.waiting: set[str] = set()
        self.events: deque[dict[str, Any]] = deque(maxlen=200)
        self.documents: dict[str, tuple[bytes, float]] = {}
        self.last_poll = 0.0
        self.closing = False

    def reset(self) -> None:
        self.__init__()


_relay = _Relay()


def enabled() -> bool:
    return get_settings().printer_mode == "relay"


def connected() -> bool:
    return enabled() and (time.time() - _relay.last_poll) <= CONNECTED_WINDOW_SECONDS


def status() -> dict[str, Any]:
    s = get_settings()
    if not enabled():
        return {"mode": s.printer_mode}
    return {
        "mode": "relay",
        "configured": bool(s.gateway_token),
        "connected": connected(),
        "lastPollAt": None if not _relay.last_poll else round(_relay.last_poll),
    }


def shutdown() -> None:
    """Release waiting long-polls so the process can stop promptly."""
    _relay.closing = True


def reset_for_tests() -> None:
    _relay.reset()


# ───────────── backend side ─────────────

class RelayError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def put_document(data: bytes) -> str:
    token = secrets.token_urlsafe(24)
    now = time.time()
    with _relay.lock:
        for t, (_, exp) in list(_relay.documents.items()):
            if exp <= now:
                del _relay.documents[t]
        _relay.documents[token] = (data, now + DOCUMENT_TTL_SECONDS)
    return token


def drop_document(token: str) -> None:
    with _relay.lock:
        _relay.documents.pop(token, None)


async def request(method: str, path: str, body: Any = None, timeout: float | None = None) -> tuple[int, Any]:
    """Queue a printer adapter call for the shop gateway and wait for its answer."""
    if not connected():
        raise RelayError("PRINTER_ADAPTER_UNREACHABLE", "The shop gateway is not connected to the backend.")
    rid = "rq_" + secrets.token_hex(8)
    deadline = time.time() + (timeout or get_settings().printer_relay_timeout_seconds)
    with _relay.lock:
        _relay.waiting.add(rid)
        _relay.pending.append({"id": rid, "method": method.upper(), "path": path, "body": body,
                               "queuedAt": now_iso()})
    try:
        while time.time() < deadline:
            with _relay.lock:
                if rid in _relay.results:
                    return _relay.results.pop(rid)
            await asyncio.sleep(_TICK)
        raise RelayError("PRINTER_RELAY_TIMEOUT", "The shop gateway did not answer in time.")
    finally:
        with _relay.lock:
            _relay.waiting.discard(rid)
            _relay.results.pop(rid, None)
            # Not picked up yet: withdraw it so it is never executed late.
            for item in list(_relay.pending):
                if item["id"] == rid:
                    _relay.pending.remove(item)


def on_event(event: dict[str, Any]) -> None:
    """Called by events.publish. Forwards display-relevant status of real (non-demo) jobs."""
    if not enabled() or event.get("type") not in FORWARDED_EVENTS:
        return
    store = get_store()
    job = store.jobs.get(str(event.get("jobId")))
    if job is None or store.is_demo_shop(job.shop_id):
        return
    payload = event.get("payload") or {}
    fields = {k: payload[k] for k in _FORWARDED_FIELDS if k in payload}
    if event["type"] == "payment_status_updated":
        fields.update({k: payload[k] for k in _PAYMENT_FIELDS if payload.get(k) is not None})
        if payload.get("status") == "settled":
            fields.update({k: payload[k] for k in _SETTLED_FIELDS if payload.get(k) is not None})
    with _relay.lock:
        _relay.events.append({
            "jobId": job.job_id,
            "shopId": job.shop_id,
            "type": event["type"],
            "ts": event.get("ts"),
            "payload": fields,
        })


# ───────────── gateway side (HTTP) ─────────────

def _require_gateway(request_: Request) -> None:
    if not enabled():
        raise api_error(404, "NOT_FOUND", "The printer relay is not enabled on this backend.")
    require_service_token(request_, get_settings().gateway_token, "GATEWAY_TOKEN")


class PollIn(BaseModel):
    gatewayId: str | None = Field(None, max_length=64)
    maxWaitSeconds: float = Field(POLL_MAX_WAIT_SECONDS, ge=0, le=POLL_MAX_WAIT_SECONDS)


@router.post("/api/v1/gateway/poll")
async def poll(body: PollIn, request_: Request) -> dict[str, Any]:
    _require_gateway(request_)
    deadline = time.time() + body.maxWaitSeconds
    while True:
        _relay.last_poll = time.time()
        with _relay.lock:
            if _relay.pending or _relay.events or _relay.closing or time.time() >= deadline:
                reqs = list(_relay.pending)
                _relay.pending.clear()
                evts = list(_relay.events)
                _relay.events.clear()
                return {"requests": reqs, "events": evts, "serverTime": now_iso()}
        if await request_.is_disconnected():
            return {"requests": [], "events": [], "serverTime": now_iso()}
        await asyncio.sleep(_TICK)


class ResultIn(BaseModel):
    id: str = Field(..., max_length=64)
    status: int = Field(..., ge=100, le=599)
    body: Any = None


class ResultsIn(BaseModel):
    results: list[ResultIn] = Field(default_factory=list, max_length=100)


@router.post("/api/v1/gateway/results")
async def results(body: ResultsIn, request_: Request) -> dict[str, Any]:
    _require_gateway(request_)
    accepted = 0
    with _relay.lock:
        for r in body.results:
            if r.id in _relay.waiting:  # late or unknown results are dropped
                _relay.results[r.id] = (r.status, r.body)
                accepted += 1
    return {"ok": True, "accepted": accepted}


@router.get("/api/v1/gateway/documents/{token}")
async def document(token: str, request_: Request) -> Response:
    _require_gateway(request_)
    with _relay.lock:
        item = _relay.documents.get(token)
    if item is None or item[1] <= time.time():
        raise api_error(404, "NOT_FOUND", "Unknown or expired document reference.")
    return Response(content=item[0], media_type="application/pdf", headers={"cache-control": "no-store"})


# ───────────── agent -> printer (through the backend) ─────────────

def _agent_allowed(method: str, path: str) -> bool:
    parts = tuple(p for p in path.split("/") if p)
    for m, pattern in _AGENT_ALLOWED:
        if m == method and len(parts) == len(pattern) and all(p == "*" or p == x for p, x in zip(pattern, parts)):
            return True
    return False


@router.api_route("/api/v1/internal/printer/{path:path}", methods=["GET", "POST"])
async def agent_printer_proxy(path: str, request_: Request) -> JSONResponse:
    from .clients import ServiceError, printer_call

    expected = get_settings().printer_agent_token
    supplied = request_.headers.get("x-printer-agent-token", "")
    if not expected:
        raise api_error(503, "INTERNAL_ERROR", "PRINTER_AGENT_TOKEN is not configured on the backend.")
    if not tokens_equal(supplied, expected):
        raise api_error(401, "UNAUTHORIZED", "Invalid printer agent token.")
    method = request_.method.upper()
    if not _agent_allowed(method, path):
        raise api_error(403, "POLICY_VIOLATION", "This printer operation is not available to the agent.")
    payload = None
    if method == "POST":
        try:
            payload = await request_.json()
        except ValueError:
            raise api_error(400, "POLICY_VIOLATION", "Invalid JSON body.") from None
    try:
        code, out = await printer_call(method, "/" + "/".join(p for p in path.split("/") if p), payload)
    except ServiceError as exc:
        return JSONResponse(status_code=502, content={"ok": False, "error": {"code": exc.code, "message": exc.message}})
    return JSONResponse(status_code=code, content=out)
