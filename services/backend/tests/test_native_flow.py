"""Native app as a full customer: create a job, upload, instruct the print operator,
review the edited document and request a quote, with a stable device identity."""

from __future__ import annotations

import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app import jobs as jobs_mod
from app.main import create_app
from app.security import b64url_encode
from app.store import get_store
from tests.test_flow import CONFIG, new_job_with_pdf, pdf_bytes

CHALLENGE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"


@pytest.fixture
def client():
    return TestClient(create_app())


def device():
    key = Ed25519PrivateKey.generate()
    pub = b64url_encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    return key, pub


def pair(client, key=None, pub=None, challenge=CHALLENGE):
    body = {"challenge": challenge}
    if key is not None:
        body |= {"devicePublicKey": pub, "deviceSignature": b64url_encode(key.sign(challenge.encode()))}
    return client.post("/api/v1/pairing/verify", json=body)


def native(res) -> dict:
    assert res.status_code == 200, res.text
    return {"authorization": f"Bearer {res.json()['sessionToken']}"}


def test_device_key_gives_a_stable_identity_across_pairings(client):
    key, pub = device()
    first = pair(client, key, pub)
    second = pair(client, key, pub, challenge="ZmVkY2JhOTg3NjU0MzIxMDAxMjM0NTY3ODlhYmNkZWY")
    assert first.json()["customerReference"] == second.json()["customerReference"]
    assert first.json()["customerReference"].startswith("native_dev_")
    job_id = new_job_with_pdf(client, native(first))
    # A renewed session (new pairing) still reaches the job it created.
    assert client.get(f"/api/v1/jobs/{job_id}", headers=native(second)).status_code == 200
    # Another device does not.
    other_key, other_pub = device()
    assert client.get(f"/api/v1/jobs/{job_id}", headers=native(pair(client, other_key, other_pub))).status_code == 404


def test_bad_device_signature_is_refused_and_legacy_pairing_still_works(client):
    key, pub = device()
    other, _ = device()
    bad = client.post("/api/v1/pairing/verify", json={
        "challenge": CHALLENGE, "devicePublicKey": pub,
        "deviceSignature": b64url_encode(other.sign(CHALLENGE.encode()))})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "SIGNATURE_INVALID"
    legacy = pair(client)
    assert legacy.status_code == 200 and "customerReference" not in legacy.json()


def test_native_app_uploads_instructs_agent_reviews_edit_and_quotes(client, monkeypatch):
    edited = pdf_bytes(2)

    async def fake_stream(**kwargs):
        rid = kwargs["run_id"]
        assert kwargs["instruction"] == "Replace Monday with Tuesday, 2 copies"
        yield {"type": "agent_started", "payload": {"runId": rid, "provider": "0g-private-computer", "model": "m",
                                                    "trustMode": "private", "instruction": kwargs["instruction"]}}
        yield {"type": "document_processed", "payload": {"runId": rid, "engineJobId": "eng_1", "totalReplacements": 1}}
        yield {"type": "configuration_updated", "payload": {"runId": rid, "toolUseId": "t1", "field": "copies", "value": 2,
                                                            "config": {**CONFIG, "copies": 2}}}
        yield {"type": "tool_succeeded", "payload": {"runId": rid, "toolUseId": "t2", "tool": "validate_print_config",
                                                     "result": {"ok": True}}}
        yield {"type": "agent_finished", "payload": {"runId": rid, "outcome": "completed", "message": "Edited and set 2 copies."}}

    async def granted(job, run_id, instruction):
        return {"baseUrl": "http://127.0.0.1:8000/api/v1/internal/inference/v1", "token": "igr_t", "model": "glm-5.3",
                "trustMode": "private"}

    async def engine_output(engine_job_id):
        assert engine_job_id == "eng_1"
        return edited

    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    monkeypatch.setattr(jobs_mod, "prepare_inference", granted)
    monkeypatch.setattr(jobs_mod, "fetch_engine_output", engine_output)

    key, pub = device()
    hdr = native(pair(client, key, pub))
    job_id = new_job_with_pdf(client, hdr, pages=3)
    with client:
        r = client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "Replace Monday with Tuesday, 2 copies"}, headers=hdr)
        assert r.status_code == 200, r.text
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)

    job = get_store().jobs[job_id]
    assert job.document.edit_status == "pending_review"
    assert any(m["role"] == "agent" for m in client.get(f"/api/v1/jobs/{job_id}/messages", headers=hdr).json())
    # Live events and the preview work for the app as well (ticket-based).
    assert client.post(f"/api/v1/jobs/{job_id}/tickets", headers=hdr).status_code == 200

    approved = client.post(f"/api/v1/jobs/{job_id}/document/approve", headers=hdr)
    assert approved.status_code == 200, approved.text
    assert get_store().jobs[job_id].document.edit_status == "approved"
    assert get_store().jobs[job_id].document.page_count == 2  # priced on the edited document

    q = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert q.status_code == 200, q.text


def test_native_cannot_touch_another_customers_job(client):
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job_id = new_job_with_pdf(client, web)
    key, pub = device()
    hdr = native(pair(client, key, pub))
    assert client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "hi"}, headers=hdr).status_code == 404
    assert client.post(f"/api/v1/jobs/{job_id}/document/approve", headers=hdr).status_code == 404


# ───────────── native-only flow: the app's print options are the configuration ─────────────

from tests.test_flow import SHOP, printer, settle  # noqa: E402,F401  (fixture + helpers)

from app import routes_native  # noqa: E402

APP_OPTIONS = {"copies": 2, "pageRange": "all", "colourMode": "colour", "paperSize": "Letter",
               "orientation": "landscape", "sides": "two-sided-short-edge"}


def native_job(client, hdr, options=APP_OPTIONS, pages=3) -> str:
    """Exactly what apps/mobile does: create the job with its printConfig, then upload."""
    job = client.post("/api/v1/jobs", json={"shopId": "shop_001", "printConfig": options}, headers=hdr)
    assert job.status_code == 200, job.text
    job_id = job.json()["jobId"]
    up = client.post("/api/v1/documents", headers={**hdr, "Idempotency-Key": f"{job_id}:a.pdf"},
                     data={"jobId": job_id, "shopId": "shop_001", "customerId": "native_dev_x"},
                     files={"file": ("a.pdf", pdf_bytes(pages), "application/pdf")})
    assert up.status_code == 200, up.text
    return job_id


def test_native_job_is_quoted_from_the_options_chosen_in_the_app(client):
    key, pub = device()
    hdr = native(pair(client, key, pub))
    job_id = native_job(client, hdr)

    q = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr)
    assert q.status_code == 200, q.text
    # 3 pages x 2 copies x 10.00 INR (colour) = 60.00 INR @ 0.005 USDC/INR
    assert q.json()["amount"] == "60.00" and q.json()["settlement"]["amount"] == "0.30"
    assert get_store().jobs[job_id].operator_config == {
        "printerId": None, "paperSize": "Letter", "colorMode": "color", "copies": 2,
        "orientation": "landscape", "sides": "two-sided-short-edge",
    }

    # Unset options fall back to the shop defaults (monochrome, A4, portrait, one-sided).
    plain = native_job(client, hdr, options={"copies": 1}, pages=2)
    assert client.post(f"/api/v1/jobs/{plain}/quote", headers=hdr).json()["amount"] == "4.00"
    assert get_store().jobs[plain].operator_config == {
        "printerId": None, "paperSize": "A4", "colorMode": "monochrome", "copies": 1,
        "orientation": "portrait", "sides": "one-sided",
    }


def test_native_print_options_outside_the_printer_vocabulary_are_refused(client):
    hdr = native(pair(client, *device()))
    for bad in ({"colourMode": "sepia"}, {"paperSize": "A3"}, {"sides": "duplex"}, {"orientation": "up"}, {"copies": 1000}):
        r = client.post("/api/v1/jobs", json={"shopId": "shop_001", "printConfig": {"copies": 1, **bad}}, headers=hdr)
        assert r.status_code == 400, (bad, r.text)


def test_web_jobs_still_need_the_print_operator_to_validate(client):
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job_id = new_job_with_pdf(client, web)
    assert client.post(f"/api/v1/jobs/{job_id}/quote", headers=web).status_code == 409


def test_native_job_pays_then_prints_on_the_default_printer_after_shop_approval(client, printer, monkeypatch):
    async def fake_agent(method, path, body=None):
        assert path == "/api/v1/payments" and body["settlementAmount"] == "0.30"
        return 200, {"paymentId": "payment_n1", "status": "processing", "paymentMethod": "hedera_x402"}

    async def printers():
        return {"ok": True, "defaultPrinter": "Front Desk",
                "printers": [{"id": "Back Office", "status": "online", "isDefault": False},
                             {"id": "Front Desk", "status": "online", "isDefault": True}]}

    monkeypatch.setattr(routes_native, "call_payment_agent", fake_agent)
    monkeypatch.setattr(jobs_mod, "list_printers", printers)
    hdr = native(pair(client, *device()))
    job_id = native_job(client, hdr)
    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).json()

    pay = client.post("/api/v1/payments", json={"jobId": job_id, "quoteId": quote["quoteId"], "authorizationId": "auth_1",
                                                 "paymentMethod": "hedera_x402"}, headers=hdr)
    assert pay.status_code == 200, pay.text
    assert get_store().jobs[job_id].execution_requested is False  # not before a verified payment

    assert settle(client, job_id, "payment_n1", "0.30").status_code == 200
    job = get_store().jobs[job_id]
    assert job.status == "awaiting_execution" and job.execution_requested is True
    assert printer["submit"] == []  # the shop has not approved yet

    r = client.post(f"/api/v1/shop/jobs/{job_id}/approve", headers=SHOP).json()
    assert r["execution"]["state"] == "submitted", r
    assert len(printer["submit"]) == 1
    config, _ = printer["submit"][0]
    assert config == {"printerId": "Front Desk", "paperSize": "Letter", "colorMode": "color", "copies": 2,
                      "orientation": "landscape", "sides": "two-sided-short-edge"}
    assert get_store().jobs[job_id].status == "executing"


def test_native_job_waits_when_no_printer_is_online(client, printer, monkeypatch):
    async def fake_agent(method, path, body=None):
        return 200, {"paymentId": "payment_n2", "status": "processing", "paymentMethod": "hedera_x402"}

    async def printers():
        return {"ok": True, "defaultPrinter": "Front Desk", "printers": [{"id": "Front Desk", "status": "offline", "isDefault": True}]}

    monkeypatch.setattr(routes_native, "call_payment_agent", fake_agent)
    monkeypatch.setattr(jobs_mod, "list_printers", printers)
    hdr = native(pair(client, *device()))
    job_id = native_job(client, hdr)
    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).json()
    client.post("/api/v1/payments", json={"jobId": job_id, "quoteId": quote["quoteId"], "authorizationId": "auth_1",
                                          "paymentMethod": "hedera_x402"}, headers=hdr)
    assert settle(client, job_id, "payment_n2", quote["settlement"]["amount"]).status_code == 200

    r = client.post(f"/api/v1/shop/jobs/{job_id}/approve", headers=SHOP).json()
    assert r["execution"]["state"] == "blocked" and r["execution"]["pending"] == ["printer"]
    assert printer["submit"] == []
    assert get_store().jobs[job_id].operator_config["printerId"] is None  # never invented
