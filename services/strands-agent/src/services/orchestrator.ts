/**
 * The Inklink planning orchestrator (Strands Agents SDK implementation).
 *
 * Wires a real Strands Agent (Google Vertex AI / Gemini model) to the four
 * tools and drives one edit request end-to-end:
 *
 *   user instruction
 *     -> agent calls inspect_document (reads text via Document Engine)
 *     -> agent reasons and calls plan_operations (validated against schema)
 *     -> agent calls execute_operation_plan (Document Engine applies it)
 *     -> agent optionally calls set_print_options (print configuration proposal)
 *     -> agent returns a human-readable message
 *
 * The LLM never edits document bytes. It only selects/validates operations;
 * the Python Document Engine performs and re-validates the actual edit. The
 * result is a proposal: the Inklink backend owns customer approval, payment and
 * job status, and nothing is printed until the shop approves.
 *
 * NOTE: Inklink's target orchestration is Google ADK. This module is the
 * Strands implementation. The tools' callback logic, the schemas and this
 * prompt are framework-neutral and can be re-hosted in ADK.
 */
import { Agent } from '@strands-agents/sdk';
import type { GoogleModel } from '@strands-agents/sdk/models/google';
import { buildVertexModel } from '../model/vertexProvider.js';
import { buildTools, type DocumentContext } from '../tools/documentTools.js';
import { toAgentError } from '../errors.js';
import type { AgentEditResult } from '../types.js';

export const SYSTEM_PROMPT = `You are Inklink's document editing assistant for a print shop.

Your job: turn a customer's natural-language instruction into precise, safe edits
on THEIR uploaded document, then execute them, and record how they want it printed.

You have these tools:
- inspect_document: read the document's text. ALWAYS call this first (for edits).
- plan_operations: validate the exact DOCUMENT EDITS you intend to perform.
- execute_operation_plan: apply the validated document edits.
- set_print_options: record the customer's requested PRINT settings (how the
  document should be PRINTED — this is NOT a document edit).

DOCUMENT-EDIT operations (change the document's content) — ONLY this one:
- replace_text { find, replace, pages? }  -> replace literal text (case-sensitive, exact).
    * Optional "pages": an inclusive 1-based range { from, to } that RESTRICTS the
      replacement to those pages (e.g. { from: 1, to: 3 } means pages 1, 2 and 3).
      Omit "pages" to replace throughout the whole document (the default).
      Page numbers are 1-based (the first page is page 1).

PRINT settings (how the document is PRINTED — captured via set_print_options; all
optional, set only what the customer asked for):
- copies       -> number of copies (int). Copies are ALWAYS a print setting, never a
                  document edit.
- printerId    -> a specific printer (usually leave unset; the shop uses its default).
- colorMode    -> "color" or "monochrome"  (map "black and white"/"B&W" -> "monochrome").
- paperSize    -> "A4", "Letter", or "Legal".
- orientation  -> "portrait" or "landscape".
- sides        -> "one-sided", "two-sided-long-edge", or "two-sided-short-edge"
                  (map "double-sided"/"duplex" -> "two-sided-long-edge";
                   "single-sided" -> "one-sided").

WHAT IS SUPPORTED — do NOT claim these are impossible:
- Page-restricted edits for digital PDFs via the "pages" field above. The Document
  Engine enforces the page boundary; occurrences outside the range are left unchanged.
  When the customer says "only pages 1 to 3", translate that to pages: { from: 1, to: 3 }.
- Digital PDFs are edited in place where possible, preserving layout, page count, page
  size and images.
- The edited document keeps the format it was uploaded in (PDF stays PDF, DOCX stays
  DOCX). Do not offer to convert between formats.
- PRINT settings (copies, colour/monochrome, paper size, orientation, single/double-sided,
  printer). When the customer mentions any of them, call set_print_options with the
  mapped values. The print shop validates them against its REAL printer and applies the
  supported ones; any option the printer cannot do is reported honestly. Do NOT claim a
  print setting was physically applied; the shop confirms that after approval.

WHAT IS NOT SUPPORTED:
- Scanned or image-only PDFs (no OCR), and any file type other than PDF or DOCX.
- Any edit other than literal text replacement.

Hard rules:
1. NEVER invent or guess find/replace targets. Use the exact text from the document.
2. If the instruction is ambiguous (e.g. "change the name" when several names exist,
   or the target/replacement is unclear), DO NOT edit. Ask the customer a specific
   clarifying question and stop.
3. Before saying something is unsupported, CHECK the lists above. If the request can be
   expressed with replace_text (optionally page-scoped) or set_print_options, DO IT via
   the tools — do not merely describe what could be done.
4. If the text to replace does not exist in the document (or in the requested page range),
   tell the customer it was not found; do not execute a no-op silently.
5. Only call execute_operation_plan after plan_operations returns valid: true. Do NOT
   claim the document has been edited until execute_operation_plan has SUCCEEDED. If a
   tool returns an error, report that error plainly; never fabricate a success.
6. Never mention tools, JSON, schemas, or internal mechanics to the customer.
7. If a page range is given for a document that is not a digital PDF, the engine will
   reject it with a clear error; relay that honestly rather than applying the change
   document-wide.
8. Nothing is printed or paid for by you. The customer reviews and approves the edited
   document, and the shop approves the job, before printing.

When you finish, reply with a short, friendly confirmation of what you did — the document
edits (include pages when page-scoped) AND the print settings you recorded (noting the
shop will apply them on its printer). Example: "I'll replace 'Alex Example' with 'Sam
Example', and prepare 2 black & white, A4, double-sided copies — you can review the edited
document, and the shop will confirm the settings on its printer before printing."`;

export interface EditRequest {
  instruction: string;
  fileBuffer: Buffer;
  filename: string;
}

export class PlanningOrchestrator {
  private buildModel(): GoogleModel {
    // Vertex AI via ADC. buildVertexModel() validates GOOGLE_CLOUD_PROJECT /
    // GOOGLE_CLOUD_LOCATION / VERTEX_AI_MODEL_ID (throws a clear, secret-free
    // error otherwise). Credentials come from ADC and are never read here.
    return buildVertexModel();
  }

  async runEdit(req: EditRequest): Promise<AgentEditResult> {
    const ctx: DocumentContext = {
      fileBuffer: req.fileBuffer,
      filename: req.filename,
    };
    const { inspectDocument, planOperations, executeOperationPlan, setPrintOptions } = buildTools(ctx);

    let result: unknown;
    try {
      const agent = new Agent({
        model: this.buildModel(),
        systemPrompt: SYSTEM_PROMPT,
        tools: [inspectDocument, planOperations, executeOperationPlan, setPrintOptions],
        printer: false,
      });
      result = await withThrottleRetry(() => agent.invoke(req.instruction));
    } catch (err) {
      // Map Vertex AI / config failures to a sanitized, typed error. Never leak
      // credentials or raw provider internals.
      throw toAgentError(err);
    }

    const message = extractText(result);

    // The orchestrator's truth about what happened comes from the context the
    // tools populated, not from parsing the model's prose. Print options (if the
    // customer requested any) are carried on EVERY path so the backend can use
    // the agent's proposal when configuring the real printer.
    if (ctx.lastProcessResult) {
      return {
        executed: true,
        message,
        plan: ctx.committedPlan,
        document: ctx.lastProcessResult,
        printOptions: ctx.printOptions,
      };
    }

    // A TERMINAL engine failure (e.g. PDF renderer unavailable) is a definite
    // failure, NOT a clarification. Surface it so the backend records a clean
    // failed state rather than leaving the job ambiguous.
    if (ctx.terminalError) {
      return {
        executed: false,
        message: message || ctx.terminalError.message,
        plan: ctx.committedPlan,
        errorCode: ctx.terminalError.code,
        printOptions: ctx.printOptions,
      };
    }

    // PRINT-SETTINGS-ONLY SUCCESS: the customer asked only to change print
    // settings (e.g. "2 copies, black and white, A4"). The agent captured them
    // via set_print_options but did NO document edit (none was requested). This
    // is a SUCCESS — the proposal is complete — NOT a clarification.
    if (ctx.printOptions && Object.keys(ctx.printOptions).length > 0) {
      return {
        executed: true,
        message,
        plan: ctx.committedPlan,
        printOptions: ctx.printOptions,
        printOptionsOnly: true,
      };
    }

    // No execution happened: either clarification is needed or nothing matched.
    return {
      executed: false,
      message,
      plan: ctx.committedPlan,
      needsClarification: true,
      printOptions: ctx.printOptions,
    };
  }
}

/** Detect a Vertex/Gemini throttling (HTTP 429 / RESOURCE_EXHAUSTED) error by
 * walking the cause chain. Status/message only; never reads credentials. */
function isThrottle(err: unknown): boolean {
  let cur: any = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const status = cur.status ?? cur.statusCode ?? cur.code;
    if (status === 429) return true;
    if (typeof cur.message === 'string' && /RESOURCE_EXHAUSTED|429|quota/i.test(cur.message)) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Run an agent invocation with a BOUNDED retry/backoff that triggers ONLY on
 * throttling (429 / RESOURCE_EXHAUSTED). Non-throttle errors propagate
 * immediately. This never loops indefinitely.
 *
 * Vertex per-minute rate limits hold for a window that short retries cannot
 * outlast, so the default schedule (5s, 12s, 20s, 30s) rides out a throttle
 * window while staying inside the agent -> engine (165s) budget. Tunable via env:
 *   AGENT_THROTTLE_RETRIES (default 4)
 *   AGENT_THROTTLE_DELAYS_MS (comma list, default "5000,12000,20000,30000")
 */
const THROTTLE_DELAYS: number[] = (process.env.AGENT_THROTTLE_DELAYS_MS ?? '5000,12000,20000,30000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const THROTTLE_MAX_RETRIES = Number.isFinite(Number(process.env.AGENT_THROTTLE_RETRIES))
  ? Math.max(0, parseInt(process.env.AGENT_THROTTLE_RETRIES as string, 10))
  : 4;

async function withThrottleRetry<T>(fn: () => Promise<T>, maxRetries = THROTTLE_MAX_RETRIES): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < maxRetries && isThrottle(err)) {
        const wait = THROTTLE_DELAYS[attempt] ?? THROTTLE_DELAYS[THROTTLE_DELAYS.length - 1] ?? 5000;
        // eslint-disable-next-line no-console
        console.warn(`[inklink-agent] Vertex throttled (429); retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

/** Pull the assistant's final text out of a Strands AgentResult, tolerant of
 * SDK shape differences across versions. */
function extractText(result: unknown): string {
  const r = result as any;
  const last = r?.lastMessage ?? r?.message ?? r;
  if (typeof last === 'string') return last.trim();
  const content = last?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
      .join('')
      .trim();
  }
  if (typeof content === 'string') return content.trim();
  if (typeof last?.text === 'string') return last.text.trim();
  return '';
}

export const planningOrchestrator = new PlanningOrchestrator();
