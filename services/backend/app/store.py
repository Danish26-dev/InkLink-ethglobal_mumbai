"""Authoritative backend state.

One process owns every job. State lives in memory and is written atomically to
DATA_DIR/state.json after each mutation (or at most once per
STATE_SAVE_INTERVAL_SECONDS when that is set), so a restart (or `--reload`) keeps
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
    """Who is calling.

    kind:
      web    anonymous browser session (customer PWA, no login)
      native paired Inklink app session
      shop   shopkeeper (account session cookie, or the SHOP_ADMIN_TOKEN API token)
      jury   ETHGlobal jury session: a customer of the demo shop AND a
             read/approve-only viewer of its own demo jobs, nothing else
    """

    kind: str
    ref: str  # web_<…> | native ref | account id | "admin" | jury_<…>
    expires_at: float
    # Shops this principal may act on. ["*"] = every shop (admin API token only).
    shops: list[str] = field(default_factory=list)
    role: str = ""  # shop: "owner" | "admin"; jury: "jury"
    active_shop: str | None = None


@dataclass
class AccountRecord:
    """A shopkeeper login. The password is stored as an scrypt hash only."""

    account_id: str
    email: str
    name: str
    password_hash: str
    shop_ids: list[str]
    role: str = "owner"
    created_at: str = ""
    disabled: bool = False


@dataclass
class ShopSession:
    """Server-side shopkeeper session. Only the SHA-256 of the cookie token is stored."""

    token_hash: str
    account_id: str
    created_at: float
    expires_at: float
    active_shop: str | None = None


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
    # none | pending_review | approved | rejected. The original file is never
    # modified; an edited copy is used only after the customer approves it.
    edit_status: str = "none"
    # Local sensitivity classification (labels and counts only, never content).
    classification: dict[str, Any] | None = None
    # Files deleted under the retention policy.
    purged: bool = False
    # SHA-256 of the original upload: the only document data that may go on-chain.
    sha256: str | None = None


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
    # Trust mode the customer asked for (may only raise the required mode).
    requested_trust_mode: str | None = None
    # Last trust-mode selection (required / effective / reason).
    trust_selection: dict[str, Any] | None = None
    # Metadata of 0G calls for this job (no prompts, no completions).
    inference_log: list[dict[str, Any]] = field(default_factory=list)
    # Jury demo only: clearly labelled simulated steps (payment, execution).
    # Never mixed into payment_status / status, never a transaction id.
    simulation: dict[str, Any] = field(default_factory=dict)
    # Device-reported events for this job (ESP32-S3 / gateway).
    device_events: list[dict[str, Any]] = field(default_factory=list)


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
        # Per-shop configuration overrides, keyed by shop id.
        self.shops: dict[str, dict[str, Any]] = {}
        self.accounts: dict[str, AccountRecord] = {}
        self.shop_sessions: dict[str, ShopSession] = {}
        # Registered devices (ESP32-S3 controllers / gateways), keyed by device id.
        self.devices: dict[str, dict[str, Any]] = {}
        # Pending on-chain records (0G Galileo); sent only once contracts are configured.
        self.chain_outbox: list[dict[str, Any]] = []
        self.upload_keys: dict[str, dict[str, Any]] = {}
        self.consumed_tickets: dict[str, float] = {}
        self._dirty = False
        self._flusher: threading.Thread | None = None
        self._stop_flusher = threading.Event()
        self._load()

    @property
    def shop(self) -> dict[str, Any]:
        """Back-compat: overrides of the primary shop."""
        return self.shops.setdefault(get_settings().shop_id, {})

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
        self.shops = raw.get("shops", {})
        if raw.get("shop") and get_settings().shop_id not in self.shops:  # migrate single-shop snapshots
            self.shops[get_settings().shop_id] = raw["shop"]
        self.accounts = {a["account_id"]: AccountRecord(**a) for a in raw.get("accounts", [])}
        self.shop_sessions = {
            s["token_hash"]: ShopSession(**s) for s in raw.get("shop_sessions", []) if s.get("expires_at", 0) > now
        }
        self.devices = raw.get("devices", {})
        self.chain_outbox = raw.get("chain_outbox", [])
        self.upload_keys = raw.get("upload_keys", {})
        # A run cannot survive a restart; never leave a job looking busy.
        for job in self.jobs.values():
            job.run_active = False

    def save(self) -> None:
        """Persist the snapshot.

        With STATE_SAVE_INTERVAL_SECONDS > 0 (used on Cloud Run, where DATA_DIR is a
        Cloud Storage volume and every write is an object upload) mutations only mark
        the store dirty and a background thread writes at most once per interval.
        `flush()` runs on shutdown so a graceful stop never loses the last changes.
        """
        interval = get_settings().state_save_interval_seconds
        if interval <= 0:
            self._write()
            return
        with self.lock:
            self._dirty = True
            if self._flusher is None or not self._flusher.is_alive():
                self._flusher = threading.Thread(target=self._flush_loop, args=(interval,),
                                                 name="state-flusher", daemon=True)
                self._flusher.start()

    def flush(self) -> None:
        """Write the snapshot now if anything changed since the last write."""
        with self.lock:
            if not self._dirty:
                return
            self._write()

    def _flush_loop(self, interval: float) -> None:
        while not self._stop_flusher.wait(interval):
            try:
                self.flush()
            except OSError:
                pass  # transient storage error: still dirty, retried next tick

    def _write(self) -> None:
        with self.lock:
            data = {
                "jobs": [asdict(j) for j in self.jobs.values()],
                "quotes": [asdict(q) for q in self.quotes.values()],
                "payments": [asdict(p) for p in self.payments.values()],
                "handoffs": [asdict(h) for h in self.handoffs.values()],
                "sessions": {t: asdict(p) for t, p in self.sessions.items()},
                "events": self.events,
                "shops": self.shops,
                "accounts": [asdict(a) for a in self.accounts.values()],
                "shop_sessions": [asdict(x) for x in self.shop_sessions.values()],
                "devices": self.devices,
                "chain_outbox": self.chain_outbox[-500:],
                "upload_keys": self.upload_keys,
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self.path)
            self._dirty = False

    def close(self) -> None:
        """Stop the background writer and write any pending changes (graceful shutdown)."""
        self._stop_flusher.set()
        self.flush()

    # ───────────── helpers ─────────────
    def touch(self, job: JobRecord) -> None:
        job.updated_at = now_iso()

    def shop_ids(self) -> list[str]:
        """Shops served by this backend: the primary shop, the jury demo shop (if enabled)
        and any shop registered by an operator (store.shops[...]["registered"])."""
        s = get_settings()
        ids = [s.shop_id]
        if s.jury_demo_enabled:
            ids.append(s.demo_shop_id)
        ids += [k for k, v in self.shops.items() if v.get("registered") and k not in ids]
        return ids

    def is_demo_shop(self, shop_id: str) -> bool:
        s = get_settings()
        return s.jury_demo_enabled and shop_id == s.demo_shop_id

    def shop_config(self, shop_id: str | None = None) -> dict[str, Any]:
        s = get_settings()
        shop_id = shop_id or s.shop_id
        demo = self.is_demo_shop(shop_id)
        cfg = {
            "shopId": shop_id,
            "demo": demo,
            "name": "Inklink Demo Print Shop (Jury)" if demo else s.shop_name,
            "description": "Isolated shop for the ETHGlobal jury demo. Jobs here never print physically."
            if demo
            else s.shop_description,
            "pricePerPageMonochrome": s.price_per_page_monochrome,
            "pricePerPageColor": s.price_per_page_color,
            "acceptingOrders": True,
            # Shop-wide floor for 0G trust mode; null = follow the document policy.
            "minimumTrustMode": None,
            "defaults": {
                "paperSize": "A4",
                "colorMode": "monochrome",
                "copies": 1,
                "orientation": "portrait",
                "sides": "one-sided",
            },
        }
        cfg.update(self.shops.get(shop_id, {}))
        cfg["shopId"], cfg["demo"] = shop_id, demo
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
