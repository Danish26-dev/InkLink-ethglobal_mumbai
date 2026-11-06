/**
 * Deterministic fallback operator — ETHGlobal jury demo only.
 *
 * Used when no model is available (e.g. no 0G key configured) so judges still
 * see the real pipeline. It is NOT AI and says so:
 *   - `agent_started.provider = "deterministic-fallback"`, model "rule-based planner (no AI)";
 *   - the plan comes from fixed parsing rules over the customer's instruction;
 *   - it calls the SAME allowlisted tools (real printer adapter, real backend
 *     execution gate, real document engine inspection), with the same zod
 *     argument checks and the same event semantics as the Strands hooks:
 *     tool_started -> configuration_updated (inside the tool) -> tool_succeeded,
 *     or tool_failed with the real error;
 *   - no document content is sent to any model.
 * The backend only requests this mode for its isolated demo shop.
 */
import {
  OPERATOR_INPUT_SCHEMAS,
  buildOperatorTools,
  emitEvent,
  type OperatorRunContext,
} from './operatorTools.js';
import { domainFailure, summarizeResult } from './hooks.js';
import { buildTools, type DocumentContext } from '../tools/documentTools.js';
import type { OperatorPrintConfig, OperatorToolName } from '@inklink/shared-schemas';

export interface DeterministicPlan {
  paperSize: OperatorPrintConfig['paperSize'];
  colorMode: OperatorPrintConfig['colorMode'];
  copies: number;
  orientation: OperatorPrintConfig['orientation'];
  duplex: { enabled: boolean; binding?: 'long-edge' | 'short-edge' };
  printerHint: string | null;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, single: 1, two: 2, double: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Fixed parsing rules. Anything not mentioned falls back to the shop defaults / current config. */
export function planFromInstruction(text: string, base: Partial<OperatorPrintConfig>): DeterministicPlan {
  const t = text.toLowerCase();
  const num = /(\d{1,3})\s*(?:x\b|copies|copy|prints|sets)/.exec(t);
  const word = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:copies|copy|prints|sets)\b/.exec(t);
  const copies = num ? Number(num[1]) : word ? WORD_NUMBERS[word[1]] : (base.copies ?? 1);

  const bw = /black\s*(?:and|&|n)\s*white|\bb\s*[&/]\s*w\b|gr[ae]yscale|monochrome|\bmono\b/.test(t);
  const colour = !bw && /\bcolou?r(ed)?\b/.test(t);
  const paper = /\bletter\b/.test(t) ? 'Letter' : /\blegal\b/.test(t) ? 'Legal' : /\ba4\b/.test(t) ? 'A4' : (base.paperSize ?? 'A4');
  const orientation = /\blandscape\b/.test(t) ? 'landscape' : /\bportrait\b/.test(t) ? 'portrait' : (base.orientation ?? 'portrait');

  const single = /\b(single|one)[-\s]?sided\b|\bsimplex\b/.test(t);
  const both = /\b(double|two)[-\s]?sided\b|\bduplex\b|\bboth sides\b/.test(t);
  const duplex = single
    ? { enabled: false }
    : both
      ? { enabled: true, binding: /short[-\s]?edge/.test(t) ? ('short-edge' as const) : ('long-edge' as const) }
      : { enabled: Boolean(base.sides && base.sides !== 'one-sided'), ...(base.sides === 'two-sided-short-edge' ? { binding: 'short-edge' as const } : {}) };

  return {
    paperSize: paper as DeterministicPlan['paperSize'],
    colorMode: bw ? 'monochrome' : colour ? 'color' : (base.colorMode ?? 'monochrome'),
    copies: Math.min(Math.max(copies, 1), 999),
    orientation: orientation as DeterministicPlan['orientation'],
    duplex,
    printerHint: null,
  };
}

type Invocable = { invoke: (input: never, ctx: never) => Promise<unknown> | unknown };

export async function runDeterministicOperator(opts: {
  ctx: OperatorRunContext;
  instruction: string;
  defaults: Partial<OperatorPrintConfig>;
  doc: DocumentContext | null;
}): Promise<void> {
  const { ctx, instruction } = opts;
  const tools = buildOperatorTools(ctx);
  const docTools = opts.doc ? buildTools(opts.doc) : null;
  let n = 0;

  /** One tool call with the same validation and events as the Strands hooks. Returns the result or null on failure. */
  const step = async (name: OperatorToolName, t: Invocable, input: Record<string, unknown>) => {
    const toolUseId = `det_${ctx.runId}_${++n}`;
    const schema = (OPERATOR_INPUT_SCHEMAS as Record<string, { safeParse: (v: unknown) => { success: boolean } }>)[name];
    if (schema && !schema.safeParse(input).success) {
      emitEvent(ctx, 'tool_failed', { runId: ctx.runId, toolUseId, tool: name, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments failed validation.' } });
      return null;
    }
    emitEvent(ctx, 'tool_started', { runId: ctx.runId, toolUseId, tool: name, input });
    let raw: unknown;
    try {
      raw = await t.invoke(input as never, { toolUse: { toolUseId, name, input } } as never);
    } catch (err) {
      emitEvent(ctx, 'tool_failed', { runId: ctx.runId, toolUseId, tool: name,
        error: { code: 'TOOL_ERROR', message: err instanceof Error ? err.message.slice(0, 500) : 'Tool execution failed.' } });
      return null;
    }
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const failure = domainFailure(name, obj);
    if (failure) {
      emitEvent(ctx, 'tool_failed', { runId: ctx.runId, toolUseId, tool: name, error: failure });
      return null;
    }
    emitEvent(ctx, 'tool_succeeded', { runId: ctx.runId, toolUseId, tool: name, result: summarizeResult(name, obj) });
    return obj ?? {};
  };

  const finish = (outcome: 'completed' | 'needs_clarification' | 'failed', message: string) =>
    emitEvent(ctx, 'agent_finished', { runId: ctx.runId, outcome, message });

  emitEvent(ctx, 'agent_started', {
    runId: ctx.runId,
    provider: 'deterministic-fallback',
    model: 'rule-based planner (no AI)',
    trustMode: null,
    instruction: instruction.slice(0, 2000),
  });
  const plan = planFromInstruction(instruction, { ...opts.defaults, ...ctx.config });
  emitEvent(ctx, 'agent_thinking', {
    runId: ctx.runId,
    text:
      `SIMULATED planning (deterministic demo operator, no AI): ${plan.copies} × ${plan.paperSize}, ` +
      `${plan.colorMode === 'monochrome' ? 'black & white' : 'colour'}, ${plan.orientation}, ` +
      `${plan.duplex.enabled ? `two-sided (${plan.duplex.binding ?? 'long-edge'})` : 'one-sided'}. ` +
      'Every action below is a real tool call.',
  });

  if (docTools) await step('inspect_document', docTools.inspectDocument as unknown as Invocable, {});

  const listed = await step('list_printers', tools.listPrinters as unknown as Invocable, {});
  if (!listed) return finish('failed', 'Printer discovery failed, so the printer was not configured.');
  const printers = (listed.printers as { id: string; status: string; isDefault: boolean }[] | undefined) ?? [];
  const chosen = printers.find((p) => p.isDefault && p.status === 'online') ?? printers.find((p) => p.status === 'online');
  if (!chosen) return finish('needs_clarification', 'No online printer was found on the shop computer.');
  if (!(await step('check_printer_readiness', tools.checkPrinterReadiness as unknown as Invocable, { printerId: chosen.id }))) {
    return finish('needs_clarification', `Printer "${chosen.id}" is not ready.`);
  }

  await step('set_paper_size', tools.setPaperSize as unknown as Invocable, { paperSize: plan.paperSize });
  await step('set_color_mode', tools.setColorMode as unknown as Invocable, { colorMode: plan.colorMode });
  await step('set_copies', tools.setCopies as unknown as Invocable, { copies: plan.copies });
  await step('set_orientation', tools.setOrientation as unknown as Invocable, { orientation: plan.orientation });
  await step('set_duplex', tools.setDuplex as unknown as Invocable, plan.duplex);

  if (!(await step('validate_print_config', tools.validatePrintConfig as unknown as Invocable, {}))) {
    return finish('failed', 'The printer rejected the configuration (see the failed step).');
  }
  const requested = await step('request_print_execution', tools.requestPrintExecution as unknown as Invocable, {});
  if (!requested) return finish('failed', 'The execution request was not accepted.');
  finish('completed', `Demo operator (no AI) configured ${plan.copies} × ${plan.paperSize} ${plan.colorMode === 'monochrome' ? 'black & white' : 'colour'}, `
    + `${plan.duplex.enabled ? 'two-sided' : 'one-sided'}. ${typeof requested.message === 'string' ? requested.message : ''}`.trim());
}
