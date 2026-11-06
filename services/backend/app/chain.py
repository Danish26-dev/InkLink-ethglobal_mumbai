"""0G Galileo: InklinkRegistry (contracts/contracts/InklinkRegistry.sol), a hash-only audit trail.

Lifecycle facts are queued in `store.chain_outbox` by the backend at the moment they become
true (job created, document uploaded, quote issued, Hedera settlement VERIFIED, execution
authorized, job completed). A background sender turns each record into a real transaction
once the registry is fully configured, and stores the transaction hash, block number and
receipt status it actually got back. Nothing is ever reported as on-chain without a receipt.

Only commitments are sent: 32-byte SHA-256 values of references and of the document bytes.
Never documents, file names, prompts, personal data, credentials or network addresses.

Boundaries:
  - 0G Galileo (this module): job/shop registry and lifecycle records.
  - Hedera: x402 HTS-USDC settlement (payment agent) and the agent's HCS spend log.
  - 0G Private Computer: AI inference (zerog.py). Unrelated to 0G Chain.

Configuration (all required to send):
  ZERO_G_GALILEO_RPC_URL, ZERO_G_GALILEO_CHAIN_ID (must equal the RPC's eth_chainId),
  INKLINK_REGISTRY_ADDRESS, ZERO_G_GALILEO_SIGNER_PRIVATE_KEY (an authorised writer, not the
  deployer), and the ABI (INKLINK_REGISTRY_ABI_PATH or the bundled app/abi/InklinkRegistry.json).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

import httpx

from .config import get_settings
from .store import get_store, now_iso

log = logging.getLogger("uvicorn.error")

RECORD_KINDS = (
    "shop_registered",
    "job_registered",
    "document_committed",
    "quote_referenced",
    "payment_verified",
    "execution_authorized",
    "job_completed",
    "job_failed",
)
# InklinkRegistry.Kind values for record(jobRef, kind, dataHash); job_registered uses registerJob.
_KIND_INDEX = {"document_committed": 1, "quote_referenced": 2, "payment_verified": 3,
               "execution_authorized": 4, "job_completed": 5, "job_failed": 6}
# The single data field each record commits to (all are 0x-prefixed SHA-256 hex).
_DATA_FIELD = {"document_committed": "documentSha256", "quote_referenced": "quoteCommitment",
               "payment_verified": "hederaTxCommitment", "execution_authorized": "jobCommitment",
               "job_completed": "jobCommitment", "job_failed": "jobCommitment"}
_BUNDLED_ABI = Path(__file__).resolve().parent / "abi" / "InklinkRegistry.json"
_REQUIRED_FUNCTIONS = ("registerShop", "registerJob", "record", "getJob")
_HEX32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
MAX_ATTEMPTS = 5
SEND_INTERVAL_SECONDS = 10.0


# ───────────── configuration ─────────────

def _abi() -> list[dict[str, Any]] | None:
    path = Path(get_settings().registry_abi_path) if get_settings().registry_abi_path else _BUNDLED_ABI
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    abi = data.get("abi", data) if isinstance(data, dict) else data
    names = {e.get("name") for e in abi if isinstance(e, dict) and e.get("type") == "function"} if isinstance(abi, list) else set()
    return abi if all(f in names for f in _REQUIRED_FUNCTIONS) else None


def _signer_address() -> str | None:
    key = get_settings().galileo_signer_private_key
    if not key:
        return None
    try:
        from eth_account import Account

        return Account.from_key(key).address
    except Exception:  # noqa: BLE001 - a malformed key is reported as "signer missing"
        return None


def status() -> dict[str, Any]:
    s = get_settings()
    checks = {
        "rpcUrl": bool(s.galileo_rpc_url),
        "chainId": s.galileo_chain_id.isdigit(),
        "registryAddress": bool(_ADDRESS.match(s.registry_address or "")),
        "registryAbi": _abi() is not None,
        "signer": _signer_address() is not None,
    }
    missing = [k for k, ok in checks.items() if not ok]
    outbox = get_store().chain_outbox
    counts: dict[str, int] = {}
    for r in outbox:
        counts[r.get("status", "?")] = counts.get(r.get("status", "?"), 0) + 1
    confirmed = sum(1 for r in outbox if r.get("status") == "confirmed")
    state = "not_configured" if missing else ("live" if confirmed else "configured_unverified")
    note = (f"Not configured ({', '.join(missing)} missing): records are queued locally, nothing is sent on-chain."
            if missing else "Records are sent to InklinkRegistry; only confirmed receipts count as on-chain."
            if confirmed else "Configured; no transaction has been confirmed yet.")
    return {
        "network": "0g-galileo-testnet",
        "chainId": s.galileo_chain_id or None,
        "status": state,
        "missing": missing,
        "contract": {"name": "InklinkRegistry", "address": s.registry_address or None,
                     "explorerUrl": f"{s.galileo_explorer_url}/address/{s.registry_address}" if checks["registryAddress"] else None},
        "signer": _signer_address(),
        "records": counts,
        "pendingRecords": sum(v for k, v in counts.items() if k.startswith("pending")),
        "note": note,
    }


# ───────────── commitments and queueing ─────────────

def commitment(*parts: str) -> str:
    """0x-prefixed SHA-256 over the given references (no raw content)."""
    return "0x" + hashlib.sha256("|".join(parts).encode()).hexdigest()


def job_ref(job_id: str) -> str:
    return commitment("inklink-job", job_id)


def shop_ref(shop_id: str) -> str:
    return commitment("inklink-shop", shop_id)


def queue(kind: str, job_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
    """Record a lifecycle fact for the registry. Only hashes/references are allowed in `data`."""
    if kind not in RECORD_KINDS:
        raise ValueError(f"unknown record kind {kind}")
    store = get_store()
    record = {"kind": kind, "jobId": job_id, "data": data, "at": now_iso(),
              "status": "pending_not_configured" if status()["missing"] else "pending", "attempts": 0}
    with store.lock:
        store.chain_outbox.append(record)
        store.save()
    return record


def records_for(job_id: str) -> list[dict[str, Any]]:
    return [r for r in get_store().chain_outbox if r.get("jobId") == job_id]


def public_record(r: dict[str, Any]) -> dict[str, Any]:
    """What a customer/shop/jury may see about a record (hashes, tx facts, explorer link)."""
    s = get_settings()
    tx = r.get("txHash")
    return {"kind": r.get("kind"), "status": r.get("status"), "at": r.get("at"),
            "dataHash": _data_hash(r) if r.get("kind") in _DATA_FIELD else None,
            "jobRef": job_ref(r["jobId"]) if r.get("jobId") else None,
            "txHash": tx, "blockNumber": r.get("blockNumber"), "confirmedAt": r.get("confirmedAt"),
            "explorerUrl": f"{s.galileo_explorer_url}/tx/{tx}" if tx else None,
            "error": r.get("lastError") if r.get("status") in ("failed", "reverted") else None}


def chain_view(job_id: str) -> dict[str, Any]:
    s = get_settings()
    return {"network": "0g-galileo-testnet", "chainId": s.galileo_chain_id or None,
            "contract": s.registry_address or None, "jobRef": job_ref(job_id),
            "records": [public_record(r) for r in records_for(job_id)]}


# ───────────── encoding ─────────────

def _data_hash(r: dict[str, Any]) -> str | None:
    v = (r.get("data") or {}).get(_DATA_FIELD.get(r.get("kind"), ""))
    return v if isinstance(v, str) and _HEX32.match(v) else None


def encode_call(r: dict[str, Any], shop_id: str | None) -> tuple[str, str]:
    """(function signature, 0x calldata) for one outbox record. Raises ValueError if it can't be encoded."""
    from eth_abi import encode
    from eth_utils import keccak

    def b32(h: str) -> bytes:
        return bytes.fromhex(h[2:])

    kind = r.get("kind")
    if kind == "shop_registered":
        sig, types, args = "registerShop(bytes32,bytes32)", ["bytes32", "bytes32"], [
            b32(shop_ref(r["data"]["shopId"])), b32(commitment("inklink-shop-meta", r["data"]["shopId"]))]
    elif kind == "job_registered":
        if not shop_id:
            raise ValueError("job_registered needs the shop id")
        sig, types, args = "registerJob(bytes32,bytes32)", ["bytes32", "bytes32"], [b32(job_ref(r["jobId"])), b32(shop_ref(shop_id))]
    elif kind in _KIND_INDEX:
        h = _data_hash(r)
        if not h or not r.get("jobId"):
            raise ValueError(f"{kind} has no valid 32-byte commitment")
        sig, types, args = "record(bytes32,uint8,bytes32)", ["bytes32", "uint8", "bytes32"], [
            b32(job_ref(r["jobId"])), _KIND_INDEX[kind], b32(h)]
    else:
        raise ValueError(f"unsupported record kind {kind}")
    return sig, "0x" + (keccak(text=sig)[:4] + encode(types, args)).hex()


# ───────────── sending ─────────────

class ChainError(Exception):
    pass


async def _rpc(method: str, params: list[Any]) -> Any:
    s = get_settings()
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(s.galileo_rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    body = res.json()
    if body.get("error"):
        raise ChainError(str(body["error"].get("message", body["error"]))[:300])
    return body.get("result")


async def _send_record(r: dict[str, Any], shop_id: str | None) -> None:
    """Sign and submit one record, wait for its receipt, and store what really happened."""
    from eth_account import Account
    from eth_utils import to_checksum_address

    s = get_settings()
    _sig, data = encode_call(r, shop_id)
    account = Account.from_key(s.galileo_signer_private_key)
    to = to_checksum_address(s.registry_address)
    tx: dict[str, Any] = {"from": account.address, "to": to, "data": data}
    gas = int(await _rpc("eth_estimateGas", [{**tx, "value": "0x0"}]), 16)
    signed = account.sign_transaction({
        "to": to, "data": data, "value": 0, "chainId": int(s.galileo_chain_id),
        "nonce": int(await _rpc("eth_getTransactionCount", [account.address, "pending"]), 16),
        "gas": gas * 12 // 10, "gasPrice": int(await _rpc("eth_gasPrice", []), 16),
    })
    tx_hash = await _rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    store = get_store()
    with store.lock:
        r.update(status="submitted", txHash=tx_hash)
        store.save()
    for _ in range(30):
        receipt = await _rpc("eth_getTransactionReceipt", [tx_hash])
        if receipt:
            ok = receipt.get("status") == "0x1"
            with store.lock:
                r.update(status="confirmed" if ok else "reverted", blockNumber=int(receipt["blockNumber"], 16),
                         confirmedAt=now_iso(), **({} if ok else {"lastError": "Transaction reverted."}))
                store.save()
            return
        await asyncio.sleep(2)
    raise ChainError("No receipt yet; will check again.")


async def send_pending() -> int:
    """Send queued records in order. Returns how many were confirmed in this pass."""
    st = status()
    store = get_store()
    if st["missing"]:
        return 0
    if int(await _rpc("eth_chainId", []), 16) != int(get_settings().galileo_chain_id):
        # Never send to a different network than the one configured.
        raise ChainError("The RPC's chain id differs from ZERO_G_GALILEO_CHAIN_ID; nothing was sent.")
    done = 0
    blocked_jobs: set[str] = set()
    registered_shops = {r["data"].get("shopId") for r in store.chain_outbox
                        if r.get("kind") == "shop_registered" and r.get("status") == "confirmed"}
    for r in list(store.chain_outbox):
        if r.get("status") == "pending_not_configured":
            r["status"] = "pending"
        if r.get("status") == "submitted" and r.get("txHash"):
            receipt = await _rpc("eth_getTransactionReceipt", [r["txHash"]])
            if receipt:
                ok = receipt.get("status") == "0x1"
                r.update(status="confirmed" if ok else "reverted", blockNumber=int(receipt["blockNumber"], 16), confirmedAt=now_iso())
            continue
        if r.get("status") != "pending" or (r.get("jobId") in blocked_jobs):
            continue
        job = store.jobs.get(r.get("jobId") or "")
        shop_id = job.shop_id if job else (r.get("data") or {}).get("shopId")
        if r.get("kind") == "job_registered" and shop_id and shop_id not in registered_shops:
            shop_rec = {"kind": "shop_registered", "jobId": None, "data": {"shopId": shop_id}, "at": now_iso(),
                        "status": "pending", "attempts": 0}
            with store.lock:
                store.chain_outbox.insert(store.chain_outbox.index(r), shop_rec)
            try:
                await _send_record(shop_rec, shop_id)
            except Exception as exc:  # noqa: BLE001
                shop_rec.update(attempts=1, lastError=str(exc)[:300])
                blocked_jobs.add(r.get("jobId"))
                continue
            if shop_rec.get("status") != "confirmed":
                blocked_jobs.add(r.get("jobId"))
                continue
            registered_shops.add(shop_id)
            done += 1
        try:
            await _send_record(r, shop_id)
            done += r.get("status") == "confirmed"
        except Exception as exc:  # noqa: BLE001 - keep order: later records of this job wait
            r["attempts"] = int(r.get("attempts") or 0) + 1
            r["lastError"] = str(exc)[:300]
            if r["attempts"] >= MAX_ATTEMPTS:
                r["status"] = "failed"
            if r.get("jobId"):
                blocked_jobs.add(r["jobId"])
        if r.get("status") in ("reverted",) and r.get("jobId"):
            blocked_jobs.add(r["jobId"])
    with store.lock:
        store.save()
    return done


async def sender_loop() -> None:
    while True:
        await asyncio.sleep(SEND_INTERVAL_SECONDS)
        try:
            await send_pending()
        except Exception as exc:  # noqa: BLE001 - logged, retried next tick
            log.warning("0G Galileo sender: %s", str(exc)[:200])
