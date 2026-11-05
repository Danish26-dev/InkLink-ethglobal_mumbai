/**
 * The closed operation schema, mirrored from the Python Document Engine
 * (document-engine/app/editing/schema.py). This is the reliability boundary:
 * the agent may only produce operations defined here, and every plan is
 * validated against these zod schemas before it is sent to the Document Engine.
 *
 * The Document Engine re-validates independently and remains the final
 * authority. This client-side validation lets the agent fail fast and ask for
 * clarification without a network round-trip.
 *
 * To add an operation, mirror the corresponding change in the Python engine.
 */
import { z } from 'zod';

export const MAX_OPERATIONS = 50;
export const MAX_TEXT_LENGTH = 5000;
export const MAX_COPIES = 999;

/**
 * Optional inclusive 1-based page range for a page-scoped replacement.
 * {from: 1, to: 3} means pages 1, 2 and 3. Omit `pages` for a whole-document
 * replacement (the default). Page scoping is only meaningful for PDFs.
 */
export const pageRange = z
  .object({
    from: z.number().int().min(1),
    to: z.number().int().min(1),
  })
  .refine((r) => r.to >= r.from, {
    message: '`to` page must be >= `from` page',
  });

export const replaceTextOperation = z.object({
  type: z.literal('replace_text'),
  find: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .refine((s) => s.trim().length > 0, {
      message: '`find` cannot be blank or whitespace-only',
    }),
  replace: z.string().max(MAX_TEXT_LENGTH),
  // Optional: restrict this replacement to an inclusive 1-based page range.
  pages: pageRange.optional(),
});

/**
 * Document-edit operations. Copy count is deliberately NOT here: it is print
 * configuration (see `printOptions` below). A `set_copies` document operation
 * is rejected.
 */
export const operation = z.discriminatedUnion('type', [replaceTextOperation]);

export const operationPlan = z.object({
  operations: z.array(operation).max(MAX_OPERATIONS),
});

export type Operation = z.infer<typeof operation>;
export type OperationPlan = z.infer<typeof operationPlan>;

export const SUPPORTED_OPERATIONS = ['replace_text'] as const;

/**
 * PRINT OPTIONS (print configuration, NOT a document edit).
 *
 * The printer settings a customer can request in natural language, including
 * the copy count. They are kept SEPARATE from the document-edit plan and are
 * never sent to the Document Engine. The agent only records a PROPOSAL; the
 * Inklink backend owns the approved print configuration, and the local printer
 * adapter (local-printer-agent/src/printConfig.js) re-validates it against the
 * shop's real printer before anything is submitted. Every field is optional:
 * the agent only sets what the customer asked for, and the backend fills
 * defaults before calling the printer adapter, which requires all fields.
 *
 * Allowed values must stay identical to local-printer-agent/src/printConfig.js
 * (checked by test/unit/contracts.test.ts).
 */
export const printColorModes = ['color', 'monochrome'] as const;
export const printPaperSizes = ['A4', 'Letter', 'Legal'] as const;
export const printOrientations = ['portrait', 'landscape'] as const;
export const printSides = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] as const;

export const printOptions = z
  .object({
    printerId: z.string().min(1).max(256).optional(),
    copies: z.number().int().min(1).max(MAX_COPIES).optional(),
    colorMode: z.enum(printColorModes).optional(),
    paperSize: z.enum(printPaperSizes).optional(),
    orientation: z.enum(printOrientations).optional(),
    sides: z.enum(printSides).optional(),
  })
  .strict(); // reject unknown keys — allowlist only

export type PrintOptions = z.infer<typeof printOptions>;
