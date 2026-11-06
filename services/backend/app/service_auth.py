"""Service-to-service authentication for private Cloud Run services.

With SERVICE_AUTH=gcp-id-token the backend adds a Google-signed ID token for the
target service to every call to the strands-agent, the document engine and the
payment agent. The token is sent in `X-Serverless-Authorization`, which Cloud Run
IAM checks, so the app-level `Authorization: Bearer <service token>` is unchanged
and still verified by each service.

Tokens come from the Cloud Run metadata server (the runtime service account; no key
files) and are cached per audience until shortly before they expire. Locally and in
docker compose SERVICE_AUTH is empty and no header is added.
"""

from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlsplit

import httpx

from .config import get_settings

log = logging.getLogger("inklink.service_auth")

METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
HEADER = "X-Serverless-Authorization"
_TOKEN_TTL_SECONDS = 50 * 60  # Google ID tokens are valid for 1 hour

_cache: dict[str, tuple[str, float]] = {}
_lock = asyncio.Lock()


def audience_for(url: str) -> str:
    """Cloud Run accepts the service's base URL (scheme + host) as the audience."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


async def _fetch_id_token(audience: str) -> str:
    async with httpx.AsyncClient(timeout=5.0) as client:
        res = await client.get(
            METADATA_IDENTITY_URL,
            params={"audience": audience, "format": "full"},
            headers={"Metadata-Flavor": "Google"},
        )
        res.raise_for_status()
        return res.text.strip()


async def auth_headers(url: str) -> dict[str, str]:
    """Headers to add to a call to `url`. Empty unless SERVICE_AUTH=gcp-id-token."""
    if get_settings().service_auth != "gcp-id-token":
        return {}
    audience = audience_for(url)
    cached = _cache.get(audience)
    if cached and cached[1] > time.time():
        return {HEADER: f"Bearer {cached[0]}"}
    async with _lock:
        cached = _cache.get(audience)
        if cached and cached[1] > time.time():
            return {HEADER: f"Bearer {cached[0]}"}
        try:
            token = await _fetch_id_token(audience)
        except httpx.HTTPError as exc:
            # The call proceeds without the header and fails with 401/403 from Cloud Run,
            # which the caller already maps to a typed "unreachable/forbidden" error.
            log.warning("Could not obtain an ID token for %s: %s", audience, type(exc).__name__)
            return {}
        _cache[audience] = (token, time.time() + _TOKEN_TTL_SECONDS)
        return {HEADER: f"Bearer {token}"}


def clear_cache_for_tests() -> None:
    _cache.clear()
