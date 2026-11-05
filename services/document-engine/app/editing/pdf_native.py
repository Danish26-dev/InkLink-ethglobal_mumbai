"""Native, in-place PDF text editing (layout-preserving).

WHY THIS EXISTS
---------------
The PDF -> DOCX -> edit -> PDF round-trip (pdf2docx + LibreOffice) reliably
performs the text edit, but it RECONSTRUCTS the whole document. On real,
image-heavy, multi-column reports that reconstruction reflows content and can
change pagination substantially (measured: a 22-page report rendered to
32-44 pages, with sections shifted and page dimensions altered).

This module edits the PDF *in place* instead: it finds the exact glyph span(s)
for the target text, removes only those glyphs (redaction), and draws the
replacement text on the SAME baseline using the original span's font size,
colour, and — when technically possible — the original embedded font. Images,
vector graphics, page size, and the number of pages are left untouched.

PAGE SCOPING
------------
`replace_text` may carry an optional inclusive, 1-based page range (`pages`).
When present, only occurrences on those pages are replaced; occurrences on any
other page are left unchanged. 1-based page numbers from the instruction are
converted to 0-based indexes here (documented at the conversion site).

TYPOGRAPHY
----------
Replacement text is placed at the original span's baseline origin (not a
rect-derived guess), so it sits on the same line as the surrounding text. We
insert the replacement string EXACTLY as given — no padding — so no extra
spaces are introduced before punctuation or between words. If the replacement
is wider than the space the original text occupied (so it would overlap the
following text), the occurrence is FLAGGED for review rather than silently
shrunk or allowed to overlap.

We never claim pixel-perfect fidelity. When the original embedded font cannot
be reused we fall back to a base-14 font that matches weight/style and record
that honestly in the result.

LICENSING
---------
Uses PyMuPDF (fitz), AGPL-3.0 (or commercial). PyMuPDF is already a dependency
of this engine. If Inklink distributes this engine or runs it as a hosted
service, AGPL source-availability obligations apply to the combined work — a
product/legal decision noted here for visibility.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from .schema import OperationPlan, PageRange, ReplaceTextOperation


class NativeEditUnsupported(Exception):
    """Raised when native in-place editing cannot safely handle the request.

    The caller should fall back to the conversion pipeline. The message explains
    why so it can be logged (never shown raw to the end user)."""


@dataclass
class NativeReplaceResult:
    find: str
    replace: str
    occurrences: int = 0
    unsafe: int = 0  # occurrences that could not be replaced in place
    pages: list[int] = field(default_factory=list)  # 1-based pages changed
    page_range: tuple[int, int] | None = None  # 1-based inclusive, if scoped
    flagged: list[str] = field(default_factory=list)  # review notes (overflow etc.)


@dataclass
class NativeEditResult:
    total_replacements: int = 0
    replaces: list[NativeReplaceResult] = field(default_factory=list)
    pages_before: int = 0
    pages_after: int = 0
    # Honest typography/placement notes surfaced to the caller (and ultimately
    # the user) when something could not be done perfectly.
    notes: list[str] = field(default_factory=list)
    font_reused: bool = True

    def as_dict(self) -> dict:
        return {
            "total_replacements": self.total_replacements,
            "strategy": "native_pdf",
            "font_reused": self.font_reused,
            "notes": self.notes,
            "operations": [
                {
                    "type": "replace_text",
                    "description": (
                        f'Replaced "{r.find}" with "{r.replace}" '
                        f"({r.occurrences} occurrence{'s' if r.occurrences != 1 else ''}"
                        + (
                            f" on page{'s' if len(r.pages) != 1 else ''} "
                            f"{', '.join(str(p) for p in r.pages)}"
                            if r.pages
                            else ""
                        )
                        + ")"
                    ),
                    "details": {
                        "find": r.find,
                        "replace": r.replace,
                        "occurrences": r.occurrences,
                        "pages": r.pages,
                        "page_range": (
                            {"from": r.page_range[0], "to": r.page_range[1]}
                            if r.page_range
                            else None
                        ),
                        "flagged": r.flagged,
                    },
                }
                for r in self.replaces
            ],
        }


# Maximum original horizontal gap (points) between an edited span's right edge
# and the next span's left edge for the two to be considered "immediately
# adjacent" (e.g. a comma or period butting against a name). At/below this, a
# SHORTER replacement is right-anchored so it meets the original right edge and
# does not leave a hole before the punctuation.
_ADJACENT_GAP_PT = 2.0


def _color_int_to_rgb(color: int) -> tuple[float, float, float]:
    """Convert a PyMuPDF integer colour to a 0..1 RGB tuple."""
    r = (color >> 16) & 255
    g = (color >> 8) & 255
    b = color & 255
    return (r / 255.0, g / 255.0, b / 255.0)


# Base-14 fallback families chosen by weight/style when the original embedded
# font cannot be reused. These are always available in any PDF viewer. We
# prefer a serif family (Times) when the original was serifed, so the fallback
# visually resembles the surrounding text more closely.
def _fallback_fontname(flags: int) -> str:
    bold = bool(flags & pymupdf.TEXT_FONT_BOLD)  # 16
    italic = bool(flags & pymupdf.TEXT_FONT_ITALIC)  # 2
    serif = bool(flags & pymupdf.TEXT_FONT_SERIFED)  # 4
    if serif:
        if bold and italic:
            return "tibi"  # Times-BoldItalic
        if bold:
            return "tibo"  # Times-Bold
        if italic:
            return "tiit"  # Times-Italic
        return "tiro"  # Times-Roman
    if bold and italic:
        return "hebi"  # Helvetica-BoldOblique
    if bold:
        return "hebo"  # Helvetica-Bold
    if italic:
        return "heit"  # Helvetica-Oblique
    return "helv"  # Helvetica


# NOTE on embedded-font reuse.
# We deliberately do NOT re-encode replacement text with the original embedded
# font. Real documents embed SUBSET TrueType fonts (e.g. "BCDEEE+TimesNewRoman")
# whose glyph/ToUnicode mapping is non-standard: inserting new text with them
# renders visually but corrupts the TEXT LAYER (measured: a three-word name
# extracted back with non-breaking spaces and was no longer searchable). A
# correct, searchable, copyable, accessible text layer matters more than an
# exact glyph match, and validation + the user's "replacement present" checks
# rely on it. So we insert replacements with a base-14 font chosen to MATCH the
# original's weight/style and serif/sans family (e.g. Times for a serif
# original), at the same size and colour, and report the substitution honestly.


def can_handle(plan: OperationPlan) -> bool:
    """Native editing supports replace_text only."""
    for op in plan.operations:
        if not isinstance(op, ReplaceTextOperation):
            return False
    return True


def _allowed_pages(pages: PageRange | None, page_count: int) -> set[int] | None:
    """Translate an optional 1-based inclusive PageRange into a set of 0-based
    page indexes. Returns None when there is no restriction (whole document).

    Raises NativeEditUnsupported for a range that cannot apply to this document
    (e.g. starts beyond the last page), so we fail clearly instead of silently
    doing nothing.
    """
    if pages is None:
        return None
    # 1-based (user/instruction) -> 0-based (internal) conversion happens HERE.
    start0 = pages.from_page - 1
    end0 = pages.to_page - 1
    if start0 >= page_count:
        raise NativeEditUnsupported(
            f"Page range {pages.from_page}-{pages.to_page} is outside the "
            f"document (it has {page_count} page{'s' if page_count != 1 else ''})."
        )
    # Clamp the end to the last page; a range like 1-99 on a 22-page doc means
    # "pages 1..22". The start was validated above.
    end0 = min(end0, page_count - 1)
    return set(range(start0, end0 + 1))


def _span_at(page: pymupdf.Page, rect: pymupdf.Rect) -> dict | None:
    """Return the text span dict whose bbox best overlaps `rect`, or None.

    Recovers the ORIGINAL baseline origin, font, size, colour and style flags
    at the match location so the replacement matches the surrounding text.
    """
    best = None
    best_overlap = 0.0
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                sbbox = pymupdf.Rect(span["bbox"])
                inter = sbbox & rect
                if inter.is_empty:
                    continue
                area = inter.get_area()
                if area > best_overlap:
                    best_overlap = area
                    best = span
    return best


def _next_text_x_after(page: pymupdf.Page, rect: pymupdf.Rect) -> float | None:
    """Find the left edge (x0) of the nearest text span that starts to the
    RIGHT of `rect` on roughly the same line. Used to detect whether a longer
    replacement would overlap following text. Returns None if nothing follows.
    """
    line_y = (rect.y0 + rect.y1) / 2.0
    best_x: float | None = None
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                sb = pymupdf.Rect(span["bbox"])
                # same visual line?
                if sb.y0 <= line_y <= sb.y1:
                    if sb.x0 >= rect.x1 - 0.5:  # starts at/after our match end
                        if best_x is None or sb.x0 < best_x:
                            best_x = sb.x0
    return best_x


def apply_plan_native(src_pdf: Path, out_pdf: Path, plan: OperationPlan) -> NativeEditResult:
    """Apply a validated plan to a PDF *in place* and write `out_pdf`.

    Raises NativeEditUnsupported if any requested occurrence cannot be replaced
    safely in place, so the caller can fall back to the conversion pipeline
    without producing a misleading document.
    """
    doc = pymupdf.open(str(src_pdf))
    try:
        result = NativeEditResult()
        result.pages_before = doc.page_count

        replace_ops = [op for op in plan.operations if isinstance(op, ReplaceTextOperation)]

        # Each planned edit records everything needed to redact + reinsert.
        planned: list[dict] = []
        per_op: list[NativeReplaceResult] = []

        for op in replace_ops:
            rr = NativeReplaceResult(find=op.find, replace=op.replace)
            allowed = _allowed_pages(op.pages, doc.page_count)
            if op.pages is not None:
                rr.page_range = (op.pages.from_page, op.pages.to_page)
            per_op.append(rr)

            page_indexes = range(doc.page_count) if allowed is None else sorted(allowed)
            changed_pages: set[int] = set()
            for pno in page_indexes:
                page = doc[pno]
                rects = page.search_for(op.find)
                for rect in rects:
                    span = _span_at(page, rect)
                    if span is None:
                        doc.close()
                        raise NativeEditUnsupported(
                            f"Occurrence of {op.find!r} on page {pno} had no resolvable span."
                        )
                    size = float(span.get("size", 0) or 0)
                    if size <= 0:
                        doc.close()
                        raise NativeEditUnsupported(
                            f"Occurrence of {op.find!r} on page {pno} had no usable font size."
                        )
                    planned.append(
                        {
                            "pno": pno,
                            "rect": rect,
                            "replace": op.replace,
                            "size": size,
                            "rgb": _color_int_to_rgb(int(span.get("color", 0))),
                            "flags": int(span.get("flags", 0)),
                            "span_font": span.get("font", "") or "",
                            "origin": span.get("origin"),  # baseline (x, y)
                            "ascender": float(span.get("ascender", 0.8) or 0.8),
                            "descender": float(span.get("descender", -0.2) or -0.2),
                            "rr": rr,
                        }
                    )
                    rr.occurrences += 1
                    changed_pages.add(pno)
            rr.pages = sorted(p + 1 for p in changed_pages)  # report 1-based

        # Nothing matched anywhere: legitimate "text not found" (not unsafe).
        if not planned:
            doc.save(str(out_pdf), garbage=3, deflate=True)
            result.pages_after = doc.page_count
            result.replaces = per_op
            result.total_replacements = 0
            return result

        # Phase 1 — redact OLD glyphs (text only; never touch images/vector).
        for pno in {p["pno"] for p in planned}:
            page = doc[pno]
            for p in planned:
                if p["pno"] == pno:
                    page.add_redact_annot(p["rect"], fill=None)
            page.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            )

        # Track whether we substituted a font (vs. an exact original reuse).
        # With the subset-font text-layer issue above, we always substitute a
        # matching base-14 font — recorded honestly rather than overclaimed.
        used_fallback = False

        # Phase 2 — draw replacement text on the ORIGINAL baseline.
        for p in planned:
            replacement: str = p["replace"]
            if not replacement:
                continue  # pure deletion; redaction already removed the text
            page = doc[p["pno"]]
            rect: pymupdf.Rect = p["rect"]
            size: float = p["size"]
            rr: NativeReplaceResult = p["rr"]

            # Baseline origin: prefer the span's real baseline (y of the span
            # baseline) so the new text aligns exactly with the surrounding
            # line. Fall back to a geometric baseline only if origin is missing.
            if p["origin"] is not None:
                base_y = float(p["origin"][1])
            else:
                base_y = rect.y1 - size * (-p["descender"])

            # Font: a base-14 font matched to the original's weight/style and
            # serif/sans family. This keeps the text layer correct (searchable,
            # copyable, accessible) which exact subset-font reuse would corrupt.
            fontname = _fallback_fontname(p["flags"])
            used_fallback = True
            measure_font = pymupdf.Font(fontname)

            # Width of the replacement and of the next span's gap.
            adv = measure_font.text_length(replacement, fontsize=size)
            next_x = _next_text_x_after(page, rect)

            # Horizontal anchoring.
            # Default: LEFT-anchor at the original span start (unchanged
            # behaviour for standalone text or text followed by a normal gap).
            insert_x = rect.x0
            # RIGHT-anchor ONLY when the replacement is SHORTER than the
            # original AND the following span sits immediately adjacent to the
            # original text (e.g. a comma/period butting against a name). In the
            # original layout the gap between the name's right edge (rect.x1)
            # and the next span's left edge is ~0; a shorter replacement would
            # otherwise leave a visible hole before that punctuation. Aligning
            # the replacement's right edge to the original right edge closes
            # that hole; the slack moves to BEFORE the text (after the preceding
            # space), where it reads as ordinary word spacing. We do NOT move
            # the neighbouring span.
            if next_x is not None:
                original_gap_to_next = next_x - rect.x1
                is_adjacent = original_gap_to_next <= _ADJACENT_GAP_PT
                is_shorter = adv < rect.width - 0.5
                if is_adjacent and is_shorter:
                    insert_x = rect.x1 - adv

            origin = pymupdf.Point(insert_x, base_y)

            # Overlap check: does the replacement fit in the horizontal space the
            # original occupied before the next text begins? If not, FLAG it
            # (never silently shrink or overwrite neighbours).
            if next_x is not None:
                available = next_x - rect.x0
            else:
                available = rect.width
            available = max(available, rect.width)
            if adv > available + 0.5:
                note = (
                    f'Replacement "{replacement}" is wider than the original '
                    f'text "{rr.find}" on page {p["pno"] + 1}; it may crowd '
                    "adjacent text. Flagged for review."
                )
                rr.flagged.append(note)
                result.notes.append(note)

            try:
                page.insert_text(
                    origin,
                    replacement,
                    fontsize=size,
                    color=p["rgb"],
                    fontname=fontname,
                )
            except Exception as exc:  # noqa: BLE001
                doc.close()
                raise NativeEditUnsupported(
                    f"Failed to reinsert text on page {p['pno']}: {exc}"
                ) from exc

        result.font_reused = not used_fallback
        if used_fallback:
            result.notes.append(
                "Replacement text uses a base font matched to the original's "
                "weight, style and serif/sans family (same size and colour). The "
                "original embedded subset font was not re-encoded because doing so "
                "corrupts the searchable text layer; this keeps the edited text "
                "selectable and accessible. This is not a pixel-perfect glyph match."
            )

        out_pdf.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(out_pdf), garbage=3, deflate=True)
        result.pages_after = doc.page_count
        result.replaces = per_op
        result.total_replacements = sum(r.occurrences for r in per_op)
        return result
    finally:
        if not doc.is_closed:
            doc.close()
