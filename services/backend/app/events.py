"""Per-job event log and SSE fan-out.

Every event gets a monotonically increasing `seq` per job (the SSE `id`), is
appended to the job's log (so a reconnecting client resumes with
`Last-Event-ID`), and is pushed to every live subscriber.
"""

from __future__ import annotations

import asyncio
from typing import Any

from . import gateway_relay
from .store import MAX_EVENTS_PER_JOB, get_store, now_iso

# Fields that never leave the backend (internal service identifiers).
_INTERNAL_PAYLOAD_FIELDS = {"engineJobId"}

_subscribers: dict[str, set[asyncio.Queue]] = {}


def publish(job_id: str, type_: str, payload: dict[str, Any], source: str = "backend") -> dict[str, Any]:
    store = get_store()
    with store.lock:
        log = store.events.setdefault(job_id, [])
        seq = (log[-1]["seq"] + 1) if log else 1
        clean = {k: v for k, v in payload.items() if k not in _INTERNAL_PAYLOAD_FIELDS}
        event = {"seq": seq, "jobId": job_id, "type": type_, "source": source, "ts": now_iso(), "payload": clean}
        log.append(event)
        if len(log) > MAX_EVENTS_PER_JOB:
            del log[: len(log) - MAX_EVENTS_PER_JOB]
        store.save()
    for queue in list(_subscribers.get(job_id, ())):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # slow client; it resumes from the log with Last-Event-ID
    gateway_relay.on_event(event)  # status for the shop's ESP32 display (relay mode only)
    return event


def history(job_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
    store = get_store()
    with store.lock:
        return [e for e in store.events.get(job_id, []) if e["seq"] > after_seq]


def subscribe(job_id: str) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _subscribers.setdefault(job_id, set()).add(queue)
    return queue


def unsubscribe(job_id: str, queue: asyncio.Queue) -> None:
    subs = _subscribers.get(job_id)
    if subs:
        subs.discard(queue)
        if not subs:
            _subscribers.pop(job_id, None)


def publish_job_status(job) -> None:
    publish(
        job.job_id,
        "job_status_updated",
        {"status": job.status, "paymentStatus": job.payment_status, "deviceStatus": job.device_status},
    )
