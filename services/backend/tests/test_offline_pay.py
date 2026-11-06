"""OfflinePay on the backend: voucher rules (ported from packages/shared-schemas), the persistent
ledger, the HTTP endpoint, settlement through the payment agent and reconciliation.

The payment agent is replaced by a stub at its client boundary only. A voucher reaches SETTLED
solely through the same HMAC-signed settlement callback the real agent sends after its
mirror-node check (tests.test_flow.settle)."""

from __future__ import annotations

import asyncio
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app import offline_pay as op
from app.clients import ServiceError
from app.main import create_app
from app.security import b64url_encode, canonical_json
from app.store import get_store, iso_from_epoch
from tests.test_flow import printer, settle  # noqa: F401  (fixture + callback helper)
from tests.test_native_flow import device, native, native_job, pair

TX = "0.0.7162784@1793986272.588926799"

# Agreed test vector (docs/API_CONTRACTS.md): device seed = 32 x 0x09, voucherId = 16 x 0x01.
VECTOR = {
    "type": "inklink_offline_payment", "version": "1.0", "voucherId": "AQEBAQEBAQEBAQEBAQEBAQ",
    "jobId": "job_vector", "quoteId": "quote_vector", "merchantId": "shop_001", "amount": "0.10", "asset": "USDC",
    "devicePublicKey": "_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg", "customerReference": "dev__RckOFqgx1tk-3jNYC-h2Z",
    "issuedAt": "2026-11-06T10:00:00.000Z", "expiresAt": "2026-11-06T10:30:00.000Z",
    "signature": "cUvdzz9y-8K1IT0U4b89ZzSvasw9bLeTjooCpszEbDF6I3x6yHJI9J7-CP5FgsFpUQ1kE1moD6xG8qV0iDl-AQ",
}
VECTOR_TEXT = ('{"amount":"0.10","asset":"USDC","customerReference":"dev__RckOFqgx1tk-3jNYC-h2Z","devicePublicKey":'
               '"_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg","expiresAt":"2026-11-06T10:30:00.000Z","issuedAt":'
               '"2026-11-06T10:00:00.000Z","jobId":"job_vector","merchantId":"shop_001","quoteId":"quote_vector","type":'
               '"inklink_offline_payment","version":"1.0","voucherId":"AQEBAQEBAQEBAQEBAQEBAQ"}')
VECTOR_NOW = 1793959800.0  # 2026-11-06T10:10:00Z


@pytest.fixture
def client():
    return TestClient(create_app())


def public_key(key: Ed25519PrivateKey) -> str:
    return b64url_encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def make_voucher(key, job_id, quote_id, amount, *, merchant="shop_001", issued=None, valid_ms=30 * 60 * 1000, **over):
    issued = time.time() if issued is None else issued
    pub = public_key(key)
    unsigned = {
        "type": "inklink_offline_payment", "version": "1.0", "voucherId": b64url_encode(Ed25519PrivateKey.generate().private_bytes_raw()[:16]),
        "jobId": job_id, "quoteId": quote_id, "merchantId": merchant, "amount": amount, "asset": "USDC",
        "devicePublicKey": pub, "customerReference": f"dev_{pub[:22]}",
        "issuedAt": iso_from_epoch(issued), "expiresAt": iso_from_epoch(issued + valid_ms / 1000),
    }
    unsigned.update(over)
    return {**unsigned, "signature": b64url_encode(key.sign(canonical_json(unsigned).encode()))}


# ───────────── the agreed test vector ─────────────

def test_agreed_test_vector_verifies_in_python():
    assert op.signing_text(VECTOR) == VECTOR_TEXT
    assert op.verify_voucher(VECTOR, merchant_id="shop_001", now=VECTOR_NOW)["voucherId"] == "AQEBAQEBAQEBAQEBAQEBAQ"
    tampered = {**VECTOR, "amount": "0.11"}
    with pytest.raises(op.OfflinePayError) as e:
        op.verify_voucher(tampered, now=VECTOR_NOW)
    assert e.value.code == "SIGNATURE_INVALID"


# ───────────── voucher rules ─────────────

@pytest.mark.parametrize("over,code", [
    ({"amount": "2.01"}, "OVER_VOUCHER_LIMIT"),
    ({"amount": "0"}, "AMOUNT_INVALID"),
    ({"amount": "1.1234567"}, "AMOUNT_INVALID"),
    ({"merchantId": "shop_other"}, "WRONG_MERCHANT"),
    ({"customerReference": "dev_someone_elses_ref_xx"}, "INVALID_VOUCHER"),
    ({"asset": "HBAR"}, "INVALID_VOUCHER"),
    ({"version": "2.0"}, "INVALID_VOUCHER"),
    ({"extra": "field"}, "INVALID_VOUCHER"),
])
def test_invalid_vouchers_are_refused_with_precise_codes(over, code):
    over = dict(over)
    v = make_voucher(Ed25519PrivateKey.generate(), "job_1", "quote_1", over.pop("amount", "0.10"), **over)
    with pytest.raises(op.OfflinePayError) as e:
        op.verify_voucher(v, merchant_id="shop_001")
    assert e.value.code == code


def test_time_window_rules():
    key = Ed25519PrivateKey.generate()
    now = time.time()
    with pytest.raises(op.OfflinePayError) as e:
        op.verify_voucher(make_voucher(key, "j", "q", "0.10", issued=now - 3600), merchant_id="shop_001")   # expired 30 min ago
    assert e.value.code == "EXPIRED"
    with pytest.raises(op.OfflinePayError) as e:
        op.verify_voucher(make_voucher(key, "j", "q", "0.10", issued=now + 3600), merchant_id="shop_001")
    assert e.value.code == "NOT_YET_VALID"
    with pytest.raises(op.OfflinePayError) as e:
        op.verify_voucher(make_voucher(key, "j", "q", "0.10", valid_ms=3 * 3600 * 1000), merchant_id="shop_001")
    assert e.value.code == "VALIDITY_TOO_LONG"
    # 4 minutes of clock skew is tolerated, 6 is not.
    op.verify_voucher(make_voucher(key, "j", "q", "0.10", issued=now + 240), merchant_id="shop_001")
    with pytest.raises(op.OfflinePayError):
        op.verify_voucher(make_voucher(key, "j", "q", "0.10", issued=now + 360), merchant_id="shop_001")


# ───────────── ledger ─────────────

def test_ledger_idempotency_replay_duplicate_job_and_outstanding_limit():
    key = Ed25519PrivateKey.generate()
    v1 = make_voucher(key, "job_a", "quote_a", "2.00")
    rec, dup = op.accept(v1, merchant_id="shop_001")
    assert (rec["state"], dup) == ("AUTHORIZED_OFFLINE", False)
    assert op.accept(v1, merchant_id="shop_001")[1] is True                        # identical: idempotent, counted once
    assert op.outstanding(v1["devicePublicKey"]) == "2.000000"

    same_id = make_voucher(key, "job_other", "quote_x", "1.00", voucherId=v1["voucherId"])
    with pytest.raises(op.OfflinePayError) as e:
        op.accept(same_id, merchant_id="shop_001")
    assert e.value.code == "REPLAYED"
    with pytest.raises(op.OfflinePayError) as e:
        op.accept(make_voucher(key, "job_a", "quote_a", "1.00"), merchant_id="shop_001")
    assert e.value.code == "DUPLICATE_JOB"

    op.accept(make_voucher(key, "job_b", "quote_b", "2.00"), merchant_id="shop_001")   # 4.00 outstanding
    with pytest.raises(op.OfflinePayError) as e:
        op.accept(make_voucher(key, "job_c", "quote_c", "1.50"), merchant_id="shop_001")   # 5.50 > 5.00
    assert e.value.code == "OVER_OUTSTANDING_LIMIT"
    # Another device has its own limit.
    op.accept(make_voucher(Ed25519PrivateKey.generate(), "job_d", "quote_d", "2.00"), merchant_id="shop_001")


def test_reconcile_requires_a_verified_hedera_transaction_for_the_same_job_and_amount():
    key = Ed25519PrivateKey.generate()
    rec, _ = op.accept(make_voucher(key, "job_r", "quote_r", "0.30"), merchant_id="shop_001")
    with pytest.raises(op.OfflinePayError) as e:
        op.reconcile_settled(rec, payment_id="offpay_1", job_id="job_r", amount="0.30", transaction_id=TX, verified_at="t")
    assert e.value.code == "INVALID_TRANSITION"                                    # must be PENDING first
    op.mark_pending(rec, "offpay_1")
    bad = [dict(job_id="other", amount="0.30", transaction_id=TX, verified_at="t"),
           dict(job_id="job_r", amount="0.31", transaction_id=TX, verified_at="t"),
           dict(job_id="job_r", amount="0.30", transaction_id="not-a-tx", verified_at="t"),
           dict(job_id="job_r", amount="0.30", transaction_id=TX, verified_at=None)]
    for kw in bad:
        with pytest.raises(op.OfflinePayError) as e:
            op.reconcile_settled(rec, payment_id="offpay_1", **kw)
        assert e.value.code == "SETTLEMENT_MISMATCH" and rec["state"] == "PENDING_SETTLEMENT"
    op.reconcile_settled(rec, payment_id="offpay_1", job_id="job_r", amount="0.30", transaction_id=TX, verified_at="t")
    assert rec["state"] == "SETTLED" and rec["transactionId"] == TX
    op.reconcile_settled(rec, payment_id="offpay_1", job_id="job_r", amount="0.30", transaction_id=TX, verified_at="t")  # idempotent
    with pytest.raises(op.OfflinePayError):
        op.reconcile_settled(rec, payment_id="offpay_1", job_id="job_r", amount="0.30",
                             transaction_id="0.0.1@1.2", verified_at="t")


# ───────────── HTTP: accept, settle through the agent, reconcile ─────────────

class Agent:
    """Stub of the payment agent's /offline-payments/settle."""

    def __init__(self, monkeypatch, *, answer=None, error: ServiceError | None = None):
        self.calls: list[dict] = []
        self.answer = answer or (200, {"paymentId": "?", "voucherId": "?", "status": "processing", "voucherState": "PENDING_SETTLEMENT"})
        self.error = error
        monkeypatch.setattr(op, "call_payment_agent", self)

    async def __call__(self, method, path, body=None):
        assert (method, path) == ("POST", "/api/v1/offline-payments/settle")
        self.calls.append(body)
        if self.error:
            raise self.error
        return self.answer


def quoted_native_job(client):
    key, pub = device()
    hdr = native(pair(client, key, pub))
    job_id = native_job(client, hdr)
    quote = client.post(f"/api/v1/jobs/{job_id}/quote", headers=hdr).json()
    assert quote["settlement"]["amount"] == "0.30"
    return key, hdr, job_id, quote


def test_voucher_is_accepted_then_settled_only_by_the_signed_callback(client, printer, monkeypatch):  # noqa: F811
    agent = Agent(monkeypatch)
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30")

    r = client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "PENDING_SETTLEMENT" and body["settlement"] == "started" and body["duplicate"] is False
    assert "signature" not in body["voucher"]

    # The agent got exactly what its contract asks for.
    call = agent.calls[0]
    assert call["paymentId"].startswith("offpay_") and not call["paymentId"].startswith("payment_")
    assert (call["jobId"], call["quoteId"], call["merchantId"], call["settlementAmount"]) == (job_id, quote["quoteId"], "shop_001", "0.30")
    assert call["resourceUrl"].endswith(f"/api/v1/jobs/{job_id}/execute") and call["voucher"] == voucher

    # A promise is not a payment: still awaiting payment, nothing printed, no transaction shown.
    job = get_store().jobs[job_id]
    assert job.status == "awaiting_payment" and job.payment_status == "processing" and job.payment_id == call["paymentId"]
    view = client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()
    assert view["payment"]["verificationStatus"] == "pending" and view["payment"]["transactionId"] is None
    assert view["offlinePayment"]["state"] == "PENDING_SETTLEMENT"
    assert printer["submit"] == []

    # Resubmitting the identical voucher is idempotent and starts no second payment.
    again = client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr)
    assert again.status_code == 409          # the job is already paying: refused before touching the ledger
    assert len(agent.calls) == 1

    # Only the verified, signed settlement settles it.
    assert settle(client, job_id, call["paymentId"], "0.30", tx=TX).status_code == 200
    got = client.get(f"/api/v1/offline-payments/{voucher['voucherId']}", headers=hdr).json()
    assert got["state"] == "SETTLED" and got["transactionId"] == TX and got["paymentId"] == call["paymentId"]
    assert get_store().jobs[job_id].status == "awaiting_execution"
    assert client.get(f"/api/v1/jobs/{job_id}", headers=hdr).json()["payment"]["verificationStatus"] == "verified"


def test_agent_unreachable_keeps_the_promise_and_retries_later(client, printer, monkeypatch):  # noqa: F811
    agent = Agent(monkeypatch, error=ServiceError("INTERNAL_ERROR", "Payment service is unreachable."))
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30")
    r = client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr)
    assert r.status_code == 200 and r.json()["state"] == "AUTHORIZED_OFFLINE" and r.json()["settlement"] == "retry_later"
    job = get_store().jobs[job_id]
    assert job.payment_status != "processing" and not get_store().payments      # nothing was started

    agent.error = None
    assert asyncio.run(op.sync_once()) == 1
    assert get_store().offline_vouchers[voucher["voucherId"]]["state"] == "PENDING_SETTLEMENT"
    assert get_store().jobs[job_id].payment_status == "processing"
    # The same retry cannot run twice for a voucher that is already settling.
    assert asyncio.run(op.sync_once()) == 0 and len(agent.calls) == 2


def test_a_definitive_refusal_is_not_retried_forever(client, printer, monkeypatch):  # noqa: F811
    agent = Agent(monkeypatch, answer=(403, {"success": False, "error": {"code": "SIGNATURE_INVALID", "message": "bad signature"}}))
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30")
    r = client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr)
    assert r.json()["settlement"] == "refused" and r.json()["failureReason"] == "bad signature"
    assert asyncio.run(op.sync_once()) == 0 and len(agent.calls) == 1
    assert not get_store().payments


def test_failed_settlement_is_retried_with_a_new_payment_id(client, printer, monkeypatch):  # noqa: F811
    from app import routes_native

    agent = Agent(monkeypatch)
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30")
    client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr)
    first = agent.calls[0]["paymentId"]

    async def failed(method, path, body=None):
        return 200, {"status": "failed"}

    monkeypatch.setattr(routes_native, "call_payment_agent", failed)
    assert asyncio.run(routes_native.refresh_payment_from_agent(first)) == "failed"
    record = get_store().offline_vouchers[voucher["voucherId"]]
    assert record["state"] == "SETTLEMENT_FAILED" and get_store().jobs[job_id].payment_status == "failed"
    assert op.outstanding(voucher["devicePublicKey"]) == "0.300000"                  # failed vouchers still count

    assert asyncio.run(op.sync_once()) == 1
    second = agent.calls[1]["paymentId"]
    assert second != first and second.startswith("offpay_")
    assert settle(client, job_id, second, "0.30", tx=TX).status_code == 200
    assert record["state"] == "SETTLED" and record["settlementAttempts"] == 2


# ───────────── endpoint guards ─────────────

def test_endpoint_refuses_mismatched_foreign_and_unpaired_vouchers(client, printer, monkeypatch):  # noqa: F811
    agent = Agent(monkeypatch)
    key, hdr, job_id, quote = quoted_native_job(client)
    post = lambda v, h=hdr: client.post("/api/v1/offline-payments", json={"voucher": v}, headers=h)  # noqa: E731

    assert post(make_voucher(key, job_id, quote["quoteId"], "0.29")).status_code == 400            # not the quoted amount
    assert post(make_voucher(key, job_id, "quote_other", "0.30")).status_code == 404               # not the job's quote
    assert post(make_voucher(key, job_id, quote["quoteId"], "0.30", merchant="shop_zzz")).status_code == 403
    assert client.post("/api/v1/offline-payments", json={"voucher": make_voucher(key, job_id, quote["quoteId"], "0.30")}).status_code in (401, 403)

    # Signed by some other device than the one paired with this session: refused and never recorded.
    other = Ed25519PrivateKey.generate()
    r = post(make_voucher(other, job_id, quote["quoteId"], "0.30"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "SIGNATURE_INVALID"
    assert get_store().offline_vouchers == {} and agent.calls == []

    # Another customer cannot use or read this job's voucher.
    stranger = native(pair(client, *device()))
    assert post(make_voucher(key, job_id, quote["quoteId"], "0.30"), stranger).status_code == 404
    good = make_voucher(key, job_id, quote["quoteId"], "0.30")
    assert post(good).status_code == 200
    assert client.get(f"/api/v1/offline-payments/{good['voucherId']}", headers=stranger).status_code == 404
    assert client.get("/api/v1/offline-payments/unknown", headers=hdr).status_code == 404


def test_expired_quote_and_repeated_voucher_ids_are_refused(client, printer, monkeypatch):  # noqa: F811
    Agent(monkeypatch)
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30", issued=time.time() - 3600)
    assert client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr).json()["error"]["code"] == "EXPIRED"
    q = get_store().quotes[quote["quoteId"]]
    q.expires_at = iso_from_epoch(time.time() - 5)
    r = client.post("/api/v1/offline-payments", json={"voucher": make_voucher(key, job_id, quote["quoteId"], "0.30")}, headers=hdr)
    assert r.status_code == 410 and r.json()["error"]["code"] == "QUOTE_EXPIRED"


def test_ledger_survives_a_restart(client, printer, monkeypatch):  # noqa: F811
    from app import store as store_mod

    Agent(monkeypatch)
    key, hdr, job_id, quote = quoted_native_job(client)
    voucher = make_voucher(key, job_id, quote["quoteId"], "0.30")
    assert client.post("/api/v1/offline-payments", json={"voucher": voucher}, headers=hdr).status_code == 200
    get_store().save()
    reloaded = store_mod.Store(get_store().path)
    assert reloaded.offline_vouchers[voucher["voucherId"]]["state"] == "PENDING_SETTLEMENT"
    assert reloaded.offline_vouchers[voucher["voucherId"]]["voucher"] == voucher
