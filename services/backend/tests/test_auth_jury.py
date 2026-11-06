"""Shopkeeper sessions, shop ownership, jury isolation, devices and chain readiness."""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import auth as auth_mod
from app import chain
from app import config as config_mod
from app import devices as devices_mod
from app import jobs as jobs_mod
from app import jury as jury_mod
from app.auth import SHOP_COOKIE, new_account
from app.main import create_app
from app.store import get_store

CSRF = {"x-inklink-request": "1"}
PASSWORD = "correct-horse-battery"


def pdf(pages=2) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def clear_throttle():
    auth_mod._login_failures.clear()
    yield


@pytest.fixture
def client():
    return TestClient(create_app())


def make_account(email="owner@example.com", shops=("shop_001",)):
    store = get_store()
    acct = new_account(email, "Owner", PASSWORD, list(shops))
    store.accounts[acct.account_id] = acct
    store.save()
    return acct


def login(client, email="owner@example.com", password=PASSWORD):
    return client.post("/api/v1/shop-auth/login", json={"email": email, "password": password})


# ───────────── shopkeeper sessions ─────────────

def test_login_session_refresh_and_logout(client):
    make_account()
    r = login(client)
    assert r.status_code == 200 and r.json()["activeShopId"] == "shop_001"
    cookie = r.cookies.get(SHOP_COOKIE)
    assert cookie and "httponly" in r.headers["set-cookie"].lower() and "samesite=strict" in r.headers["set-cookie"].lower()
    assert "password" not in r.text
    # Refresh: a new browser tab with the same cookie keeps the session.
    other = TestClient(create_app(), cookies={SHOP_COOKIE: cookie})
    assert other.get("/api/v1/shop-auth/me").status_code == 200
    assert other.get("/api/v1/shop/overview").json()["shopId"] == "shop_001"
    # Logout invalidates the SERVER-side session; the old cookie is useless afterwards.
    client.post("/api/v1/shop-auth/logout")
    stale = TestClient(create_app(), cookies={SHOP_COOKIE: cookie})
    assert stale.get("/api/v1/shop-auth/me").status_code == 401
    assert stale.get("/api/v1/shop/jobs").status_code == 401


def test_wrong_password_and_lockout(client):
    make_account()
    for _ in range(5):
        assert login(client, password="wrong-password-1").status_code == 401
    assert login(client).status_code == 429  # locked even with the right password
    assert login(client, email="nobody@example.com").json()["error"]["code"] in ("INVALID_CREDENTIALS", "LOGIN_LOCKED")


def test_expired_session_is_rejected(client):
    make_account()
    cookie = login(client).cookies.get(SHOP_COOKIE)
    for sess in get_store().shop_sessions.values():
        sess.expires_at = time.time() - 1
    c = TestClient(create_app(), cookies={SHOP_COOKIE: cookie})
    r = c.get("/api/v1/shop/overview")
    assert r.status_code == 401 and r.json()["error"]["code"] == "SESSION_EXPIRED"


def test_protected_routes_require_a_session(client):
    for path in ("/api/v1/shop/overview", "/api/v1/shop/jobs", "/api/v1/shop/hardware", "/api/v1/shop/payments", "/api/v1/shop/config"):
        assert client.get(path).status_code == 401


def test_cookie_writes_need_the_csrf_header(client):
    make_account()
    login(client)
    assert client.put("/api/v1/shop/availability", json={"acceptingOrders": False}).status_code == 403
    assert client.put("/api/v1/shop/availability", json={"acceptingOrders": False}, headers=CSRF).status_code == 200


def test_shop_ownership_is_enforced(client):
    make_account(shops=("shop_001",))
    login(client)
    r = client.get("/api/v1/shop/overview", headers={"x-inklink-shop": "shop_demo"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "SHOP_FORBIDDEN"
    assert client.put("/api/v1/shop-auth/active-shop", json={"shopId": "shop_demo"}, headers=CSRF).status_code == 403
    # A job in a shop the owner does not manage is not visible.
    jury = TestClient(create_app())
    jt = {"authorization": f"Bearer {jury.post('/api/v1/jury/sessions').json()['sessionToken']}"}
    demo_job = jury.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=jt).json()["jobId"]
    assert client.get(f"/api/v1/jobs/{demo_job}").status_code == 404


def test_multi_shop_account_can_switch(client):
    make_account(shops=("shop_001", "shop_demo"))
    body = login(client).json()
    assert [s["shopId"] for s in body["shops"]] == ["shop_001", "shop_demo"]
    r = client.put("/api/v1/shop-auth/active-shop", json={"shopId": "shop_demo"}, headers=CSRF)
    assert r.status_code == 200 and r.json()["activeShopId"] == "shop_demo"
    assert client.get("/api/v1/shop/overview").json()["shopId"] == "shop_demo"


# ───────────── jury isolation ─────────────

def jury_session(client) -> dict:
    s = client.post("/api/v1/jury/sessions").json()
    assert s["demoShopId"] == "shop_demo"
    return {"authorization": f"Bearer {s['sessionToken']}"}


def test_demo_shop_is_hidden_from_customers_and_jury_is_confined(client):
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    assert "shop_demo" not in [s["shopId"] for s in client.get("/api/v1/shops", headers=web).json()]
    assert client.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=web).status_code == 404
    jt = jury_session(client)
    assert [s["shopId"] for s in client.get("/api/v1/shops", headers=jt).json()] == ["shop_demo"]
    assert client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=jt).status_code == 404
    assert client.put("/api/v1/shop/config", json={"name": "x", "pricePerPageMonochrome": "1.00", "pricePerPageColor": "1.00"}, headers=jt).status_code == 403
    assert client.get("/api/v1/shop/overview", headers={**jt, "x-inklink-shop": "shop_001"}).status_code == 403


def test_jury_sessions_cannot_see_each_other(client):
    a, b = jury_session(client), jury_session(client)
    job = client.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=a).json()["jobId"]
    assert client.get(f"/api/v1/jobs/{job}", headers=b).status_code == 404
    assert [j["jobId"] for j in client.get("/api/v1/shop/jobs", headers=a).json()] == [job]
    assert client.get("/api/v1/shop/jobs", headers=b).json() == []


def _demo_job_ready(client, jt):
    """A demo job with a validated config, a quote and an execution request (as the operator would leave it)."""
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=jt).json()["jobId"]
    client.post("/api/v1/documents", headers=jt, data={"jobId": job_id}, files={"file": ("d.pdf", pdf(2), "application/pdf")})
    job = get_store().jobs[job_id]
    job.operator_config = {"printerId": "P", "paperSize": "A4", "colorMode": "monochrome", "copies": 2, "orientation": "portrait", "sides": "two-sided-long-edge"}
    job.config_validated = job.execution_requested = True
    assert client.post(f"/api/v1/jobs/{job_id}/quote", headers=jt).status_code == 200
    return job_id


def test_simulated_payment_and_execution_never_fake_settlement_or_print(client, monkeypatch):
    submitted = []

    async def submit(config, data):
        submitted.append(1)
        return {"ok": True}

    async def validate(config):
        return True, []

    monkeypatch.setattr(jobs_mod, "submit_print", submit)
    monkeypatch.setattr(jury_mod, "validate_print_config", validate)
    jt = jury_session(client)
    job_id = _demo_job_ready(client, jt)
    # Execution is refused until the gates are satisfied.
    assert client.post(f"/api/v1/jury/jobs/{job_id}/simulate-execution", headers=jt).status_code == 409
    assert client.post(f"/api/v1/jury/jobs/{job_id}/approve-quote", headers=jt).json()["approved"] is True
    view = client.post(f"/api/v1/jury/jobs/{job_id}/simulate-payment", headers=jt).json()
    assert view["paymentStatus"] != "settled" and view["simulation"]["payment"]["state"] == "SIMULATED_SETTLED"
    pay = client.get(f"/api/v1/jury/jobs/{job_id}/payment", headers=jt).json()
    assert pay["realPayment"] is None and "transactionId" not in json.dumps(pay["simulated"])
    # The jury approves as the demo shop; the backend still never submits a demo job.
    r = client.post(f"/api/v1/shop/jobs/{job_id}/approve", headers=jt).json()
    assert r["execution"]["state"] in ("pending", "demo_no_physical_print")
    view = client.post(f"/api/v1/jury/jobs/{job_id}/simulate-execution", headers=jt).json()
    assert view["simulation"]["execution"]["state"] == "SIMULATED_SUBMISSION"
    assert view["status"] != "completed" and submitted == []
    stages = {s["id"]: s for s in client.get(f"/api/v1/jury/jobs/{job_id}/lifecycle", headers=jt).json()["stages"]}
    assert stages["payment"]["mode"] == "simulated" and stages["completion"]["state"] == "not_applicable"


def test_demo_jobs_never_submit_even_with_a_real_settlement(monkeypatch):
    submitted = []

    async def submit(config, data):
        submitted.append(1)
        return {"ok": True}

    monkeypatch.setattr(jobs_mod, "submit_print", submit)
    client = TestClient(create_app())
    jt = jury_session(client)
    job_id = _demo_job_ready(client, jt)
    job = get_store().jobs[job_id]
    job.customer_approved_quote = job.shop_approved = True
    job.payment_status, job.status = "settled", "awaiting_execution"
    assert asyncio.run(jobs_mod.try_execute(job_id))["state"] == "demo_no_physical_print"
    assert submitted == []


def test_reset_removes_only_this_sessions_demo_jobs(client):
    a, b = jury_session(client), jury_session(client)
    ja = client.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=a).json()["jobId"]
    jb = client.post("/api/v1/jobs", json={"shopId": "shop_demo"}, headers=b).json()["jobId"]
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    real = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    assert client.post("/api/v1/jury/reset", headers=a).json()["removed"] == [ja]
    store = get_store()
    assert ja not in store.jobs and jb in store.jobs and real in store.jobs


def test_deterministic_fallback_is_demo_only():
    client = TestClient(create_app())
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    asyncio.run(jobs_mod.run_operator(job_id, "print it", mode="deterministic"))
    from app.events import history

    finished = [e for e in history(job_id) if e["type"] == "agent_finished"][-1]["payload"]
    assert finished["outcome"] == "unavailable" and "jury demo shop" in finished["message"]


# ───────────── devices ─────────────

def _with_device_token(monkeypatch, token="test-device-token"):
    s = dataclasses.replace(config_mod.get_settings(), device_token=token)
    monkeypatch.setattr(devices_mod, "get_settings", lambda: s)
    return {"authorization": f"Bearer {token}"}


def test_device_status_is_not_configured_without_a_token(client):
    assert devices_mod.device_views("shop_001")["status"] == "not_configured"
    assert client.post("/api/v1/devices/heartbeat", json={"deviceId": "esp1", "shopId": "shop_001"}).status_code == 503


def test_device_heartbeat_and_completion_rules(client, monkeypatch):
    dev = _with_device_token(monkeypatch)
    assert client.post("/api/v1/devices/heartbeat", json={"deviceId": "esp1", "shopId": "shop_001", "type": "esp32-s3", "state": "idle"},
                       headers={"authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/api/v1/devices/heartbeat", json={"deviceId": "esp1", "shopId": "shop_001", "type": "esp32-s3", "state": "idle"}, headers=dev).status_code == 200
    assert devices_mod.device_views("shop_001")["status"] == "online"
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    # A completion event for a job that was never submitted does not complete it.
    r = client.post("/api/v1/devices/events", json={"deviceId": "esp1", "jobId": job_id, "type": "print_completed"}, headers=dev).json()
    assert r["jobStatus"] == "created"
    get_store().jobs[job_id].status = "executing"
    r = client.post("/api/v1/devices/events", json={"deviceId": "esp1", "jobId": job_id, "type": "print_completed"}, headers=dev).json()
    assert r["jobStatus"] == "completed"


# ───────────── chain readiness ─────────────

def test_chain_is_not_configured_and_outbox_holds_hashes_only(client):
    st = chain.status()
    assert st["status"] == "not_configured" and "rpcUrl" in st["missing"]
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    client.post("/api/v1/documents", headers=web, data={"jobId": job_id}, files={"file": ("secret-name.pdf", pdf(1), "application/pdf")})
    recs = chain.records_for(job_id)
    assert {r["kind"] for r in recs} >= {"job_registered", "document_committed"}
    assert all(r["status"] == "pending_not_configured" for r in recs)
    assert "secret-name" not in json.dumps(recs)
    assert recs[-1]["data"]["documentSha256"].startswith("0x")
