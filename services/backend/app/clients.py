"""Outbound calls to the other Inklink services. All are bounded and typed.

The backend is the only component that may:
  - start a print-operator run (strands-agent),
  - submit a job to the printer adapter (/print),
  - start a payment with the payment agent.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from .config import get_settings
from .service_auth import auth_headers


async def engine_health() -> bool:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            res = await client.get(f"{s.document_engine_url}/health", headers=await auth_headers(s.document_engine_url))
            return res.status_code == 200
    except httpx.HTTPError:
        return False


class ServiceError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ───────────── strands-agent: print operator ─────────────

async def stream_operator_run(
    *,
    job_id: str,
    run_id: str,
    instruction: str,
    document: tuple[str, bytes] | None,
    defaults: dict[str, Any],
    current: dict[str, Any],
    inference: dict[str, Any] | None = None,
    mode: str = "ai",
) -> AsyncIterator[dict[str, Any]]:
    """Yield HarnessEvents from POST /api/operator/runs (NDJSON).

    `inference` carries the per-run grant for the backend's 0G gateway (no 0G key).
    """
    s = get_settings()
    if not s.agent_service_token:
        raise ServiceError("AGENT_NOT_CONFIGURED", "AGENT_SERVICE_TOKEN is not configured on the backend.")
    data = {
        "instruction": instruction,
        "jobId": job_id,
        "runId": run_id,
        "defaults": json.dumps(defaults),
        "current": json.dumps(current),
    }
    if inference:
        data["inference"] = json.dumps(inference)
    if mode == "deterministic":
        data["mode"] = "deterministic"
    files = {"file": (document[0], document[1])} if document else None
    timeout = httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{s.agent_url}/api/operator/runs",
                data=data,
                files=files,
                headers={"authorization": f"Bearer {s.agent_service_token}", **(await auth_headers(s.agent_url))},
            ) as res:
                if res.status_code != 200:
                    body = (await res.aread()).decode("utf-8", "ignore")
                    try:
                        err = json.loads(body).get("error", {})
                    except json.JSONDecodeError:
                        err = {}
                    raise ServiceError(err.get("code", "AGENT_ERROR"), err.get("message", f"Agent returned {res.status_code}."), res.status_code)
                async for line in res.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
    except httpx.ConnectError as exc:
        raise ServiceError("AGENT_UNREACHABLE", "The print operator service is not reachable.") from exc
    except httpx.TimeoutException as exc:
        raise ServiceError("AGENT_TIMEOUT", "The print operator service timed out.") from exc


async def agent_health() -> dict[str, Any] | None:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            res = await client.get(f"{s.agent_url}/api/health", headers=await auth_headers(s.agent_url))
            return res.json() if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


# ───────────── document engine ─────────────

async def fetch_engine_output(engine_job_id: str) -> bytes:
    s = get_settings()
    try:
        headers = await auth_headers(s.document_engine_url)
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(f"{s.document_engine_url}/jobs/{engine_job_id}/download", headers=headers)
            if res.status_code != 200:
                raise ServiceError("ENGINE_OUTPUT_MISSING", "The edited document could not be retrieved.", res.status_code)
            data = res.content
            await client.delete(f"{s.document_engine_url}/jobs/{engine_job_id}", headers=headers)  # scratch cleanup
            return data
    except httpx.HTTPError as exc:
        raise ServiceError("ENGINE_UNREACHABLE", "The document engine is not reachable.") from exc


# ───────────── local printer adapter ─────────────
#
# PRINTER_MODE=direct  HTTP to PRINTER_AGENT_URL (backend on the shop LAN).
# PRINTER_MODE=relay   through the shop gateway connector (cloud backend), see gateway_relay.py.

def _printer_headers() -> dict[str, str]:
    token = get_settings().printer_agent_token
    return {"x-printer-agent-token": token} if token else {}


async def printer_call(method: str, path: str, body: Any = None, timeout: float | None = None) -> tuple[int, Any]:
    """One printer adapter call -> (HTTP status, JSON body). Raises ServiceError when unreachable.

    Default timeout: 20 s direct; PRINTER_RELAY_TIMEOUT_SECONDS (30 s) through the relay,
    which covers the connector's own 20 s call to the local adapter plus the round trip.
    """
    s = get_settings()
    if s.printer_mode == "relay":
        from . import gateway_relay

        try:
            return await gateway_relay.request(method, path, body, timeout=timeout)
        except gateway_relay.RelayError as exc:
            raise ServiceError(exc.code, exc.message) from exc
    try:
        async with httpx.AsyncClient(timeout=timeout or 20.0) as client:
            res = await client.request(method, f"{s.printer_agent_url}{path}", json=body, headers=_printer_headers())
            return res.status_code, res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The local printer adapter is not reachable.") from exc


async def list_printers() -> dict[str, Any]:
    status, body = await printer_call("GET", "/printers")
    body = body if isinstance(body, dict) else {}
    if status != 200 or not body.get("ok"):
        raise ServiceError((body.get("error") or {}).get("code", "DISCOVERY_FAILED"), "Printer discovery failed.", status)
    return body


async def validate_print_config(config: dict[str, Any]) -> tuple[bool, list[str]]:
    status, body = await printer_call("POST", "/validate", {"config": config})
    if status == 502 or not isinstance(body, dict):
        raise ServiceError("DISCOVERY_FAILED", "Could not validate against the discovered printers.", 502)
    return bool(body.get("ok")), [str(e) for e in body.get("errors", [])]


async def submit_print(config: dict[str, Any], pdf_bytes: bytes) -> dict[str, Any]:
    import base64

    s = get_settings()
    if s.printer_mode == "relay":
        from . import gateway_relay

        # A short-lived reference instead of the file: the connector downloads it.
        token = gateway_relay.put_document(pdf_bytes)
        try:
            status, body = await printer_call(
                "POST", "/print",
                {"config": config, "document": {"token": token, "path": f"/api/v1/gateway/documents/{token}",
                                                "size": len(pdf_bytes), "contentType": "application/pdf"}},
                timeout=150.0,
            )
        finally:
            gateway_relay.drop_document(token)
    else:
        status, body = await printer_call(
            "POST", "/print",
            {"config": config, "documentBase64": base64.b64encode(pdf_bytes).decode("ascii")},
            timeout=120.0,
        )
    return {"httpStatus": status, **(body if isinstance(body, dict) else {})}


# ───────────── payment agent (Hedera x402) ─────────────

async def call_payment_agent(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.request(
                method,
                f"{s.payment_agent_url}{path}",
                json=body,
                headers={"authorization": f"Bearer {s.internal_api_token}", **(await auth_headers(s.payment_agent_url))},
            )
            try:
                return res.status_code, res.json()
            except ValueError:
                return res.status_code, None
    except httpx.HTTPError as exc:
        raise ServiceError("INTERNAL_ERROR", "Payment service is unreachable.") from exc
