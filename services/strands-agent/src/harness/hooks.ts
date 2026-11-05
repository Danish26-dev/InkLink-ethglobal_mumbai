/**
 * Print Operator Harness lifecycle hooks (Strands SDK).
 *
 * Before a tool runs:
 *   - the tool name must be on the operator allowlist,
 *   - printer-tool arguments are re-validated with the same zod schema the tool uses,
 *   - a per-run tool-call budget prevents runaway loops,
 *   otherwise the call is CANCELLED and `tool_failed` is published.
 *   Passing calls publish `tool_started` with the real arguments.
 *
 * After a tool runs:
 *   - `tool_succeeded` is published ONLY when the SDK reports success AND the
 *     tool's own result does not report a domain failure;
 *   - everything else publishes `tool_failed` with the real code/message.
 *
 * Completed text blocks from the model are published as `agent_thinking`
 * (customer-visible narration). Hidden reasoning blocks are not forwarded.
 */
import {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  ContentBlockEvent,
  type Agent,
} from '@strands-agents/sdk';
import { OPERATOR_TOOLS, type OperatorToolName } from '@inklink/shared-schemas';
import { OPERATOR_INPUT_SCHEMAS, emitEvent, type OperatorRunContext, type PrinterToolName } from './operatorTools.js';
import type { DocumentContext } from '../tools/documentTools.js';

const ALLOWED = new Set<string>(OPERATOR_TOOLS);
export const DEFAULT_MAX_TOOL_CALLS = 40;

export interface HookOptions {
  doc: DocumentContext | null;
  maxToolCalls?: number;
}

/** Parse a tool result's first text/json content as an object, if possible. */
export function resultObject(result: { content: ReadonlyArray<unknown> }): Record<string, unknown> | null {
  for (const block of result.content as any[]) {
    if (block && typeof block.json === 'object' && block.json !== null) return block.json as Record<string, unknown>;
    if (block && typeof block.text === 'string') {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        return { text: block.text };
      }
    }
  }
  return null;
}

/**
 * Decide whether a tool's own result is a domain failure. Operator tools use
 * `ok:false`; the document tools use `valid:false` / `executed:false`.
 */
export function domainFailure(tool: string, obj: Record<string, unknown> | null): { code: string; message: string } | null {
  if (!obj) return null;
  if (obj.ok === false) return { code: String(obj.code ?? 'TOOL_FAILED'), message: String(obj.message ?? 'The action failed.') };
  if (tool === 'plan_operations' && obj.valid === false) {
    return { code: 'PLAN_INVALID', message: 'The proposed document edit failed validation.' };
  }
  if (tool === 'execute_operation_plan' && obj.executed === false) {
    return { code: String(obj.code ?? 'EDIT_FAILED'), message: String(obj.error ?? 'The document edit was not applied.') };
  }
  return null;
}

/** Keep event payloads small and free of document contents. */
export function summarizeResult(tool: string, obj: Record<string, unknown> | null): Record<string, unknown> {
  if (!obj) return {};
  if (tool === 'inspect_document') return { chars: obj.chars ?? null };
  const json = JSON.stringify(obj);
  return json.length <= 4000 ? obj : { truncated: true, preview: json.slice(0, 4000) };
}

function sanitizeInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const json = JSON.stringify(input);
  return json.length <= 4000 ? (input as Record<string, unknown>) : { truncated: true, preview: json.slice(0, 4000) };
}

export function installOperatorHooks(agent: Agent, ctx: OperatorRunContext, opts: HookOptions): void {
  const maxCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const cancelled = new Set<string>();
  let calls = 0;

  agent.addHook(BeforeToolCallEvent, (event) => {
    const { name, toolUseId, input } = event.toolUse;
    const reject = (code: string, message: string) => {
      event.cancel = message;
      cancelled.add(toolUseId);
      emitEvent(ctx, 'tool_failed', { runId: ctx.runId, toolUseId, tool: name, error: { code, message } });
    };

    calls += 1;
    if (!ALLOWED.has(name)) return reject('TOOL_NOT_ALLOWED', `"${name}" is not an allowlisted operator tool.`);
    if (calls > maxCalls) return reject('TOOL_BUDGET_EXCEEDED', `More than ${maxCalls} tool calls in one run.`);

    const schema = (OPERATOR_INPUT_SCHEMAS as Record<string, { safeParse: (v: unknown) => { success: boolean; error?: any } }>)[
      name as PrinterToolName
    ];
    if (schema) {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        const detail = parsed.error?.issues?.map((i: any) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
        return reject('INVALID_ARGUMENTS', detail || 'Arguments failed validation.');
      }
    }
    emitEvent(ctx, 'tool_started', {
      runId: ctx.runId,
      toolUseId,
      tool: name as OperatorToolName,
      input: sanitizeInput(input),
    });
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    const { name, toolUseId } = event.toolUse;
    if (cancelled.has(toolUseId)) return; // already reported by the Before hook

    const obj = resultObject(event.result);
    if (event.result.status === 'error' || event.error) {
      const message = event.error?.message || (obj && typeof obj.text === 'string' ? obj.text : 'Tool execution failed.');
      emitEvent(ctx, 'tool_failed', {
        runId: ctx.runId,
        toolUseId,
        tool: name,
        error: { code: 'TOOL_ERROR', message: message.slice(0, 500) },
      });
      return;
    }
    const failure = domainFailure(name, obj);
    if (failure) {
      emitEvent(ctx, 'tool_failed', { runId: ctx.runId, toolUseId, tool: name, error: failure });
      return;
    }

    if (name === 'execute_operation_plan' && opts.doc?.lastProcessResult) {
      const r = opts.doc.lastProcessResult;
      emitEvent(ctx, 'document_processed', {
        runId: ctx.runId,
        engineJobId: r.job_id,
        totalReplacements: r.changes.total_replacements,
        outputFormat: r.output_format === 'pdf' ? 'pdf' : 'docx',
        pageCount: r.validation?.page_count ?? null,
        reviewRecommended: Boolean(r.validation?.review_recommended),
        notes: r.validation?.notes ?? [],
      });
    }
    emitEvent(ctx, 'tool_succeeded', {
      runId: ctx.runId,
      toolUseId,
      tool: name as OperatorToolName,
      result: summarizeResult(name, obj),
    });
  });

  agent.addHook(ContentBlockEvent, (event) => {
    const block = event.contentBlock as { type?: string; text?: string };
    if (block?.type === 'textBlock' && typeof block.text === 'string' && block.text.trim()) {
      emitEvent(ctx, 'agent_thinking', { runId: ctx.runId, text: block.text.trim().slice(0, 2000) });
    }
  });
}
