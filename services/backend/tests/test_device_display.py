"""GET /api/v1/devices/display: read-only device view built from the backend's own records.

Payments reach `verified` here only through the same HMAC-signed settlement callback the
payment agent sends after its mirror-node check (tests.test_flow.settle). Nothing the device
sends can change payment or execution state."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import config
from app import routes_native
from app.main import create_app
from app.store import get_store
from tests.test_flow import SHOP, new_job_with_pdf, printer, request_execution, settle, web_session  # noqa: F401

DEVICE = {"authorization": "Bearer test-device-token"}
TX = "0.0.7162784@1793967953.517115964"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DEVICE_TOKEN", "test-device-token")
    config.get_settings.cache_clear()
    yield TestClient(create_app())
    config.get_settings.cache_clear()


def heartbeat(client, device_id="esp32-cirkit-01", shop_id="shop_001"):
    r = client.post("/api/v1/devices/heartbeat", headers=DEVICE,
                    json={"deviceId": device_id, "shopId": shop_id, "type": "esp32-s3", "state": "idle"})
    assert r.status_code == 200, r.text


def display(client, device_id="esp32-cirkit-01", headers=DEVICE):
    return client.get("/api/v1/devices/display", params={"deviceId": device_id}, headers=headers)


@pytest.fixture
def paying(client, printer, monkeypatch):  # noqa: F811
    """A real job up to an initiated payment (payment agent stubbed at its HTTP boundary)."""

    async def fake_agent(method, path, body=None):
        if path == "/api/v1/payments":
            return 200, {"paymentId": "payment_1", "status": "processing", "paymentMethod": "hedera_x402"}
        return 200, {"status": "processing"}

    monkeypatch.setattr(routes_native, "call_payment_agent", fake_agent)
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr, pages=3)
    request_execution(client, job_id)
    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).json()
    handoff = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()
    pair = client.post("/api/v1/pairing/verify", json={"challenge": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}).json()
    native = {"authorization": f"Bearer {pair['sessionToken']}"}
    client.post("/api/v1/payment-handoffs/claim", json={"handoffToken": handoff["handoffToken"]}, headers=native)

    def pay():
        r = client.post("/api/v1/payments", json={"jobId": job_id, "quoteId": quote["quoteId"], "authorizationId": "auth_1",
                                                  "paymentMethod": "hedera_x402"}, headers=native)
        assert r.status_code == 200, r.text

    return job_id, pay, monkeypatch


# ───────────── authentication ─────────────

def test_missing_and_invalid_token(client):
    heartbeat(client)
    assert display(client, headers={}).status_code == 401
    assert display(client, headers={"authorization": "Bearer wrong"}).status_code == 401
    assert display(client).status_code == 200


def test_unknown_device_and_bad_device_id(client):
    assert display(client, device_id="never-seen").status_code == 404
    assert display(client, device_id="bad id!").status_code == 400


def test_demo_shop_device_is_refused(client):
    heartbeat(client, device_id="esp32-demo", shop_id="shop_demo")
    assert display(client, device_id="esp32-demo").status_code == 409


# ───────────── states ─────────────

def test_no_active_job_is_a_valid_empty_state(client):
    heartbeat(client)
    body = display(client).json()
    assert body["ok"] is True
    assert body["active_job"] is None and body["jobs"] == []
    assert body["device"]["device_id"] == "esp32-cirkit-01" and body["device"]["status"] == "online"
    assert body["shop"]["shop_id"] == "shop_001"
    assert set(body["printer"]) == {"mode", "gateway_connected"}


def test_active_job_without_payment(client):
    heartbeat(client)
    job_id = new_job_with_pdf(client, web_session(client))
    job = display(client).json()["active_job"]
    assert job["job_id"] == job_id and job["job_state"] == "created"
    assert job["verification_status"] == "not_started"
    assert job["transaction_id"] is None and job["execution_authorized"] is False
    # Status only: no file name or customer data reaches the device.
    assert "filename" not in job and "owner" not in job


def test_pending_then_real_verified_settlement_then_execution(client, paying):
    job_id, pay, _ = paying
    heartbeat(client)
    job = display(client).json()["active_job"]
    assert job["job_state"] == "awaiting_payment"
    assert job["verification_status"] == "not_started" and job["amount"] == "0.06"   # quoted, not yet paid

    pay()
    job = display(client).json()["active_job"]
    assert job["payment_status"] == "processing" and job["verification_status"] == "pending"
    assert job["transaction_id"] is None and job["verified_at"] is None

    # A tampered callback changes nothing.
    assert settle(client, job_id, "payment_1", "0.06", tx=TX, secret="wrong").status_code == 401
    assert display(client).json()["active_job"]["verification_status"] == "pending"

    # The signed settlement callback (sent by the agent after its mirror-node check).
    assert settle(client, job_id, "payment_1", "0.06", tx=TX).status_code == 200
    job = display(client).json()["active_job"]
    assert job["verification_status"] == "verified" and job["payment_status"] == "settled"
    assert job["transaction_id"] == TX
    assert job["amount"] == "0.06" and job["asset"] == "HTS_USDC" and job["network"] == "hedera:testnet"
    assert job["hashscan_url"].startswith("https://hashscan.io/testnet/transaction/")
    assert job["verified_at"] and job["settled_at"] == "2026-11-05T12:00:00.000Z"
    assert job["execution_authorized"] is False   # paid is not authorized: the shop has not approved

    # Only the backend authorizes execution (shop approval -> submission -> execution_authorized).
    assert client.post(f"/api/v1/shop/jobs/{job_id}/approve", headers=SHOP).status_code == 200
    job = display(client).json()["active_job"]
    assert job["execution_authorized"] is True and job["job_state"] == "executing"


@pytest.mark.parametrize("outcome", ["failed", "expired"])
def test_failed_and_expired_payments(client, paying, outcome):
    job_id, pay, monkeypatch = paying
    pay()

    async def agent_says(method, path, body=None):
        return 200, {"status": outcome}

    monkeypatch.setattr(routes_native, "call_payment_agent", agent_says)
    assert asyncio.run(routes_native.refresh_payment_from_agent("payment_1")) == outcome
    heartbeat(client)
    job = display(client).json()["active_job"]
    assert job["payment_status"] == outcome and job["verification_status"] == outcome
    assert job["transaction_id"] is None and job["execution_authorized"] is False


def test_device_events_cannot_fake_payment_or_authorization(client, paying):
    job_id, pay, _ = paying
    pay()
    heartbeat(client)
    r = client.post("/api/v1/devices/events", headers=DEVICE,
                    json={"deviceId": "esp32-cirkit-01", "jobId": job_id, "type": "print_completed",
                          "detail": "settled 0.0.1@1.2"})
    assert r.status_code == 200
    job = display(client).json()["active_job"]
    assert job["verification_status"] == "pending" and job["transaction_id"] is None
    assert job["execution_authorized"] is False
    assert get_store().jobs[job_id].status == "awaiting_payment"   # completion needs a backend-submitted job
