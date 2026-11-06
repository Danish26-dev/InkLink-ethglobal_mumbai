import { useEffect, useRef } from 'react';
import { Bot, Check, Circle, Cpu, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { JobView, OperatorEvent } from '@inklink/shared-schemas';
import { PHASE_LABEL, TOOL_LABEL, type OperatorState, type Phase } from '../lib/operatorState';
import { COLOR_LABEL, ORIENTATION_LABEL, PAPER_LABEL, SIDES_LABEL } from './PrinterDialog';

const PROVIDER_LABEL: Record<string, string> = {
  '0g-private-computer': '0G Private Computer',
  'vertex-ai': 'Vertex AI',
};

/* ───────────── left: agent, task, phase ───────────── */

const STEPS: { label: string; phases: Phase[] }[] = [
  { label: 'Read document', phases: ['reading_document', 'editing_document'] },
  { label: 'Select printer', phases: ['selecting_printer'] },
  { label: 'Configure settings', phases: ['configuring'] },
  { label: 'Validate with printer', phases: ['validating'] },
  { label: 'Request execution', phases: ['requesting_execution'] },
  { label: 'Approvals & payment', phases: ['awaiting_approvals'] },
  { label: 'Printing', phases: ['printing', 'completed'] },
];

export function AgentPanel({ state, agentAvailable, agentReason }: {
  state: OperatorState; agentAvailable: boolean | null; agentReason?: string | null;
}) {
  const run = state.run;
  const current = STEPS.findIndex((s) => s.phases.includes(state.phase));
  // A step counts as done only when one of its tools actually succeeded (or the job printed).
  const succeeded = new Set(state.tools.filter((t) => t.status === 'succeeded').map((t) => t.tool));
  const STEP_TOOLS: string[][] = [
    ['inspect_document', 'plan_operations', 'execute_operation_plan'],
    ['check_printer_readiness'],
    ['set_paper_size', 'set_color_mode', 'set_copies', 'set_orientation', 'set_duplex'],
    ['validate_print_config'],
    ['request_print_execution'],
  ];
  const reached = (i: number) =>
    state.phase === 'completed' ||
    (i < STEP_TOOLS.length && STEP_TOOLS[i].some((t) => succeeded.has(t)) && (i !== 3 || state.validated)) ||
    (i === 5 && Boolean(state.executionAuthorized));
  return (
    <aside className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto border-r border-light-grey p-5" aria-label="Agent">
      <section>
        <p className="label-mono mb-2">Agent</p>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink text-paper"><Bot className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <p className="font-medium leading-tight">Inklink Print Operator</p>
            <p className="flex items-center gap-1.5 text-xs text-graphite">
              <span className={`h-2 w-2 rounded-full ${run?.active ? 'pulse-dot bg-signal' : agentAvailable === false ? 'bg-signal' : agentAvailable ? 'bg-emerald-500' : 'bg-graphite'}`} />
              {run?.active ? 'Working' : agentAvailable === false ? 'Unavailable' : agentAvailable ? 'Ready' : 'Checking…'}
            </p>
          </div>
        </div>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-2"><Cpu className="h-3.5 w-3.5 text-graphite" aria-hidden="true" /><dt className="sr-only">Provider</dt>
            <dd>{run ? PROVIDER_LABEL[run.provider] ?? run.provider : '—'}</dd></div>
          {run?.model && <div className="flex items-center gap-2 font-mono text-graphite"><dt className="sr-only">Model</dt><dd className="truncate">{run.model}</dd></div>}
          {run?.trustMode && (
            <div className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /><dt className="sr-only">Trust mode</dt>
              <dd>Trust mode: <span className="font-mono">{run.trustMode}</span></dd></div>
          )}
        </dl>
        {agentAvailable === false && !run?.active && agentReason && (
          <p className="mt-3 rounded-md bg-signal/10 p-2 text-xs text-ink">{agentReason}</p>
        )}
      </section>

      <section>
        <p className="label-mono mb-2">Task</p>
        <p className="text-sm leading-relaxed">{run?.instruction || <span className="text-graphite">No instruction yet. Send a message from the conversation.</span>}</p>
      </section>

      <section>
        <p className="label-mono mb-2">Phase</p>
        <p className="mb-3 text-sm font-medium">{PHASE_LABEL[state.phase]}</p>
        <ol className="space-y-2">
          {STEPS.map((s, i) => {
            const active = i === current && state.phase !== 'completed';
            const done = reached(i) && !active;
            return (
              <li key={s.label} className={`flex items-center gap-2 text-sm ${active ? 'text-ink' : done ? 'text-ink' : 'text-graphite'}`}>
                {active ? (run?.active ? <Loader2 className="h-4 w-4 animate-spin text-signal" aria-hidden="true" /> : <Circle className="h-4 w-4 fill-signal text-signal" aria-hidden="true" />)
                  : done ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}
                {s.label}
              </li>
            );
          })}
        </ol>
      </section>

      {(state.thinking || run?.finishMessage) && (
        <section>
          <p className="label-mono mb-2">{run?.active ? 'Narration' : 'Result'}</p>
          <p className="rounded-md bg-paper p-3 text-sm leading-relaxed">{run?.active ? state.thinking : run?.finishMessage}</p>
        </section>
      )}
    </aside>
  );
}

/* ───────────── right: config, document, readiness, gates ───────────── */

export function ConfigPanel({ state, job }: { state: OperatorState; job: JobView | null }) {
  const c = state.config;
  const printerName = state.printers.find((p) => p.id === c.printerId)?.name ?? c.printerId;
  const rows: [string, string | null, string][] = [
    ['Printer', printerName, 'printerId'],
    ['Paper', c.paperSize ? PAPER_LABEL[c.paperSize] : null, 'paperSize'],
    ['Colour', c.colorMode ? COLOR_LABEL[c.colorMode] : null, 'colorMode'],
    ['Copies', c.copies !== null ? String(c.copies) : null, 'copies'],
    ['Orientation', c.orientation ? ORIENTATION_LABEL[c.orientation] : null, 'orientation'],
    ['Sides', c.sides ? SIDES_LABEL[c.sides] : null, 'sides'],
  ];
  const doc = job?.document;
  const pageCount = state.document?.pageCount ?? doc?.pageCount ?? null;
  const submitResult = state.controlTool.submit?.status === 'succeeded' ? state.controlTool.submit.result : undefined;
  const gates: [string, boolean][] = [
    ['Configuration validated', state.validated],
    ['Customer approved quote', Boolean(job?.customerApprovedQuote)],
    ['Payment settled (verified)', (state.payment?.status ?? job?.paymentStatus) === 'settled'],
    ['Shop approved', Boolean(job?.shopApproved)],
    ['Sent to printer', Boolean(state.executionAuthorized) || job?.status === 'executing' || job?.status === 'completed'],
  ];

  return (
    <aside className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto border-l border-light-grey p-5" aria-label="Live configuration">
      <section>
        <p className="label-mono mb-2">Live configuration</p>
        <dl className="divide-y divide-light-grey rounded-lg border border-light-grey bg-white text-sm">
          {rows.map(([label, value, field]) => (
            <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
              <dt className="text-graphite">{label}</dt>
              <dd className="flex items-center gap-1.5 text-right">
                {(state.touched as Record<string, number | undefined>)[field] && <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-label="changed in this run" />}
                {value ?? <span className="text-graphite">Not set</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className={`mt-2 flex items-center gap-1.5 text-xs ${state.validated ? 'text-emerald-700' : 'text-graphite'}`}>
          {state.validated ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}
          {state.validated ? 'Validated against the real printer' : 'Not validated since the last change'}
        </p>
      </section>

      <section>
        <p className="label-mono mb-2">Document</p>
        {doc ? (
          <div className="space-y-1 text-sm">
            <p className="truncate font-medium">{doc.filename}</p>
            <p className="font-mono text-xs text-graphite">{doc.format.toUpperCase()} · {pageCount ?? 'unknown'} pages · {(doc.size / 1024).toFixed(0)} KB</p>
            {(doc.edited || state.document) && (
              <p className="text-xs">Edited by the operator{state.document ? ` · ${state.document.totalReplacements} replacements` : ''}</p>
            )}
            {(state.document?.reviewRecommended || doc.reviewRecommended) && (
              <p className="flex items-center gap-1.5 text-xs text-signal"><TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />Review recommended before printing</p>
            )}
            {(state.document?.notes ?? doc.notes).slice(0, 4).map((n) => <p key={n} className="text-xs text-graphite">· {n}</p>)}
          </div>
        ) : <p className="text-sm text-graphite">No document yet.</p>}
      </section>

      <section>
        <p className="label-mono mb-2">Printer readiness</p>
        {state.readiness ? (
          <p className="text-sm">
            <span className={state.readiness.available ? 'text-emerald-700' : 'text-signal'}>{state.readiness.status}</span>
            {state.readiness.printerId && <span className="text-graphite"> · {state.readiness.printerId}</span>}
          </p>
        ) : <p className="text-sm text-graphite">Not checked yet.</p>}
        {state.printers.length > 0 && <p className="mt-1 text-xs text-graphite">{state.printers.length} printer(s) discovered on the shop computer.</p>}
      </section>

      <section>
        <p className="label-mono mb-2">Execution gates</p>
        <ul className="space-y-1.5 text-sm">
          {gates.map(([label, ok]) => (
            <li key={label} className={`flex items-center gap-2 ${ok ? '' : 'text-graphite'}`}>
              {ok ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}{label}
            </li>
          ))}
        </ul>
        {typeof submitResult?.message === 'string' && <p className="mt-2 text-xs text-graphite">{submitResult.message}</p>}
        {state.payment?.hashscanUrl && (
          <a className="mt-2 inline-block text-xs text-signal underline" href={state.payment.hashscanUrl} target="_blank" rel="noreferrer">View Hedera transaction</a>
        )}
      </section>
    </aside>
  );
}

/* ───────────── bottom: event stream ───────────── */

export function summarize(e: OperatorEvent): string {
  switch (e.type) {
    case 'agent_started':
      return `${PROVIDER_LABEL[e.payload.provider] ?? e.payload.provider} · ${e.payload.model}${e.payload.trustMode ? ` · trust ${e.payload.trustMode}` : ''}`;
    case 'agent_thinking':
      return e.payload.text;
    case 'tool_started':
      return `${TOOL_LABEL[e.payload.tool] ?? e.payload.tool} ${Object.keys(e.payload.input ?? {}).length ? JSON.stringify(e.payload.input) : ''}`;
    case 'tool_succeeded':
      return `${TOOL_LABEL[e.payload.tool] ?? e.payload.tool} ✓`;
    case 'tool_failed':
      return `${TOOL_LABEL[e.payload.tool] ?? e.payload.tool} · ${e.payload.error.code}: ${e.payload.error.message}`;
    case 'configuration_updated':
      return `${e.payload.field} = ${e.payload.value}`;
    case 'printer_readiness_updated':
      return e.payload.printers ? `${e.payload.printers.length} printer(s) discovered` : `${e.payload.printerId ?? 'printer'} is ${e.payload.status}`;
    case 'document_processed':
      return `${e.payload.totalReplacements} replacement(s) · ${e.payload.outputFormat.toUpperCase()}${e.payload.pageCount ? ` · ${e.payload.pageCount} pages` : ''}`;
    case 'approval_required':
      return `${e.payload.kind}: ${e.payload.reason}`;
    case 'payment_status_updated':
      return `payment ${e.payload.status}${e.payload.transactionId ? ` · ${e.payload.transactionId}` : ''}`;
    case 'execution_authorized':
      return `authorized by backend · ${e.payload.submissionState ?? ''}`;
    case 'job_status_updated':
      return `job ${e.payload.status} · payment ${e.payload.paymentStatus} · device ${e.payload.deviceStatus}`;
    case 'agent_finished':
      return `${e.payload.outcome} · ${e.payload.message}`;
    default:
      return '';
  }
}

export function EventStream({ events, played }: { events: OperatorEvent[]; played: number }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <section className="flex min-h-0 flex-col border-t border-light-grey bg-ink text-paper" aria-label="Event stream">
      <div className="flex items-center gap-3 px-5 py-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper/60">Event stream</p>
        <span className="font-mono text-[11px] text-paper/40">{events.length} events · GET /api/v1/jobs/…/events</span>
      </div>
      <ol ref={ref} className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 font-mono text-[12px] leading-6" aria-live="off">
        {events.length === 0 && <li className="text-paper/40">Waiting for events…</li>}
        {events.map((e, i) => (
          <li key={e.seq} className={`flex gap-3 ${i === played - 1 ? 'text-paper' : i >= played ? 'text-paper/35' : 'text-paper/70'}`}>
            <span className="w-8 shrink-0 text-right text-paper/40">{e.seq}</span>
            <span className="w-16 shrink-0 text-paper/40">{e.ts.slice(11, 19)}</span>
            <span className="w-14 shrink-0 text-paper/40">{e.source}</span>
            <span className={`w-48 shrink-0 ${e.type === 'tool_failed' ? 'text-signal' : e.type === 'tool_succeeded' ? 'text-emerald-400' : ''}`}>{e.type}</span>
            <span className="truncate">{summarize(e)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
