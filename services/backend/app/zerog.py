"""0G Private Computer provider layer (server-side only).

One API key per trust mode (ZERO_G_STANDARD/VERIFIED/PRIVATE_API_KEY). Every
call is made with the key for the requested mode AND the routing header
`X-0G-Provider-Trust-Mode: <mode>`, so the tier is enforced twice: by the key's
own trust setting at pc.0g.ai and by the per-request floor.

Rules (from the 0G Router docs: routing, privacy, verifiable execution):
  - Tiers are ordered standard < verified < private and act as a floor.
  - private  -> TeeML providers only (sealed inference).
  - verified -> TeeML or TeeTLS (verifiable; the upstream may see plaintext).
  - standard -> any provider, no attestation.
  - With no qualifying provider the Router answers 503
    `no_provider_for_trust_mode`. We surface that and NEVER retry with a
    weaker mode or another key.
  - For verified/private we send `verify_tee: true` and require
    `x_0g_trace.tee_verified == true`; anything else is treated as untrusted.
    We never invent an attestation result.
  - The deprecated JSON-body `provider` routing object is stripped so a caller
    cannot override the tier from the body.

Keys never leave this module: errors and status objects carry no secret.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import TRUST_MODES, get_settings

TRUST_HEADER = "X-0G-Provider-Trust-Mode"
_RANK = {m: i for i, m in enumerate(TRUST_MODES)}

# Catalog `verifiability` values that satisfy each tier.
_TIER_VERIFIABILITY = {
    "standard": None,  # any model in the catalog
    "verified": {"TeeML", "TeeTLS"},
    "private": {"TeeML"},
}


class ZeroGError(Exception):
    """A safe, user-presentable inference failure (no secrets, no content)."""

    def __init__(self, code: str, message: str, status: int = 503, retryable: bool = False) -> None:
        super().__init__(message)
        self.code, self.message, self.status, self.retryable = code, message, status, retryable

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message}


def rank(mode: str) -> int:
    if mode not in _RANK:
        raise ZeroGError("INVALID_TRUST_MODE", f'Unknown trust mode "{mode}". Use standard, verified or private.', 400)
    return _RANK[mode]


def strictest(*modes: str | None) -> str:
    present = [m for m in modes if m]
    for m in present:
        rank(m)
    return max(present, key=rank) if present else "private"


def key_for(mode: str) -> str:
    """The API key for exactly this trust mode. Never substitutes another mode's key."""
    rank(mode)
    key = get_settings().zero_g_keys.get(mode, "")
    if not key:
        raise ZeroGError(
            "ZERO_G_KEY_MISSING",
            f"ZERO_G_{mode.upper()}_API_KEY is not configured on the backend, so {mode} inference is unavailable. "
            "Inklink does not use another trust mode's key instead.",
            503,
        )
    return key


def model_for(mode: str) -> str:
    rank(mode)
    return get_settings().zero_g_models.get(mode) or ""


def headers_for(mode: str) -> dict[str, str]:
    return {"authorization": f"Bearer {key_for(mode)}", "content-type": "application/json", TRUST_HEADER: mode}


def status() -> dict[str, Any]:
    """Non-secret configuration summary for dashboards and health checks."""
    s = get_settings()
    return {
        "baseUrl": s.zero_g_base_url,
        "defaultTrustMode": s.zero_g_default_trust_mode,
        "requireTeeVerification": s.zero_g_require_tee_verification,
        "modes": {m: {"configured": bool(s.zero_g_keys.get(m)), "model": s.zero_g_models.get(m)} for m in TRUST_MODES},
    }


# ───────────── model catalog (public, no auth) ─────────────

_catalog: dict[str, Any] = {"at": 0.0, "models": {}}


async def catalog(force: bool = False) -> dict[str, dict[str, Any]]:
    s = get_settings()
    if not force and _catalog["models"] and time.time() - _catalog["at"] < s.zero_g_catalog_ttl_seconds:
        return _catalog["models"]
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(f"{s.zero_g_base_url}/models")
            data = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ZeroGError("ZERO_G_CATALOG_UNAVAILABLE", "The 0G model catalog is not reachable, so model trust support cannot be confirmed.", 503, True) from exc
    if res.status_code != 200 or not isinstance(data, dict):
        raise ZeroGError("ZERO_G_CATALOG_UNAVAILABLE", f"The 0G model catalog returned {res.status_code}.", 503, True)
    models = {m["id"]: m for m in data.get("data", []) if isinstance(m, dict) and m.get("id")}
    _catalog.update(at=time.time(), models=models)
    return models


def check_model(models: dict[str, dict[str, Any]], model: str, mode: str, *, needs_tools: bool) -> None:
    """Fail clearly when a model cannot serve a trust mode (no downgrade, no substitution)."""
    rank(mode)
    entry = models.get(model)
    if entry is None:
        raise ZeroGError("ZERO_G_MODEL_UNKNOWN", f'Model "{model}" is not in the 0G catalog.', 400)
    allowed = _TIER_VERIFIABILITY[mode]
    if allowed is not None and entry.get("verifiability") not in allowed:
        raise ZeroGError(
            "ZERO_G_MODEL_TRUST_UNSUPPORTED",
            f'Model "{model}" does not list a {mode}-capable provider (verifiability: {entry.get("verifiability") or "none"}). '
            f"Choose a model with {' or '.join(sorted(allowed))} for {mode} inference.",
            400,
        )
    if needs_tools and "tools" not in (entry.get("supported_parameters") or []):
        raise ZeroGError("ZERO_G_MODEL_NO_TOOLS", f'Model "{model}" does not support tool calling, which the print operator needs.', 400)


async def preflight(mode: str, *, needs_tools: bool = True) -> str:
    """Confirm key + model + tier before any document content is sent. Returns the model id."""
    key_for(mode)
    model = model_for(mode)
    if not model:
        raise ZeroGError("ZERO_G_MODEL_MISSING", f"No 0G model is configured for {mode} inference.", 503)
    check_model(await catalog(), model, mode, needs_tools=needs_tools)
    return model


# ───────────── chat completions ─────────────

@dataclass
class InferenceResult:
    body: dict[str, Any]
    trust_mode: str
    model: str
    provider: str | None
    request_id: str | None
    tee_verified: bool | None


_ERROR_MESSAGES = {
    "no_provider_for_trust_mode": "No 0G provider is available for {mode} inference with model {model} right now. "
    "Inklink does not fall back to a weaker trust mode.",
    "insufficient_balance": "The 0G account for {mode} inference has insufficient balance.",
    "invalid_api_key": "The configured 0G {mode} API key was rejected.",
    "api_key_revoked": "The configured 0G {mode} API key has been revoked.",
    "invalid_trust_mode": "0G rejected the trust mode {mode}.",
}


def _upstream_error(res: httpx.Response, mode: str, model: str) -> ZeroGError:
    try:
        err = (res.json() or {}).get("error") or {}
    except ValueError:
        err = {}
    code = str(err.get("code") or "")
    template = _ERROR_MESSAGES.get(code)
    message = template.format(mode=mode, model=model) if template else f"0G inference failed ({res.status_code}{', ' + code if code else ''})."
    return ZeroGError(
        f"ZERO_G_{(code or 'HTTP_' + str(res.status_code)).upper()}",
        message,
        502 if res.status_code >= 500 else res.status_code,
        retryable=res.status_code in (429, 502, 503),
    )


def sanitize_request(body: dict[str, Any], model: str) -> dict[str, Any]:
    """Pin the model and remove every body-level routing override."""
    clean = {k: v for k, v in body.items() if k not in ("provider", "verify_tee", "model", "stream", "stream_options")}
    clean["model"] = model
    clean["stream"] = False
    return clean


async def chat_completion(mode: str, model: str, body: dict[str, Any]) -> InferenceResult:
    """One non-streaming call in exactly `mode`. Raises ZeroGError; never retries in another mode."""
    s = get_settings()
    headers = headers_for(mode)
    payload = sanitize_request(body, model)
    verify = mode in ("verified", "private")
    if verify:
        payload["verify_tee"] = True
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=180.0, write=30.0, pool=10.0)) as client:
            res = await client.post(f"{s.zero_g_base_url}/chat/completions", json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        raise ZeroGError("ZERO_G_TIMEOUT", f"0G {mode} inference timed out.", 504, True) from exc
    except httpx.HTTPError as exc:
        raise ZeroGError("ZERO_G_UNREACHABLE", "The 0G router is not reachable.", 503, True) from exc
    if res.status_code != 200:
        raise _upstream_error(res, mode, model)
    try:
        data = res.json()
    except ValueError as exc:
        raise ZeroGError("ZERO_G_BAD_RESPONSE", "0G returned a response that is not JSON.", 502) from exc

    trace = data.get("x_0g_trace") if isinstance(data, dict) else None
    trace = trace if isinstance(trace, dict) else {}
    tee = trace.get("tee_verified")
    tee_verified = tee if isinstance(tee, bool) else None
    if verify and s.zero_g_require_tee_verification and tee_verified is not True:
        raise ZeroGError(
            "ZERO_G_TEE_VERIFICATION_FAILED" if tee_verified is False else "ZERO_G_TEE_VERIFICATION_MISSING",
            f"The {mode} response could not be confirmed by 0G TEE verification "
            f"(tee_verified={'false' if tee_verified is False else 'absent'}); the output was discarded.",
            502,
        )
    return InferenceResult(
        body=data,
        trust_mode=mode,
        model=model,
        provider=str(trace["provider"]) if trace.get("provider") else None,
        request_id=str(trace["request_id"]) if trace.get("request_id") else res.headers.get("ZG-Res-Key"),
        tee_verified=tee_verified,
    )
