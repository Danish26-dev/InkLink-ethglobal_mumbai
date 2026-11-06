"""Test configuration: isolated data dir and known test-only secrets.

Environment must be set before the app (and its cached settings) is imported.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="inklink-backend-test-")
os.environ.update(
    {
        "DATA_DIR": _TMP,
        "SHOP_ADMIN_TOKEN": "test-shop-admin-token",
        "AGENT_SERVICE_TOKEN": "test-agent-service-token",
        "INTERNAL_API_TOKEN": "test-internal-token",
        "BACKEND_API_TOKEN": "test-backend-api-token",
        "PAYMENT_EVENT_SIGNING_SECRET": "test-secret-0123456789abcdef",
        "MERCHANT_ACCOUNT_ID": "0.0.900001",
        "INR_TO_USDC_RATE": "0.005",
        "PRICE_PER_PAGE_MONOCHROME": "2.00",
        "PRICE_PER_PAGE_COLOR": "10.00",
        # Never read the developer's real services/backend/.env (or real 0G keys) in tests.
        "INKLINK_BACKEND_DOTENV": "0",
        "ZERO_G_STANDARD_API_KEY": "",
        "ZERO_G_VERIFIED_API_KEY": "",
        "ZERO_G_PRIVATE_API_KEY": "",
        "ZERO_G_DEFAULT_TRUST_MODE": "private",
        "SHOP_LOCAL_ACCESS": "true",
    }
)

import pytest  # noqa: E402

from app import store as store_mod  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_store(tmp_path):
    store_mod.reset_store_for_tests(tmp_path / "state.json")
    yield
