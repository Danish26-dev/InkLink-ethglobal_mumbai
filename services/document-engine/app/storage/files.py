"""Job-scoped temporary file storage for the Document Engine.

Every processing request gets an isolated job directory under WORK_DIR. This
keeps a job's uploaded, intermediate, and output files together and makes
cleanup a single directory delete.

This layer is intentionally simple (local filesystem scratch space). It is NOT
the system of record: the Inklink backend owns the authoritative job lifecycle
and status. The engine only needs a safe per-request workspace it can wipe.
"""

from __future__ import annotations

import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from ..config import get_settings

# Job ids are uuid4().hex: exactly 32 lowercase hex characters. Anything else is
# rejected before it is used to build a filesystem path.
_JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


@dataclass
class Job:
    """A single processing job with its own working directory."""

    job_id: str
    dir: Path

    def path(self, filename: str) -> Path:
        """Return a path inside the job dir, guarding against traversal."""
        safe = Path(filename).name  # strip any directory components
        if not safe or safe in (".", ".."):
            safe = "file"
        return self.dir / safe


def create_job() -> Job:
    settings = get_settings()
    job_id = uuid.uuid4().hex
    job_dir = settings.work_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return Job(job_id=job_id, dir=job_dir)


def is_valid_job_id(job_id: str) -> bool:
    return bool(job_id) and _JOB_ID_RE.fullmatch(job_id) is not None


def get_job(job_id: str) -> Job | None:
    """Return an existing job by id, or None. Only well-formed job ids are
    accepted, which prevents path traversal through the id."""
    if not is_valid_job_id(job_id):
        return None
    settings = get_settings()
    job_dir = settings.work_dir / job_id
    if job_dir.is_dir():
        return Job(job_id=job_id, dir=job_dir)
    return None


def save_upload(job: Job, filename: str, content: bytes) -> Path:
    dest = job.path(filename)
    dest.write_bytes(content)
    return dest


def delete_job(job_id: str) -> bool:
    """Permanently remove a job's directory and all its files."""
    job = get_job(job_id)
    if job is None:
        return False
    shutil.rmtree(job.dir, ignore_errors=True)
    return not job.dir.exists()


def cleanup_expired(max_age_seconds: int) -> int:
    """Delete job directories older than max_age_seconds. Returns count removed.

    Safety net so abandoned jobs do not linger, independent of the caller's own
    delete calls. Only directories named like job ids are touched.
    """
    settings = get_settings()
    now = time.time()
    removed = 0
    for child in settings.work_dir.iterdir():
        if not child.is_dir() or not is_valid_job_id(child.name):
            continue
        try:
            age = now - child.stat().st_mtime
        except OSError:
            continue
        if age > max_age_seconds:
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    return removed
