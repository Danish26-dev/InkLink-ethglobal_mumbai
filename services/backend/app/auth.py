"""Authentication and authorization for every caller kind.

- web:    anonymous browser session (POST /api/v1/web/sessions). No login.
- native: paired Inklink app session (POST /api/v1/pairing/verify).
- shop:   a shopkeeper account session (HttpOnly cookie set by
          POST /api/v1/shop-auth/login), or the SHOP_ADMIN_TOKEN bearer for
          server-to-server/API use. Every shop route is scoped to shops the
          caller owns (backend-enforced, never trusted from the browser).
- jury:   an ETHGlobal jury session: a customer of the isolated demo shop and
          a viewer/approver of its OWN demo jobs only.

Cookie sessions store only SHA-256(token) server-side. State-changing requests
authenticated by cookie must carry `X-Inklink-Request: 1` (CSRF guard; a
cross-site form cannot set custom headers). Bearer-authenticated calls are not
cookie-bound and need no CSRF header.

Short-lived single-purpose event tickets let EventSource (which cannot send
headers) open GET /jobs/{id}/events without putting a token in a URL.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

from fastapi import Header, HTTPException, Request, Response

from .config import get_settings
from .security import new_token, tokens_equal
from .store import AccountRecord, JobRecord, Principal, ShopSession, get_store, now_iso

EVENT_TICKET_TTL_SECONDS = 60
SHOP_COOKIE = "inklink_shop_session"
CSRF_HEADER = "x-inklink-request"
_tickets: dict[str, tuple[str, str, float]] = {}  # ticket -> (job_id, principal ref, expiry)
_login_failures: dict[str, list[float]] = {}


def api_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"success": False, "error": {"code": code, "message": message}})


# ───────────── passwords (stdlib scrypt) ─────────────

_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("Passwords must be at least 10 characters.")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, n, r, p, salt, digest = encoded.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), dklen=len(expected), n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


# ───────────── sessions ─────────────

def issue_session(kind: str, ref: str, ttl_seconds: int, *, shops: list[str] | None = None, role: str = "") -> tuple[str, float]:
    store = get_store()
    token = new_token()
    expires = time.time() + ttl_seconds
    with store.lock:
        store.sessions[token] = Principal(kind=kind, ref=ref, expires_at=expires, shops=shops or [], role=role)
        store.save()
    return token, expires


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        return ""
    return authorization[7:].strip()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_shop_session(account: AccountRecord) -> tuple[str, ShopSession]:
    s = get_settings()
    store = get_store()
    token = secrets.token_urlsafe(32)
    now = time.time()
    sess = ShopSession(token_hash=_hash(token), account_id=account.account_id, created_at=now,
                       expires_at=now + s.shop_session_ttl_seconds, active_shop=(account.shop_ids or [None])[0])
    with store.lock:
        # Drop this account's expired sessions while we are here.
        for k, v in list(store.shop_sessions.items()):
            if v.expires_at <= now:
                store.shop_sessions.pop(k, None)
        store.shop_sessions[sess.token_hash] = sess
        store.save()
    return token, sess


def set_shop_cookie(response: Response, token: str, expires_at: float) -> None:
    s = get_settings()
    response.set_cookie(SHOP_COOKIE, token, max_age=max(0, int(expires_at - time.time())), httponly=True,
                        secure=s.session_cookie_secure, samesite="strict", path="/")


def clear_shop_cookie(response: Response) -> None:
    response.delete_cookie(SHOP_COOKIE, path="/")


def shop_session_for(request: Request) -> ShopSession | None:
    token = request.cookies.get(SHOP_COOKIE)
    if not token:
        return None
    store = get_store()
    sess = store.shop_sessions.get(_hash(token))
    if not sess:
        return None
    if sess.expires_at <= time.time():
        with store.lock:
            store.shop_sessions.pop(sess.token_hash, None)
            store.save()
        return None
    return sess


def end_shop_session(request: Request) -> None:
    sess = shop_session_for(request)
    if sess:
        store = get_store()
        with store.lock:
            store.shop_sessions.pop(sess.token_hash, None)
            store.save()


# ───────────── login throttling ─────────────

def login_allowed(key: str) -> bool:
    s = get_settings()
    now = time.time()
    recent = [t for t in _login_failures.get(key, []) if now - t < s.login_lockout_seconds]
    _login_failures[key] = recent
    return len(recent) < s.login_max_failures


def record_login_failure(key: str) -> None:
    _login_failures.setdefault(key, []).append(time.time())


def clear_login_failures(key: str) -> None:
    _login_failures.pop(key, None)


# ───────────── principal resolution ─────────────

def _admin_principal() -> Principal:
    return Principal(kind="shop", ref="admin", expires_at=float("inf"), shops=["*"], role="admin")


def resolve_principal(request: Request | None, authorization: str | None) -> Principal:
    token = _bearer(authorization)
    s = get_settings()
    if token:
        if s.shop_admin_token and tokens_equal(token, s.shop_admin_token):
            return _admin_principal()
        store = get_store()
        principal = store.sessions.get(token)
        if principal is None:
            raise api_error(401, "UNAUTHORIZED", "A valid session is required.")
        if principal.expires_at <= time.time():
            with store.lock:
                store.sessions.pop(token, None)
                store.save()
            raise api_error(401, "SESSION_EXPIRED", "The session has expired.")
        return principal
    if request is not None:
        sess = shop_session_for(request)
        if sess:
            account = get_store().accounts.get(sess.account_id)
            if not account or account.disabled:
                raise api_error(401, "SESSION_EXPIRED", "This account is no longer active.")
            if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CSRF_HEADER) != "1":
                raise api_error(403, "CSRF_REJECTED", "Missing X-Inklink-Request header.")
            return Principal(kind="shop", ref=account.account_id, expires_at=sess.expires_at,
                             shops=list(account.shop_ids), role=account.role, active_shop=sess.active_shop)
        if request.cookies.get(SHOP_COOKIE):
            raise api_error(401, "SESSION_EXPIRED", "Your session has expired. Please log in again.")
    raise api_error(401, "UNAUTHORIZED", "A valid session is required.")


_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def is_local_request(request: Request) -> bool:
    """True only for requests that originate on this computer (no forwarded remote client)."""
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        return False
    forwarded = request.headers.get("x-forwarded-for", "")
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    return all(h in _LOOPBACK for h in hops)


def local_shop_principal(request: Request, authorization: str | None) -> Principal | None:
    """Opt-in kiosk mode (SHOP_LOCAL_ACCESS=true): tokenless shop access from this computer only."""
    s = get_settings()
    if (s.shop_local_access and not _bearer(authorization) and not request.cookies.get(SHOP_COOKIE)
            and is_local_request(request)):
        return Principal(kind="shop", ref="local", expires_at=float("inf"), shops=[s.shop_id], role="owner")
    return None


async def any_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    return local_shop_principal(request, authorization) or resolve_principal(request, authorization)


async def web_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    p = resolve_principal(request, authorization)
    if p.kind not in ("web", "shop", "jury"):
        raise api_error(403, "UNAUTHORIZED", "This endpoint is for the web app.")
    return p


async def native_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    p = resolve_principal(request, authorization)
    if p.kind != "native":
        raise api_error(403, "UNAUTHORIZED", "Pair with the shop in the Inklink app first.")
    return p


async def shop_principal(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    """Shopkeepers and the jury (read + approve of its own demo jobs)."""
    local = local_shop_principal(request, authorization)
    if local:
        return local
    p = resolve_principal(request, authorization)
    if p.kind not in ("shop", "jury"):
        raise api_error(403, "UNAUTHORIZED", "Shop access only.")
    return p


async def shop_owner(request: Request, authorization: str | None = Header(default=None)) -> Principal:
    """Shopkeepers only: changes to shop configuration, availability, completion."""
    p = await shop_principal(request, authorization)
    if p.kind != "shop":
        raise api_error(403, "UNAUTHORIZED", "Only the shopkeeper can do this.")
    return p


def may_access_shop(principal: Principal, shop_id: str) -> bool:
    return "*" in principal.shops or shop_id in principal.shops


def active_shop(principal: Principal, request: Request) -> str:
    """The shop a shop-scoped request acts on, checked against what the caller owns."""
    s = get_settings()
    store = get_store()
    wanted = request.headers.get("x-inklink-shop") or principal.active_shop
    if not wanted:
        wanted = s.demo_shop_id if principal.kind == "jury" else (
            s.shop_id if "*" in principal.shops else (principal.shops[0] if principal.shops else None))
    if not wanted or wanted not in store.shop_ids() or not may_access_shop(principal, wanted):
        raise api_error(403, "SHOP_FORBIDDEN", "You do not manage this shop.")
    return wanted


def require_service_token(request: Request, expected: str, label: str) -> None:
    token = _bearer(request.headers.get("authorization"))
    if not expected:
        raise api_error(503, "INTERNAL_ERROR", f"{label} is not configured on the backend.")
    if not tokens_equal(token, expected):
        raise api_error(401, "UNAUTHORIZED", "Invalid service token.")


def job_for(principal: Principal, job_id: str) -> JobRecord:
    """Load a job the caller may see.

    - web/native: the job's owner or the native app that claimed it,
    - shop: a job of a shop the shopkeeper manages,
    - jury: only its own jobs in the demo shop.
    Anything else is reported as not found (other people's jobs are not revealed).
    """
    job = get_store().jobs.get(job_id)
    if job is None:
        raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")
    if principal.kind == "shop" and may_access_shop(principal, job.shop_id):
        return job
    if principal.kind == "jury":
        if job.owner == principal.ref and get_store().is_demo_shop(job.shop_id):
            return job
    elif principal.kind in ("web", "native") and principal.ref in (job.owner, job.claimed_by):
        return job
    raise api_error(404, "JOB_NOT_FOUND", "Unknown job.")


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


def new_account(email: str, name: str, password: str, shop_ids: list[str], role: str = "owner") -> AccountRecord:
    return AccountRecord(account_id="acct_" + secrets.token_hex(6), email=email.strip().lower(), name=name.strip(),
                         password_hash=hash_password(password), shop_ids=shop_ids, role=role, created_at=now_iso())
