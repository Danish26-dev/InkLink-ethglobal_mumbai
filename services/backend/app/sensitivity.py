"""Document sensitivity classification and trust-mode selection.

Runs locally on the backend before any document content leaves it. Only the
classification result (level, category labels, counts) is stored or returned;
matched values and document text are never stored, logged or returned.

Policy:
  sensitive (personal / financial / identity / confidential) -> private
  unclassified (no readable text, e.g. scanned or unreadable) -> private
  customer asked for provable execution                       -> verified
  non-sensitive                                               -> standard

Effective mode = strictest(required, customer request, shop minimum). A
stricter mode may be chosen; a weaker one never is.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any

from .config import get_settings
from .zerog import rank, strictest

MAX_SCAN_CHARS = 200_000
MAX_SCAN_PAGES = 30

_PATTERNS: dict[str, list[tuple[str, re.Pattern[str]]]] = {
    "identity": [
        ("aadhaar_number", re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b")),
        ("pan_number", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
        ("passport_number", re.compile(r"\bpassport\s*(no\.?|number)?\s*[:#]?\s*[A-Z]\d{7}\b", re.I)),
        ("identity_document", re.compile(r"\b(aadhaar|passport|driving licen[cs]e|voter id|national id|date of birth|DOB)\b", re.I)),
    ],
    "financial": [
        ("payment_card", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
        ("bank_account", re.compile(r"\b(account\s*(no\.?|number)|a/c\s*no\.?|IFSC|IBAN|SWIFT|routing number)\b", re.I)),
        ("ifsc_code", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
        ("financial_document", re.compile(r"\b(bank statement|salary slip|payslip|pay slip|income tax|tax return|form 16|ITR|credit card|balance sheet|loan)\b", re.I)),
    ],
    "personal": [
        ("email_address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
        ("phone_number", re.compile(r"(?<!\d)(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)")),
        ("medical_record", re.compile(r"\b(diagnosis|prescription|medical record|patient name|lab report|blood group)\b", re.I)),
        ("personal_address", re.compile(r"\b(residential address|home address|permanent address)\b", re.I)),
    ],
    "confidential": [
        ("confidential_marking", re.compile(r"\b(confidential|strictly private|internal use only|proprietary|trade secret|not for distribution)\b", re.I)),
        ("legal_agreement", re.compile(r"\b(non-disclosure|NDA|agreement|contract|hereinafter|indemnif\w+|terms and conditions of employment)\b", re.I)),
    ],
}

_VERIFIED_REQUEST = re.compile(r"\b(verifi(ed|able)|provable|attest(ed|ation)?|audit(able)?|provenance)\b", re.I)
_PRIVATE_REQUEST = re.compile(r"\b(private|privately|sensitive|confidential|don'?t share|do not share|privacy)\b", re.I)


def _luhn_ok(digits: str) -> bool:
    nums = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(nums) <= 19:
        return False
    total = 0
    for i, n in enumerate(reversed(nums)):
        if i % 2:
            n = n * 2 - 9 if n * 2 > 9 else n * 2
        total += n
    return total % 10 == 0


def extract_text(path: Path, fmt: str) -> str | None:
    """Readable text for classification only, or None when none can be extracted."""
    try:
        if fmt == "pdf":
            from pypdf import PdfReader

            reader = PdfReader(str(path))
            parts: list[str] = []
            for page in reader.pages[:MAX_SCAN_PAGES]:
                parts.append(page.extract_text() or "")
                if sum(len(p) for p in parts) > MAX_SCAN_CHARS:
                    break
            text = "\n".join(parts)
        elif fmt == "docx":
            with zipfile.ZipFile(path) as z:
                xml = z.read("word/document.xml").decode("utf-8", "ignore")
            text = re.sub(r"<[^>]+>", " ", xml)
        else:
            return None
    except Exception:  # noqa: BLE001 - unreadable means unclassified, never an error
        return None
    text = re.sub(r"\s+", " ", text).strip()[:MAX_SCAN_CHARS]
    return text if len(text) >= 20 else None


def classify_text(text: str | None) -> dict[str, Any]:
    """Classify text. Returns labels and counts only, never matched values."""
    if text is None:
        return {
            "level": "unclassified",
            "categories": [],
            "signals": {},
            "reason": "No readable text could be extracted, so the document is treated as sensitive.",
        }
    signals: dict[str, int] = {}
    categories: set[str] = set()
    for category, rules in _PATTERNS.items():
        for label, pattern in rules:
            matches = pattern.findall(text) if label != "payment_card" else [
                m for m in re.finditer(pattern, text) if _luhn_ok(m.group(0))
            ]
            if matches:
                signals[label] = len(matches)
                categories.add(category)
    level = "sensitive" if categories else "non_sensitive"
    return {
        "level": level,
        "categories": sorted(categories),
        "signals": signals,
        "reason": (
            f"Detected {', '.join(sorted(categories))} information."
            if categories
            else "No personal, financial, identity or confidential markers were found."
        ),
    }


def classify_document(path: Path, fmt: str) -> dict[str, Any]:
    return classify_text(extract_text(path, fmt))


def instruction_preferences(text: str) -> str | None:
    """Trust mode the customer's own words ask for, if any."""
    if _PRIVATE_REQUEST.search(text):
        return "private"
    if _VERIFIED_REQUEST.search(text):
        return "verified"
    return None


def required_mode(doc_class: dict[str, Any] | None, instruction_class: dict[str, Any] | None) -> tuple[str, str]:
    """Minimum trust mode and the reason, from the document and instruction classifications."""
    s = get_settings()
    if doc_class is None:
        # No document content in this run: only the instruction text is sent.
        if instruction_class and instruction_class["level"] == "sensitive":
            return "private", "The instruction contains sensitive information."
        return s.zero_g_default_trust_mode, f"No document attached; using the configured default ({s.zero_g_default_trust_mode})."
    if doc_class["level"] in ("sensitive", "unclassified"):
        return "private", doc_class["reason"]
    if instruction_class and instruction_class["level"] == "sensitive":
        return "private", "The instruction contains sensitive information."
    return "standard", "The document was classified as non-sensitive."


def select_trust_mode(
    *,
    doc_class: dict[str, Any] | None,
    instruction: str,
    customer_requested: str | None,
    shop_minimum: str | None,
) -> dict[str, Any]:
    """Effective trust mode for one run. Never weaker than required."""
    instruction_class = classify_text(instruction)
    required, reason = required_mode(doc_class, instruction_class)
    from_words = instruction_preferences(instruction)
    effective = strictest(required, customer_requested, from_words, shop_minimum)
    raised_by = None
    if rank(effective) > rank(required):
        raised_by = (
            "customer" if effective in (customer_requested, from_words) else "shop minimum"
        )
    return {
        "requiredTrustMode": required,
        "requestedTrustMode": customer_requested or from_words,
        "shopMinimumTrustMode": shop_minimum,
        "effectiveTrustMode": effective,
        "reason": reason,
        "raisedBy": raised_by,
        "instructionLevel": instruction_class["level"],
    }
