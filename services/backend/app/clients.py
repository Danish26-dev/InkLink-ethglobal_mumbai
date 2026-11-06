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
    files = {"file": (document[0], document[1])} if document else None
    timeout = httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{s.agent_url}/api/operator/runs",
                data=data,
                files=files,
                headers={"authorization": f"Bearer {s.agent_service_token}"},
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
            res = await client.get(f"{s.agent_url}/api/health")
            return res.json() if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


# ───────────── document engine ─────────────

async def fetch_engine_output(engine_job_id: str) -> bytes:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(f"{s.document_engine_url}/jobs/{engine_job_id}/download")
            if res.status_code != 200:
                raise ServiceError("ENGINE_OUTPUT_MISSING", "The edited document could not be retrieved.", res.status_code)
            data = res.content
            await client.delete(f"{s.document_engine_url}/jobs/{engine_job_id}")  # scratch cleanup
            return data
    except httpx.HTTPError as exc:
        raise ServiceError("ENGINE_UNREACHABLE", "The document engine is not reachable.") from exc


# ───────────── local printer adapter ─────────────

def _printer_headers() -> dict[str, str]:
    token = get_settings().printer_agent_token
    return {"x-printer-agent-token": token} if token else {}


async def list_printers() -> dict[str, Any]:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            res = await client.get(f"{s.printer_agent_url}/printers", headers=_printer_headers())
            body = res.json()
            if res.status_code != 200 or not body.get("ok"):
                raise ServiceError(body.get("error", {}).get("code", "DISCOVERY_FAILED"), "Printer discovery failed.", res.status_code)
            return body
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The local printer adapter is not reachable.") from exc


async def validate_print_config(config: dict[str, Any]) -> tuple[bool, list[str]]:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            res = await client.post(f"{s.printer_agent_url}/validate", json={"config": config}, headers=_printer_headers())
            body = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The local printer adapter is not reachable.") from exc
    if res.status_code == 502:
        raise ServiceError("DISCOVERY_FAILED", "Could not validate against the discovered printers.", 502)
    return bool(body.get("ok")), [str(e) for e in body.get("errors", [])]


async def submit_print(config: dict[str, Any], pdf_bytes: bytes) -> dict[str, Any]:
    import base64

    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.post(
                f"{s.printer_agent_url}/print",
                json={"config": config, "documentBase64": base64.b64encode(pdf_bytes).decode("ascii")},
                headers=_printer_headers(),
            )
            return {"httpStatus": res.status_code, **res.json()}
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceError("PRINTER_ADAPTER_UNREACHABLE", "The local printer adapter is not reachable.") from exc


# ───────────── payment agent (Hedera x402) ─────────────

async def call_payment_agent(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.request(
                method,
                f"{s.payment_agent_url}{path}",
                json=body,
                headers={"authorization": f"Bearer {s.internal_api_token}"},
            )
            try:
                return res.status_code, res.json()
            except ValueError:
                return res.status_code, None
    except httpx.HTTPError as exc:
        raise ServiceError("INTERNAL_ERROR", "Payment service is unreachable.") from exc
