/**
 * Strands tools for Inklink document editing.
 *
 * These are narrow, single-responsibility tools the Strands agent can call.
 * The document bytes are NOT passed through the LLM — they live in a
 * per-request context that the tools close over. The LLM only sees extracted
 * text (via inspect) and produces a structured plan (validated before execute).
 *
 * Reliability rules enforced here:
 *   - plan_operations validates the plan against the closed zod schema.
 *   - execute_operation_plan re-validates, then calls the Document Engine,
 *     which is the final authority.
 *   - There is no tool that runs code, shell, or filesystem operations.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { documentEngine, DocumentEngineError } from '../clients/documentEngineClient.js';
import { operationPlan, printOptions, type OperationPlan, type PrintOptions, type ProcessResultLike } from '../types.js';

/** Per-request state shared with the tools (never seen by the LLM). */
export interface DocumentContext {
  fileBuffer: Buffer;
  filename: string;
  /** Populated by inspect_document so plan_operations can reason about it. */
  extractedText?: string;
  /** Populated by execute_operation_plan; read by the orchestrator. */
  lastProcessResult?: ProcessResultLike;
  /** The plan the agent committed to (for the orchestrator to report). */
  committedPlan?: OperationPlan;
  /** Set when the engine returned a TERMINAL (non-retryable) error. */
  terminalError?: { code: string; message: string };
  /**
   * Structured PRINT OPTIONS the customer requested (print configuration,
   * including copies; NOT a document edit). Captured by set_print_options; the
   * Inklink backend validates them and the local printer adapter re-validates
   * them against the shop's real printer. Never sent to the engine.
   */
  printOptions?: PrintOptions;
}

export function buildTools(ctx: DocumentContext) {
  const inspectDocument = tool({
    name: 'inspect_document',
    description:
      'Read the uploaded document and return its plain text so you can decide ' +
      'exactly what to change. Use this before planning any edit. This tool ' +
      'never modifies the document.',
    inputSchema: z.object({}),
    callback: async () => {
      const result = await documentEngine.inspect(ctx.fileBuffer, ctx.filename);
      ctx.extractedText = result.text;
      const preview = result.text.length > 8000 ? result.text.slice(0, 8000) + '\n…(truncated)' : result.text;
      return JSON.stringify({ chars: result.chars, text: preview });
    },
  });

  const planOperations = tool({
    name: 'plan_operations',
    description:
      'Validate a proposed DOCUMENT EDIT plan against the supported operation ' +
      'schema. Only this operation is allowed: replace_text {find, replace, pages?}. ' +
      'Copies and other print settings are NOT document edits; record them with ' +
      'set_print_options instead. ' +
      'replace_text may include an OPTIONAL "pages" object { from, to } giving ' +
      'an inclusive 1-based page range to restrict the replacement (e.g. ' +
      '{ from: 1, to: 3 } = pages 1-3); omit it to replace throughout the whole ' +
      'document. Page scoping is supported and enforced by the engine for PDFs. ' +
      'Call this with the operations you intend to perform. If the plan is ' +
      'invalid it returns the validation errors so you can correct it. Do NOT ' +
      'guess find/replace targets — if the instruction is ambiguous, ask the ' +
      'user to clarify instead of calling this.',
    inputSchema: z.object({
      operations: z
        .array(z.record(z.string(), z.unknown()))
        .describe('List of operation objects to validate against the closed schema.'),
    }),
    callback: (input) => {
      const parsed = operationPlan.safeParse({ operations: input.operations });
      if (!parsed.success) {
        return JSON.stringify({
          valid: false,
          errors: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      ctx.committedPlan = parsed.data;
      return JSON.stringify({ valid: true, plan: parsed.data });
    },
  });

  const executeOperationPlan = tool({
    name: 'execute_operation_plan',
    description:
      'Execute the validated operation plan on the document via the Document ' +
      'Engine. Only call this after plan_operations reported valid: true. ' +
      'Supports page-scoped replace_text (via the optional "pages" range), which ' +
      'the engine enforces deterministically. Returns a summary of exactly what ' +
      'changed, including which pages were affected. The edited document keeps ' +
      'the uploaded format and is returned for the customer to review and approve ' +
      'before anything is printed. If it returns an error, report that error and ' +
      'do NOT claim the edit succeeded.',
    inputSchema: z.object({
      operations: z
        .array(z.record(z.string(), z.unknown()))
        .describe('The validated operations to execute.'),
    }),
    callback: async (input) => {
      // Re-validate — never trust that the model passed the same plan it validated.
      const parsed = operationPlan.safeParse({ operations: input.operations });
      if (!parsed.success) {
        return JSON.stringify({
          executed: false,
          error: 'Plan failed validation and was not executed.',
          errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      try {
        const result = await documentEngine.process(ctx.fileBuffer, ctx.filename, parsed.data);
        ctx.lastProcessResult = result;
        ctx.committedPlan = parsed.data;
        return JSON.stringify({ executed: true, changes: result.changes });
      } catch (err) {
        if (err instanceof DocumentEngineError) {
          // Some engine failures are TERMINAL — retrying will never succeed
          // (e.g. the PDF renderer is unavailable, the file is unsupported, or
          // the PDF is scanned). Signal the model to STOP and report, not loop.
          const TERMINAL = new Set([
            'libreoffice_unavailable',
            'unsupported_format',
            'scanned_pdf',
            'output_validation_failed',
            'file_too_large',
            'output_format_mismatch',
          ]);
          const terminal = TERMINAL.has(err.code);
          // Record the terminal failure so the orchestrator can surface it
          // directly even if the model's prose is unhelpful.
          if (terminal) ctx.terminalError = { code: err.code, message: err.message };
          return JSON.stringify({
            executed: false,
            terminal,
            code: err.code,
            error: err.message,
            directive: terminal
              ? 'This failure is permanent for this request. Do NOT retry or call any ' +
                'tool again. Tell the customer this exact problem in one short sentence and stop.'
              : 'You may reconsider the plan, but do not repeat the identical call.',
          });
        }
        throw err;
      }
    },
  });

  const setPrintOptions = tool({
    name: 'set_print_options',
    description:
      'Capture the customer\'s requested PRINT settings (how the document should ' +
      'be PRINTED — not a document edit). Supported fields (all optional; set ' +
      'only what the customer asked for): ' +
      'printerId (string), copies (int 1-999), ' +
      "colorMode ('color' | 'monochrome'), " +
      "paperSize ('A4' | 'Letter' | 'Legal'), " +
      "orientation ('portrait' | 'landscape'), " +
      "sides ('one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge'). " +
      'Map natural language, e.g. "black and white" -> colorMode "monochrome"; ' +
      '"double-sided" -> sides "two-sided-long-edge"; "landscape" -> orientation ' +
      '"landscape"; "3 copies" -> copies 3. This is the ONLY place copies are ' +
      'recorded. This tool only RECORDS the request; the print shop validates the ' +
      'settings against its real printer and applies the supported ones. Do NOT ' +
      'claim a setting was applied — the shop confirms that after approval.',
    inputSchema: z.object({
      printerId: z.string().optional(),
      copies: z.number().int().optional(),
      colorMode: z.enum(['color', 'monochrome']).optional(),
      paperSize: z.enum(['A4', 'Letter', 'Legal']).optional(),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      sides: z.enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']).optional(),
    }),
    callback: (input) => {
      // Validate against the strict allowlist. Merge with any previously
      // captured options so multiple calls accumulate.
      const merged = { ...(ctx.printOptions ?? {}), ...input };
      const parsed = printOptions.safeParse(merged);
      if (!parsed.success) {
        return JSON.stringify({
          recorded: false,
          errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      ctx.printOptions = parsed.data;
      return JSON.stringify({
        recorded: true,
        printOptions: parsed.data,
        note:
          'Print options recorded. The print shop will validate them against its ' +
          'real printer and apply the supported ones; any unsupported option will ' +
          'be reported. Nothing prints until the shopkeeper approves.',
      });
    },
  });

  return { inspectDocument, planOperations, executeOperationPlan, setPrintOptions };
}
