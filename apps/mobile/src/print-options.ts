/**
 * The print options the customer can pick, with their labels. Values are what Contract 3
 * sends; paper, orientation and sides use exactly the local printer agent's values
 * (checked against OPERATOR_* in test/print-options.test.ts).
 */

import type {
  ColourMode,
  PaperSize,
  PrintConfig,
  PrintOrientation,
  PrintSides,
} from "@inklink/shared-schemas";

export interface Option<T extends string> {
  value: T;
  label: string;
}

export const COLOUR_OPTIONS: Option<ColourMode>[] = [
  { value: "grayscale", label: "Black & white" },
  { value: "colour", label: "Colour" },
];

export const PAPER_OPTIONS: Option<PaperSize>[] = [
  { value: "A4", label: "A4" },
  { value: "Letter", label: "Letter" },
  { value: "Legal", label: "Legal" },
];

export const ORIENTATION_OPTIONS: Option<PrintOrientation>[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

export const SIDES_OPTIONS: Option<PrintSides>[] = [
  { value: "one-sided", label: "One-sided" },
  { value: "two-sided-long-edge", label: "Two-sided (book)" },
  { value: "two-sided-short-edge", label: "Two-sided (flip)" },
];

export const DEFAULT_PRINT_CONFIG: PrintConfig = {
  copies: 1,
  pageRange: "all",
  colourMode: "grayscale",
  paperSize: "A4",
  orientation: "portrait",
  sides: "one-sided",
};

/** Human label for a stored value, falling back to the raw value. */
export function labelFor<T extends string>(options: Option<T>[], value: T | undefined): string {
  if (value === undefined) return "—";
  return options.find((o) => o.value === value)?.label ?? value;
}
