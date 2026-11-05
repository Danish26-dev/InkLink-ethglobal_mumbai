// Strict, allowlisted print-configuration schema + validation.
//
// This is the adapter-side source of truth for what a valid print
// configuration is. The agent (LLM) only PROPOSES a configuration and the
// Inklink backend owns the approved one; this deterministic code re-validates
// it before anything is submitted. We never accept arbitrary values, and never
// execute anything derived from free text. The allowed values must stay in
// sync with strands-agent/src/schema.ts (enforced by a contract test there).
//
// Config shape (MVP):
//   {
//     printerId: string,          // must match a discovered printer id
//     copies: integer 1..999,
//     colorMode: 'color' | 'monochrome',
//     paperSize: 'A4' | 'Letter' | 'Legal',
//     orientation: 'portrait' | 'landscape',
//     sides: 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge'
//   }

export const COLOR_MODES = ['color', 'monochrome'];
export const PAPER_SIZES = ['A4', 'Letter', 'Legal'];
export const ORIENTATIONS = ['portrait', 'landscape'];
export const SIDES = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'];

export const MAX_COPIES = 999;

/**
 * Validate a proposed print configuration against the allowlist and the set of
 * printers actually discovered on this machine.
 *
 * @param {object} config proposed configuration (untrusted)
 * @param {Array<{id:string}>} availablePrinters discovered printers
 * @returns {{ ok: boolean, errors: string[], value?: object }}
 */
export function validatePrintConfig(config, availablePrinters = []) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['Configuration must be an object.'] };
  }

  // printerId — must be a non-empty string that matches a discovered printer.
  const printerId = config.printerId;
  if (typeof printerId !== 'string' || printerId.trim() === '') {
    errors.push('printerId is required.');
  } else if (
    availablePrinters.length > 0 &&
    !availablePrinters.some((p) => p.id === printerId)
  ) {
    errors.push(`Unknown printerId: no discovered printer matches "${printerId}".`);
  }

  // copies — integer within range.
  const copies = config.copies;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    errors.push(`copies must be an integer between 1 and ${MAX_COPIES}.`);
  }

  // Enumerated settings — reject anything outside the allowlist (no silent
  // substitution of an incompatible option).
  if (!COLOR_MODES.includes(config.colorMode)) {
    errors.push(`colorMode must be one of: ${COLOR_MODES.join(', ')}.`);
  }
  if (!PAPER_SIZES.includes(config.paperSize)) {
    errors.push(`paperSize must be one of: ${PAPER_SIZES.join(', ')}.`);
  }
  if (!ORIENTATIONS.includes(config.orientation)) {
    errors.push(`orientation must be one of: ${ORIENTATIONS.join(', ')}.`);
  }
  if (!SIDES.includes(config.sides)) {
    errors.push(`sides must be one of: ${SIDES.join(', ')}.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Return a clean, normalized value — only the allowlisted keys, nothing else
  // from the untrusted input is carried through.
  return {
    ok: true,
    errors: [],
    value: {
      printerId,
      copies,
      colorMode: config.colorMode,
      paperSize: config.paperSize,
      orientation: config.orientation,
      sides: config.sides,
    },
  };
}
