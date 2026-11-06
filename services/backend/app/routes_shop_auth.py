"""Shopkeeper login, session and shop selection.

POST /api/v1/shop-auth/login        {email, password} -> HttpOnly session cookie
GET  /api/v1/shop-auth/me           current session, account and managed shops
PUT  /api/v1/shop-auth/active-shop  {shopId} (must be a shop the account manages)
POST /api/v1/shop-auth/logout       invalidates the server-side session

Accounts are created on the backend with `python -m app.manage create-shopkeeper`.
There are no default credentials.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .auth import (
    api_error,
    clear_login_failures,
    clear_shop_cookie,
    create_shop_session,
    end_shop_session,
    login_allowed,
    record_login_failure,
    set_shop_cookie,
    shop_session_for,
    verify_password,
)
from .store import get_store, iso_from_epoch

router = APIRouter(prefix="/api/v1/shop-auth")

# Verifying against a fixed hash for unknown emails keeps response time uniform.
_DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


class LoginIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


def _shops_view(shop_ids: list[str]) -> list[dict[str, Any]]:
    store = get_store()
    out = []
    for sid in shop_ids:
        if sid in store.shop_ids():
            cfg = store.shop_config(sid)
            out.append({"shopId": sid, "name": cfg["name"], "demo": cfg["demo"], "acceptingOrders": bool(cfg.get("acceptingOrders", True))})
    return out


def _session_view(request: Request) -> dict[str, Any]:
    sess = shop_session_for(request)
    if not sess:
        raise api_error(401, "UNAUTHORIZED", "Not logged in.")
    account = get_store().accounts.get(sess.account_id)
    if not account or account.disabled:
        raise api_error(401, "UNAUTHORIZED", "This account is no longer active.")
    return {
        "account": {"accountId": account.account_id, "email": account.email, "name": account.name, "role": account.role},
        "shops": _shops_view(account.shop_ids),
        "activeShopId": sess.active_shop,
        "expiresAt": iso_from_epoch(sess.expires_at),
    }


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    key = f"{email}|{request.client.host if request.client else ''}"
    if not login_allowed(key):
        raise api_error(429, "LOGIN_LOCKED", "Too many failed attempts. Try again in a few minutes.")
    account = next((a for a in get_store().accounts.values() if a.email == email), None)
    ok = verify_password(body.password, account.password_hash if account else _DUMMY_HASH)
    if not account or not ok or account.disabled:
        record_login_failure(key)
        raise api_error(401, "INVALID_CREDENTIALS", "Email or password is incorrect.")
    clear_login_failures(key)
    end_shop_session(request)  # never reuse a pre-login session (fixation)
    token, sess = create_shop_session(account)
    set_shop_cookie(response, token, sess.expires_at)
    return {
        "account": {"accountId": account.account_id, "email": account.email, "name": account.name, "role": account.role},
        "shops": _shops_view(account.shop_ids),
        "activeShopId": sess.active_shop,
        "expiresAt": iso_from_epoch(sess.expires_at),
    }


@router.get("/me")
async def me(request: Request) -> dict[str, Any]:
    return _session_view(request)


class ActiveShopIn(BaseModel):
    shopId: str


@router.put("/active-shop")
async def set_active_shop(body: ActiveShopIn, request: Request) -> dict[str, Any]:
    if request.headers.get("x-inklink-request") != "1":
        raise api_error(403, "CSRF_REJECTED", "Missing X-Inklink-Request header.")
    sess = shop_session_for(request)
    if not sess:
        raise api_error(401, "UNAUTHORIZED", "Not logged in.")
    account = get_store().accounts.get(sess.account_id)
    if not account or body.shopId not in account.shop_ids or body.shopId not in get_store().shop_ids():
        raise api_error(403, "SHOP_FORBIDDEN", "You do not manage this shop.")
    store = get_store()
    with store.lock:
        sess.active_shop = body.shopId
        store.save()
    return _session_view(request)


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    end_shop_session(request)
    clear_shop_cookie(response)
    return {"ok": True}
