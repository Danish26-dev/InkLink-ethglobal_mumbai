"""Verify the closed-schema validation rejects anything outside the allowed set.

This proves the core reliability/security guarantee: the engine only accepts
known operations with valid fields, and rejects unknown/malicious plans.

Run:  venv/Scripts/python.exe -m tests.verify_validation
"""

from __future__ import annotations

import sys

from pydantic import ValidationError

from app.editing.schema import OperationPlan


def expect_reject(label: str, data: dict) -> bool:
    try:
        OperationPlan.model_validate(data)
    except ValidationError:
        print(f"  [ok] rejected: {label}")
        return True
    print(f"  [FAIL] accepted (should reject): {label}")
    return False


def expect_accept(label: str, data: dict) -> bool:
    try:
        OperationPlan.model_validate(data)
        print(f"  [ok] accepted: {label}")
        return True
    except ValidationError as exc:
        print(f"  [FAIL] rejected (should accept): {label} -> {exc}")
        return False


def main() -> int:
    ok = True

    # Should be accepted
    ok &= expect_accept(
        "valid multiple replacements",
        {"operations": [
            {"type": "replace_text", "find": "a", "replace": "b"},
            {"type": "replace_text", "find": "c", "replace": "d", "pages": {"from": 1, "to": 2}},
        ]},
    )
    ok &= expect_accept("empty plan", {"operations": []})

    # Copy count is print configuration, not a document edit (Inklink contract).
    ok &= expect_reject(
        "retired set_copies operation",
        {"operations": [{"type": "set_copies", "copies": 2}]},
    )
    ok &= expect_reject(
        "replace + set_copies mixed",
        {"operations": [
            {"type": "replace_text", "find": "a", "replace": "b"},
            {"type": "set_copies", "copies": 2},
        ]},
    )
    ok &= expect_reject(
        "page range end before start",
        {"operations": [{"type": "replace_text", "find": "a", "replace": "b",
                         "pages": {"from": 3, "to": 1}}]},
    )

    # Should be rejected
    ok &= expect_reject(
        "unknown operation type",
        {"operations": [{"type": "run_python", "code": "os.system('rm -rf /')"}]},
    )
    ok &= expect_reject(
        "replace_text missing 'replace'",
        {"operations": [{"type": "replace_text", "find": "a"}]},
    )
    ok &= expect_reject(
        "blank find",
        {"operations": [{"type": "replace_text", "find": "   ", "replace": "b"}]},
    )
    ok &= expect_reject(
        "too many operations",
        {"operations": [{"type": "replace_text", "find": "a", "replace": "b"}] * 51},
    )

    print("\n" + ("ALL VALIDATION CHECKS PASSED" if ok else "VALIDATION CHECKS FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
