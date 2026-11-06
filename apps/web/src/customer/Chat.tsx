import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, FileText, Loader2, MonitorPlay, Paperclip, Send, TriangleAlert } from 'lucide-react';
import type { ConversationMessage, JobView, PaymentHandoff, Quote } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { foldEvents, PHASE_LABEL, TOOL_LABEL } from '../lib/operatorState';
import { recentJobs, savedHandoff, saveHandoff } from '../lib/recent';
import { useJobEvents } from '../lib/useJobEvents';
import { PaymentHandoffCard } from './PaymentHandoffCard';
import { COLOR_LABEL, ORIENTATION_LABEL, PAPER_LABEL, SIDES_LABEL } from '../workspace/PrinterDialog';

const REFRESH_ON = new Set(['agent_finished', 'job_status_updated', 'approval_required', 'document_processed', 'payment_status_updated', 'execution_authorized']);
const LOCKED = new Set(['awaiting_execution', 'executing', 'completed', 'cancelled', 'failed']);

/** WhatsApp-style conversation with the shop's print operator. */
export function Chat() {
  const { jobId = '' } = useParams<{ jobId: string }>();
  const shopName = recentJobs().find((j) => j.jobId === jobId)?.shopName ?? 'Print shop';
  const { events, state: stream } = useJobEvents(jobId, 'web');
  const live = useMemo(() => foldEvents(events), [events]);

  const [job, setJob] = useState<JobView | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'send' | 'upload' | 'quote' | 'approve'>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<PaymentHandoff | null>(() => savedHandoff(jobId));
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [j, m] = await Promise.all([api.job(jobId), api.messages(jobId)]);
      setJob(j);
      setMessages(m);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [jobId]);

  const lastRaw = events[events.length - 1];
  useEffect(() => {
    if (!lastRaw || REFRESH_ON.has(lastRaw.type)) void refresh();
  }, [refresh, lastRaw?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, live.run?.active, job?.quote?.quoteId, handoff]);

  const running = Boolean(job?.runActive || live.run?.active);
  const locked = job ? LOCKED.has(job.status) : false;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || running || locked) return;
    setBusy('send');
    setError(null);
    try {
      const msg = await api.sendMessage(jobId, t);
      setMessages((m) => [...m, msg]);
      setText('');
      setHandoff(null);
      saveHandoff(null, jobId);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('upload');
    setError(null);
    try {
      await api.upload(jobId, file);
      setHandoff(null);
      saveHandoff(null, jobId);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const requestQuote = async () => {
    setBusy('quote');
    setError(null);
    try {
      await api.quote(jobId);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const h = await api.approveQuote(jobId);
      setHandoff(h);
      saveHandoff(h, jobId);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openDocument = async (version: 'original' | 'current') => {
    try {
      window.open(await api.documentUrl(jobId, version), '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const currentTool = [...live.tools].reverse().find((t) => t.status === 'running');

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col bg-[#F1F0EB]">
      <header className="flex items-center gap-3 bg-ink px-4 py-3 text-paper">
        <Link to="/" className="rounded-md p-1.5 hover:bg-white/10" aria-label="Back to shops"><ArrowLeft className="h-5 w-5" /></Link>
        <img src="/icon.svg" alt="" className="h-9 w-9 rounded-full bg-paper p-1" />
        <div className="min-w-0">
          <p className="truncate font-medium leading-tight">{shopName}</p>
          <p className="text-xs text-paper/60">
            {running ? (currentTool ? `${TOOL_LABEL[currentTool.tool] ?? currentTool.tool}…` : 'Print operator is working…') : stream === 'live' ? 'Print operator' : 'Connecting…'}
          </p>
        </div>
        <Link to={`/chat/${jobId}/workspace`} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10">
          <MonitorPlay className="h-4 w-4" aria-hidden="true" />Watch operator
        </Link>
      </header>

      {job && <StatusTracker job={job} />}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4" aria-live="polite">
        {messages.map((m) => <Bubble key={m.messageId} m={m} />)}

        {job?.document && (
          <div className="flex justify-end">
            <div className="w-[85%] max-w-sm rounded-xl rounded-tr-sm bg-white p-3 shadow-sm">
              <div className="flex items-center gap-3">
                <FileText className="h-8 w-8 text-signal" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.document.filename}</p>
                  <p className="font-mono text-[11px] text-graphite">
                    {job.document.format.toUpperCase()} · {job.document.pageCount ?? '?'} pages{job.document.edited ? ' · edited' : ''}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                <button type="button" className="text-signal underline" onClick={() => openDocument('original')}>Original</button>
                {job.document.edited && <button type="button" className="text-signal underline" onClick={() => openDocument('current')}>Edited version</button>}
              </div>
              {job.document.reviewRecommended && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-signal"><TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />Please review the edited version.</p>
              )}
            </div>
          </div>
        )}

        {running && (
          <div className="flex">
            <Link to={`/chat/${jobId}/workspace`} className="flex items-center gap-2 rounded-xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm hover:ring-1 hover:ring-ink/20">
              <Loader2 className="h-4 w-4 animate-spin text-signal" aria-hidden="true" />
              <span>{PHASE_LABEL[live.phase]}</span>
              <span className="text-xs text-graphite underline">watch</span>
            </Link>
          </div>
        )}

        {job && !running && <ConfigSummary job={job} />}

        {job && !running && job.configValidated && !job.quote && !locked && (
          <div className="flex">
            <button type="button" className="btn-primary" onClick={requestQuote} disabled={busy !== null}>
              {busy === 'quote' && <Loader2 className="h-4 w-4 animate-spin" />}Get price
            </button>
          </div>
        )}

        {job?.quote && <QuoteCard quote={job.quote} job={job} busy={busy === 'approve'} onApprove={approve} hasHandoff={Boolean(handoff)} />}
        {handoff && job?.status === 'awaiting_payment' && <div className="max-w-sm"><PaymentHandoffCard handoff={handoff} /></div>}

        <div ref={endRef} />
      </div>

      {error && <p className="bg-signal/10 px-4 py-2 text-sm" role="alert">{error}</p>}

      <form onSubmit={send} className="flex items-end gap-2 bg-[#F1F0EB] px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
        <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden" onChange={(e) => upload(e.target.files?.[0])} aria-label="Attach a PDF or DOCX" />
        <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-ink shadow-sm disabled:opacity-40"
          onClick={() => fileRef.current?.click()} disabled={busy !== null || running || locked} aria-label="Attach document">
          {busy === 'upload' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
        </button>
        <label className="sr-only" htmlFor="composer">Message</label>
        <textarea id="composer" rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e as unknown as FormEvent); } }}
          placeholder={locked ? 'This order can no longer be changed' : job?.document ? 'e.g. 2 copies, black & white, double-sided' : 'Attach a document first, then tell us what you need'}
          disabled={locked} maxLength={2000}
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-3xl border-0 bg-white px-4 py-3 text-sm shadow-sm focus:ring-2 focus:ring-ink/20" />
        <button type="submit" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-signal text-white shadow-sm disabled:opacity-40"
          disabled={!text.trim() || busy !== null || running || locked} aria-label="Send">
          {busy === 'send' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </button>
      </form>
    </div>
  );
}

function Bubble({ m }: { m: ConversationMessage }) {
  if (m.role === 'system') {
    return <p className="mx-auto w-fit max-w-[85%] rounded-lg bg-[#E4E2D9] px-3 py-1.5 text-center text-xs text-ink/80">{m.text}</p>;
  }
  const mine = m.role === 'customer';
  return (
    <div className={`flex ${mine ? 'justify-end' : ''}`}>
      <div className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm shadow-sm ${mine ? 'rounded-tr-sm bg-[#FFE3D8]' : 'rounded-tl-sm bg-white'}`}>
        {m.text}
        <span className="ml-2 align-bottom font-mono text-[10px] text-graphite">{m.createdAt.slice(11, 16)}</span>
      </div>
    </div>
  );
}

function ConfigSummary({ job }: { job: JobView }) {
  const c = job.operatorConfig;
  if (!c.paperSize && !c.colorMode && !c.copies) return null;
  const parts = [
    c.copies ? `${c.copies} ${c.copies === 1 ? 'copy' : 'copies'}` : null,
    c.colorMode ? COLOR_LABEL[c.colorMode] : null,
    c.paperSize ? PAPER_LABEL[c.paperSize]?.split(' · ')[0] : null,
    c.orientation ? ORIENTATION_LABEL[c.orientation] : null,
    c.sides ? SIDES_LABEL[c.sides]?.split(' · ')[0] : null,
  ].filter(Boolean);
  return (
    <div className="flex">
      <div className="max-w-[85%] rounded-xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm">
        <p className="label-mono mb-1">Print settings</p>
        <p>{parts.join(' · ')}</p>
        <p className={`mt-1 flex items-center gap-1 text-xs ${job.configValidated ? 'text-emerald-700' : 'text-graphite'}`}>
          {job.configValidated ? <><Check className="h-3.5 w-3.5" aria-hidden="true" />Checked with the shop printer</> : 'Not yet checked with the printer'}
        </p>
      </div>
    </div>
  );
}

function QuoteCard({ quote, job, busy, onApprove, hasHandoff }: {
  quote: Quote; job: JobView; busy: boolean; onApprove: () => void; hasHandoff: boolean;
}) {
  const payable = quote.paymentMethods.includes('hedera_x402');
  const expired = new Date(quote.expiresAt).getTime() <= Date.now();
  return (
    <div className="flex">
      <div className="w-[85%] max-w-sm rounded-xl rounded-tl-sm bg-white p-4 shadow-sm">
        <p className="label-mono">Price</p>
        <p className="mt-1 text-3xl font-semibold tracking-tightest">₹{quote.amount}</p>
        {quote.settlement && (
          <p className="font-mono text-[11px] text-graphite">≈ {quote.settlement.amount} USDC on Hedera · rate {quote.settlement.rate}</p>
        )}
        <p className="mt-1 text-xs text-graphite">{job.document?.pageCount ?? '?'} pages × {job.operatorConfig.copies ?? 1} · valid until {new Date(quote.expiresAt).toLocaleTimeString()}</p>
        {!payable ? (
          <p className="mt-3 rounded-md bg-light-grey/70 p-2 text-xs">This shop has not set up payments yet, so the order cannot be paid right now.</p>
        ) : expired ? (
          <p className="mt-3 text-xs text-signal">This price expired. Send a message or ask again for a new price.</p>
        ) : job.customerApprovedQuote && hasHandoff ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" aria-hidden="true" />Approved · continue in the Inklink app</p>
        ) : job.status === 'awaiting_payment' ? (
          <button type="button" className="btn-signal mt-3 w-full" onClick={onApprove} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Approve & pay in Inklink app
          </button>
        ) : null}
      </div>
    </div>
  );
}

const TRACK: { status: JobView['status'][]; label: string }[] = [
  { status: ['created'], label: 'Setup' },
  { status: ['awaiting_payment'], label: 'Payment' },
  { status: ['awaiting_execution'], label: 'Shop' },
  { status: ['executing'], label: 'Printing' },
  { status: ['completed'], label: 'Ready' },
];

function StatusTracker({ job }: { job: JobView }) {
  const idx = TRACK.findIndex((t) => t.status.includes(job.status));
  if (job.status === 'failed' || job.status === 'cancelled') {
    return <p className="bg-signal/10 px-4 py-2 text-sm">This order {job.status === 'failed' ? 'failed' : 'was cancelled'}.</p>;
  }
  return (
    <nav aria-label="Order progress" className="border-b border-black/5 bg-white/70 px-4 py-2">
      <ol className="flex items-center gap-1.5">
        {TRACK.map((t, i) => (
          <li key={t.label} className="flex flex-1 items-center gap-1.5" aria-current={i === idx ? 'step' : undefined}>
            <span className={`h-1.5 flex-1 rounded-full ${i <= idx ? 'bg-signal' : 'bg-light-grey'}`} />
            <span className={`font-mono text-[10px] uppercase tracking-wider ${i === idx ? 'text-ink' : 'text-graphite'}`}>{t.label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 font-mono text-[10px] text-graphite">payment {job.paymentStatus} · printer {job.deviceStatus}</p>
    </nav>
  );
}
