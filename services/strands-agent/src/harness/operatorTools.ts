/**
 * Inklink Print Operator tools — the allowlisted, deterministic action layer.
 *
 * The model chooses WHICH tool to call and with what arguments. Everything a
 * tool actually does is plain code here:
 *   - arguments are validated against the shared allowlists (zod) before use;
 *   - printer facts come from the local printer adapter, never from the model;
 *   - a setting is only changed after validation passes, and the change is
 *     published as `configuration_updated` from inside the tool;
 *   - a tool reports failure as `{ ok: false, code, message }` so the harness
 *     can publish `tool_failed` with the real reason.
 *
 * There is no tool that prints. `request_print_execution` only ASKS the backend,
 * which owns the job state and decides whether physical execution is allowed.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  OPERATOR_COLOR_MODES,
  OPERATOR_MAX_COPIES,
  OPERATOR_ORIENTATIONS,
  OPERATOR_PAPER_SIZES,
  type HarnessEvent,
  type OperatorConfigField,
  type OperatorEventPayloads,
  type OperatorEventType,
  type OperatorPrintConfig,
  type OperatorSides,
  type PrinterSummary,
} from '@inklink/shared-schemas';
import { backend, printerAdapter, ServiceCallError } from './clients.js';

export interface OperatorRunContext {
  jobId: string;
  runId: string;
  config: OperatorPrintConfig;
  /** True only after the adapter accepted the complete config. Any later change resets it. */
  validated: boolean;
  printers: PrinterSummary[] | null;
  emit: (event: HarnessEvent) => void;
}

export function emitEvent<K extends OperatorEventType>(
  ctx: OperatorRunContext,
  type: K,
  payload: OperatorEventPayloads[K],
): void {
  ctx.emit({ type, ts: new Date().toISOString(), payload } as HarnessEvent);
}

type ToolOutcome = { ok: true; [k: string]: unknown } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): ToolOutcome => ({ ok: false, code, message });

function serviceFailure(err: unknown): ToolOutcome {
  if (err instanceof ServiceCallError) return fail(err.code, err.message);
  return fail('UNEXPECTED_ERROR', 'The action failed unexpectedly.');
}

/** Input schemas, exported so the BeforeToolCall hook re-validates with the same rules. */
export const OPERATOR_INPUT_SCHEMAS = {
  list_printers: z.object({}).strict(),
  check_printer_readiness: z.object({ printerId: z.string().min(1).max(256) }).strict(),
  set_paper_size: z.object({ paperSize: z.enum(OPERATOR_PAPER_SIZES) }).strict(),
  set_color_mode: z.object({ colorMode: z.enum(OPERATOR_COLOR_MODES) }).strict(),
  set_copies: z.object({ copies: z.number().int().min(1).max(OPERATOR_MAX_COPIES) }).strict(),
  set_orientation: z.object({ orientation: z.enum(OPERATOR_ORIENTATIONS) }).strict(),
  set_duplex: z
    .object({ enabled: z.boolean(), binding: z.enum(['long-edge', 'short-edge']).optional() })
    .strict(),
  validate_print_config: z.object({}).strict(),
  request_print_execution: z.object({}).strict(),
} as const;

export type PrinterToolName = keyof typeof OPERATOR_INPUT_SCHEMAS;

function setField(
  ctx: OperatorRunContext,
  toolUseId: string,
  field: OperatorConfigField,
  value: string | number | null,
): void {
  (ctx.config as unknown as Record<string, unknown>)[field] = value;
  ctx.validated = false; // any change invalidates a previous validation
  emitEvent(ctx, 'configuration_updated', {
    runId: ctx.runId,
    toolUseId,
    field,
    value,
    config: { ...ctx.config },
  });
}

export function buildOperatorTools(ctx: OperatorRunContext) {
  const listPrinters = tool({
    name: 'list_printers',
    description:
      'Discover the printers installed on the print shop computer. Returns each printer id, ' +
      'name, status (online/offline/unknown) and whether it is the default. Call this before ' +
      'choosing a printer. Never invent a printer id.',
    inputSchema: OPERATOR_INPUT_SCHEMAS.list_printers,
    callback: async (): Promise<ToolOutcome> => {
      try {
        const { printers, defaultPrinter } = await printerAdapter.listPrinters();
        ctx.printers = printers;
        emitEvent(ctx, 'printer_readiness_updated', {
          printerId: ctx.config.printerId,
          status: 'unknown',
          available: printers.some((p) => p.status === 'online'),
          printers,
        });
        return { ok: true, printers, defaultPrinter };
      } catch (err) {
        return serviceFailure(err);
      }
    },
  });

  const checkPrinterReadiness = tool({
    name: 'check_printer_readiness',
    description:
      'Select a printer for this job and check that it is ready right now. printerId must be an ' +
      'id returned by list_printers. If the printer is offline or missing, it is not selected.',
    inputSchema: OPERATOR_INPUT_SCHEMAS.check_printer_readiness,
    callback: async (input, context): Promise<ToolOutcome> => {
      const toolUseId = context?.toolUse.toolUseId ?? 'unknown';
      if (ctx.printers && !ctx.printers.some((p) => p.id === input.printerId)) {
        return fail('PRINTER_NOT_FOUND', `"${input.printerId}" is not one of the discovered printers.`);
      }
      try {
        const r = await printerAdapter.availability(input.printerId);
        const status = (['online', 'offline', 'unknown', 'not_found'].includes(r.status) ? r.status : 'unknown') as
          'online' | 'offline' | 'unknown' | 'not_found';
        emitEvent(ctx, 'printer_readiness_updated', { printerId: input.printerId, status, available: r.available });
        if (!r.available) return fail('PRINTER_UNAVAILABLE', `Printer "${input.printerId}" is ${status}.`);
        setField(ctx, toolUseId, 'printerId', input.printerId);
        return { ok: true, printerId: input.printerId, status };
      } catch (err) {
        return serviceFailure(err);
      }
    },
  });

  const simpleSetter = <F extends 'paperSize' | 'colorMode' | 'orientation'>(
    name: 'set_paper_size' | 'set_color_mode' | 'set_orientation',
    field: F,
    description: string,
  ) =>
    tool({
      name,
      description,
      inputSchema: OPERATOR_INPUT_SCHEMAS[name] as z.ZodObject<any>,
      callback: (input: Record<string, unknown>, context): ToolOutcome => {
        // The SDK already validated `input` against this tool's enum schema.
        const value = String(input[field]);
        setField(ctx, context?.toolUse.toolUseId ?? 'unknown', field, value);
        return { ok: true, [field]: value };
      },
    });

  const setPaperSize = simpleSetter(
    'set_paper_size',
    'paperSize',
    `Set the paper size. Allowed: ${OPERATOR_PAPER_SIZES.join(', ')}.`,
  );
  const setColorMode = simpleSetter(
    'set_color_mode',
    'colorMode',
    'Set colour or black & white printing. Allowed: color, monochrome ("black and white" = monochrome).',
  );
  const setOrientation = simpleSetter(
    'set_orientation',
    'orientation',
    'Set page orientation. Allowed: portrait, landscape.',
  );

  const setCopies = tool({
    name: 'set_copies',
    description: `Set the number of copies (integer 1-${OPERATOR_MAX_COPIES}). Copies are a print setting, never a document edit.`,
    inputSchema: OPERATOR_INPUT_SCHEMAS.set_copies,
    callback: (input, context): ToolOutcome => {
      setField(ctx, context?.toolUse.toolUseId ?? 'unknown', 'copies', input.copies);
      return { ok: true, copies: input.copies };
    },
  });

  const setDuplex = tool({
    name: 'set_duplex',
    description:
      'Turn double-sided printing on or off. enabled=false prints one-sided. When enabled, binding ' +
      'defaults to long-edge (normal book-style flip); use short-edge only if the customer asks.',
    inputSchema: OPERATOR_INPUT_SCHEMAS.set_duplex,
    callback: (input, context): ToolOutcome => {
      const sides: OperatorSides = !input.enabled
        ? 'one-sided'
        : input.binding === 'short-edge'
          ? 'two-sided-short-edge'
          : 'two-sided-long-edge';
      setField(ctx, context?.toolUse.toolUseId ?? 'unknown', 'sides', sides);
      return { ok: true, sides };
    },
  });

  const validatePrintConfig = tool({
    name: 'validate_print_config',
    description:
      'Validate the complete print configuration against the selected real printer. All of printer, ' +
      'paper size, colour mode, copies, orientation and duplex must be set first.',
    inputSchema: OPERATOR_INPUT_SCHEMAS.validate_print_config,
    callback: async (): Promise<ToolOutcome> => {
      const missing = (Object.keys(ctx.config) as OperatorConfigField[]).filter((k) => ctx.config[k] === null);
      if (missing.length) return fail('CONFIG_INCOMPLETE', `Set these first: ${missing.join(', ')}.`);
      try {
        const r = await printerAdapter.validate(ctx.config);
        if (!r.ok) return fail('CONFIG_INVALID', r.errors.join(' ') || 'The printer rejected this configuration.');
        ctx.validated = true;
        return { ok: true, config: { ...ctx.config } };
      } catch (err) {
        return serviceFailure(err);
      }
    },
  });

  const requestPrintExecution = tool({
    name: 'request_print_execution',
    description:
      'Ask the Inklink backend to print this job with the validated configuration. You cannot print ' +
      'directly. The backend prints only after the customer approved the quote, payment was verified ' +
      'and the shop approved; until then it records the request and reports what is pending.',
    inputSchema: OPERATOR_INPUT_SCHEMAS.request_print_execution,
    callback: async (): Promise<ToolOutcome> => {
      if (!ctx.validated) return fail('CONFIG_NOT_VALIDATED', 'Run validate_print_config successfully first.');
      try {
        const r = await backend.requestExecution(ctx.jobId, ctx.runId, ctx.config);
        if (!r.accepted) return fail('EXECUTION_REQUEST_REJECTED', r.message || `Backend state: ${r.state}.`);
        return { ok: true, state: r.state, pending: r.pending, message: r.message };
      } catch (err) {
        return serviceFailure(err);
      }
    },
  });

  return {
    listPrinters,
    checkPrinterReadiness,
    setPaperSize,
    setColorMode,
    setCopies,
    setOrientation,
    setDuplex,
    validatePrintConfig,
    requestPrintExecution,
  };
}
