/**
 * The app's print options must use exactly the local printer agent's values, so a job
 * created from the phone can be printed without guessing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATOR_ORIENTATIONS,
  OPERATOR_PAPER_SIZES,
  OPERATOR_SIDES,
} from "@inklink/shared-schemas";
import {
  COLOUR_OPTIONS,
  DEFAULT_PRINT_CONFIG,
  ORIENTATION_OPTIONS,
  PAPER_OPTIONS,
  SIDES_OPTIONS,
  labelFor,
} from "../src/print-options";

const values = (o: { value: string }[]) => o.map((x) => x.value).sort();

describe("print options match the printer agent", () => {
  it("offers exactly the supported paper sizes (no A3)", () => {
    assert.deepEqual(values(PAPER_OPTIONS), [...OPERATOR_PAPER_SIZES].sort());
  });

  it("offers exactly the supported orientations and sides", () => {
    assert.deepEqual(values(ORIENTATION_OPTIONS), [...OPERATOR_ORIENTATIONS].sort());
    assert.deepEqual(values(SIDES_OPTIONS), [...OPERATOR_SIDES].sort());
  });

  it("keeps the Contract 3 colour values the backend maps", () => {
    assert.deepEqual(values(COLOUR_OPTIONS), ["colour", "grayscale"]);
  });

  it("sends a complete config by default", () => {
    assert.deepEqual(DEFAULT_PRINT_CONFIG, {
      copies: 1,
      pageRange: "all",
      colourMode: "grayscale",
      paperSize: "A4",
      orientation: "portrait",
      sides: "one-sided",
    });
  });

  it("labels values for display", () => {
    assert.equal(labelFor(SIDES_OPTIONS, "two-sided-long-edge"), "Two-sided (book)");
    assert.equal(labelFor(ORIENTATION_OPTIONS, undefined), "—");
  });
});
