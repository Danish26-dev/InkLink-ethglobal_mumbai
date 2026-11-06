"""Document retention: delete uploaded and edited files after the configured time.

Files of a job are deleted DOCUMENT_RETENTION_HOURS after its last change,
except while the job is paid and waiting to print or printing. Job metadata
(status, quote, events) is kept; the document is marked `purged`.
"""

from __future__ import annotations

import asyncio
import shutil
from datetime import datetime, timezone

from .config import get_settings
from .store import get_store

KEEP_STATUSES = ("awaiting_execution", "executing")
SWEEP_INTERVAL_SECONDS = 600


def _age_hours(iso: str) -> float:
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


def purge_expired() -> list[str]:
    """Delete expired document files. Returns the affected job ids."""
    s = get_settings()
    store = get_store()
    purged: list[str] = []
    with store.lock:
        for job in store.jobs.values():
            doc = job.document
            if not doc or doc.purged or job.status in KEEP_STATUSES or job.run_active:
                continue
            if _age_hours(job.updated_at) < s.document_retention_hours:
                continue
            shutil.rmtree(s.data_dir / "documents" / job.job_id, ignore_errors=True)
            doc.purged = True
            doc.edited_path = None
            purged.append(job.job_id)
        if purged:
            store.save()
    return purged


async def retention_loop() -> None:
    while True:
        try:
            purge_expired()
        except Exception:  # noqa: BLE001 - a failed sweep retries on the next interval
            pass
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
