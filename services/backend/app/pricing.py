"""Quotes: INR price from page count, copies and colour; HTS-USDC settlement.

Agreed FX policy (docs/API_CONTRACTS.md, Contract 4): the rate is a snapshot
valid for QUOTE_TTL_SECONDS, USDC has at most 6 decimals, the amount is rounded
UP so the shop is never undercharged, and the quote expiry is the payment
deadline. Integer arithmetic only — no floating-point money.
"""

from __future__ import annotations

import re

_DEC = re.compile(r"^\d+(\.\d+)?$")


def _parse(text: str, max_frac: int) -> int:
    if not _DEC.match(text):
        raise ValueError(f"invalid decimal: {text}")
    whole, _, frac = text.partition(".")
    if len(frac) > max_frac:
        raise ValueError(f"too many decimals: {text}")
    return int(whole) * 10**max_frac + int(frac.ljust(max_frac, "0") or "0")


def inr_price(pages: int, copies: int, price_per_page: str) -> str:
    """pages × copies × price, as an INR decimal string with 2 decimals."""
    if pages < 1 or copies < 1:
        raise ValueError("pages and copies must be at least 1")
    paise = _parse(price_per_page, 2) * pages * copies
    return f"{paise // 100}.{paise % 100:02d}"


def inr_to_usdc(inr_amount: str, rate: str) -> str:
    """Mirror of services/mock-gateway/src/fx.ts: "20.00" @ "0.005" -> "0.10"."""
    paise = _parse(inr_amount, 2)
    rate_scaled = _parse(rate, 9)
    micro = -(-(paise * rate_scaled) // 100_000)  # ceil division
    whole, frac = divmod(micro, 1_000_000)
    frac_text = f"{frac:06d}".rstrip("0").ljust(2, "0")
    return f"{whole}.{frac_text}"
