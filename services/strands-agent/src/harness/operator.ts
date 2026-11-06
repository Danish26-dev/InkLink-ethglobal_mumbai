/**
 * Inklink Print Operator Harness — one run of the print operator for a job.
 *
 * Wraps the Strands Agents SDK:
 *   model     -> the configured provider (0G Private Computer by default; no fallback)
 *   tools     -> document tools (inspect / plan / execute) + allowlisted printer tools
 *   executor  -> sequential, so each action completes before the next starts
 *   hooks     -> allowlist, argument validation, budget, lifecycle events
 *
 * Every observable step is published as a HarnessEvent through `emit`. The
 * backend relays them to the Agent Workspace over SSE and updates its own
 * authoritative job state. The harness itself holds no job state beyond a run.
 */
import { Agent } from '@strands-agents/sdk';
import {
  EMPTY_OPERATOR_CONFIG,
  type HarnessEvent,
  type OperatorPrintConfig,
} from '@inklink/shared-schemas';
import { buildModel, providerStatus, ModelUnavailableError, type InferenceGrant } from '../model/providers.js';
import { buildTools, type DocumentContext } from '../tools/documentTools.js';
import { toAgentError } from '../errors.js';
import { buildOperatorTools, emitEvent, type OperatorRunContext } from './operatorTools.js';
import { installOperatorHooks } from './hooks.js';

export const OPERATOR_SYSTEM_PROMPT = `You are the Inklink print operator at a print shop. You configure a real printer for the customer's job by calling tools, exactly like a person clicking through printer preferences.

Tools you may use:
- inspect_document: read the document text (call first when a document is attached).
- plan_operations / execute_operation_plan: only when the customer asks to change the document's text (replace_text).
- list_printers: discover the shop's real printers.
- check_printer_readiness: select a printer by its id from list_printers and confirm it is ready.
- set_paper_size, set_color_mode, set_copies, set_orientation, set_duplex: change one print setting each.
- validate_print_config: validate the full configuration against the selected printer.
- request_print_execution: ask the backend to print. You cannot print yourself.

Procedure:
1. If a document is attached, call inspect_document. Apply text edits only if the customer asked for them.
2. Call list_printers, then check_printer_readiness for the shop's default printer (or the one the customer named) if it is online.
3. Set every print setting, one tool call at a time: paper size, colour mode, copies, orientation, duplex.
   Use the customer's request; for anything they did not mention, use the shop defaults given below.
   Map "black and white"/"B&W" to monochrome, "double-sided"/"duplex"/"both sides" to set_duplex enabled=true.
4. Call validate_print_config. If it fails, fix the reported problem; do not repeat an identical failing call.
5. Call request_print_execution once validation succeeded.
6. Finish with one or two short sentences for the customer: what you configured and what happens next
   (they review and approve the quote, payment is completed in the Inklink app, the shop prints).

Rules:
- Never invent printer ids, settings, or results. Only report what tools returned.
- If a tool fails, say so plainly. Never claim something worked when its tool failed.
- If the request is ambiguous (e.g. which text to change), ask one clarifying question and stop.
- Never mention tool names, JSON or internal mechanics to the customer.`;

export interface OperatorRunRequest {
  jobId: string;
  runId: string;
  instruction: string;
  document: { buffer: Buffer; filename: string } | null;
  /** Shop defaults for settings the customer did not mention. */
  defaults: Partial<OperatorPrintConfig>;
  /** Configuration already confirmed earlier for this job (continues from here). */
  current?: Partial<OperatorPrintConfig>;
  /** Backend-issued 0G inference grant (trust mode chosen by the backend's policy). */
  inference?: InferenceGrant | null;
  emit: (event: HarnessEvent) => void;
}

function describeDefaults(d: Partial<OperatorPrintConfig>): string {
  const parts = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : 'none provided (ask the customer if a setting is unclear)';
}

/** Run the operator once. Always ends with an `agent_finished` event. */
export async function runPrintOperator(req: OperatorRunRequest): Promise<void> {
  const ctx: OperatorRunContext = {
    jobId: req.jobId,
    runId: req.runId,
    config: { ...EMPTY_OPERATOR_CONFIG, ...(req.current ?? {}) },
    validated: false,
    printers: null,
    emit: req.emit,
  };

  const status = providerStatus();
  if (!status.available) {
    emitEvent(ctx, 'agent_finished', {
      runId: req.runId,
      outcome: 'unavailable',
      message: status.reason ?? 'The print operator is not available.',
    });
    return;
  }

  let model;
  try {
    model = buildModel(req.inference ?? null);
  } catch (err) {
    emitEvent(ctx, 'agent_finished', {
      runId: req.runId,
      outcome: 'unavailable',
      message: err instanceof ModelUnavailableError ? err.message : 'The print operator is not available.',
    });
    return;
  }

  const doc: DocumentContext | null = req.document
    ? { fileBuffer: req.document.buffer, filename: req.document.filename }
    : null;
  const docTools = doc ? buildTools(doc) : null;
  const printerTools = buildOperatorTools(ctx);

  const tools = [
    ...(docTools ? [docTools.inspectDocument, docTools.planOperations, docTools.executeOperationPlan] : []),
    printerTools.listPrinters,
    printerTools.checkPrinterReadiness,
    printerTools.setPaperSize,
    printerTools.setColorMode,
    printerTools.setCopies,
    printerTools.setOrientation,
    printerTools.setDuplex,
    printerTools.validatePrintConfig,
    printerTools.requestPrintExecution,
  ];

  const agent = new Agent({
    model,
    systemPrompt:
      OPERATOR_SYSTEM_PROMPT +
      `\n\nShop defaults: ${describeDefaults(req.defaults)}.` +
      `\nAlready confirmed for this job: ${describeDefaults(ctx.config)}.` +
      (doc ? `\nAttached document: ${doc.filename}.` : '\nNo document is attached.'),
    tools,
    toolExecutor: 'sequential',
    printer: false,
  });
  installOperatorHooks(agent, ctx, { doc });

  emitEvent(ctx, 'agent_started', {
    runId: req.runId,
    provider: status.provider === 'vertex-ai' ? 'vertex-ai' : '0g-private-computer',
    model: req.inference?.model ?? status.model ?? 'unknown',
    trustMode: status.provider === 'vertex-ai' ? null : (req.inference?.trustMode ?? null),
    instruction: req.instruction.slice(0, 2000),
  });

  try {
    const result: any = await agent.invoke(req.instruction);
    const message = extractText(result);
    emitEvent(ctx, 'agent_finished', {
      runId: req.runId,
      outcome: ctx.validated ? 'completed' : 'needs_clarification',
      message: message || (ctx.validated ? 'Printer configured.' : 'The operator could not finish the configuration.'),
    });
  } catch (err) {
    const safe = toAgentError(err);
    emitEvent(ctx, 'agent_finished', { runId: req.runId, outcome: 'failed', message: `${safe.message} (${safe.code})` });
  }
}

function extractText(result: any): string {
  const last = result?.lastMessage ?? result?.message ?? result;
  if (typeof last === 'string') return last.trim();
  const content = last?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : (c?.text ?? '')))
      .join('')
      .trim();
  }
  return typeof last?.text === 'string' ? last.text.trim() : '';
}
