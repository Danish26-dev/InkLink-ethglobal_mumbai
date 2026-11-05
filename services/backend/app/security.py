"""Wire-format and auth primitives (agreed contracts, docs/API_CONTRACTS.md).

- canonical JSON + unpadded Base64URL, byte-compatible with
  packages/shared-schemas/src/wire-format.ts
- Ed25519 gateway identity: signs the shop QR and the pairing challenge
- HMAC-SHA256 verification of the payment agent's settlement callback
- opaque bearer tokens for web, native and shop principals
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

CALLBACK_MAX_AGE_SECONDS = 300
TIMESTAMP_HEADER = "x-inklink-timestamp"
SIGNATURE_HEADER = "x-inklink-signature"


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, None-valued object fields omitted."""

    def strip(v: Any) -> Any:
        if isinstance(v, dict):
            return {k: strip(x) for k, x in v.items() if x is not None}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v

    return json.dumps(strip(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class GatewayIdentity:
    """Ed25519 key that identifies this shop gateway."""

    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._key = private_key
        raw = private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.public_key = b64url_encode(raw)

    @classmethod
    def from_seed(cls, seed: bytes) -> "GatewayIdentity":
        return cls(Ed25519PrivateKey.from_private_bytes(seed))

    @classmethod
    def load_or_create(cls, path: Path) -> "GatewayIdentity":
        """Persist the key so the QR the app pinned stays valid across restarts."""
        if path.exists():
            return cls.from_seed(path.read_bytes())
        path.parent.mkdir(parents=True, exist_ok=True)
        seed = secrets.token_bytes(32)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(seed)
        return cls.from_seed(seed)

    def sign(self, text: str) -> str:
        return b64url_encode(self._key.sign(text.encode("utf-8")))


def build_qr_payload(
    identity: GatewayIdentity,
    *,
    shop_id: str,
    gateway_id: str,
    mdns: str,
    port: int,
    ip: str | None,
    ttl_seconds: int,
    nonce: str | None = None,
    expires_at: str | None = None,
) -> dict[str, Any]:
    from .store import iso_from_epoch

    unsigned = {
        "type": "inklink_shop",
        "version": "1.0",
        "shopId": shop_id,
        "gatewayId": gateway_id,
        "gateway": {"discovery": "local", "mdns": mdns, "ip": ip or None, "port": port},
        "publicKey": identity.public_key,
        "nonce": nonce or b64url_encode(secrets.token_bytes(12)),
        "expiresAt": expires_at or iso_from_epoch(time.time() + ttl_seconds),
    }
    signed = json.loads(canonical_json(unsigned))
    signed["signature"] = identity.sign(canonical_json(unsigned))
    return signed


def callback_signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + raw_body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify_callback(raw_body: bytes, headers: dict[str, str], secret: str, now: float | None = None) -> str | None:
    """Return None when valid, otherwise the rejection reason."""
    ts = headers.get(TIMESTAMP_HEADER)
    sig = headers.get(SIGNATURE_HEADER)
    if not ts or not sig or not ts.isdigit():
        return "MISSING_HEADERS"
    if abs((now if now is not None else time.time()) - int(ts)) > CALLBACK_MAX_AGE_SECONDS:
        return "STALE_TIMESTAMP"
    if not hmac.compare_digest(callback_signature(secret, ts, raw_body), sig):
        return "BAD_SIGNATURE"
    return None


def new_token() -> str:
    return b64url_encode(secrets.token_bytes(32))


def tokens_equal(a: str, b: str) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a.encode(), b.encode())


def hashscan_for(transaction_id: str) -> str:
    """0.0.123@1700000000.000000001 -> .../0.0.123-1700000000-000000001 (as the mock)."""
    head, _, tail = transaction_id.partition("@")
    seconds, _, nanos = tail.partition(".")
    return f"https://hashscan.io/testnet/transaction/{head}-{seconds}-{nanos}"
