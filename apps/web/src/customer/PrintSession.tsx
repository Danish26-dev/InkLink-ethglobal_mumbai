import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Circle, Loader2, Lock, MonitorPlay, Plus, Sparkles, TriangleAlert } from 'lucide-react';
import type { ConversationMessage, JobView, OperatorEvent, PaymentHandoff, Quote, ShopChannel, TrustMode } from '@inklink/shared-schemas';
import { api, ApiError, errorMessage } from '../lib/api';
import { foldEvents, PHASE_LABEL, TOOL_LABEL, type OperatorState } from '../lib/operatorState';
import { currentJobFor, rememberJob, savedHandoff, saveHandoff, setCurrentJob } from '../lib/recent';
import { useJobEvents } from '../lib/useJobEvents';
import { COLOR_LABEL, ORIENTATION_LABEL, PAPER_LABEL, SIDES_LABEL } from '../workspace/PrinterDialog';
import { CustomerShell } from './CustomerShell';
import { DocumentStage } from './DocumentStage';
import { PaymentHandoffCard } from './PaymentHandoffCard';

const REFRESH_ON = new Set(['agent_finished', 'job_status_updated', 'approval_required', 'document_processed', 'payment_status_updated',
  'execution_authorized', 'configuration_updated', 'printer_readiness_updated']);

/** True if any event after `afterSeq` changes backend job state the page shows. */
function needsRefresh(events: OperatorEvent[], afterSeq: number): boolean {
  return events.some((e) => e.seq > afterSeq && (REFRESH_ON.has(e.type)
    || (e.type === 'tool_succeeded' && (e.payload as { tool?: string }).tool === 'validate_print_config')));
}
const LOCKED = new Set(['awaiting_execution', 'executing', 'completed', 'cancelled', 'failed']);

/**
 * /app/chat/:shopId — a print session with one shop.
 * Opens ?job=, else this tab's current job with the shop, else starts a new one.
 */
export function PrintSession() {
  const { shopId = '' } = useParams<{ shopId: string }>();
  const [search, setSearch] = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(search.get('job') ?? currentJobFor(shopId));
  const [shop, setShop] = useState<ShopChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);

  useEffect(() => {
    api.shops().then((list) => setShop(list.find((s) => s.shopId === shopId) ?? null), () => undefined);
  }, [shopId]);

  const startSession = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    try {
      const s = (await api.shops()).find((x) => x.shopId === shopId);
      if (!s) throw new Error('This shop is not on Inklink.');
      setShop(s);
      if (!s.acceptingOrders) throw new Error(`${s.name} is not accepting orders right now.`);
      const job = await api.createJob(shopId);
      rememberJob({ jobId: job.jobId, shopId, shopName: s.name, createdAt: job.createdAt });
      setJobId(job.jobId);
      setSearch({ job: job.jobId }, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      creating.current = false;
    }
  }, [shopId, setSearch]);

  useEffect(() => {
    if (!jobId) {
      void startSession();
      return;
    }
    api.job(jobId).then(
      (j) => setCurrentJob(j.shopId, j.jobId),
      (e) => {
        // A job from an expired session is not visible any more: start fresh.
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
          setCurrentJob(shopId, null);
          setJobId(null);
        }
      },
    );
  }, [jobId, shopId, startSession]);

  const shopRef = shop ? { id: shop.shopId, name: shop.name } : null;
  if (!jobId) {
    return (
      <CustomerShell shop={shopRef}>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
          {error ? (
            <>
              <p className="text-sm text-signal" role="alert">{error}</p>
              <Link to="/app" className="btn-ghost">Choose another shop</Link>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Starting your print session…</p>
          )}
        </div>
      </CustomerShell>
    );
  }
  return (
    <CustomerShell shop={shopRef}>
      <Session key={jobId} jobId={jobId} shop={shop} onNew={() => { setCurrentJob(shopId, null); setJobId(null); }} />
    </CustomerShell>
  );
}

type Busy = null | 'send' | 'upload' | 'quote' | 'approve' | 'review';

/** Hooks for embedding the real session in the jury demo without changing its behaviour. */
export interface SessionEmbed {
  /** Quote approval; returns the native-app handoff, or null when payments are not configured. */
  approve: (jobId: string) => Promise<PaymentHandoff | null>;
  agentHref: string;
  hideNewJob?: boolean;
  /** Rendered under the quote once it is approved (e.g. "continue to the shop perspective"). */
  afterApproval?: React.ReactNode;
}

export function Session({ jobId, shop, onNew, embed }: { jobId: string; shop: ShopChannel | null; onNew: () => void; embed?: SessionEmbed }) {
  const { events, state: stream } = useJobEvents(jobId, 'web');
  const live = useMemo(() => foldEvents(events), [events]);
  const [job, setJob] = useState<JobView | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<PaymentHandoff | null>(() => savedHandoff(jobId));

  const refresh = useCallback(async () => {
    try {
      const [j, m] = await Promise.all([api.job(jobId), api.messages(jobId)]);
      setJob(j);
      setMessages(m);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [jobId]);

  // The job view always comes from the backend. Refetch (debounced) when ANY new event
  // changes it — events arrive in bursts after a reconnect — and whenever the stream
  // comes back, because changes may have happened while it was down.
  const handledSeq = useRef<number | null>(null);
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  useEffect(() => {
    const prev = handledSeq.current;
    handledSeq.current = lastSeq;
    if (prev !== null && !needsRefresh(events, prev)) return; // first run always loads
    const t = setTimeout(() => void refresh(), 150);
    return () => clearTimeout(t);
  }, [refresh, lastSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stream === 'live') void refresh();
  }, [stream, refresh]);

  const act = async (kind: Busy, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!job) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-graphite"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading your session…</div>;
  }

  const running = Boolean(job.runActive || live.run?.active);
  const locked = LOCKED.has(job.status);
  const clearHandoff = () => { setHandoff(null); saveHandoff(null, jobId); };

  return (
    <main className="mx-auto max-w-[1280px] px-5 pb-16 pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="label-mono">Print session · {shop?.name ?? 'Print shop'}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{job.document?.filename ?? 'New print job'}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link to={embed?.agentHref ?? `/app/jobs/${jobId}/agent`} className="btn-ghost px-3 py-1.5 text-xs"><MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />Watch the operator</Link>
          {!embed?.hideNewJob && <button type="button" onClick={onNew} className="btn-ghost px-3 py-1.5 text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />New job</button>}
        </div>
      </div>

      <Progress job={job} live={live} running={running} messages={messages} />

      {error && <p className="mt-4 rounded-lg bg-signal/10 px-4 py-2 text-sm" role="alert">{error}</p>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <DocumentStage job={job} busy={busy === 'upload'} locked={locked} processing={running}
          onUpload={(f) => act('upload', async () => { await api.upload(jobId, f); clearHandoff(); })} />

        <div className="flex flex-col gap-4">
          {!locked && (
            <Requirements job={job} disabled={!job.document || running || busy !== null} sending={busy === 'send'}
              onSend={(text) => act('send', async () => { await api.sendMessage(jobId, text); clearHandoff(); })}
              onPrivacy={(m) => act(null, async () => setJob(await api.setPrivacy(jobId, m)))} />
          )}
          <Intelligence job={job} live={live} running={running} messages={messages} jobId={jobId} agentHref={embed?.agentHref} />
          {job.document?.editStatus === 'pending_review' && (
            <Card title="Review the edited copy" accent>
              <p className="text-sm text-graphite">The operator created an edited copy. Compare it with your original in the preview, then decide. Your original is never changed.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act('review', () => api.approveEdits(jobId))}>Use the edited copy</button>
                <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act('review', () => api.rejectEdits(jobId))}>Keep my original</button>
              </div>
            </Card>
          )}
          <Settings job={job} />
          <Pricing job={job} running={running} locked={locked} busy={busy} handoff={handoff} approvableWithoutPayment={Boolean(embed)}
            onQuote={() => act('quote', () => api.quote(jobId))}
            onApprove={() => act('approve', async () => {
              const h = embed ? await embed.approve(jobId) : await api.approveQuote(jobId);
              setHandoff(h);
              saveHandoff(h, jobId);
            })} />
          {embed?.afterApproval && job.customerApprovedQuote && embed.afterApproval}
          <Tracking job={job} />
          <AuditCard job={job} />
        </div>
      </div>
    </main>
  );
}

/* ───────────── progress ───────────── */

function steps(job: JobView, live: OperatorState, running: boolean, messages: ConversationMessage[]) {
  const asked = messages.some((m) => m.role === 'customer');
  const intelligenceDone = job.configValidated;
  const reviewDone = job.document?.editStatus !== 'pending_review';
  const paid = job.paymentStatus === 'settled' || ['awaiting_execution', 'executing', 'completed'].includes(job.status);
  const printing = ['executing', 'completed'].includes(job.status);
  return [
    { label: 'Upload', done: Boolean(job.document) },
    { label: 'Requirements', done: asked },
    { label: 'Intelligence', done: intelligenceDone, active: running },
    { label: 'Review', done: intelligenceDone && reviewDone },
    { label: 'Quote', done: job.customerApprovedQuote },
    { label: 'Pay in app', done: paid },
    { label: 'Printing', done: job.status === 'completed', active: printing && job.status !== 'completed' },
  ];
}

function Progress({ job, live, running, messages }: { job: JobView; live: OperatorState; running: boolean; messages: ConversationMessage[] }) {
  const list = steps(job, live, running, messages);
  const current = list.findIndex((s) => !s.done);
  return (
    <nav aria-label="Print job progress" className="mt-5 overflow-x-auto">
      <ol className="flex min-w-[640px] items-center">
        {list.map((s, i) => {
          const isCurrent = i === current;
          return (
            <li key={s.label} className="flex flex-1 items-center gap-2" aria-current={isCurrent ? 'step' : undefined}>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
                s.done ? 'bg-ink text-paper' : isCurrent ? 'bg-signal text-white' : 'bg-light-grey text-graphite'
              }`}>
                {s.done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : s.active ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : i + 1}
              </span>
              <span className={`whitespace-nowrap text-[13px] ${s.done || isCurrent ? 'text-ink' : 'text-graphite'}`}>{s.label}</span>
              {i < list.length - 1 && <span className={`mx-2 h-px flex-1 ${s.done ? 'bg-ink' : 'bg-light-grey'}`} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ───────────── right column ───────────── */

function Card({ title, accent, children, aside }: { title: string; accent?: boolean; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className={`rounded-2xl border bg-white p-5 ${accent ? 'border-signal/50' : 'border-light-grey'}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

const CHIPS = ['2 copies', 'Black & white', 'Colour', 'Double-sided', 'A4', 'Landscape'];
const PRIVACY: { value: TrustMode | null; label: string; hint: string }[] = [
  { value: null, label: 'Auto', hint: 'Chosen from your document: sensitive or unreadable files always run Private.' },
  { value: 'verified', label: 'Verified', hint: 'At least verifiable execution. The model provider may still see the text.' },
  { value: 'private', label: 'Private', hint: 'Sealed inference inside a TEE: nobody, not even the provider, sees your document.' },
];

function Requirements({ job, disabled, sending, onSend, onPrivacy }: {
  job: JobView; disabled: boolean; sending: boolean; onSend: (t: string) => void; onPrivacy: (m: TrustMode | null) => void;
}) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t && !disabled) {
      onSend(t);
      setText('');
    }
  };
  const requested = job.privacy.requestedTrustMode === 'standard' ? null : job.privacy.requestedTrustMode;
  return (
    <Card title="How should it be printed?">
      <form onSubmit={submit}>
        <label htmlFor="requirements" className="sr-only">Printing requirements</label>
        <textarea id="requirements" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000}
          disabled={!job.document} placeholder={job.document ? 'e.g. 2 copies, black and white, A4, double-sided' : 'Upload a document first'}
          className="w-full resize-none rounded-xl border border-light-grey bg-paper px-3 py-2.5 text-sm focus:border-ink focus:outline-none disabled:opacity-60"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e as unknown as FormEvent); }} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button key={c} type="button" disabled={!job.document} onClick={() => setText((t) => (t.trim() ? `${t.trim()}, ${c.toLowerCase()}` : c))}
              className="rounded-full border border-light-grey px-2.5 py-1 text-xs text-ink/80 hover:border-ink disabled:opacity-50">
              + {c}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-graphite"><Lock className="h-3.5 w-3.5" aria-hidden="true" />Privacy</span>
          <div role="radiogroup" aria-label="Inference privacy" className="flex rounded-full bg-paper p-0.5">
            {PRIVACY.map((o) => (
              <button key={o.label} type="button" role="radio" aria-checked={requested === o.value} title={o.hint} disabled={disabled && !job.document}
                onClick={() => onPrivacy(o.value)}
                className={`rounded-full px-2.5 py-1 text-xs ${requested === o.value ? 'bg-ink text-paper' : 'text-ink/70 hover:bg-light-grey'}`}>
                {o.label}
              </button>
            ))}
          </div>
          <button type="submit" className="btn-signal ml-auto px-4 py-2" disabled={disabled || !text.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}Start
          </button>
        </div>
      </form>
    </Card>
  );
}

function Intelligence({ job, live, running, messages, jobId, agentHref }: {
  job: JobView; live: OperatorState; running: boolean; messages: ConversationMessage[]; jobId: string; agentHref?: string;
}) {
  const sel = job.privacy.selection;
  const last = [...messages].reverse().find((m) => m.role === 'agent' || m.role === 'system');
  const tools = live.tools.slice(-6);
  if (!running && !live.run && !sel && !last) return null;
  const refused = live.run?.outcome === 'unavailable';
  return (
    <Card title="Document intelligence"
      aside={<Link to={agentHref ?? `/app/jobs/${jobId}/agent`} className="flex items-center gap-1 text-xs text-signal hover:underline">Watch live <ArrowRight className="h-3 w-3" aria-hidden="true" /></Link>}>
      <p className="flex items-center gap-2 text-sm font-medium">
        {running ? <Loader2 className="h-4 w-4 animate-spin text-signal" aria-hidden="true" /> : refused ? <TriangleAlert className="h-4 w-4 text-signal" aria-hidden="true" /> : <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />}
        {running ? PHASE_LABEL[live.phase] : refused ? 'The operator did not start' : PHASE_LABEL[live.phase]}
      </p>
      {sel && (
        <p className="mt-1 text-xs text-graphite">
          {sel.provider === 'deterministic-fallback'
            ? 'SIMULATED planning: deterministic demo operator (no AI inference)'
            : sel.provider === 'vertex-ai'
            ? 'Vertex AI (non-sensitive documents only)'
            : `${sel.effectiveTrustMode === 'private' ? 'Private' : sel.effectiveTrustMode === 'verified' ? 'Verified' : 'Standard'} inference on 0G`} · {sel.reason}
        </p>
      )}
      {tools.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {tools.map((t) => (
            <li key={t.toolUseId} className={`flex items-center gap-2 text-[13px] ${t.status === 'failed' ? 'text-signal' : t.status === 'succeeded' ? 'text-ink' : 'text-graphite'}`}>
              {t.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : t.status === 'succeeded' ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
              {TOOL_LABEL[t.tool] ?? t.tool}
            </li>
          ))}
        </ul>
      )}
      {last && !running && <p className={`mt-3 rounded-lg p-3 text-[13px] leading-relaxed ${refused ? 'bg-signal/10' : 'bg-paper'}`}>{last.text}</p>}
    </Card>
  );
}

function Settings({ job }: { job: JobView }) {
  const c = job.operatorConfig;
  if (!c.paperSize && !c.colorMode && !c.copies) return null;
  const rows: [string, string | null][] = [
    ['Printer', c.printerId ?? 'Not connected'],
    ['Copies', c.copies ? String(c.copies) : null],
    ['Colour', c.colorMode ? COLOR_LABEL[c.colorMode] : null],
    ['Paper', c.paperSize ? PAPER_LABEL[c.paperSize] : null],
    ['Orientation', c.orientation ? ORIENTATION_LABEL[c.orientation] : null],
    ['Two-sided', c.sides ? SIDES_LABEL[c.sides] : null],
  ];
  return (
    <Card title="Print settings"
      aside={<span className={`flex items-center gap-1 text-xs ${job.configValidated ? 'text-emerald-700' : 'text-graphite'}`}>
        {job.configValidated ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}
        {job.configValidated ? 'Checked with the printer' : 'Not checked yet'}
      </span>}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="text-[11px] text-graphite">{k}</dt><dd>{v ?? '—'}</dd></div>
        ))}
      </dl>
    </Card>
  );
}

function Pricing({ job, running, locked, busy, handoff, onQuote, onApprove, approvableWithoutPayment }: {
  job: JobView; running: boolean; locked: boolean; busy: Busy; handoff: PaymentHandoff | null; onQuote: () => void; onApprove: () => void;
  approvableWithoutPayment?: boolean;
}) {
  const reviewPending = job.document?.editStatus === 'pending_review';
  const quoteExpired = job.quote ? new Date(job.quote.expiresAt).getTime() <= Date.now() : false;
  // An expired price can be renewed (the backend allows it unless a payment is in flight).
  const canRequote = quoteExpired && !running && !locked && job.configValidated && job.status === 'awaiting_payment'
    && job.paymentStatus !== 'processing';
  if (!job.quote) {
    if (!job.configValidated || running || locked) return null;
    return (
      <Card title="Price">
        <p className="text-sm text-graphite">Your document and settings are ready. Get the price based on the real page count.</p>
        <button type="button" className="btn-primary mt-3 w-full" onClick={onQuote} disabled={busy !== null || reviewPending}>
          {busy === 'quote' && <Loader2 className="h-4 w-4 animate-spin" />}{reviewPending ? 'Review the edited copy first' : 'Get price'}
        </button>
      </Card>
    );
  }
  return (
    <>
      <QuoteCard quote={job.quote} job={job} busy={busy === 'approve'} onApprove={onApprove} hasHandoff={Boolean(handoff)} demo={approvableWithoutPayment}
        reviewPending={reviewPending} />
      {canRequote && (
        <button type="button" className="btn-primary w-full" onClick={onQuote} disabled={busy !== null}>
          {busy === 'quote' && <Loader2 className="h-4 w-4 animate-spin" />}Get a new price
        </button>
      )}
      {handoff && job.status === 'awaiting_payment' && !job.payment && <PaymentHandoffCard handoff={handoff} />}
      {(job.payment || job.customerApprovedQuote) && !job.demo && <PaymentStatusCard job={job} />}
    </>
  );
}

const CHAIN_KIND: Record<string, string> = {
  shop_registered: 'Shop registered', job_registered: 'Job registered', document_committed: 'Document hash',
  quote_referenced: 'Quote reference', payment_verified: 'Hedera payment reference', execution_authorized: 'Print authorized',
  job_completed: 'Job completed', job_failed: 'Job failed',
};
const CHAIN_STATUS: Record<string, string> = {
  pending_not_configured: 'queued · registry not configured', pending: 'queued', submitted: 'submitted, awaiting receipt',
  confirmed: 'confirmed', reverted: 'reverted', failed: 'not sent (failed)',
};

/** 0G Galileo audit trail exactly as recorded: hashes only, tx links only from real receipts. */
function AuditCard({ job }: { job: JobView }) {
  const c = job.chain;
  if (!c || c.records.length === 0) return null;
  const short = (h: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');
  return (
    <Card title="On-chain audit · 0G Galileo">
      <p className="text-xs text-graphite">
        Only hashes are recorded, never your document or details. Contract {c.contract ? <span className="font-mono">{short(c.contract)}</span> : 'not configured'}
        {c.chainId ? ` · chain ${c.chainId}` : ''}.
      </p>
      <ul className="mt-3 space-y-2 text-xs">
        {c.records.map((r, i) => (
          <li key={`${r.kind}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{CHAIN_KIND[r.kind] ?? r.kind}</span>
            <span className={r.status === 'confirmed' ? 'text-emerald-700' : r.status === 'reverted' || r.status === 'failed' ? 'text-signal' : 'text-graphite'}>
              {CHAIN_STATUS[r.status] ?? r.status}
            </span>
            {r.txHash && r.explorerUrl && (
              <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-signal underline">{short(r.txHash)}</a>
            )}
            {r.blockNumber !== null && <span className="text-graphite">block {r.blockNumber}</span>}
            {r.dataHash && <span className="basis-full font-mono text-[10px] text-graphite">hash {r.dataHash}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const PAYMENT_STATE: Record<string, { label: string; tone: 'wait' | 'ok' | 'bad' }> = {
  none: { label: 'Waiting for payment in the Inklink app', tone: 'wait' },
  pending: { label: 'Verifying payment on Hedera', tone: 'wait' },
  verified: { label: 'Payment verified', tone: 'ok' },
  unverified: { label: 'Settlement reported, not verified', tone: 'bad' },
  failed: { label: 'Payment failed', tone: 'bad' },
  expired: { label: 'Payment expired', tone: 'bad' },
};

/** Payment exactly as the backend recorded it; nothing here is inferred in the browser. */
function PaymentStatusCard({ job }: { job: JobView }) {
  const p = job.payment;
  const state = PAYMENT_STATE[p?.verificationStatus ?? 'none'];
  const color = state.tone === 'ok' ? 'text-emerald-700' : state.tone === 'bad' ? 'text-signal' : 'text-graphite';
  const amount = p?.amount ?? job.quote?.settlement?.amount ?? null;
  return (
    <Card title="Payment" accent={state.tone === 'bad'}>
      <p className={`flex items-center gap-1.5 text-sm font-medium ${color}`} role="status">
        {state.tone === 'ok' ? <Check className="h-4 w-4" aria-hidden="true" /> : state.tone === 'bad'
          ? <TriangleAlert className="h-4 w-4" aria-hidden="true" /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {state.label}
      </p>
      <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-1 text-xs">
        <dt className="text-graphite">Amount</dt><dd>{amount ? `${amount} USDC` : '—'}{job.quote ? ` · ₹${job.quote.amount}` : ''}</dd>
        <dt className="text-graphite">Method</dt><dd>Hedera x402 (HTS-USDC)</dd>
        <dt className="text-graphite">Network</dt><dd>Hedera Testnet</dd>
        <dt className="text-graphite">Status</dt><dd className="font-mono">{p?.status ?? job.paymentStatus}</dd>
        <dt className="text-graphite">Transaction</dt>
        <dd className="break-all font-mono">{p?.transactionId && p.hashscanUrl
          ? <a href={p.hashscanUrl} target="_blank" rel="noreferrer" className="text-signal underline">{p.transactionId}</a>
          : 'Not settled yet'}</dd>
        {p?.verifiedAt && (<><dt className="text-graphite">Verified</dt><dd>{new Date(p.verifiedAt).toLocaleString()}</dd></>)}
      </dl>
      {(p?.verificationStatus === 'failed' || p?.verificationStatus === 'expired') && (
        <p className="mt-3 text-xs text-graphite">No money was taken by Inklink for this attempt. Approve the price again to retry, or get a new price if it expired.</p>
      )}
    </Card>
  );
}

function QuoteCard({ quote, job, busy, onApprove, hasHandoff, demo, reviewPending }: {
  quote: Quote; job: JobView; busy: boolean; onApprove: () => void; hasHandoff: boolean; demo?: boolean; reviewPending?: boolean;
}) {
  // In the jury demo the quote can be approved without a payment method; payment then follows the labelled simulated path.
  const payable = quote.paymentMethods.includes('hedera_x402') || Boolean(demo);
  const expired = new Date(quote.expiresAt).getTime() <= Date.now();
  const retry = job.paymentStatus === 'failed' || job.paymentStatus === 'expired';
  return (
    <section className="rounded-2xl bg-ink p-5 text-paper">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-paper/60">Quotation</p>
      <p className="mt-2 text-4xl font-semibold tracking-tightest">₹{quote.amount}</p>
      {quote.settlement && <p className="mt-1 font-mono text-[11px] text-paper/60">≈ {quote.settlement.amount} USDC on Hedera · rate {quote.settlement.rate}</p>}
      <p className="mt-2 text-xs text-paper/70">{job.document?.pageCount ?? '?'} pages × {job.operatorConfig.copies ?? 1} · valid until {new Date(quote.expiresAt).toLocaleTimeString()}</p>
      {!payable ? (
        <p className="mt-4 rounded-lg bg-white/10 p-3 text-xs">This shop has not set up payments yet, so the job cannot be paid right now.</p>
      ) : expired ? (
        <p className="mt-4 text-xs text-signal">This price expired. Get a new price to continue.</p>
      ) : reviewPending ? (
        <p className="mt-4 text-xs text-paper/80">Review the edited copy before approving the price.</p>
      ) : retry && job.status === 'awaiting_payment' ? (
        <button type="button" className="btn-signal mt-4 w-full" onClick={onApprove} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Retry payment in the Inklink app
        </button>
      ) : job.payment ? (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-emerald-300"><Check className="h-3.5 w-3.5" aria-hidden="true" />Approved · payment started in the Inklink app</p>
      ) : job.customerApprovedQuote && hasHandoff ? (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-emerald-300"><Check className="h-3.5 w-3.5" aria-hidden="true" />Approved · continue in the Inklink app</p>
      ) : job.customerApprovedQuote ? (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-emerald-300"><Check className="h-3.5 w-3.5" aria-hidden="true" />Quote approved by the customer</p>
      ) : job.status === 'awaiting_payment' ? (
        <button type="button" className="btn-signal mt-4 w-full" onClick={onApprove} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Approve and pay in the Inklink app
        </button>
      ) : null}
    </section>
  );
}

const TIMELINE: { status: JobView['status'][]; label: string; detail: string }[] = [
  { status: ['awaiting_execution'], label: 'Payment verified', detail: 'Settlement confirmed on Hedera' },
  { status: ['executing'], label: 'Printing', detail: 'Sent to the printer by the shop' },
  { status: ['completed'], label: 'Ready for collection', detail: 'Pick up your pages at the shop' },
];

function Tracking({ job }: { job: JobView }) {
  if (!['awaiting_execution', 'executing', 'completed', 'failed', 'cancelled'].includes(job.status)) return null;
  if (job.status === 'failed' || job.status === 'cancelled') {
    return <Card title="Job status" accent><p className="text-sm">This job {job.status === 'failed' ? 'failed' : 'was cancelled'}.</p></Card>;
  }
  const idx = TIMELINE.findIndex((t) => t.status.includes(job.status));
  return (
    <Card title="Tracking">
      <ol className="space-y-3">
        {TIMELINE.map((t, i) => (
          <li key={t.label} className="flex gap-3">
            <span className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full ${i <= idx ? 'bg-ink text-paper' : 'bg-light-grey'}`}>
              {i <= idx && <Check className="h-3 w-3" aria-hidden="true" />}
            </span>
            <span><span className={`block text-sm ${i <= idx ? 'font-medium' : 'text-graphite'}`}>{t.label}</span><span className="block text-xs text-graphite">{t.detail}</span></span>
          </li>
        ))}
      </ol>
      <p className="mt-3 font-mono text-[11px] text-graphite">payment {job.paymentStatus} · printer {job.deviceStatus}</p>
    </Card>
  );
}
