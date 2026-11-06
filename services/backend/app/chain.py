"""0G Galileo testnet integration: InklinkShopRegistry and InklinkJobRegistry.

STATUS: not deployed / not in this repository. The Solidity sources and ABIs
are not present, so this module does NOT invent addresses or function
signatures. It provides:

  - `status()`: which pieces are configured (RPC, chain id, addresses, ABI
    files, signer). Anything missing -> `not_configured`.
  - `queue(kind, job_id, data)`: records lifecycle facts in a local outbox
    (`store.chain_outbox`) as `pending_not_configured`, so they can be sent
    once the contracts and ABIs exist.
  - `commitment(...)`: the only data ever allowed on-chain — hashes and
    references. Never documents, PII, instructions, credentials or gateway
    addresses.

Boundaries (enforced by the callers):
  - 0G Galileo: shop registry, job registry, lifecycle records.
  - Hedera: x402 USDC settlement (payment agent) and HCS audit.
  - A payment reference is queued only AFTER the backend verified the
    Hedera settlement callback; there is no payment contract on 0G.

To finish the integration: put the ABI JSON files next to the backend, set
INKLINK_*_ABI_PATH / *_ADDRESS / ZERO_G_GALILEO_* and implement `_send()`
with the ABI's real function names (see docs/SMART_CONTRACT_INTEGRATION.md).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .config import get_settings
from .store import get_store, now_iso

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


def _abi_ok(path: str) -> bool:
    if not path:
        return False
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    abi = data.get("abi", data) if isinstance(data, dict) else data
    return isinstance(abi, list) and len(abi) > 0


def status() -> dict[str, Any]:
    s = get_settings()
    checks = {
        "rpcUrl": bool(s.galileo_rpc_url),
        "chainId": bool(s.galileo_chain_id),
        "shopRegistryAddress": bool(s.shop_registry_address),
        "jobRegistryAddress": bool(s.job_registry_address),
        "shopRegistryAbi": _abi_ok(s.shop_registry_abi_path),
        "jobRegistryAbi": _abi_ok(s.job_registry_abi_path),
        "signer": bool(s.galileo_signer_private_key),
    }
    missing = [k for k, ok in checks.items() if not ok]
    pending = sum(1 for r in get_store().chain_outbox if r.get("status") == "pending_not_configured")
    return {
        "network": "0g-galileo-testnet",
        "status": "not_configured" if missing else "configured_unverified",
        "missing": missing,
        "contracts": {
            "InklinkShopRegistry": s.shop_registry_address or None,
            "InklinkJobRegistry": s.job_registry_address or None,
        },
        "pendingRecords": pending,
        "note": "Contracts are not deployed from this repository yet; records are queued locally, nothing is sent on-chain.",
    }


def commitment(*parts: str) -> str:
    """0x-prefixed SHA-256 over the given references (no raw content)."""
    return "0x" + hashlib.sha256("|".join(parts).encode()).hexdigest()


def queue(kind: str, job_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
    """Record a lifecycle fact for the registries. Only hashes/references are allowed in `data`."""
    if kind not in RECORD_KINDS:
        raise ValueError(f"unknown record kind {kind}")
    store = get_store()
    record = {"kind": kind, "jobId": job_id, "data": data, "at": now_iso(),
              "status": "pending_not_configured" if status()["missing"] else "pending"}
    with store.lock:
        store.chain_outbox.append(record)
        store.save()
    return record


def records_for(job_id: str) -> list[dict[str, Any]]:
    return [r for r in get_store().chain_outbox if r.get("jobId") == job_id]
