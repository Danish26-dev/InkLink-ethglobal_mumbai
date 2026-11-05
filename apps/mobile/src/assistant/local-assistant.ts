/**
 * Local Assistant (SLM) integration layer.
 *
 * ⚠️ MOCK IMPLEMENTATION. The real on-device runtime (quantized SLM + llama.cpp)
 * is a later milestone. This file defines the INTERFACE and a labelled mock so the
 * app can wire the "describe your print job in words" UX now.
 *
 * Security boundary (enforced by this interface, not the model):
 *   - The assistant only returns a STRUCTURED request. It never executes shell
 *     commands, touches the filesystem, controls GPIO, signs transactions, or
 *     sees private keys. The app validates and acts on the structured output.
 */

import type { PrintConfig } from "@inklink/shared-schemas";

export interface AssistantRequest {
  /** Natural-language instruction, e.g. "2 copies, black and white, double sided". */
  instruction: string;
}

export interface AssistantResult {
  /** Extracted, validated print configuration. */
  printConfig: PrintConfig;
  /** Fields the model was unsure about; the UI should confirm these. */
  uncertain: (keyof PrintConfig)[];
  /** Whether this came from the real model or the mock. Always surfaced in UI. */
  source: "mock" | "slm";
}

export interface LocalAssistant {
  parse(req: AssistantRequest): Promise<AssistantResult>;
}

/**
 * Deterministic mock: a small rule-based parser standing in for the SLM. Clearly
 * labelled; the UI must show source === "mock".
 */
export class MockLocalAssistant implements LocalAssistant {
  async parse(req: AssistantRequest): Promise<AssistantResult> {
    const text = req.instruction.toLowerCase();
    const uncertain: (keyof PrintConfig)[] = [];

    // copies
    const copiesMatch = text.match(/(\d+)\s*(copies|copy|prints?)/);
    const copies = copiesMatch ? Math.max(1, parseInt(copiesMatch[1], 10)) : 1;
    if (!copiesMatch) uncertain.push("copies");

    // colour
    const mono = /(black\s*(and|&)?\s*white|b\s*&?\s*w|grayscale|greyscale|mono)/.test(text);
    const colour = /colou?r/.test(text);
    const colourMode: PrintConfig["colourMode"] = mono
      ? "grayscale"
      : colour
        ? "colour"
        : "grayscale";
    if (!mono && !colour) uncertain.push("colourMode");

    // page range
    const rangeMatch = text.match(/pages?\s*([\d]+\s*-\s*[\d]+)/);
    const pageRange = rangeMatch ? rangeMatch[1].replace(/\s+/g, "") : "all";
    if (!rangeMatch) uncertain.push("pageRange");

    // paper size
    const sizeMatch = text.match(/\b(a4|a3|letter|legal)\b/);
    const paperSize = (sizeMatch?.[1]?.toUpperCase() as PrintConfig["paperSize"]) ?? "A4";
    if (!sizeMatch) uncertain.push("paperSize");

    return {
      printConfig: { copies, pageRange, colourMode, paperSize },
      uncertain,
      source: "mock",
    };
  }
}
