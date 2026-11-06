"""End-to-end backend flow through the HTTP API.

External services (agent, printer adapter, payment agent) are replaced with
test stubs at the client boundary only; every rule under test is the
backend's own code.
"""

from __future__ import annotations

import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import jobs as jobs_mod
from app import routes_native
from app.events import history
from app.main import create_app
from app.security import callback_signature, hashscan_for
from app.store import get_store


def fresh_challenge() -> str:
    import secrets

    from app.security import b64url_encode

    return b64url_encode(secrets.token_bytes(32))

SHOP = {"authorization": "Bearer test-shop-admin-token"}
AGENT = {"authorization": "Bearer test-agent-service-token"}
CONFIG = {
    "printerId": "Office Laser",
    "paperSize": "A4",
    "colorMode": "monochrome",
    "copies": 2,
    "orientation": "portrait",
    "sides": "two-sided-long-edge",
}


def pdf_bytes(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


@pytest.fixture
def client():
    return TestClient(create_app())


@pytest.fixture
def printer(monkeypatch):
    """Stub the local printer adapter: validation passes, submissions are recorded."""
    calls = {"validate": 0, "submit": []}

    async def validate(config):
        calls["validate"] += 1
        return True, []

    async def submit(config, data):
        calls["submit"].append((config, len(data)))
        return {"httpStatus": 200, "ok": True, "state": "PRINT_SUBMITTED", "message": "Accepted by spooler.", "submissionId": "sub_1"}

    monkeypatch.setattr(jobs_mod, "validate_print_config", validate)
    monkeypatch.setattr(routes_native, "validate_print_config", validate)
    monkeypatch.setattr(jobs_mod, "submit_print", submit)
    return calls


def web_session(client) -> dict:
    s = client.post("/api/v1/web/sessions").json()
    assert s["customerReference"].startswith("web_")
    return {"authorization": f"Bearer {s['sessionToken']}"}


def new_job_with_pdf(client, hdr, pages=3) -> str:
    job = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=hdr).json()
    up = client.post(
        "/api/v1/documents",
        headers=hdr,
        data={"jobId": job["jobId"], "shopId": "shop_001", "customerId": "web_x"},
        files={"file": ("report.pdf", pdf_bytes(pages), "application/pdf")},
    )
    assert up.status_code == 200, up.text
    return job["jobId"]


def request_execution(client, job_id):
    return client.post(f"/api/v1/internal/jobs/{job_id}/execution-requests", json={"runId": "run_1", "config": CONFIG}, headers=AGENT)


def settle(client, job_id, payment_id, amount, *, tx="0.0.123@1700000000.000000001", secret="test-secret-0123456789abcdef", **override):
    body = {
        "paymentId": payment_id,
        "jobId": job_id,
        "payerAccount": "0.0.700001",
        "merchantAccountId": "0.0.900001",
        "network": "hedera:testnet",
        "asset": "HTS_USDC",
        "amount": amount,
        "transactionId": tx,
        "settlementTimestamp": "2026-11-05T12:00:00.000Z",
        "status": "settled",
        "hashscanUrl": hashscan_for(tx),
        **override,
    }
    raw = json.dumps(body).encode()
    ts = str(int(time.time()))
    return client.post(
        "/api/v1/internal/payment-settled",
        content=raw,
        headers={"content-type": "application/json", "x-inklink-timestamp": ts, "x-inklink-signature": callback_signature(secret, ts, raw)},
    )


# ───────────── sessions, shops, upload ─────────────

def test_web_session_shop_and_upload_counts_pdf_pages(client, monkeypatch):
    async def no_agent():
        return None

    monkeypatch.setattr("app.views.agent_health", no_agent)
    hdr = web_session(client)
    shops = client.get("/api/v1/shops", headers=hdr).json()
    assert shops[0]["shopId"] == "shop_001"
    assert shops[0]["agentAvailable"] is False  # agent unreachable is reported, not assumed
    job_id = new_job_with_pdf(client, hdr, pages=4)
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["document"]["pageCount"] == 4
    assert view["status"] == "created"


def test_unauthenticated_and_foreign_jobs_are_refused(client):
    assert client.get("/api/v1/shops").status_code == 401
    a, b = web_session(client), web_session(client)
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=a).json()["jobId"]
    r = client.get(f"/api/v1/jobs/{job_id}", headers=b)
    assert r.status_code == 404
    assert r.json() == {"success": False, "error": {"code": "JOB_NOT_FOUND", "message": "Unknown job."}}


def test_upload_rejects_non_pdf_bytes(client):
    hdr = web_session(client)
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=hdr).json()["jobId"]
    r = client.post("/api/v1/documents", headers=hdr, data={"jobId": job_id},
                    files={"file": ("evil.pdf", b"MZ not a pdf", "application/pdf")})
    assert r.status_code == 415


def test_quote_requires_a_validated_configuration(client):
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    r = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert r.status_code == 409


# ───────────── operator relay ─────────────

def test_operator_events_update_the_authoritative_job(client, monkeypatch):
    async def fake_stream(**kwargs):
        rid = kwargs["run_id"]
        yield {"type": "agent_started", "payload": {"runId": rid, "provider": "0g-private-computer", "model": "m", "trustMode": "private", "instruction": "x"}}
        yield {"type": "tool_started", "payload": {"runId": rid, "toolUseId": "t1", "tool": "set_copies", "input": {"copies": 2}}}
        yield {"type": "configuration_updated", "payload": {"runId": rid, "toolUseId": "t1", "field": "copies", "value": 2, "config": {**dict.fromkeys(CONFIG), "copies": 2}}}
        yield {"type": "tool_succeeded", "payload": {"runId": rid, "toolUseId": "t1", "tool": "set_copies", "result": {"ok": True}}}
        yield {"type": "tool_succeeded", "payload": {"runId": rid, "toolUseId": "t2", "tool": "validate_print_config", "result": {"ok": True}}}
        yield {"type": "agent_finished", "payload": {"runId": rid, "outcome": "completed", "message": "Configured 2 copies."}}

    async def granted(job, run_id, instruction):
        return {"baseUrl": "http://127.0.0.1:8000/api/v1/internal/inference/v1", "token": "igr_t", "model": "glm-5.3", "trustMode": "private"}

    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    monkeypatch.setattr(jobs_mod, "prepare_inference", granted)
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    with client:  # keep the loop alive for the background run
        r = client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "2 copies please"}, headers=hdr)
        assert r.status_code == 200
        for _ in range(50):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    job = get_store().jobs[job_id]
    assert job.operator_config["copies"] == 2
    assert job.config_validated is True
    types = [e["type"] for e in history(job_id)]
    assert ["agent_started", "tool_started", "configuration_updated", "tool_succeeded"] == [t for t in types if t in
            ("agent_started", "tool_started", "configuration_updated", "tool_succeeded")][:4]
    assert any(m["role"] == "agent" and "2 copies" in m["text"] for m in job.messages)


def test_agent_unreachable_is_reported_as_unavailable(client):
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    with client:
        client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "print it"}, headers=hdr)
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    finished = [e for e in history(job_id) if e["type"] == "agent_finished"]
    assert finished and finished[-1]["payload"]["outcome"] == "unavailable"


def test_engine_job_id_never_reaches_browsers(client):
    from app.events import publish

    publish("job_x", "document_processed", {"runId": "r", "engineJobId": "secret-internal", "totalReplacements": 1})
    assert "engineJobId" not in history("job_x")[-1]["payload"]


# ───────────── execution gate ─────────────

def test_execution_request_requires_the_service_token(client, printer):
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    r = client.post(f"/api/v1/internal/jobs/{job_id}/execution-requests", json={"runId": "r", "config": CONFIG},
                    headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_full_flow_prints_only_after_every_gate(client, printer, monkeypatch):
    async def fake_agent(method, path, body=None):
        if path == "/api/v1/payments":
            assert body["settlementAmount"] == "0.06"  # 3 pages x 2 copies x 2.00 INR = 12.00 INR @ 0.005
            assert body["resourceUrl"].endswith(f"/api/v1/jobs/{body['jobId']}/execute")
            return 200, {"paymentId": "payment_1", "status": "processing", "paymentMethod": "hedera_x402"}
        return 200, {"status": "processing"}

    monkeypatch.setattr(routes_native, "call_payment_agent", fake_agent)
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr, pages=3)

    # Agent asks to print: recorded, but nothing prints yet.
    r = request_execution(client, job_id).json()
    assert r["accepted"] is True and "customer_quote" in r["pending"]
    assert printer["submit"] == []

    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).json()
    assert quote["amount"] == "12.00" and quote["settlement"]["amount"] == "0.06"
    handoff = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()
    assert handoff["deepLink"].startswith("inklink://pay?handoff=")

    # Native app pairs, claims the handoff, pays.
    pair = client.post("/api/v1/pairing/verify", json={"challenge": fresh_challenge()}).json()
    native = {"authorization": f"Bearer {pair['sessionToken']}"}
    claim = client.post("/api/v1/payment-handoffs/claim", json={"handoffToken": handoff["handoffToken"]}, headers=native)
    assert claim.status_code == 200 and claim.json()["jobId"] == job_id
    pay = client.post("/api/v1/payments", json={"jobId": job_id, "quoteId": quote["quoteId"], "authorizationId": "auth_1",
                                                 "paymentMethod": "hedera_x402"}, headers=native)
    assert pay.status_code == 200, pay.text
    assert printer["submit"] == []

    # Tampered callbacks are refused and change nothing.
    assert settle(client, job_id, "payment_1", "0.06", secret="wrong").status_code == 401
    assert settle(client, job_id, "payment_1", "9.99").status_code == 422
    assert get_store().jobs[job_id].payment_status == "processing"

    # Verified settlement: awaiting_execution (never completed), still no print without the shop.
    assert settle(client, job_id, "payment_1", "0.06").status_code == 200
    job = get_store().jobs[job_id]
    assert job.status == "awaiting_execution" and job.payment_status == "settled"
    assert printer["submit"] == []
    assert settle(client, job_id, "payment_1", "0.06").json() == {"ok": True, "duplicate": True}

    # Shop approves -> exactly one submission -> executing (spooler accepted, not completed).
    r = client.post(f"/api/v1/shop/jobs/{job_id}/approve", headers=SHOP).json()
    assert r["execution"]["state"] == "submitted"
    assert len(printer["submit"]) == 1
    job = get_store().jobs[job_id]
    assert job.status == "executing" and job.device_status == "processing"
    assert any(e["type"] == "execution_authorized" for e in history(job_id))

    # Shop confirms the pages came out.
    assert client.post(f"/api/v1/shop/jobs/{job_id}/complete", headers=SHOP).json()["status"] == "completed"


def test_handoff_cannot_be_claimed_by_a_second_device(client, printer):
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    request_execution(client, job_id)
    client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    token = client.post(f"/api/v1/jobs/{job_id}/quote/approve", headers=hdr).json()["handoffToken"]
    devices = []
    for _ in range(2):
        p = client.post("/api/v1/pairing/verify", json={"challenge": fresh_challenge()}).json()
        devices.append({"authorization": f"Bearer {p['sessionToken']}"})
    assert client.post("/api/v1/payment-handoffs/claim", json={"handoffToken": token}, headers=devices[0]).status_code == 200
    assert client.post("/api/v1/payment-handoffs/claim", json={"handoffToken": token}, headers=devices[1]).status_code == 409


def test_payment_requirements_needs_backend_token(client, printer):
    hdr = web_session(client)
    job_id = new_job_with_pdf(client, hdr)
    request_execution(client, job_id)
    client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert client.get(f"/api/v1/internal/jobs/{job_id}/payment-requirements").status_code == 401
    r = client.get(f"/api/v1/internal/jobs/{job_id}/payment-requirements", headers={"authorization": "Bearer test-backend-api-token"})
    assert r.status_code == 200 and r.json()["merchantAccountId"] == "0.0.900001"


def test_event_tickets_are_single_use(client):
    hdr = web_session(client)
    job_id = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=hdr).json()["jobId"]
    ticket = client.post(f"/api/v1/jobs/{job_id}/tickets", headers=hdr).json()["ticket"]
    from app.auth import redeem_event_ticket

    redeem_event_ticket(ticket, job_id)
    with pytest.raises(Exception):
        redeem_event_ticket(ticket, job_id)


def test_shop_endpoints_require_the_shop_token(client):
    hdr = web_session(client)
    assert client.get("/api/v1/shop/jobs", headers=hdr).status_code == 403
    assert client.get("/api/v1/shop/jobs", headers=SHOP).status_code == 200


def test_closed_shop_refuses_new_jobs(client):
    client.put("/api/v1/shop/availability", json={"acceptingOrders": False}, headers=SHOP)
    hdr = web_session(client)
    r = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=hdr)
    assert r.status_code == 503 and r.json()["error"]["code"] == "SHOP_UNAVAILABLE"
