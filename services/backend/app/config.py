"""Runtime configuration for the Inklink backend (environment-driven).

Secrets (service tokens, the callback signing secret) are read here and are
never returned by any endpoint or written to logs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


TRUST_MODES = ("standard", "verified", "private")  # ordered weakest -> strongest
ZERO_G_DEFAULT_BASE_URL = "https://router-api.0g.ai/v1"
ZERO_G_DEFAULT_MODEL = "glm-5.3"  # TeeML (private-capable) and supports tool calling

_BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader for services/backend/.env. Never overrides real env vars."""
    if os.getenv("INKLINK_BACKEND_DOTENV", "1") == "0" or not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _bool(name: str, default: bool) -> bool:
    raw = _env(name)
    return default if not raw else raw.lower() in ("1", "true", "yes", "on")


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

    # 0G Private Computer — one API key per trust mode. Server-side only:
    # never returned by an endpoint, never sent to the agent or a browser.
    zero_g_base_url: str = ZERO_G_DEFAULT_BASE_URL
    zero_g_keys: dict[str, str] = field(default_factory=dict, repr=False)
    zero_g_models: dict[str, str] = field(default_factory=dict)
    zero_g_default_trust_mode: str = "private"
    zero_g_require_tee_verification: bool = True
    zero_g_catalog_ttl_seconds: int = 300
    # URL the agent uses to reach this backend's inference gateway.
    backend_internal_url: str = "http://127.0.0.1:8000"

    # The shop dashboard is reachable without a token from this computer only.
    shop_local_access: bool = False
    # Uploaded and edited documents are deleted this long after the last change.
    document_retention_hours: float = 24.0

    zero_g_timeout_seconds: float = 180.0
    # Retries of the SAME trust mode on transient errors (429/502/503/timeout). Never a weaker mode.
    zero_g_max_retries: int = 2

    # Shopkeeper accounts (created with `python -m app.manage create-shopkeeper`).
    shop_session_ttl_seconds: int = 8 * 3600
    # Set true behind HTTPS so the session cookie is Secure.
    session_cookie_secure: bool = False
    login_max_failures: int = 5
    login_lockout_seconds: int = 900

    # ETHGlobal jury demo: an isolated shop whose jobs can never print physically.
    jury_demo_enabled: bool = True
    demo_shop_id: str = "shop_demo"
    jury_session_ttl_seconds: int = 4 * 3600

    # ESP32-S3 controller / gateway devices report with this bearer token.
    device_token: str = field(default="", repr=False)
    device_offline_after_seconds: int = 60

    # 0G Galileo testnet contracts (InklinkShopRegistry, InklinkJobRegistry).
    galileo_rpc_url: str = ""
    galileo_chain_id: str = ""
    shop_registry_address: str = ""
    job_registry_address: str = ""
    shop_registry_abi_path: str = ""
    job_registry_abi_path: str = ""
    # Backend signer for registry writes (NOT the deployer key; keep it in a secret manager).
    galileo_signer_private_key: str = field(default="", repr=False)

    # 0G Storage (optional; documents stay off-chain and are never uploaded without this).
    zero_g_storage_indexer_url: str = ""

    # Optional production static serving (single origin): landing + PWA builds.
    landing_dist_dir: str = ""
    web_dist_dir: str = ""

    # ── Deployment (Cloud Run) ──
    # 0 = write state.json after every mutation (local default). >0 = coalesce writes
    # (DATA_DIR on a Cloud Storage volume); pending changes are flushed on shutdown.
    state_save_interval_seconds: float = 0.0
    # Ed25519 gateway identity seed. Empty = DATA_DIR/gateway_ed25519.key (created on
    # first start). On Cloud Run: a Secret Manager secret mounted as a read-only file.
    gateway_identity_key_path: str = ""
    # "gcp-id-token": add a Google-signed ID token (X-Serverless-Authorization) to calls
    # to private Cloud Run services (agent, document engine, payment agent).
    service_auth: str = ""
    # "direct": call the printer adapter at PRINTER_AGENT_URL (same LAN).
    # "relay": the shop gateway connector polls this backend outbound (cloud backend).
    printer_mode: str = "direct"
    gateway_token: str = field(default="", repr=False)
    printer_relay_timeout_seconds: float = 30.0
    # Public HTTPS origin of this backend; when set it is added (signed) to the shop QR
    # so the native app can reach a cloud-hosted backend.
    public_api_origin: str = ""

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
    _load_dotenv(_BACKEND_ROOT / ".env")
    default_model = _env("ZERO_G_MODEL_ID", ZERO_G_DEFAULT_MODEL)
    return Settings(
        zero_g_base_url=_env("ZERO_G_BASE_URL", ZERO_G_DEFAULT_BASE_URL).rstrip("/"),
        zero_g_keys={m: _env(f"ZERO_G_{m.upper()}_API_KEY") for m in TRUST_MODES},
        zero_g_models={m: _env(f"ZERO_G_{m.upper()}_MODEL_ID", default_model) for m in TRUST_MODES},
        zero_g_default_trust_mode=_env("ZERO_G_DEFAULT_TRUST_MODE", "private").lower(),
        zero_g_require_tee_verification=_bool("ZERO_G_REQUIRE_TEE_VERIFICATION", True),
        zero_g_catalog_ttl_seconds=int(_env("ZERO_G_CATALOG_TTL_SECONDS", "300")),
        backend_internal_url=_env("BACKEND_INTERNAL_URL", f"http://127.0.0.1:{_env('PORT', '8000')}").rstrip("/"),
        # Off by default now that shopkeepers log in; opt-in for kiosk setups only.
        shop_local_access=_bool("SHOP_LOCAL_ACCESS", False),
        document_retention_hours=float(_env("DOCUMENT_RETENTION_HOURS", "24")),
        zero_g_timeout_seconds=float(_env("ZERO_G_TIMEOUT_SECONDS", "180")),
        zero_g_max_retries=int(_env("ZERO_G_MAX_RETRIES", "2")),
        shop_session_ttl_seconds=int(_env("SHOP_SESSION_TTL_SECONDS", str(8 * 3600))),
        session_cookie_secure=_bool("SESSION_COOKIE_SECURE", False),
        login_max_failures=int(_env("LOGIN_MAX_FAILURES", "5")),
        login_lockout_seconds=int(_env("LOGIN_LOCKOUT_SECONDS", "900")),
        jury_demo_enabled=_bool("JURY_DEMO_ENABLED", True),
        demo_shop_id=_env("DEMO_SHOP_ID", "shop_demo"),
        jury_session_ttl_seconds=int(_env("JURY_SESSION_TTL_SECONDS", str(4 * 3600))),
        device_token=_env("DEVICE_TOKEN"),
        device_offline_after_seconds=int(_env("DEVICE_OFFLINE_AFTER_SECONDS", "60")),
        galileo_rpc_url=_env("ZERO_G_GALILEO_RPC_URL"),
        galileo_chain_id=_env("ZERO_G_GALILEO_CHAIN_ID"),
        shop_registry_address=_env("INKLINK_SHOP_REGISTRY_ADDRESS"),
        job_registry_address=_env("INKLINK_JOB_REGISTRY_ADDRESS"),
        shop_registry_abi_path=_env("INKLINK_SHOP_REGISTRY_ABI_PATH"),
        job_registry_abi_path=_env("INKLINK_JOB_REGISTRY_ABI_PATH"),
        galileo_signer_private_key=_env("ZERO_G_GALILEO_SIGNER_PRIVATE_KEY"),
        zero_g_storage_indexer_url=_env("ZERO_G_STORAGE_INDEXER_URL"),
        landing_dist_dir=_env("LANDING_DIST_DIR"),
        web_dist_dir=_env("WEB_DIST_DIR"),
        state_save_interval_seconds=float(_env("STATE_SAVE_INTERVAL_SECONDS", "0")),
        gateway_identity_key_path=_env("GATEWAY_IDENTITY_KEY_PATH"),
        service_auth=_env("SERVICE_AUTH").lower(),
        printer_mode=_env("PRINTER_MODE", "direct").lower(),
        gateway_token=_env("GATEWAY_TOKEN"),
        printer_relay_timeout_seconds=float(_env("PRINTER_RELAY_TIMEOUT_SECONDS", "30")),
        public_api_origin=_env("PUBLIC_API_ORIGIN").rstrip("/"),
        port=int(_env("PORT", "8000")),
        host=_env("HOST", "127.0.0.1"),
        data_dir=Path(_env("DATA_DIR", "./data")).resolve(),
        allowed_origins=_origins(_env("BACKEND_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")),
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
