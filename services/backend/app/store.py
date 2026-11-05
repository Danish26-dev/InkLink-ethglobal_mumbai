"""Authoritative backend state.

One process owns every job. State lives in memory and is written atomically to
DATA_DIR/state.json after each mutation, so a restart (or `--reload`) keeps
jobs, quotes, payments, sessions and event logs. This is the single source of
truth for job status: other services propose, this store decides.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import get_settings

MAX_EVENTS_PER_JOB = 2000


def now_iso() -> str:
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def iso_from_epoch(seconds: float) -> str:
    t = datetime.fromtimestamp(seconds, timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def empty_operator_config() -> dict[str, Any]:
    return {
        "printerId": None,
        "paperSize": None,
        "colorMode": None,
        "copies": None,
        "orientation": None,
        "sides": None,
    }


@dataclass
class Principal:
    """Who holds a token: an anonymous web visitor, a paired native app, or the shop."""

    kind: str  # "web" | "native" | "shop"
    ref: str  # web_<…> | native session ref | shop id
    expires_at: float


@dataclass
class DocumentRecord:
    document_id: str
    filename: str
    format: str  # "pdf" | "docx"
    size: int
    original_path: str
    edited_path: str | None = None
    page_count: int | None = None
    review_recommended: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass
class QuoteRecord:
    quote_id: str
    job_id: str
    merchant_id: str
    inr: str
    usdc: str | None
    rate: str | None
    captured_at: str
    expires_at: str
    payment_methods: list[str]
    pages: int
    copies: int
    color_mode: str


@dataclass
class PaymentRecord:
    payment_id: str
    job_id: str
    quote_id: str
    merchant_id: str
    amount_usdc: str
    status: str
    transaction_id: str | None = None
    hashscan_url: str | None = None


@dataclass
class HandoffRecord:
    token: str
    job_id: str
    quote_id: str
    expires_at: float
    claimed_by: str | None = None


@dataclass
class JobRecord:
    job_id: str
    shop_id: str
    owner: str
    created_at: str
    updated_at: str
    status: str = "created"
    payment_status: str = "created"
    device_status: str = "unknown"
    document: DocumentRecord | None = None
    print_config: dict[str, Any] = field(default_factory=dict)  # Contract 3 printConfig
    operator_config: dict[str, Any] = field(default_factory=empty_operator_config)
    config_validated: bool = False
    quote_id: str | None = None
    customer_approved_quote: bool = False
    shop_approved: bool = False
    execution_requested: bool = False
    payment_id: str | None = None
    claimed_by: str | None = None
    run_active: bool = False
    submission: dict[str, Any] | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.jobs: dict[str, JobRecord] = {}
        self.quotes: dict[str, QuoteRecord] = {}
        self.payments: dict[str, PaymentRecord] = {}
        self.handoffs: dict[str, HandoffRecord] = {}
        self.sessions: dict[str, Principal] = {}
        self.events: dict[str, list[dict[str, Any]]] = {}
        self.shop: dict[str, Any] = {}
        self.upload_keys: dict[str, dict[str, Any]] = {}
        self.consumed_tickets: dict[str, float] = {}
        self._load()

    # ───────────── persistence ─────────────
    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return  # start fresh rather than crash on a corrupt snapshot
        for j in raw.get("jobs", []):
            doc = j.pop("document", None)
            job = JobRecord(**j)
            job.document = DocumentRecord(**doc) if doc else None
            self.jobs[job.job_id] = job
        self.quotes = {q["quote_id"]: QuoteRecord(**q) for q in raw.get("quotes", [])}
        self.payments = {p["payment_id"]: PaymentRecord(**p) for p in raw.get("payments", [])}
        self.handoffs = {h["token"]: HandoffRecord(**h) for h in raw.get("handoffs", [])}
        now = time.time()
        self.sessions = {
            t: Principal(**p) for t, p in raw.get("sessions", {}).items() if p.get("expires_at", 0) > now
        }
        self.events = raw.get("events", {})
        self.shop = raw.get("shop", {})
        self.upload_keys = raw.get("upload_keys", {})
        # A run cannot survive a restart; never leave a job looking busy.
        for job in self.jobs.values():
            job.run_active = False

    def save(self) -> None:
        with self.lock:
            data = {
                "jobs": [asdict(j) for j in self.jobs.values()],
                "quotes": [asdict(q) for q in self.quotes.values()],
                "payments": [asdict(p) for p in self.payments.values()],
                "handoffs": [asdict(h) for h in self.handoffs.values()],
                "sessions": {t: asdict(p) for t, p in self.sessions.items()},
                "events": self.events,
                "shop": self.shop,
                "upload_keys": self.upload_keys,
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self.path)

    # ───────────── helpers ─────────────
    def touch(self, job: JobRecord) -> None:
        job.updated_at = now_iso()

    def shop_config(self) -> dict[str, Any]:
        s = get_settings()
        cfg = {
            "name": s.shop_name,
            "description": s.shop_description,
            "pricePerPageMonochrome": s.price_per_page_monochrome,
            "pricePerPageColor": s.price_per_page_color,
            "acceptingOrders": True,
            "defaults": {
                "paperSize": "A4",
                "colorMode": "monochrome",
                "copies": 1,
                "orientation": "portrait",
                "sides": "one-sided",
            },
        }
        cfg.update(self.shop)
        return cfg


_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(get_settings().data_dir / "state.json")
    return _store


def reset_store_for_tests(path: Path) -> Store:
    global _store
    _store = Store(path)
    return _store
