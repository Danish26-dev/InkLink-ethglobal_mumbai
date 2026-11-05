"""Runtime configuration for the Inklink backend (environment-driven).

Secrets (service tokens, the callback signing secret) are read here and are
never returned by any endpoint or written to logs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _origins(raw: str) -> list[str]:
    return [o.strip() for o in raw.split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    port: int = 8000
    host: str = "127.0.0.1"
    data_dir: Path = Path("./data")
    allowed_origins: list[str] = field(default_factory=list)

    # Shop identity (single shop per backend, as in the gateway design)
    shop_id: str = "shop_001"
    gateway_id: str = "gateway_001"
    shop_name: str = "Inklink Print Shop"
    shop_description: str = "Local print shop on the Inklink network."
    gateway_mdns: str = "gateway-001.local"
    gateway_ip: str = ""

    # Sessions
    web_session_ttl_seconds: int = 7200
    native_session_ttl_seconds: int = 900
    shop_admin_token: str = ""

    # Pricing (INR, decimal strings) and FX policy for HTS-USDC settlement
    price_per_page_monochrome: str = "2.00"
    price_per_page_color: str = "10.00"
    inr_to_usdc_rate: str = ""  # USDC per 1 INR; empty = Hedera settlement not offered
    fx_source_label: str = "configured rate"
    quote_ttl_seconds: int = 300

    # Services
    agent_url: str = "http://127.0.0.1:4000"
    agent_service_token: str = ""
    document_engine_url: str = "http://127.0.0.1:5001"
    printer_agent_url: str = "http://127.0.0.1:7777"
    printer_agent_token: str = ""

    # Payment agent (Hedera x402) — shared secrets, identical on both sides
    payment_agent_url: str = "http://127.0.0.1:4021"
    gate_url: str = "http://127.0.0.1:4022"
    internal_api_token: str = ""
    backend_api_token: str = ""
    payment_event_signing_secret: str = ""
    merchant_account_id: str = ""

    # Native-app handoff
    handoff_ttl_seconds: int = 900
    handoff_deep_link_base: str = "inklink://pay"

    max_upload_bytes: int = 25 * 1024 * 1024

    @property
    def payments_configured(self) -> bool:
        return bool(
            self.internal_api_token
            and self.payment_event_signing_secret
            and self.merchant_account_id
            and self.inr_to_usdc_rate
        )


@lru_cache
def get_settings() -> Settings:
    return Settings(
        port=int(_env("PORT", "8000")),
        host=_env("HOST", "127.0.0.1"),
        data_dir=Path(_env("DATA_DIR", "./data")).resolve(),
        allowed_origins=_origins(_env("BACKEND_ALLOWED_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174")),
        shop_id=_env("SHOP_ID", "shop_001"),
        gateway_id=_env("GATEWAY_ID", "gateway_001"),
        shop_name=_env("SHOP_NAME", "Inklink Print Shop"),
        shop_description=_env("SHOP_DESCRIPTION", "Local print shop on the Inklink network."),
        gateway_mdns=_env("GATEWAY_MDNS", "gateway-001.local"),
        gateway_ip=_env("GATEWAY_IP"),
        web_session_ttl_seconds=int(_env("WEB_SESSION_TTL_SECONDS", "7200")),
        native_session_ttl_seconds=int(_env("SESSION_TTL_SECONDS", "900")),
        shop_admin_token=_env("SHOP_ADMIN_TOKEN"),
        price_per_page_monochrome=_env("PRICE_PER_PAGE_MONOCHROME", "2.00"),
        price_per_page_color=_env("PRICE_PER_PAGE_COLOR", "10.00"),
        inr_to_usdc_rate=_env("INR_TO_USDC_RATE"),
        fx_source_label=_env("FX_SOURCE_LABEL", "configured rate"),
        quote_ttl_seconds=int(_env("QUOTE_TTL_SECONDS", "300")),
        agent_url=_env("AGENT_URL", "http://127.0.0.1:4000").rstrip("/"),
        agent_service_token=_env("AGENT_SERVICE_TOKEN"),
        document_engine_url=_env("DOCUMENT_ENGINE_URL", "http://127.0.0.1:5001").rstrip("/"),
        printer_agent_url=_env("PRINTER_AGENT_URL", "http://127.0.0.1:7777").rstrip("/"),
        printer_agent_token=_env("PRINTER_AGENT_TOKEN"),
        payment_agent_url=_env("PAYMENT_AGENT_URL", "http://127.0.0.1:4021").rstrip("/"),
        gate_url=_env("GATE_URL", "http://127.0.0.1:4022").rstrip("/"),
        internal_api_token=_env("INTERNAL_API_TOKEN"),
        backend_api_token=_env("BACKEND_API_TOKEN"),
        payment_event_signing_secret=_env("PAYMENT_EVENT_SIGNING_SECRET"),
        merchant_account_id=_env("MERCHANT_ACCOUNT_ID"),
        handoff_ttl_seconds=int(_env("HANDOFF_TTL_SECONDS", "900")),
        handoff_deep_link_base=_env("HANDOFF_DEEP_LINK_BASE", "inklink://pay"),
        max_upload_bytes=int(_env("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024))),
    )
