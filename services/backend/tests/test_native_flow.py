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
