import { useEffect, useRef } from 'react';
import { Bot, Check, Circle, Cpu, FileText, Loader2, Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { JobView, OperatorEvent } from '@inklink/shared-schemas';
import { PHASE_LABEL, TOOL_LABEL, type OperatorState } from '../lib/operatorState';
import { COLOR_LABEL, ORIENTATION_LABEL, PAPER_LABEL, SIDES_LABEL } from './PrinterDialog';

const PROVIDER_LABEL: Record<string, string> = {
  '0g-private-computer': '0G Private Computer',
  'vertex-ai': 'Vertex AI',
};
const MODE_LABEL: Record<string, string> = { standard: 'Standard', verified: 'Verified', private: 'Private' };

/** Honest wording: a provider attestation is not a per-response signature check. */
export function verificationLabel(last: { verification?: string; teeVerified?: boolean | null; teeType?: string | null }): string {
  if (last.verification === 'tee_signature_verified' || last.teeVerified === true) return 'TEE signature verified';
  if (last.verification === 'provider_attested') return `attested ${last.teeType ?? 'TEE'} provider`;
  return 'no attestation (standard)';
}

/* ───────────── left: agent identity, task, reasoning summary ───────────── */

export function AgentPanel({ state, job, agentAvailable, agentReason }: {
  state: OperatorState; job: JobView | null; agentAvailable: boolean | null; agentReason?: string | null;
}) {
  const run = state.run;
  const sel = job?.privacy.selection;
  const last = job?.privacy.lastInference;
  const current = [...state.tools].reverse().find((t) => t.status === 'running') ?? state.tools[state.tools.length - 1];
  const statusText = run?.active ? 'Operating the printer' : agentAvailable === false ? 'Unavailable' : agentAvailable ? 'Ready' : 'Checking…';
  const dot = run?.active ? 'pulse-dot bg-signal' : agentAvailable === false ? 'bg-signal' : agentAvailable ? 'bg-emerald-500' : 'bg-graphite';

  return (
    <aside className="flex min-h-0 w-full flex-col gap-6 overflow-y-auto border-r border-light-grey bg-white p-5" aria-label="Agent">
      <section>
        <div className="flex items-center gap-3">
          <span className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-paper">
            <Bot className="h-5 w-5" aria-hidden="true" />
            <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${dot}`} />
          </span>
          <div className="min-w-0">
            <p className="font-medium leading-tight">Inklink Print Operator</p>
            <p className="text-xs text-graphite">Strands agent · {statusText}</p>
          </div>
        </div>
        <dl className="mt-4 space-y-2 rounded-lg bg-paper p-3 text-xs">
          <div className="flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-graphite" aria-hidden="true" /><dt className="text-graphite">Inference</dt>
            <dd className="ml-auto text-right">{run ? PROVIDER_LABEL[run.provider] ?? run.provider : sel?.provider ? PROVIDER_LABEL[sel.provider] ?? sel.provider : '—'}</dd>
          </div>
          {(run?.model || sel?.model) && (
            <div className="flex items-center gap-2"><dt className="pl-5 text-graphite">Model</dt><dd className="ml-auto font-mono">{run?.model || sel?.model}</dd></div>
          )}
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-graphite" aria-hidden="true" /><dt className="text-graphite">Trust mode</dt>
            <dd className="ml-auto font-medium">{sel ? MODE_LABEL[sel.effectiveTrustMode] : run?.trustMode ? MODE_LABEL[run.trustMode] : '—'}</dd>
          </div>
          {last && (
            <div className="flex items-center gap-2">
              <ShieldCheck className={`h-3.5 w-3.5 ${last.verification && last.verification !== 'none' ? 'text-emerald-600' : 'text-graphite'}`} aria-hidden="true" />
              <dt className="text-graphite">Last call</dt>
              <dd className={`ml-auto text-right ${last.ok ? '' : 'text-signal'}`}>
                {!last.ok ? last.errorCode : verificationLabel(last)}
              </dd>
            </div>
          )}
          {last?.requestId && (
            <div className="flex items-center gap-2">
              <dt className="pl-5 text-graphite">0G request</dt>
              <dd className="ml-auto truncate font-mono text-[11px]" title={last.requestId}>{last.requestId}</dd>
            </div>
          )}
          {last?.provider && (
            <div className="flex items-center gap-2">
              <dt className="pl-5 text-graphite">Provider</dt>
              <dd className="ml-auto truncate font-mono text-[11px]" title={last.provider}>{last.provider}</dd>
            </div>
          )}
        </dl>
        {sel && <p className="mt-2 text-[11px] leading-snug text-graphite">{sel.reason}{sel.raisedBy ? ` Raised by ${sel.raisedBy}.` : ''}</p>}
        {agentAvailable === false && !run?.active && agentReason && (
          <p className="mt-3 rounded-md bg-signal/10 p-2 text-xs">{agentReason}</p>
        )}
      </section>

      <section>
        <p className="label-mono mb-2">Current task</p>
        <p className="text-sm leading-relaxed">{run?.instruction || <span className="text-graphite">No instruction yet.</span>}</p>
      </section>

      <section>
        <p className="label-mono mb-2">Now</p>
        <p className="text-sm font-medium">{PHASE_LABEL[state.phase]}</p>
        {current && (
          <p className={`mt-1 flex items-center gap-1.5 text-xs ${current.status === 'failed' ? 'text-signal' : 'text-graphite'}`}>
            {current.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : current.status === 'succeeded' ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                : <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
            {TOOL_LABEL[current.tool] ?? current.tool}
          </p>
        )}
      </section>

      <section className="min-h-0">
        <p className="label-mono mb-2">Reasoning summary</p>
        {state.narration.length === 0 && !run?.finishMessage && (
          <p className="text-xs text-graphite">The operator's own words appear here as it works. Hidden model reasoning is never shown.</p>
        )}
        <ol className="space-y-2">
          {state.narration.map((n, i) => (
            <li key={i} className="border-l-2 border-light-grey pl-3 text-[13px] leading-relaxed text-ink/80">{n}</li>
          ))}
          {run?.finishMessage && !run.active && run.finishMessage !== state.narration[state.narration.length - 1] && (
            <li className={`border-l-2 pl-3 text-[13px] leading-relaxed ${run.outcome === 'completed' ? 'border-emerald-500' : 'border-signal'}`}>
              {run.finishMessage}
            </li>
          )}
        </ol>
      </section>
    </aside>
  );
}

/* ───────────── right: document details, configuration, boundaries ───────────── */

export function ConfigPanel({ state, job }: { state: OperatorState; job: JobView | null }) {
  const c = state.config;
  const printerName = state.printers.find((p) => p.id === c.printerId)?.name ?? c.printerId;
  const rows: [string, string | null, string, string][] = [
    ['Printer', printerName, 'printerId', 'printer'],
    ['Paper', c.paperSize ? PAPER_LABEL[c.paperSize] : null, 'paperSize', 'paperSize'],
    ['Colour', c.colorMode ? COLOR_LABEL[c.colorMode] : null, 'colorMode', 'colorMode'],
    ['Copies', c.copies !== null ? String(c.copies) : null, 'copies', 'copies'],
    ['Orientation', c.orientation ? ORIENTATION_LABEL[c.orientation] : null, 'orientation', 'orientation'],
    ['Two-sided', c.sides ? SIDES_LABEL[c.sides] : null, 'sides', 'sides'],
  ];
  const doc = job?.document;
  const pageCount = state.document?.pageCount ?? doc?.pageCount ?? null;
  // Approval boundaries stay separate: none of them is implied by another.
  const gates: [string, boolean, string][] = [
    ['Settings validated', state.validated, 'by the printer adapter'],
    ['Customer approved quote', Boolean(job?.customerApprovedQuote), 'in the customer app'],
    ['Payment verified', (state.payment?.status ?? job?.paymentStatus) === 'settled', 'signed Hedera settlement'],
    ['Shop authorized', Boolean(job?.shopApproved), 'in the shop dashboard'],
    ['Sent to printer', Boolean(state.executionAuthorized) || job?.status === 'executing' || job?.status === 'completed', 'by the backend only'],
  ];

  return (
    <aside className="flex min-h-0 w-full flex-col gap-6 overflow-y-auto border-l border-light-grey bg-white p-5" aria-label="Document and configuration">
      <section>
        <p className="label-mono mb-2">Document</p>
        {doc ? (
          <div className="rounded-lg border border-light-grey p-3">
            <div className="flex items-start gap-2.5">
              <FileText className="mt-0.5 h-5 w-5 shrink-0 text-signal" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{doc.filename}</p>
                <p className="font-mono text-[11px] text-graphite">{doc.format.toUpperCase()} · {pageCount ?? 'unknown'} pages · {(doc.size / 1024).toFixed(0)} KB</p>
              </div>
            </div>
            {doc.classification && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink/80">
                <Lock className="h-3 w-3" aria-hidden="true" />
                {doc.classification.level === 'sensitive' ? `Sensitive: ${doc.classification.categories.join(', ')}`
                  : doc.classification.level === 'unclassified' ? 'Unclassified (treated as sensitive)' : 'No sensitive content found'}
              </p>
            )}
            {doc.editStatus !== 'none' && (
              <p className="mt-1 text-[11px] text-graphite">
                Edited copy: {doc.editStatus === 'pending_review' ? 'awaiting customer review' : doc.editStatus}
                {state.document ? ` · ${state.document.totalReplacements} replacement(s)` : ''}
              </p>
            )}
            {(state.document?.reviewRecommended || doc.reviewRecommended) && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-signal"><TriangleAlert className="h-3 w-3" aria-hidden="true" />Review recommended</p>
            )}
          </div>
        ) : <p className="text-sm text-graphite">No document yet.</p>}
      </section>

      <section>
        <p className="label-mono mb-2">Current configuration</p>
        <dl className="divide-y divide-light-grey rounded-lg border border-light-grey text-[13px]">
          {rows.map(([label, value, field, control]) => {
            const call = state.controlTool[control as keyof typeof state.controlTool];
            const touched = (state.touched as Record<string, number | undefined>)[field];
            const pending = touched && call?.status === 'running';
            return (
              <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-graphite">{label}</dt>
                <dd className={`flex items-center gap-1.5 text-right ${pending ? 'italic text-ink/60' : ''}`}>
                  {value ?? <span className="text-graphite">Not set</span>}
                  {value && call?.status === 'succeeded' && <Check className="h-3.5 w-3.5 text-emerald-600" aria-label="confirmed" />}
                  {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-signal" aria-label="awaiting result" />}
                </dd>
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-graphite"><dt>Quality</dt><dd>Driver default</dd></div>
        </dl>
        <p className={`mt-2 flex items-center gap-1.5 text-xs ${state.validated ? 'text-emerald-700' : 'text-graphite'}`}>
          {state.validated ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}
          {state.validated ? 'Validated against the real printer' : 'Not validated since the last change'}
        </p>
      </section>

      <section>
        <p className="label-mono mb-2">Before anything prints</p>
        <ul className="space-y-2 text-[13px]">
          {gates.map(([label, ok, by]) => (
            <li key={label} className={`flex items-start gap-2 ${ok ? '' : 'text-graphite'}`}>
              {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
              <span>{label}<span className="block text-[11px] text-graphite">{by}</span></span>
            </li>
          ))}
        </ul>
        {state.payment?.hashscanUrl && (
          <a className="mt-2 inline-block text-xs text-signal underline" href={state.payment.hashscanUrl} target="_blank" rel="noreferrer">View Hedera transaction</a>
        )}
      </section>
    </aside>
  );
}

/* ───────────── bottom: live tool execution events ───────────── */

export function summarize(e: OperatorEvent): string {
  switch (e.type) {
    case 'agent_started':
      return `${PROVIDER_LABEL[e.payload.provider] ?? e.payload.provider} · ${e.payload.model}${e.payload.trustMode ? ` · trust ${e.payload.trustMode}` : ''}`;
    case 'agent_thinking':
      return e.payload.text;
    case 'tool_started':
      return `${TOOL_LABEL[e.payload.tool] ?? e.payload.tool} ${Object.keys(e.payload.input ?? {}).length ? JSON.stringify(e.payload.input) : ''}`;
    case 'tool_succeeded':
      return `${TOOL_LABEL[e.payload.tool] ?? e.payload.tool} · result ok`;
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

const TYPE_TONE: Partial<Record<OperatorEvent['type'], string>> = {
  tool_started: 'text-paper',
  tool_succeeded: 'text-emerald-400',
  tool_failed: 'text-signal',
  configuration_updated: 'text-[#9DB8E8]',
  agent_finished: 'text-paper',
};

export function EventStream({ events, played }: { events: OperatorEvent[]; played: number }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, played]);
  return (
    <section className="flex h-full min-h-0 flex-col border-t border-black/20 bg-ink text-paper" aria-label="Live tool execution events">
      <div className="flex items-center gap-3 px-5 py-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper/70">Live tool execution</p>
        <span className="font-mono text-[11px] text-paper/40">{events.length} events · SSE /api/v1/jobs/…/events</span>
        {played < events.length && <span className="font-mono text-[11px] text-signal">{events.length - played} queued for the cursor</span>}
      </div>
      <ol ref={ref} className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 font-mono text-[12px] leading-6" aria-live="off">
        {events.length === 0 && <li className="text-paper/40">Waiting for events…</li>}
        {events.map((e, i) => (
          <li key={e.seq} className={`flex gap-3 ${i === played - 1 ? 'bg-white/5' : ''} ${i >= played ? 'opacity-40' : ''}`}>
            <span className="w-8 shrink-0 text-right text-paper/40">{e.seq}</span>
            <span className="w-16 shrink-0 text-paper/40">{e.ts.slice(11, 19)}</span>
            <span className="w-14 shrink-0 text-paper/40">{e.source}</span>
            <span className={`w-48 shrink-0 ${TYPE_TONE[e.type] ?? 'text-paper/70'}`}>{e.type}</span>
            <span className="truncate text-paper/80">{summarize(e)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
