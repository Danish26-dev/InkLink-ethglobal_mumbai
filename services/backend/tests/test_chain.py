"""0G Galileo InklinkRegistry sender: encoding, configuration gates and receipt handling.

The JSON-RPC endpoint is replaced by an in-memory fake that decodes and checks every signed
transaction; nothing here counts as on-chain proof. Live deployment is verified separately."""

from __future__ import annotations

import asyncio

import pytest
from eth_account import Account
from eth_utils import keccak

from app import chain, config
from app.store import get_store

KEY = "0x" + "11" * 32          # test-only key (never funded, never used outside tests)
REGISTRY = "0x" + "ab" * 20
CHAIN_ID = 16602


@pytest.fixture
def configured(monkeypatch):
    for k, v in {"ZERO_G_GALILEO_RPC_URL": "http://rpc.test", "ZERO_G_GALILEO_CHAIN_ID": str(CHAIN_ID),
                 "INKLINK_REGISTRY_ADDRESS": REGISTRY, "ZERO_G_GALILEO_SIGNER_PRIVATE_KEY": KEY}.items():
        monkeypatch.setenv(k, v)
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


class FakeRpc:
    """Accepts raw transactions, records their decoded calls, returns receipts."""

    def __init__(self, chain_id=CHAIN_ID, revert_selector: bytes | None = None):
        self.chain_id = chain_id
        self.sent: list[dict] = []
        self.revert_selector = revert_selector
        self.nonce = 0

    async def __call__(self, method, params):
        if method == "eth_chainId":
            return hex(self.chain_id)
        if method == "eth_estimateGas":
            return hex(90000)
        if method == "eth_gasPrice":
            return hex(3_000_000_000)
        if method == "eth_getTransactionCount":
            return hex(self.nonce)
        if method == "eth_sendRawTransaction":
            from eth_account._utils.legacy_transactions import Transaction  # decode the signed legacy tx

            tx = Transaction.from_bytes(bytes.fromhex(params[0][2:]))
            sender = Account.recover_transaction(params[0])
            self.sent.append({"to": "0x" + tx.to.hex(), "data": tx.data, "nonce": tx.nonce, "from": sender})
            self.nonce += 1
            return "0x" + f"{len(self.sent):064x}"
        if method == "eth_getTransactionReceipt":
            idx = int(params[0], 16) - 1
            reverted = self.revert_selector is not None and self.sent[idx]["data"][:4] == self.revert_selector
            return {"status": "0x0" if reverted else "0x1", "blockNumber": hex(1000 + idx)}
        raise AssertionError(method)


def test_not_configured_queues_but_never_sends():
    st = chain.status()
    assert st["status"] == "not_configured" and "rpcUrl" in st["missing"]
    rec = chain.queue("document_committed", "job_x", {"documentSha256": "0x" + "cd" * 32})
    assert rec["status"] == "pending_not_configured"
    assert asyncio.run(chain.send_pending()) == 0
    assert all("txHash" not in r for r in get_store().chain_outbox)


def test_bundled_abi_has_the_registry_functions(configured):
    st = chain.status()
    assert st["missing"] == [] and st["status"] == "configured_unverified"
    assert st["signer"] == Account.from_key(KEY).address


def test_encoding_matches_the_contract_signatures():
    sig, data = chain.encode_call({"kind": "document_committed", "jobId": "job_1", "data": {"documentSha256": "0x" + "cd" * 32}}, "shop_001")
    assert sig == "record(bytes32,uint8,bytes32)"
    assert data[:10] == "0x" + keccak(text=sig)[:4].hex()
    assert data.endswith("cd" * 32)
    sig, data = chain.encode_call({"kind": "job_registered", "jobId": "job_1", "data": {}}, "shop_001")
    assert sig == "registerJob(bytes32,bytes32)" and chain.shop_ref("shop_001")[2:] in data
    with pytest.raises(ValueError):
        chain.encode_call({"kind": "payment_verified", "jobId": "job_1", "data": {"hederaTxCommitment": "not-a-hash"}}, "shop_001")


def test_lifecycle_is_sent_in_order_with_shop_registration_and_receipts(configured, monkeypatch):
    rpc = FakeRpc()
    monkeypatch.setattr(chain, "_rpc", rpc)
    from app.store import JobRecord, now_iso

    ts = now_iso()
    get_store().jobs["job_1"] = JobRecord(job_id="job_1", shop_id="shop_001", owner="web_x", created_at=ts, updated_at=ts)
    chain.queue("job_registered", "job_1", {"jobCommitment": chain.commitment("job_1", "shop_001"), "shopId": "shop_001"})
    chain.queue("document_committed", "job_1", {"documentSha256": "0x" + "cd" * 32})
    chain.queue("payment_verified", "job_1", {"hederaTxCommitment": chain.commitment("0.0.1@1.2"), "network": "hedera:testnet"})
    assert asyncio.run(chain.send_pending()) == 4  # shop + job + document + payment
    sel = [s["data"][:4] for s in rpc.sent]
    assert sel == [keccak(text=f)[:4] for f in ("registerShop(bytes32,bytes32)", "registerJob(bytes32,bytes32)",
                                                  "record(bytes32,uint8,bytes32)", "record(bytes32,uint8,bytes32)")]
    assert all(s["to"].lower() == REGISTRY and s["from"] == Account.from_key(KEY).address for s in rpc.sent)
    assert [s["nonce"] for s in rpc.sent] == [0, 1, 2, 3]
    view = chain.chain_view("job_1")
    assert [r["status"] for r in view["records"]] == ["confirmed"] * 3
    assert view["records"][0]["explorerUrl"].startswith("https://chainscan-galileo.0g.ai/tx/0x")
    assert view["records"][1]["dataHash"] == "0x" + "cd" * 32
    assert chain.status()["status"] == "live"


def test_wrong_network_is_refused(configured, monkeypatch):
    monkeypatch.setattr(chain, "_rpc", FakeRpc(chain_id=1))
    chain.queue("document_committed", "job_2", {"documentSha256": "0x" + "cd" * 32})
    with pytest.raises(chain.ChainError):
        asyncio.run(chain.send_pending())
    assert all("txHash" not in r for r in get_store().chain_outbox)


def test_reverted_record_blocks_later_records_of_that_job(configured, monkeypatch):
    rpc = FakeRpc(revert_selector=keccak(text="record(bytes32,uint8,bytes32)")[:4])
    monkeypatch.setattr(chain, "_rpc", rpc)
    from app.store import JobRecord, now_iso

    ts = now_iso()
    get_store().jobs["job_3"] = JobRecord(job_id="job_3", shop_id="shop_001", owner="web_x", created_at=ts, updated_at=ts)
    chain.queue("job_registered", "job_3", {"jobCommitment": "0x" + "01" * 32, "shopId": "shop_001"})
    chain.queue("document_committed", "job_3", {"documentSha256": "0x" + "cd" * 32})
    chain.queue("quote_referenced", "job_3", {"quoteCommitment": "0x" + "ef" * 32})
    asyncio.run(chain.send_pending())
    statuses = [r["status"] for r in chain.records_for("job_3")]
    assert statuses == ["confirmed", "reverted", "pending"]   # never reported as on-chain
