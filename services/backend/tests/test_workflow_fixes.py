"""End-to-end integration fixes: printer selection, workflow gating, payment retry and the
customer's payment view. External services are stubbed only at their client boundary."""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import jobs as jobs_mod
from app import routes_native, routes_shop
from app.clients import ServiceError
from app.main import create_app
from app.store import get_store
from tests.test_flow import SHOP, new_job_with_pdf, printer, request_execution, settle, web_session  # noqa: F401

DISCOVERY = {"ok": True, "defaultPrinter": "HP Office", "printers": [
    {"id": "HP Office", "name": "HP Office", "status": "online", "isDefault": True},
    {"id": "Canon Colour", "name": "Canon Colour", "status": "online", "isDefault": False},
    {"id": "Old Laser", "name": "Old Laser", "status": "offline", "isDefault": False},
]}
TX = "0.0.7162784@1793967953.517115964"


@pytest.fixture
def client():
    return TestClient(create_app())


def discovery(monkeypatch, body=DISCOVERY, error: ServiceError | None = None):
    async def fake():
        if error:
            raise error
        return body

    monkeypatch.setattr(jobs_mod, "list_printers", fake)
    monkeypatch.setattr(routes_shop, "list_printers", fake)


# ───────────── printer selection ─────────────

def test_default_online_printer_prefers_the_shops_choice_and_never_invents():
    assert jobs_mod.default_online_printer(DISCOVERY) == "HP Office"
    assert jobs_mod.default_online_printer(DISCOVERY, "Canon Colour") == "Canon Colour"
    assert jobs_mod.default_online_printer(DISCOVERY, "Old Laser") == "HP Office"     # chosen but offline
    assert jobs_mod.default_online_printer({"printers": []}) is None
    assert jobs_mod.default_online_printer({"printers": [{"id": "x", "status": "offline"}]}) is None


def test_shop_picks_only_a_discovered_printer(client, monkeypatch):
    discovery(monkeypatch)
    base = {"name": "Shop", "pricePerPageMonochrome": "2.00", "pricePerPageColor": "10.00"}
    bad = client.put("/api/v1/shop/config", headers=SHOP, json={**base, "defaultPrinterId": "Typed In Printer"})
    assert bad.status_code == 400
    ok = client.put("/api/v1/shop/config", headers=SHOP, json={**base, "defaultPrinterId": "Canon Colour"})
    assert ok.status_code == 200 and ok.json()["defaultPrinterId"] == "Canon Colour"
    # Saving other settings without the field keeps the choice.
    assert client.put("/api/v1/shop/config", headers=SHOP, json=base).json()["defaultPrinterId"] == "Canon Colour"
    assert client.put("/api/v1/shop/config", headers=SHOP, json={**base, "defaultPrinterId": None}).json()["defaultPrinterId"] is None


def test_shop_cannot_pick_a_printer_while_the_gateway_is_offline(client, monkeypatch):
    discovery(monkeypatch, error=ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The shop gateway is not connected to the backend."))
    r = client.put("/api/v1/shop/config", headers=SHOP, json={"name": "Shop", "pricePerPageMonochrome": "2.00",
                                                               "pricePerPageColor": "10.00", "defaultPrinterId": "HP Office"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "PRINTER_ADAPTER_UNREACHABLE"


def test_operator_run_gets_the_shops_real_printer(client, monkeypatch):
    discovery(monkeypatch)
    get_store().shops.setdefault("shop_001", {})["defaultPrinterId"] = "Canon Colour"
    seen = {}

    async def fake_stream(**kwargs):
        seen["current"] = kwargs["current"]
        yield {"type": "agent_finished", "payload": {"runId": kwargs["run_id"], "outcome": "completed", "message": "ok"}}

    async def granted(job, run_id, instruction):
        return {"baseUrl": "http://127.0.0.1:8000/api/v1/internal/inference/v1", "token": "igr_t", "model": "glm-5.3", "trustMode": "private"}

    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    monkeypatch.setattr(jobs_mod, "prepare_inference", granted)
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    with client:
        assert client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "2 copies"}, headers=hdr).status_code == 200
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    assert seen["current"]["printerId"] == "Canon Colour"


def test_gateway_offline_is_explained_to_the_customer_and_no_printer_is_invented(client, monkeypatch):
    discovery(monkeypatch, error=ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The shop gateway is not connected to the backend."))
    seen = {}

    async def fake_stream(**kwargs):
        seen["current"] = kwargs["current"]
        yield {"type": "agent_finished", "payload": {"runId": kwargs["run_id"], "outcome": "completed", "message": "ok"}}

    async def granted(job, run_id, instruction):
        return {"baseUrl": "x", "token": "igr_t", "model": "glm-5.3", "trustMode": "private"}

    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    monkeypatch.setattr(jobs_mod, "prepare_inference", granted)
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    with client:
        client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "print it"}, headers=hdr)
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    assert "printerId" not in seen["current"]
    texts = [m["text"] for m in get_store().jobs[job_id].messages]
    assert any("shop gateway" in t and "Shop configuration" in t for t in texts)


# ───────────── workflow gating and payment retry ─────────────

def _quoted_job(client, hdr):
    job_id = new_job_with_pdf(client, hdr, pages=3)
    request_execution(client, job_id)
    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert quote.status_code == 200, quote.text
    return job_id, quote.json()


def _pay(client, monkeypatch, job_id, quote_id, handoff_token, pid="payment_1"):
    async def fake_agent(method, path, body=None):
        if path == "/api/v1/payments":
            return 200, {"paymentId": pid, "status": "processing", "paymentMethod": "hedera_x402"}
        return 200, {"status": "processing"}

    monkeypatch.setattr(routes_native, "call_payment_agent", fake_agent)
    pair = client.post("/api/v1/pairing/verify", json={"challenge": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}).json()
    native = {"authorization": f"Bearer {pair['sessionToken']}"}
    client.post("/api/v1/payment-handoffs/claim", json={"handoffToken": handoff_token}, headers=native)
    return client.post("/api/v1/payments", json={"jobId": job_id, "quoteId": quote_id, "authorizationId": "auth_1",
                                                 "paymentMethod": "hedera_x402"}, headers=native)


def test_no_quote_while_the_edited_document_awaits_review(client, printer):  # noqa: F811
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    request_execution(client, job_id)
    job = get_store().jobs[job_id]
    job.document.edited_path = job.document.original_path
    job.document.edit_status = "pending_review"
    r = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert r.status_code == 409 and "Review the edited document" in r.json()["error"]["message"]


def test_payment_in_flight_blocks_requote_reapproval_and_new_instructions(client, printer, monkeypatch):  # noqa: F811
    hdr = web_session(client)
    job_id, quote = _quoted_job(client, hdr)
    handoff = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()
    assert _pay(client, monkeypatch, job_id, quote["quoteId"], handoff["handoffToken"]).status_code == 200
    assert client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).status_code == 409
    assert client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).status_code == 409
    assert client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "colour"}, headers=hdr).status_code == 409
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["payment"]["verificationStatus"] == "pending" and view["payment"]["transactionId"] is None
    assert view["payment"]["amount"] == quote["settlement"]["amount"]


def test_failed_payment_can_be_retried(client, printer, monkeypatch):  # noqa: F811
    hdr = web_session(client)
    job_id, quote = _quoted_job(client, hdr)
    handoff = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()
    assert _pay(client, monkeypatch, job_id, quote["quoteId"], handoff["handoffToken"]).status_code == 200

    async def failed(method, path, body=None):
        return 200, {"status": "failed"}

    monkeypatch.setattr(routes_native, "call_payment_agent", failed)
    assert asyncio.run(routes_native.refresh_payment_from_agent("payment_1")) == "failed"
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["paymentStatus"] == "failed" and view["payment"]["verificationStatus"] == "failed"

    # Same quote, approved again, second attempt settles for real (signed callback).
    handoff2 = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr)
    assert handoff2.status_code == 200
    assert _pay(client, monkeypatch, job_id, quote["quoteId"], handoff2.json()["handoffToken"], pid="payment_2").status_code == 200
    assert settle(client, job_id, "payment_2", quote["settlement"]["amount"], tx=TX).status_code == 200
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["status"] == "awaiting_execution"
    assert view["payment"]["verificationStatus"] == "verified" and view["payment"]["transactionId"] == TX
    assert view["payment"]["hashscanUrl"].startswith("https://hashscan.io/testnet/transaction/")


def test_a_new_quote_after_a_failed_payment_starts_clean(client, printer, monkeypatch):  # noqa: F811
    hdr = web_session(client)
    job_id, quote = _quoted_job(client, hdr)
    handoff = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()
    _pay(client, monkeypatch, job_id, quote["quoteId"], handoff["handoffToken"])
    job = get_store().jobs[job_id]
    job.payment_status = "expired"
    get_store().payments["payment_1"].status = "expired"
    requote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert requote.status_code == 200
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["paymentStatus"] == "created" and view["payment"] is None
    assert get_store().payments["payment_1"].status == "expired"   # history is kept
