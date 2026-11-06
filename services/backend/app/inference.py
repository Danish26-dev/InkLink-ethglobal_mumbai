"""Inference gateway for the Strands print operator.

The agent never holds a 0G key. For each run the backend issues a short-lived
inference grant bound to (job, run, trust mode, model). The agent's Strands
OpenAIModel uses:

    baseURL = {BACKEND_INTERNAL_URL}/api/v1/internal/inference/v1
    apiKey  = <grant>

and this gateway forwards each chat completion to 0G with the key and header
for exactly the granted trust mode. The grant cannot change the mode or the
model, and body-level routing overrides are stripped (see zerog.py).

Responses are fetched non-streaming so the TEE verification result is known
before any output reaches the agent; when the agent asked for a stream, the
verified response is replayed as OpenAI `chat.completion.chunk` SSE.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Iterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import zerog
from .security import tokens_equal
from .store import get_store, now_iso

GRANT_TTL_SECONDS = 15 * 60
MAX_INFERENCE_LOG = 30

router = APIRouter(prefix="/api/v1/internal/inference")


@dataclass
class Grant:
    token: str
    job_id: str
    run_id: str
    trust_mode: str
    model: str
    expires_at: float


_grants: dict[str, Grant] = {}


def issue_grant(job_id: str, run_id: str, trust_mode: str, model: str) -> Grant:
    now = time.time()
    for k, g in list(_grants.items()):
        if g.expires_at <= now:
            _grants.pop(k, None)
    g = Grant("igr_" + secrets.token_urlsafe(32), job_id, run_id, trust_mode, model, now + GRANT_TTL_SECONDS)
    _grants[g.token] = g
    return g


def revoke_grant(token: str) -> None:
    _grants.pop(token, None)


def _grant_for(request: Request) -> Grant | None:
    raw = request.headers.get("authorization", "")
    token = raw[7:].strip() if raw.lower().startswith("bearer ") else ""
    if not token:
        return None
    for g in list(_grants.values()):
        if tokens_equal(token, g.token):
            return g if g.expires_at > time.time() else None
    return None


def _openai_error(status: int, code: str, message: str) -> JSONResponse:
    # OpenAI-shaped so the agent's OpenAI client surfaces `message` verbatim.
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": "inklink_inference_error", "code": code}})


def _log(job_id: str, entry: dict[str, Any]) -> None:
    store = get_store()
    job = store.jobs.get(job_id)
    if not job:
        return
    with store.lock:
        job.inference_log = (job.inference_log + [entry])[-MAX_INFERENCE_LOG:]
        store.save()


def _sse(body: dict[str, Any]) -> Iterator[str]:
    """Replay a complete chat.completion as OpenAI-compatible stream chunks."""
    base = {"id": body.get("id", "chatcmpl-inklink"), "object": "chat.completion.chunk",
            "created": body.get("created", int(time.time())), "model": body.get("model", "")}
    choice = (body.get("choices") or [{}])[0]
    msg = choice.get("message") or {}

    def chunk(delta: dict[str, Any], finish: str | None = None) -> str:
        return "data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"

    yield chunk({"role": "assistant"})
    if msg.get("reasoning_content"):
        yield chunk({"reasoning_content": msg["reasoning_content"]})
    if msg.get("content"):
        yield chunk({"content": msg["content"]})
    for i, call in enumerate(msg.get("tool_calls") or []):
        fn = call.get("function") or {}
        yield chunk({"tool_calls": [{"index": i, "id": call.get("id"), "type": "function",
                                     "function": {"name": fn.get("name"), "arguments": fn.get("arguments") or "{}"}}]})
    yield chunk({}, choice.get("finish_reason") or ("tool_calls" if msg.get("tool_calls") else "stop"))
    if body.get("usage"):
        yield "data: " + json.dumps({**base, "choices": [], "usage": body["usage"]}) + "\n\n"
    yield "data: [DONE]\n\n"


@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    grant = _grant_for(request)
    if grant is None:
        return _openai_error(401, "INFERENCE_GRANT_INVALID", "Invalid or expired inference grant.")
    try:
        body = await request.json()
    except ValueError:
        return _openai_error(400, "BAD_REQUEST", "Body must be JSON.")
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return _openai_error(400, "BAD_REQUEST", "messages is required.")

    entry: dict[str, Any] = {"at": now_iso(), "runId": grant.run_id, "trustMode": grant.trust_mode, "model": grant.model}
    try:
        result = await zerog.chat_completion(grant.trust_mode, grant.model, body)
    except zerog.ZeroGError as exc:
        _log(grant.job_id, {**entry, "ok": False, "errorCode": exc.code})
        return _openai_error(exc.status, exc.code, exc.message)

    att = result.attestation or {}
    _log(grant.job_id, {**entry, "ok": True, "provider": result.provider, "requestId": result.request_id,
                        "teeVerified": result.tee_verified, "verification": result.verification,
                        "teeType": att.get("tee_type"), "teeVerifier": att.get("tee_verifier")})
    if body.get("stream"):
        return StreamingResponse(_sse(result.body), media_type="text/event-stream", headers={"cache-control": "no-cache"})
    return JSONResponse(result.body)
