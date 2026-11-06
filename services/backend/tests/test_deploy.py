"""Deployment features: gateway key from a mounted secret, cloud origin in the QR,
coalesced state writes, Cloud Run ID tokens and the shop gateway printer relay."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi.testclient import TestClient

from app import clients, config, gateway_relay, service_auth
from app import store as store_mod
from app.security import GatewayIdentity, b64url_decode, build_qr_payload, canonical_json

GW = {"authorization": "Bearer test-gateway-token"}


@pytest.fixture
def env(monkeypatch):
    """Set env vars for one test and rebuild the cached settings around it."""

    def apply(**values: str) -> None:
        for k, v in values.items():
            monkeypatch.setenv(k, v)
        config.get_settings.cache_clear()

    yield apply
    config.get_settings.cache_clear()
    gateway_relay.reset_for_tests()
    service_auth.clear_cache_for_tests()


def _relay_app(env):
    env(PRINTER_MODE="relay", GATEWAY_TOKEN="test-gateway-token", PRINTER_AGENT_TOKEN="test-printer-token")
    from app.main import create_app

    return TestClient(create_app())


# ───────────── gateway identity ─────────────

def test_gateway_key_from_secret_file_hex_and_raw(tmp_path):
    seed = bytes(range(32))
    hex_file = tmp_path / "hex"
    hex_file.write_text(seed.hex() + "\n")
    raw_file = tmp_path / "raw"
    raw_file.write_bytes(seed)
    a = GatewayIdentity.load_configured(SimpleNamespace(gateway_identity_key_path=str(hex_file), data_dir=tmp_path))
    b = GatewayIdentity.load_configured(SimpleNamespace(gateway_identity_key_path=str(raw_file), data_dir=tmp_path))
    assert a.public_key == b.public_key == GatewayIdentity.from_seed(seed).public_key


def test_gateway_key_path_must_exist_and_is_never_created(tmp_path):
    missing = tmp_path / "nope"
    with pytest.raises(RuntimeError):
        GatewayIdentity.load_configured(SimpleNamespace(gateway_identity_key_path=str(missing), data_dir=tmp_path))
    assert not missing.exists()
    bad = tmp_path / "bad"
    bad.write_text("not-a-key")
    with pytest.raises(ValueError):
        GatewayIdentity.load_configured(SimpleNamespace(gateway_identity_key_path=str(bad), data_dir=tmp_path))


# ───────────── QR cloud origin ─────────────

def _verify(payload: dict) -> bool:
    unsigned = {k: v for k, v in payload.items() if k != "signature"}
    key = Ed25519PublicKey.from_public_bytes(b64url_decode(payload["publicKey"]))
    try:
        key.verify(b64url_decode(payload["signature"]), canonical_json(unsigned).encode())
        return True
    except Exception:  # noqa: BLE001
        return False


def test_qr_signs_cloud_origin_only_when_configured():
    ident = GatewayIdentity.from_seed(bytes(32))
    common = dict(shop_id="shop_001", gateway_id="gateway_001", mdns="gateway-001.local", port=8080, ip=None, ttl_seconds=60)
    lan = build_qr_payload(ident, **common)
    cloud = build_qr_payload(ident, **common, cloud_origin="https://inklink-backend-x.a.run.app")
    assert "cloudOrigin" not in lan["gateway"] and _verify(lan)
    assert cloud["gateway"]["cloudOrigin"] == "https://inklink-backend-x.a.run.app" and _verify(cloud)
    cloud["gateway"]["cloudOrigin"] = "https://evil.example"
    assert not _verify(cloud)


# ───────────── coalesced state writes ─────────────

def test_state_writes_are_coalesced_and_flushed_on_close(env, tmp_path):
    env(STATE_SAVE_INTERVAL_SECONDS="30")
    path = tmp_path / "state.json"
    st = store_mod.Store(path)
    st.shops["shop_x"] = {"registered": True}
    st.save()
    assert not path.exists()  # deferred
    st.close()
    assert json.loads(path.read_text())["shops"]["shop_x"]["registered"] is True


def test_state_writes_immediately_by_default(tmp_path):
    path = tmp_path / "state.json"
    st = store_mod.Store(path)
    st.save()
    assert path.exists()


# ───────────── Cloud Run ID tokens ─────────────

def test_id_token_header_only_when_enabled_and_cached(env, monkeypatch):
    calls = []

    async def fake_fetch(audience: str) -> str:
        calls.append(audience)
        return "id-token-" + str(len(calls))

    monkeypatch.setattr(service_auth, "_fetch_id_token", fake_fetch)
    assert asyncio.run(service_auth.auth_headers("https://svc.a.run.app/api/x")) == {}
    env(SERVICE_AUTH="gcp-id-token")
    h1 = asyncio.run(service_auth.auth_headers("https://svc.a.run.app/api/x"))
    h2 = asyncio.run(service_auth.auth_headers("https://svc.a.run.app/other"))
    assert h1 == h2 == {"X-Serverless-Authorization": "Bearer id-token-1"}
    assert calls == ["https://svc.a.run.app"]


# ───────────── printer relay ─────────────

def test_relay_endpoints_require_relay_mode_and_token(env):
    from app.main import create_app

    direct = TestClient(create_app())
    assert direct.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 0}, headers=GW).status_code == 404
    client = _relay_app(env)
    assert client.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 0}).status_code == 401
    assert client.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 0},
                       headers={"authorization": "Bearer wrong"}).status_code == 401
    res = client.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 0}, headers=GW)
    assert res.status_code == 200 and res.json()["requests"] == []
    assert client.get("/health").json()["printer"]["connected"] is True


def test_printer_call_fails_fast_when_gateway_not_connected(env):
    env(PRINTER_MODE="relay", GATEWAY_TOKEN="test-gateway-token")
    with pytest.raises(clients.ServiceError) as exc:
        asyncio.run(clients.list_printers())
    assert exc.value.code == "PRINTER_ADAPTER_UNREACHABLE"


def test_print_round_trip_through_the_gateway(env):
    client = _relay_app(env)
    client.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 0}, headers=GW)  # gateway connects
    pdf = b"%PDF-1.4 test document"
    out: dict = {}

    def backend_side():
        out["result"] = asyncio.run(clients.submit_print({"printerId": "p1", "copies": 1}, pdf))

    worker = threading.Thread(target=backend_side)
    worker.start()
    polled = client.post("/api/v1/gateway/poll", json={"maxWaitSeconds": 5}, headers=GW).json()
    assert len(polled["requests"]) == 1
    req = polled["requests"][0]
    assert req["method"] == "POST" and req["path"] == "/print"
    assert "documentBase64" not in req["body"]  # only a reference crosses the relay
    doc = client.get(req["body"]["document"]["path"], headers=GW)
    assert doc.status_code == 200 and doc.content == pdf
    assert client.get(req["body"]["document"]["path"]).status_code == 401
    answered = client.post("/api/v1/gateway/results", headers=GW, json={"results": [
        {"id": req["id"], "status": 200, "body": {"ok": True, "state": "PRINT_SUBMITTED", "submissionId": "s1"}}]})
    assert answered.json()["accepted"] == 1
    worker.join(10)
    assert out["result"] == {"httpStatus": 200, "ok": True, "state": "PRINT_SUBMITTED", "submissionId": "s1"}
    # The one-time document reference is gone after the print request completes.
    assert client.get(req["body"]["document"]["path"], headers=GW).status_code == 404


def test_unanswered_request_times_out_and_is_withdrawn(env):
    env(PRINTER_MODE="relay", GATEWAY_TOKEN="test-gateway-token", PRINTER_RELAY_TIMEOUT_SECONDS="0.3")
    gateway_relay._relay.last_poll = time.time()
    with pytest.raises(clients.ServiceError) as exc:
        asyncio.run(clients.list_printers())
    assert exc.value.code == "PRINTER_RELAY_TIMEOUT"
    assert not gateway_relay._relay.pending  # never executed late


def test_agent_printer_proxy_allowlist(env, monkeypatch):
    client = _relay_app(env)
    seen = []

    async def fake_call(method, path, body=None, timeout=None):
        seen.append((method, path, body))
        return 200, {"ok": True, "printers": []}

    monkeypatch.setattr(clients, "printer_call", fake_call)
    hdr = {"x-printer-agent-token": "test-printer-token"}
    assert client.get("/api/v1/internal/printer/printers").status_code == 401
    assert client.get("/api/v1/internal/printer/printers", headers=hdr).json()["ok"] is True
    assert client.get("/api/v1/internal/printer/printers/HP%20One/availability", headers=hdr).status_code == 200
    assert client.post("/api/v1/internal/printer/validate", headers=hdr, json={"config": {}}).status_code == 200
    assert client.post("/api/v1/internal/printer/print", headers=hdr, json={}).status_code == 403
    assert [s[1] for s in seen] == ["/printers", "/printers/HP One/availability", "/validate"]


def test_only_status_fields_of_real_jobs_reach_the_gateway(env):
    env(PRINTER_MODE="relay", GATEWAY_TOKEN="test-gateway-token")
    st = store_mod.get_store()
    s = config.get_settings()
    ts = store_mod.now_iso()
    st.jobs["job_real"] = store_mod.JobRecord(job_id="job_real", shop_id=s.shop_id, owner="x", created_at=ts, updated_at=ts)
    st.jobs["job_demo"] = store_mod.JobRecord(job_id="job_demo", shop_id=s.demo_shop_id, owner="x", created_at=ts, updated_at=ts)
    gateway_relay.on_event({"jobId": "job_real", "type": "job_status_updated",
                            "payload": {"status": "executing", "price": "4.00", "filename": "secret.pdf"}})
    gateway_relay.on_event({"jobId": "job_demo", "type": "job_status_updated", "payload": {"status": "executing"}})
    gateway_relay.on_event({"jobId": "job_real", "type": "message_added", "payload": {"text": "hi"}})
    forwarded = list(gateway_relay._relay.events)
    assert len(forwarded) == 1
    assert forwarded[0]["jobId"] == "job_real" and forwarded[0]["payload"] == {"status": "executing"}

    # Settlement proof is forwarded only for a verified ("settled") payment event.
    gateway_relay._relay.events.clear()
    gateway_relay.on_event({"jobId": "job_real", "type": "payment_status_updated",
                            "payload": {"status": "processing", "transactionId": None, "amount": "0.05"}})
    gateway_relay.on_event({"jobId": "job_real", "type": "payment_status_updated",
                            "payload": {"status": "settled", "transactionId": "0.0.1@1.2", "network": "hedera:testnet",
                                        "amount": "0.05", "verifiedAt": "v", "paymentId": "pay_x"}})
    first, second = [e["payload"] for e in gateway_relay._relay.events]
    assert first == {"status": "processing"}
    assert second == {"status": "settled", "transactionId": "0.0.1@1.2", "network": "hedera:testnet",
                      "amount": "0.05", "verifiedAt": "v"}


# ───────────── bootstrap shopkeeper (Cloud Run has no shell) ─────────────

def test_bootstrap_shopkeeper_once_and_never_overwrites(monkeypatch):
    from app.manage import bootstrap_shopkeeper_from_env

    assert bootstrap_shopkeeper_from_env() is None  # not configured
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_EMAIL", "Owner@Example.com")
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_PASSWORD", "correct horse battery")
    created = bootstrap_shopkeeper_from_env()
    st = store_mod.get_store()
    acct = st.accounts[created]
    assert acct.email == "owner@example.com" and acct.shop_ids
    before = acct.password_hash
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_PASSWORD", "a different password")
    assert bootstrap_shopkeeper_from_env() is None
    assert st.accounts[created].password_hash == before


def test_bootstrap_password_sync_is_opt_in_and_ends_sessions(monkeypatch):
    from app.auth import verify_password
    from app.manage import bootstrap_shopkeeper_from_env

    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_EMAIL", "owner@example.com")
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_PASSWORD", "first password 123")
    acct_id = bootstrap_shopkeeper_from_env()
    st = store_mod.get_store()
    st.shop_sessions["h1"] = store_mod.ShopSession(token_hash="h1", account_id=acct_id, created_at=time.time(),
                                                   expires_at=time.time() + 60)
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_PASSWORD", "second password 456")
    monkeypatch.setenv("BOOTSTRAP_SHOPKEEPER_SYNC_PASSWORD", "true")
    assert bootstrap_shopkeeper_from_env() == acct_id
    assert verify_password("second password 456", st.accounts[acct_id].password_hash)
    assert "h1" not in st.shop_sessions
    assert bootstrap_shopkeeper_from_env() is None  # already in sync: nothing to do
