"""Bearer-token authentication for the three caller kinds.

- web:    anonymous browser session (POST /api/v1/web/sessions), no login
- native: paired Inklink app session (POST /api/v1/pairing/verify)
- shop:   shop dashboard, SHOP_ADMIN_TOKEN

Short-lived single-purpose event tickets let EventSource (which cannot send
headers) open GET /jobs/{id}/events without putting the session token in a URL.
"""

from __future__ import annotations

import secrets
import time

from fastapi import Header, HTTPException, Request

from .config import get_settings
from .security import new_token, tokens_equal
from .store import JobRecord, Principal, get_store

EVENT_TICKET_TTL_SECONDS = 60
_tickets: dict[str, tuple[str, str, float]] = {}  # ticket -> (job_id, principal ref, expiry)


def api_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"success": False, "error": {"code": code, "message": message}})


def issue_session(kind: str, ref: str, ttl_seconds: int) -> tuple[str, float]:
    store = get_store()
    token = new_token()
    expires = time.time() + ttl_seconds
    with store.lock:
        store.sessions[token] = Principal(kind=kind, ref=ref, expires_at=expires)
        store.save()
    return token, expires


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        return ""
    return authorization[7:].strip()


def resolve_principal(authorization: str | None) -> Principal:
    token = _bearer(authorization)
    s = get_settings()
    if token and s.shop_admin_token and tokens_equal(token, s.shop_admin_token):
        return Principal(kind="shop", ref=s.shop_id, expires_at=float("inf"))
    store = get_store()
    principal = store.sessions.get(token) if token else None
    if principal is None:
        raise api_error(401, "UNAUTHORIZED", "A valid session is required.")
    if principal.expires_at <= time.time():
        with store.lock:
            store.sessions.pop(token, None)
            store.save()
        raise api_error(401, "SESSION_EXPIRED", "The session has expired.")
    return principal


_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def is_local_request(request: Request) -> bool:
    """True only for requests that originate on this computer.

    A dev proxy (Vite) forwards the browser's address in X-Forwarded-For; any
    non-loopback hop there (e.g. a phone on the LAN) makes the request remote.
    """
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        return False
    forwarded = request.headers.get("x-forwarded-for", "")
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    return all(h in _LOOPBACK for h in hops)


def local_shop_principal(request: Request, authorization: str | None) -> Principal | None:
    """Tokenless shop access from the shop computer, when SHOP_LOCAL_ACCESS is on."""
    s = get_settings()
    if s.shop_local_access and not _bearer(authorization) and is_local_request(request):
        return Principal(kind="shop", ref=s.shop_id, expires_at=float("inf"))
    return None


async def any_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    return local_shop_principal(request, authorization) or resolve_principal(authorization)


async def web_principal(authorization: str | None = Header(default=None)) -> Principal:
    p = resolve_principal(authorization)
    if p.kind not in ("web", "shop"):
        raise api_error(403, "UNAUTHORIZED", "This endpoint is for the web app.")
    return p


async def native_principal(authorization: str | None = Header(default=None)) -> Principal:
    p = resolve_principal(authorization)
    if p.kind != "native":
        raise api_error(403, "UNAUTHORIZED", "Pair with the shop in the Inklink app first.")
    return p


async def shop_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    s = get_settings()
    local = local_shop_principal(request, authorization)
    if local:
        return local
    if not s.shop_admin_token:
        raise api_error(503, "UNAUTHORIZED", "SHOP_ADMIN_TOKEN is not configured on the backend.")
    p = resolve_principal(authorization)
    if p.kind != "shop":
        raise api_error(403, "UNAUTHORIZED", "Shop access only.")
    return p


def require_service_token(request: Request, expected: str, label: str) -> None:
    token = _bearer(request.headers.get("authorization"))
    if not expected:
        raise api_error(503, "INTERNAL_ERROR", f"{label} is not configured on the backend.")
    if not tokens_equal(token, expected):
        raise api_error(401, "UNAUTHORIZED", "Invalid service token.")


def job_for(principal: Principal, job_id: str) -> JobRecord:
    """Load a job the caller may see: its web owner, the native app that claimed it, or the shop."""
    job = get_store().jobs.get(job_id)
    if job is None:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")
    if principal.kind == "shop":
        return job
    if principal.ref in (job.owner, job.claimed_by):
        return job
    raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")  # do not reveal other people's jobs


def issue_event_ticket(principal: Principal, job_id: str) -> str:
    ticket = secrets.token_urlsafe(24)
    now = time.time()
    for k, (_, _, exp) in list(_tickets.items()):
        if exp <= now:
            _tickets.pop(k, None)
    _tickets[ticket] = (job_id, principal.ref, now + EVENT_TICKET_TTL_SECONDS)
    return ticket


def redeem_event_ticket(ticket: str, job_id: str) -> None:
    entry = _tickets.pop(ticket, None)  # single use
    if not entry or entry[0] != job_id or entry[2] <= time.time():
        raise api_error(401, "UNAUTHORIZED", "Invalid or expired event ticket.")


def web_customer_reference() -> str:
    return "web_" + new_token()[:22]
