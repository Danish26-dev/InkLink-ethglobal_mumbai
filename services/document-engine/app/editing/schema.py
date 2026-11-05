"""Closed operation schema for document editing.

This is the security and reliability boundary of the Inklink Document Engine.
The AI agent layer is only ever allowed to produce operations defined here.
Anything it returns is treated as untrusted input and validated against these
models before any document is touched. There is deliberately NO "run arbitrary
code" or "freeform edit" operation, and there never should be.

Supported operations:
  - replace_text : find/replace a literal string (optionally page-scoped, PDF only)

Copy count is NOT a document-editing operation. It is print configuration and
is carried in the print options handled by the Inklink backend and the local
printer adapter, never in this plan. A plan containing `set_copies` is
rejected as an unknown operation.

To add a new operation you:
  1. Add a model here (subclass of BaseModel with a unique literal `type`).
  2. Add it to the `Operation` union and `OPERATION_MODELS`.
  3. Implement its deterministic executor in operations.py (and pdf_native.py
     if it can be applied in place to PDFs).
  4. Mirror it in the agent's zod schema (strands-agent/src/schema.ts).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


# Hard limits to keep a single request bounded and predictable.
MAX_OPERATIONS = 50
MAX_TEXT_LENGTH = 5000


class PageRange(BaseModel):
    """An inclusive 1-based page range, e.g. {from: 1, to: 3} means pages 1,2,3.

    Page numbers are 1-based in the user-facing instruction and in this schema.
    The deterministic executor converts them to 0-based indexes internally.
    """

    # `from` is a Python keyword, so expose it via an alias and read it as
    # `from_page` in code. Clients still send {"from": 1, "to": 3}.
    from_page: int = Field(..., ge=1, alias="from")
    to_page: int = Field(..., ge=1, alias="to")

    model_config = {"populate_by_name": True}

    @field_validator("to_page")
    @classmethod
    def to_after_from(cls, v: int, info) -> int:  # type: ignore[no-untyped-def]
        start = info.data.get("from_page")
        if start is not None and v < start:
            raise ValueError("`to` page must be >= `from` page")
        return v


class ReplaceTextOperation(BaseModel):
    """Replace every literal occurrence of `find` with `replace`.

    Matching is literal (not regex) and case-sensitive. The executor preserves
    surrounding document formatting; it only rewrites the matched text.

    `pages` is OPTIONAL. When omitted, the replacement applies to the WHOLE
    document (the default). When present, the replacement is restricted to the
    given inclusive 1-based page range; occurrences on any other page are left
    unchanged. Page scoping is only meaningful for PDFs (which have fixed
    pages); the engine rejects it for DOCX input where there is no fixed
    pagination.
    """

    type: Literal["replace_text"]
    find: str = Field(..., min_length=1, max_length=MAX_TEXT_LENGTH)
    replace: str = Field(..., max_length=MAX_TEXT_LENGTH)
    pages: PageRange | None = None

    @field_validator("find")
    @classmethod
    def find_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("`find` cannot be blank or whitespace-only")
        return v


# With a single supported operation the plan entry is the model itself; its
# literal `type` field rejects anything else (including `set_copies`, since
# copies are print configuration). When a second operation is added, turn this into
#   Annotated[Union[ReplaceTextOperation, NewOperation], Field(discriminator="type")]
Operation = ReplaceTextOperation

# Registry of supported operation type names -> model, for validation/help text.
OPERATION_MODELS = {
    "replace_text": ReplaceTextOperation,
}


class OperationPlan(BaseModel):
    """The full, validated plan the agent produces for one document.

    `operations` are content operations applied in order. An empty plan is
    structurally valid; the caller decides whether that is an error in its
    context.
    """

    operations: list[Operation] = Field(default_factory=list, max_length=MAX_OPERATIONS)


def supported_operations() -> list[str]:
    """Names of operations the engine can execute, for prompts and error text."""
    return list(OPERATION_MODELS.keys())
