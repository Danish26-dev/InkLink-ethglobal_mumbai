"""0G three-key provider layer, sensitivity policy and inference gateway.

The 0G router is replaced by an httpx MockTransport at the HTTP boundary, so
the real request-building, header, key-selection and error code runs.
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import time
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import config as config_mod
from app import inference as inference_mod
from app import jobs as jobs_mod
from app import sensitivity as sens_mod
from app import views as views_mod
from app import zerog
from app.auth import is_local_request
from app.events import history
from app.main import create_app
from app.store import get_store

KEYS = {"standard": "sk-std-SENTINEL-1111", "verified": "sk-ver-SENTINEL-2222", "private": "sk-prv-SENTINEL-3333"}
CATALOG = {
    "data": [
        {"id": "glm-5.3", "verifiability": "TeeML", "supported_parameters": ["tools", "temperature"]},
        {"id": "teetls-model", "verifiability": "TeeTLS", "supported_parameters": ["tools"]},
        {"id": "gpt-4.1", "verifiability": "", "supported_parameters": ["tools"]},
        {"id": "laya", "verifiability": "TeeML", "supported_parameters": []},
    ]
}


# What 0G publishes at GET /v1/providers (shape taken from the live router).
PROVIDERS = {
    "data": [
        {"address": "0xprovider", "model_id": "glm-5.3", "canonical_id": "glm-5.3", "trust_mode": "private",
         "verifiability": "TeeML", "tee_attested": True, "tee_type": "TDX", "tee_verifier": "dstack"},
        {"address": "0xtls", "model_id": "glm-5.3", "canonical_id": "glm-5.3", "trust_mode": "verified",
         "verifiability": "TeeTLS", "tee_attested": True, "tee_type": "TDX", "tee_verifier": "dstack"},
    ]
}


def completion(tee: bool | None = True, tool_call: bool = False, provider: str = "0xprovider") -> dict:
    msg: dict = {"role": "assistant", "content": "ok"}
    if tool_call:
        msg = {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "set_copies", "arguments": "{\"copies\": 2}"}}]}
    trace = {"request_id": "req_1", "provider": provider}
    if tee is not None:
        trace["tee_verified"] = tee
    return {"id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "glm-5.3",
            "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tool_call else "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}, "x_0g_trace": trace}


@pytest.fixture
def settings(monkeypatch):
    """Apply settings overrides to every module that reads them."""

    def apply(**overrides):
        s = dataclasses.replace(config_mod.get_settings(), **overrides)
        for mod in (zerog, sens_mod, jobs_mod, views_mod, inference_mod):
            if hasattr(mod, "get_settings"):
                monkeypatch.setattr(mod, "get_settings", lambda s=s: s)
        monkeypatch.setattr("app.main.get_settings", lambda s=s: s)
        return s

    zerog._catalog.update(at=0.0, models={})
    zerog._providers.update(at=0.0, by_address={})
    return apply


@pytest.fixture
def router(monkeypatch):
    """Fake 0G router. Records every request; responses are scripted per test."""
    state = {"calls": [], "reply": lambda req: httpx.Response(200, json=completion())}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/models"):
            return httpx.Response(200, json=CATALOG)
        if req.url.path.endswith("/providers"):
            return httpx.Response(200, json=PROVIDERS)
        body = json.loads(req.content or b"{}")
        state["calls"].append({"auth": req.headers.get("authorization"), "mode": req.headers.get("x-0g-provider-trust-mode"), "body": body})
        return state["reply"](req)

    real = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(zerog.httpx, "AsyncClient", client)

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(zerog, "_sleep", no_wait)  # retry back-off is instant in tests
    return state


def run(coro):
    return asyncio.run(coro)


# ───────────── 1-3. key selection per trust mode ─────────────

@pytest.mark.parametrize("mode", ["standard", "verified", "private"])
def test_each_mode_uses_its_own_key_and_header(settings, router, mode):
    settings(zero_g_keys=KEYS)
    result = run(zerog.chat_completion(mode, "glm-5.3", {"messages": [{"role": "user", "content": "hi"}]}))
    call = router["calls"][-1]
    assert call["auth"] == f"Bearer {KEYS[mode]}"
    assert call["mode"] == mode
    assert call["body"]["model"] == "glm-5.3" and call["body"]["stream"] is False
    assert ("verify_tee" in call["body"]) is (mode != "standard")
    assert result.trust_mode == mode


# ───────────── 4. sensitive documents always need private ─────────────

@pytest.mark.parametrize("text", [
    "Name: A. Kumar, PAN ABCDE1234F, Aadhaar 2345 6789 0123",
    "Bank statement for account number 001234567890, IFSC HDFC0001234",
    "CONFIDENTIAL — Non-disclosure agreement between the parties",
    "Patient name: X. Diagnosis: Y. Prescription follows.",
])
def test_sensitive_content_requires_private_even_if_standard_requested(settings, text):
    settings()
    doc = sens_mod.classify_text(text)
    assert doc["level"] == "sensitive"
    sel = sens_mod.select_trust_mode(doc_class=doc, instruction="print 2 copies", customer_requested="standard", shop_minimum=None)
    assert sel["requiredTrustMode"] == "private" and sel["effectiveTrustMode"] == "private"


def test_unclassified_document_defaults_to_private(settings):
    settings()
    doc = sens_mod.classify_text(None)  # e.g. scanned PDF without text
    sel = sens_mod.select_trust_mode(doc_class=doc, instruction="print it", customer_requested=None, shop_minimum=None)
    assert doc["level"] == "unclassified" and sel["effectiveTrustMode"] == "private"


def test_non_sensitive_document_uses_standard_and_classification_holds_no_content(settings):
    settings()
    doc = sens_mod.classify_text("Annual school sports day schedule. Races start at nine in the morning.")
    assert doc["level"] == "non_sensitive"
    sel = sens_mod.select_trust_mode(doc_class=doc, instruction="2 copies black and white", customer_requested=None, shop_minimum=None)
    assert sel["effectiveTrustMode"] == "standard"
    leaky = sens_mod.classify_text("PAN ABCDE1234F")
    assert "ABCDE1234F" not in json.dumps(leaky)


def test_provenance_request_selects_verified(settings):
    settings()
    doc = sens_mod.classify_text("Public notice about the community library opening hours this week.")
    sel = sens_mod.select_trust_mode(doc_class=doc, instruction="please use verifiable execution", customer_requested=None, shop_minimum=None)
    assert sel["effectiveTrustMode"] == "verified"


# ───────────── 5. no downgrade ─────────────

def test_explicit_private_request_is_never_downgraded(settings):
    settings()
    doc = sens_mod.classify_text("Public notice about the community library opening hours this week.")
    sel = sens_mod.select_trust_mode(doc_class=doc, instruction="2 copies", customer_requested="private", shop_minimum="standard")
    assert sel["effectiveTrustMode"] == "private" and sel["raisedBy"] == "customer"


def test_no_private_provider_fails_once_and_never_retries_weaker(settings, router):
    settings(zero_g_keys=KEYS)
    router["reply"] = lambda req: httpx.Response(503, json={"error": {"message": "no provider available for trust mode: tier=private",
                                                                       "type": "server_error", "code": "no_provider_for_trust_mode"}})
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("private", "glm-5.3", {"messages": [{"role": "user", "content": "x"}]}))
    assert exc.value.code == "ZERO_G_NO_PROVIDER_FOR_TRUST_MODE"
    assert "does not fall back" in exc.value.message
    # Retries are the SAME mode with the SAME key (1 + ZERO_G_MAX_RETRIES attempts), never weaker.
    assert [c["mode"] for c in router["calls"]] == ["private"] * (1 + zerog.get_settings().zero_g_max_retries)
    assert all(c["auth"] == f"Bearer {KEYS['private']}" for c in router["calls"])


def test_non_retryable_errors_are_not_retried(settings, router):
    settings(zero_g_keys=KEYS)
    router["reply"] = lambda req: httpx.Response(401, json={"error": {"code": "invalid_api_key", "message": "bad"}})
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("verified", "glm-5.3", {"messages": [{"role": "user", "content": "x"}]}))
    assert exc.value.code == "ZERO_G_INVALID_API_KEY" and len(router["calls"]) == 1


def test_body_routing_overrides_are_stripped(settings, router):
    settings(zero_g_keys=KEYS)
    run(zerog.chat_completion("private", "glm-5.3", {"model": "gpt-4.1", "provider": {"trust_mode": "standard"},
                                                     "messages": [{"role": "user", "content": "x"}]}))
    body = router["calls"][-1]["body"]
    assert "provider" not in body and body["model"] == "glm-5.3"


def test_failed_tee_signature_is_discarded(settings, router):
    settings(zero_g_keys=KEYS)
    router["reply"] = lambda req: httpx.Response(200, json=completion(tee=False))
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("verified", "glm-5.3", {"messages": [{"role": "user", "content": "x"}]}))
    assert exc.value.code == "ZERO_G_TEE_VERIFICATION_FAILED"


def test_absent_tee_result_requires_a_published_attested_provider(settings, router):
    """The live router omits tee_verified; the serving provider must be attested at the tier."""
    settings(zero_g_keys=KEYS)
    msgs = {"messages": [{"role": "user", "content": "x"}]}
    # Attested private TeeML provider: accepted, recorded as provider_attested (never as signature-verified).
    router["reply"] = lambda req: httpx.Response(200, json=completion(tee=None, provider="0xPROVIDER"))
    r = run(zerog.chat_completion("private", "glm-5.3", msgs))
    assert r.verification == "provider_attested" and r.tee_verified is None and r.attestation["tee_type"] == "TDX"
    # A TeeTLS provider qualifies for verified but never for private.
    router["reply"] = lambda req: httpx.Response(200, json=completion(tee=None, provider="0xtls"))
    assert run(zerog.chat_completion("verified", "glm-5.3", msgs)).verification == "provider_attested"
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("private", "glm-5.3", msgs))
    assert exc.value.code == "ZERO_G_PROVIDER_NOT_ATTESTED"
    # Unknown provider: discarded.
    router["reply"] = lambda req: httpx.Response(200, json=completion(tee=None, provider="0xunknown"))
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("private", "glm-5.3", msgs))
    assert exc.value.code == "ZERO_G_PROVIDER_NOT_ATTESTED"
    # Router-verified signature is reported as such.
    router["reply"] = lambda req: httpx.Response(200, json=completion(tee=True))
    assert run(zerog.chat_completion("private", "glm-5.3", msgs)).verification == "tee_signature_verified"


# ───────────── 6. model / trust-mode compatibility ─────────────

def test_unsupported_model_trust_combinations_fail_safely():
    models = {m["id"]: m for m in CATALOG["data"]}
    zerog.check_model(models, "glm-5.3", "private", needs_tools=True)
    zerog.check_model(models, "teetls-model", "verified", needs_tools=True)
    zerog.check_model(models, "gpt-4.1", "standard", needs_tools=True)
    for model, mode, code in [
        ("teetls-model", "private", "ZERO_G_MODEL_TRUST_UNSUPPORTED"),
        ("gpt-4.1", "verified", "ZERO_G_MODEL_TRUST_UNSUPPORTED"),
        ("gpt-4.1", "private", "ZERO_G_MODEL_TRUST_UNSUPPORTED"),
        ("laya", "private", "ZERO_G_MODEL_NO_TOOLS"),
        ("does-not-exist", "standard", "ZERO_G_MODEL_UNKNOWN"),
    ]:
        with pytest.raises(zerog.ZeroGError) as exc:
            zerog.check_model(models, model, mode, needs_tools=True)
        assert exc.value.code == code
    with pytest.raises(zerog.ZeroGError):
        zerog.rank("yolo")


# ───────────── 7. missing key ─────────────

def test_missing_key_is_a_clear_error_and_no_other_key_is_used(settings, router):
    settings(zero_g_keys={"standard": KEYS["standard"], "verified": "", "private": ""})
    with pytest.raises(zerog.ZeroGError) as exc:
        run(zerog.chat_completion("private", "glm-5.3", {"messages": [{"role": "user", "content": "x"}]}))
    assert exc.value.code == "ZERO_G_KEY_MISSING" and "ZERO_G_PRIVATE_API_KEY" in exc.value.message
    assert router["calls"] == []


# ───────────── 8. no credential leaks ─────────────

def test_no_credentials_in_any_response(settings, router, monkeypatch):
    settings(zero_g_keys=KEYS)

    async def health():
        return {"modelProvider": {"provider": "0g-private-computer", "available": True}, "operatorRunsEnabled": True}

    monkeypatch.setattr(views_mod, "agent_health", health)
    client = TestClient(create_app())
    shop = {"authorization": "Bearer test-shop-admin-token"}
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    bodies = [
        client.get("/health").text,
        client.get("/api/v1/shops", headers=web).text,
        client.get(f"/api/v1/jobs/{job}", headers=web).text,
        client.get("/api/v1/shop/overview", headers=shop).text,
        client.get("/api/v1/shop/config", headers=shop).text,
        client.get("/api/v1/shop/payments", headers=shop).text,
        repr(zerog.get_settings()),
    ]
    for text in bodies:
        for key in KEYS.values():
            assert key not in text
    overview = json.loads(bodies[3])
    assert overview["agent"]["zeroG"]["modes"]["private"]["configured"] is True


# ───────────── gateway: grant, SSE replay, failures never print ─────────────

def _job_with_grant(mode="private"):
    from app.store import JobRecord, now_iso

    store = get_store()
    job = JobRecord(job_id="job_gw", shop_id="shop_001", owner="web_x", created_at=now_iso(), updated_at=now_iso())
    store.jobs[job.job_id] = job
    return job, inference_mod.issue_grant(job.job_id, "run_1", mode, "glm-5.3")


def test_gateway_requires_a_grant_and_replays_tool_calls_as_sse(settings, router):
    settings(zero_g_keys=KEYS)
    router["reply"] = lambda req: httpx.Response(200, json=completion(tool_call=True))
    client = TestClient(create_app())
    url = "/api/v1/internal/inference/v1/chat/completions"
    assert client.post(url, json={"messages": []}, headers={"authorization": "Bearer nope"}).status_code == 401

    job, grant = _job_with_grant("private")
    r = client.post(url, json={"model": "anything", "stream": True, "messages": [{"role": "user", "content": "x"}]},
                    headers={"authorization": f"Bearer {grant.token}"})
    assert r.status_code == 200 and r.text.rstrip().endswith("data: [DONE]")
    chunks = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: {")]
    calls = [c for ch in chunks for choice in ch["choices"] for c in (choice["delta"].get("tool_calls") or [])]
    assert calls[0]["function"]["name"] == "set_copies"
    assert router["calls"][-1]["mode"] == "private"
    assert get_store().jobs[job.job_id].inference_log[-1]["teeVerified"] is True


def test_failed_inference_never_triggers_printing(settings, router, monkeypatch):
    settings(zero_g_keys=KEYS)
    router["reply"] = lambda req: httpx.Response(503, json={"error": {"code": "no_provider_for_trust_mode", "message": "x"}})
    submitted = []

    async def submit(config, data):
        submitted.append(1)
        return {"ok": True}

    monkeypatch.setattr(jobs_mod, "submit_print", submit)
    client = TestClient(create_app())
    job, grant = _job_with_grant("private")
    r = client.post("/api/v1/internal/inference/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]},
                    headers={"authorization": f"Bearer {grant.token}"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "ZERO_G_NO_PROVIDER_FOR_TRUST_MODE"
    assert get_store().jobs[job.job_id].inference_log[-1]["ok"] is False
    assert run(jobs_mod.try_execute(job.job_id))["state"] == "awaiting_operator"
    assert submitted == []


# ───────────── run preparation (end to end through upload) ─────────────

def docx_bytes(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", f"<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>")
    return buf.getvalue()


def _upload(client, text):
    web = {"authorization": f"Bearer {client.post('/api/v1/web/sessions').json()['sessionToken']}"}
    job = client.post("/api/v1/jobs", json={"shopId": "shop_001"}, headers=web).json()["jobId"]
    r = client.post("/api/v1/documents", headers=web, data={"jobId": job},
                    files={"file": ("doc.docx", docx_bytes(text), "application/octet-stream")})
    assert r.status_code == 200, r.text
    return web, job


def test_upload_classifies_and_run_gets_a_private_grant(settings, router, monkeypatch):
    settings(zero_g_keys=KEYS)

    async def no_agent():
        return None

    monkeypatch.setattr(jobs_mod, "agent_health", no_agent)
    client = TestClient(create_app())
    web, job_id = _upload(client, "Salary slip. PAN ABCDE1234F. Account number 001234567890.")
    view = client.get(f"/api/v1/jobs/{job_id}", headers=web).json()
    assert view["document"]["classification"]["level"] == "sensitive"
    assert "ABCDE1234F" not in json.dumps(view)

    client.put(f"/api/v1/jobs/{job_id}/privacy", json={"requestedTrustMode": "standard"}, headers=web)
    job = get_store().jobs[job_id]
    grant = run(jobs_mod.prepare_inference(job, "run_t", "print 2 copies"))
    assert grant["trustMode"] == "private" and grant["model"] == "glm-5.3"
    assert "sk-" not in json.dumps(grant)  # the agent gets a grant, never a 0G key
    assert job.trust_selection["effectiveTrustMode"] == "private"


def test_missing_private_key_refuses_the_run_before_sending_anything(settings, router, monkeypatch):
    settings(zero_g_keys={"standard": KEYS["standard"], "verified": KEYS["verified"], "private": ""})

    async def no_agent():
        return None

    monkeypatch.setattr(jobs_mod, "agent_health", no_agent)
    streamed = []

    async def fake_stream(**kwargs):
        streamed.append(kwargs)
        yield {}

    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    client = TestClient(create_app())
    web, job_id = _upload(client, "CONFIDENTIAL employment contract between the parties hereinafter")
    with client:
        client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "print it"}, headers=web)
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    finished = [e for e in history(job_id) if e["type"] == "agent_finished"][-1]["payload"]
    assert finished["outcome"] == "unavailable" and "ZERO_G_PRIVATE_API_KEY" in finished["message"]
    assert streamed == [] and router["calls"] == []  # nothing sent to the agent or to 0G


def test_vertex_agent_is_refused_for_documents_needing_private(settings, monkeypatch):
    settings(zero_g_keys=KEYS)

    async def vertex():
        return {"modelProvider": {"provider": "vertex-ai", "model": "gemini"}, "operatorRunsEnabled": True}

    monkeypatch.setattr(jobs_mod, "agent_health", vertex)
    client = TestClient(create_app())
    _, job_id = _upload(client, "Passport number A1234567 and date of birth")
    with pytest.raises(jobs_mod.RunRefused):
        run(jobs_mod.prepare_inference(get_store().jobs[job_id], "run_v", "print"))


# ───────────── 11. relayed events reflect tool results ─────────────

def test_relayed_tool_failure_changes_nothing(settings, monkeypatch):
    settings()

    async def granted(job, run_id, instruction):
        return None

    async def fake_stream(**kwargs):
        rid = kwargs["run_id"]
        yield {"type": "tool_started", "payload": {"runId": rid, "toolUseId": "t1", "tool": "validate_print_config", "input": {}}}
        yield {"type": "tool_failed", "payload": {"runId": rid, "toolUseId": "t1", "tool": "validate_print_config",
                                                 "error": {"code": "CONFIG_INCOMPLETE", "message": "Set these first: printerId."}}}
        yield {"type": "agent_finished", "payload": {"runId": rid, "outcome": "needs_clarification", "message": "Which printer?"}}

    monkeypatch.setattr(jobs_mod, "prepare_inference", granted)
    monkeypatch.setattr(jobs_mod, "stream_operator_run", fake_stream)
    client = TestClient(create_app())
    web, job_id = _upload(client, "Public library timetable for the week ahead, open to all.")
    with client:
        client.post(f"/api/v1/jobs/{job_id}/messages", json={"text": "print"}, headers=web)
        for _ in range(100):
            if not get_store().jobs[job_id].run_active:
                break
            time.sleep(0.05)
    failed = [e for e in history(job_id) if e["type"] == "tool_failed"][-1]
    assert failed["payload"]["error"]["code"] == "CONFIG_INCOMPLETE"
    assert not any(e["type"] == "tool_succeeded" for e in history(job_id))
    assert get_store().jobs[job_id].config_validated is False


# ───────────── document review keeps the original ─────────────

def test_edited_document_needs_approval_before_quote(settings):
    settings()
    client = TestClient(create_app())
    web, job_id = _upload(client, "Public library timetable for the week ahead, open to all.")
    job = get_store().jobs[job_id]
    edited = job.document.original_path.replace("original", "edited")
    open(edited, "wb").write(docx_bytes("edited"))
    original_bytes = open(job.document.original_path, "rb").read()
    job.document.edited_path, job.document.edit_status, job.config_validated = edited, "pending_review", True
    r = client.post(f"/api/v1/jobs/{job_id}/quote", headers=web)
    assert r.status_code == 409 and "Review the edited document" in r.json()["error"]["message"]
    assert client.post(f"/api/v1/jobs/{job_id}/document/reject", headers=web).json()["document"]["editStatus"] == "rejected"
    assert open(job.document.original_path, "rb").read() == original_bytes


# ───────────── local shop access ─────────────

def _req(host, xff=None):
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return Request({"type": "http", "client": (host, 1234), "headers": headers, "method": "GET", "path": "/"})


def test_local_shop_access_is_loopback_only():
    assert is_local_request(_req("127.0.0.1"))
    assert is_local_request(_req("127.0.0.1", "127.0.0.1"))
    assert not is_local_request(_req("127.0.0.1", "192.168.1.20"))  # phone through the dev proxy
    assert not is_local_request(_req("192.168.1.20"))
