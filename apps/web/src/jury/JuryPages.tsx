/**
 * ETHGlobal jury demo stages. Each stage uses the real application:
 * the customer print session, the shop orders table and the Agent Workspace,
 * on ONE demo job in the isolated demo shop. Every step is labelled LIVE,
 * SIMULATED, NOT CONFIGURED or UNAVAILABLE from what the backend reports.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Circle, Cpu, FileText, Loader2, Lock, Network, Printer, RotateCcw, TriangleAlert, Wallet } from 'lucide-react';
import type { JobView, PaymentHandoff, ShopChannel, ShopHardware } from '@inklink/shared-schemas';
import { api, errorMessage, type JuryLifecycle, type JuryPayment } from '../lib/api';
import { TOOL_LABEL } from '../lib/operatorState';
import { Session } from '../customer/PrintSession';
import { PaymentHandoffCard } from '../customer/PaymentHandoffCard';
import { OrdersTable, DevicesCard } from '../shop/ShopPages';
import { Workspace } from '../workspace/Workspace';
import { summarize, verificationLabel } from '../workspace/Panels';
import { ModeBadge, useJury } from './JuryLayout';

function Page({ stage, title, intro, children, next }: { stage: number; title: string; intro: ReactNode; children: ReactNode; next?: { to: string; label: string } }) {
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      <p className="label-mono">Stage {stage}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tightest">{title}</h1>
      <div className="mt-2 max-w-3xl text-sm leading-relaxed text-graphite">{intro}</div>
      <div className="mt-6">{children}</div>
      {next && (
        <div className="mt-8 flex justify-end">
          <Link to={next.to} className="btn-signal px-5 py-2.5">{next.label} <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </div>
      )}
    </div>
  );
}

function NeedJob() {
  return (
    <div className="card flex flex-col items-center gap-3 p-10 text-center">
      <FileText className="h-8 w-8 text-graphite" aria-hidden="true" />
      <p className="text-sm text-graphite">There is no demo job yet. Start in the customer stage and upload a PDF.</p>
      <Link to="/jury/customer" className="btn-primary">Go to the customer stage</Link>
    </div>
  );
}

/* ───────────── 1. Introduction ───────────── */

export function JuryIntro() {
  const { integrations } = useJury();
  return (
    <Page stage={1} title="Inklink, end to end" intro={
      <>Printing today means emailing files to strangers, standing at a counter and paying by hand. Inklink lets a customer send a
        document to a nearby shop from a browser. An autonomous print operator configures the real printer. AI runs on 0G Private
        Computer at the privacy level the document needs, and payment settles in USDC on Hedera through the native app. Nothing
        prints until the customer, the payment and the shop all agree.</>
    }>
      <div className="grid gap-4 md:grid-cols-5">
        {[
          [FileText, 'Customer', 'Browser, no login'],
          [Lock, '0G Private Computer', 'Trust mode by sensitivity'],
          [Cpu, 'Strands agent', 'Allowlisted printer tools'],
          [Wallet, 'Hedera x402', 'USDC via the native app'],
          [Printer, 'Print shop', 'Gateway, printer, ESP32-S3'],
        ].map(([Icon, title, text], i) => {
          const I = Icon as typeof FileText;
          return (
            <div key={title as string} className="relative rounded-2xl border border-light-grey bg-white p-4">
              <I className="h-5 w-5 text-signal" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">{title as string}</p>
              <p className="text-xs text-graphite">{text as string}</p>
              {i < 4 && <ArrowRight className="absolute -right-3.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-graphite md:block" aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-2xl bg-ink p-6 text-paper">
          <h2 className="text-lg font-semibold">What you will do</h2>
          <ol className="mt-3 space-y-1.5 text-sm text-paper/80">
            <li>1. Upload your own PDF as a customer and describe the print.</li>
            <li>2. Watch the backend classify it and choose the 0G trust mode.</li>
            <li>3. Switch to the print shop and see the same job arrive.</li>
            <li>4. Watch the agent configure the printer, every click tied to a real tool event.</li>
            <li>5. Follow payment and execution, with every simulated step labelled.</li>
          </ol>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/jury/customer" className="btn-signal px-5 py-2.5">Start the live demonstration <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
            <a href="#architecture" className="btn border border-white/20 px-5 py-2.5 text-paper hover:bg-white/10">Explore the technical architecture</a>
          </div>
        </section>
        <section className="card p-6">
          <h2 className="text-lg font-semibold">What is live right now</h2>
          <p className="mt-1 text-xs text-graphite">Reported by this backend at load time. Nothing here is assumed.</p>
          {!integrations ? <p className="mt-4 flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Checking…</p> : (
            <ul className="mt-4 divide-y divide-light-grey text-sm">
              {integrations.map((i) => (
                <li key={i.id} className="flex items-start gap-3 py-2">
                  <span className="w-44 shrink-0 font-medium">{i.label}</span>
                  <ModeBadge mode={i.state} />
                  <span className="text-xs text-graphite">{i.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section id="architecture" className="mt-8 rounded-2xl border border-light-grey bg-white p-6">
        <h2 className="text-lg font-semibold">Technical architecture</h2>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-paper p-4 font-mono text-[11px] leading-5 text-ink/80">{`Customer PWA (guest session) ──▶ Inklink backend (FastAPI, authoritative job state, SSE)
                                   │  classify document locally → trust mode (standard < verified < private)
                                   ├─▶ Strands agent (print operator) ──▶ backend inference gateway ──▶ 0G Private Computer
                                   │        └─ allowlisted tools: printer adapter, document engine, execution request
                                   ├─▶ Document Engine (deterministic, schema-checked operations)
                                   ├─▶ Local printer adapter (discovery, readiness, validation, spooler)
                                   ├─▶ Payment agent ──▶ x402 gate ──▶ Hedera (HTS-USDC); signed settlement callback
                                   ├─◀ ESP32-S3 controller (heartbeat, device events)
                                   └─▶ 0G Galileo registries (shop, job lifecycle; hashes only) — not deployed yet
Native Inklink app: customer identity, payment authorization, Hedera x402`}</pre>
        <p className="mt-3 text-xs text-graphite">The model can never print. It can only ask; the backend prints only when the configuration is validated, the
          customer approved the quote, payment is verified and the shop approved. Demo-shop jobs can never reach a physical printer.</p>
      </section>
    </Page>
  );
}

/* ───────────── 2. Customer ───────────── */

export function JuryCustomer() {
  const { session, jobId, setJobId } = useJury();
  const navigate = useNavigate();
  const [shop, setShop] = useState<ShopChannel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shops().then((list) => setShop(list.find((s) => s.shopId === session.demoShopId) ?? null), (e) => setError(errorMessage(e)));
  }, [session.demoShopId]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const j = await api.createJob(session.demoShopId);
      setJobId(j.jobId);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [session.demoShopId, setJobId]);

  if (!jobId) {
    return (
      <Page stage={2} title="Be the customer" intro="This is the real customer app. No login and no wallet. Pick the participating shop to open a printing session.">
        {error && <p className="mb-4 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
        {!shop ? <p className="flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Finding the demo shop…</p> : (
          <button type="button" onClick={start} disabled={!shop.acceptingOrders}
            className="group flex w-full max-w-xl items-center gap-4 rounded-2xl border border-light-grey bg-white p-5 text-left hover:border-ink">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-paper font-semibold">D</span>
            <span className="flex-1">
              <span className="block font-medium">{shop.name}</span>
              <span className="block text-sm text-graphite">{shop.description}</span>
              <span className="mt-1 block text-xs text-graphite">Print operator {shop.agentAvailable ? 'online' : 'unavailable (0G keys not configured; a labelled fallback is offered)'}</span>
            </span>
            <span className="text-sm font-medium text-signal">Open a printing session <ArrowRight className="inline h-4 w-4" aria-hidden="true" /></span>
          </button>
        )}
      </Page>
    );
  }

  return (
    <div>
      <div className="mx-auto max-w-[1280px] px-5 pt-5">
        <p className="rounded-xl bg-white px-4 py-3 text-sm text-ink/80 ring-1 ring-light-grey">
          <span className="font-medium">Try it:</span> upload a PDF from your computer, then write
          <span className="mx-1 rounded bg-paper px-1.5 py-0.5 font-mono text-[12px]">Print this document in A4, black and white, two copies, double-sided.</span>
          and press Start. Follow the processing in <Link to="/jury/processing" className="text-signal underline">stage 3</Link>.
        </p>
      </div>
      <Session jobId={jobId} shop={shop} onNew={() => setJobId(null)} embed={{
        agentHref: '/jury/agent',
        hideNewJob: true,
        approve: async (id) => (await api.jury.approveQuote(id)).handoff as PaymentHandoff | null,
        afterApproval: (
          <section className="rounded-2xl bg-signal p-5 text-white">
            <p className="text-sm font-medium">Quote approved.</p>
            <p className="mt-1 text-sm text-white/85">Now see how the print shop processes this job.</p>
            <button type="button" onClick={() => navigate('/jury/shop')} className="btn mt-3 bg-ink text-paper hover:bg-black">
              Open the shop perspective <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </section>
        ),
      }} />
    </div>
  );
}

/* ───────────── 3. Live processing ───────────── */

type StepState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

function useProcessingSteps(job: JobView | null) {
  const { events } = useJury();
  const tool = (name: string) => {
    const started = events.filter((e) => e.type === 'tool_started' && e.payload.tool === name);
    const ok = events.some((e) => e.type === 'tool_succeeded' && e.payload.tool === name);
    const failed = events.filter((e) => e.type === 'tool_failed' && e.payload.tool === name);
    return { started: started.length > 0, ok, failed: failed.length && !ok ? (failed[failed.length - 1] as { payload: { error: { message: string } } }).payload.error.message : null };
  };
  const startedEv = [...events].reverse().find((e) => e.type === 'agent_started');
  const finishedEv = [...events].reverse().find((e) => e.type === 'agent_finished');
  const provider = startedEv?.type === 'agent_started' ? startedEv.payload.provider : null;
  const fallback = provider === 'deterministic-fallback';
  const sel = job?.privacy.selection;
  const finishedMsg = finishedEv?.type === 'agent_finished' ? finishedEv.payload : null;
  const running = Boolean(job?.runActive);

  const plan = tool('plan_operations');
  const exec = tool('execute_operation_plan');
  const validate = tool('validate_print_config');
  const steps: { label: string; state: StepState; mode: string; detail: string }[] = [
    { label: 'Document received', state: job?.document ? 'done' : 'pending', mode: 'live',
      detail: job?.document ? `${job.document.filename} · ${job.document.pageCount ?? '?'} pages · SHA-256 recorded` : 'Upload a PDF in the customer stage.' },
    { label: 'Document classified', state: job?.document?.classification ? 'done' : 'pending', mode: 'live',
      detail: job?.document?.classification ? `${job.document.classification.level.replace('_', '-')}: ${job.document.classification.reason}` : 'Runs on the backend before any AI sees the file.' },
    { label: 'Trust mode selected', state: fallback ? 'skipped' : sel?.effectiveTrustMode ? (sel.error ? 'failed' : 'done') : 'pending', mode: fallback ? 'simulated' : 'live',
      detail: fallback ? 'Fallback operator: no inference, so no trust mode is used.' : sel?.effectiveTrustMode ? `${sel.effectiveTrustMode} (required ${sel.requiredTrustMode}) · ${sel.reason}` : 'Chosen when the operator starts.' },
    { label: '0G inference requested', state: fallback ? 'skipped' : (job?.privacy.inferenceCalls ?? 0) > 0 ? (job?.privacy.lastInference?.ok ? 'done' : 'failed') : sel?.error ? 'failed' : 'pending',
      mode: fallback ? 'simulated' : sel?.error ? 'unavailable' : 'live',
      detail: fallback ? 'Not used: SIMULATED rule-based planning.' : sel?.error ? sel.error.message
        : job?.privacy.lastInference ? `${job.privacy.inferenceCalls} call(s) · last ${job.privacy.lastInference.ok ? 'ok' : job.privacy.lastInference.errorCode} · ${verificationLabel(job.privacy.lastInference)}${job.privacy.lastInference.requestId ? ` · request ${job.privacy.lastInference.requestId}` : ''}` : 'Not requested yet.' },
    { label: 'Strands agent processing', state: running ? 'active' : startedEv ? (finishedMsg?.outcome === 'failed' ? 'failed' : 'done') : finishedMsg?.outcome === 'unavailable' ? 'failed' : 'pending',
      mode: fallback ? 'simulated' : 'live',
      detail: fallback ? 'Deterministic demo operator calling the real tools.' : startedEv?.type === 'agent_started' ? `${startedEv.payload.provider} · ${startedEv.payload.model}` : finishedMsg?.message ?? 'Starts when the customer submits instructions.' },
    { label: 'Structured operations generated', state: plan.ok ? 'done' : plan.failed ? 'failed' : startedEv && !running ? 'skipped' : 'pending', mode: 'live',
      detail: plan.ok ? 'Validated against the closed operation schema.' : plan.failed ?? 'Only when the instruction asks for a text edit.' },
    { label: 'Document engine execution', state: exec.ok ? 'done' : exec.failed ? 'failed' : startedEv && !running ? 'skipped' : 'pending', mode: 'live',
      detail: exec.ok ? 'Edited copy created; the original is unchanged until the customer approves.' : exec.failed ?? 'Only when an edit was planned.' },
    { label: 'Configuration validation', state: validate.ok ? 'done' : validate.failed ? 'failed' : running ? 'active' : 'pending', mode: 'live',
      detail: validate.ok ? 'Accepted by the real printer adapter.' : validate.failed ?? 'Checked against the real printer.' },
  ];
  return { steps, fallback, running, finishedMsg, events };
}

const ICON: Record<StepState, ReactNode> = {
  done: <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />,
  active: <Loader2 className="h-4 w-4 animate-spin text-signal" aria-hidden="true" />,
  failed: <TriangleAlert className="h-4 w-4 text-signal" aria-hidden="true" />,
  pending: <Circle className="h-4 w-4 text-graphite" aria-hidden="true" />,
  skipped: <Circle className="h-4 w-4 text-light-grey" aria-hidden="true" />,
};

export function JuryProcessing() {
  const { job, jobId, refreshJob } = useJury();
  const { steps, fallback, running, finishedMsg, events } = useProcessingSteps(job);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!jobId) return <Page stage={3} title="Live processing" intro=""><NeedJob /></Page>;
  const hasInstruction = events.some((e) => e.type === 'agent_started') || Boolean(finishedMsg) || false;
  const canFallback = Boolean(job?.document) && !running && finishedMsg?.outcome === 'unavailable';

  const runFallback = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.jury.runFallback(jobId);
      await refreshJob();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page stage={3} title="Live processing" next={{ to: '/jury/shop', label: 'See it in the print shop' }} intro={
      'Every row below comes from the backend: the job record and its event stream. Nothing is shown before the backend reports it.'}>
      <ol className="card divide-y divide-light-grey">
        {steps.map((s) => (
          <li key={s.label} className="flex items-start gap-3 p-4">
            <span className="mt-0.5">{ICON[s.state]}</span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${s.state === 'skipped' ? 'text-graphite' : ''}`}>{s.label}</p>
              <p className="text-xs text-graphite">{s.detail}</p>
            </div>
            <ModeBadge mode={s.state === 'skipped' && s.mode === 'live' ? 'not_used' : s.mode} />
          </li>
        ))}
      </ol>

      {canFallback && (
        <div className="mt-5 rounded-2xl border border-signal/50 bg-white p-5">
          <p className="flex items-center gap-2 text-sm font-medium"><TriangleAlert className="h-4 w-4 text-signal" aria-hidden="true" />The AI operator did not run</p>
          <p className="mt-1 text-sm text-graphite">{finishedMsg?.message}</p>
          <p className="mt-2 text-sm text-graphite">You can continue with the deterministic demo operator. It plans with fixed rules (no AI, labelled SIMULATED),
            but calls the same real tools: printer discovery, readiness, validation on the real adapter and the backend execution request.</p>
          <button type="button" className="btn-signal mt-3" onClick={runFallback} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Run the deterministic demo operator
          </button>
        </div>
      )}
      {!hasInstruction && !canFallback && job?.document && !running && (
        <p className="mt-4 text-sm text-graphite">Submit printing instructions in the <Link to="/jury/customer" className="text-signal underline">customer stage</Link> to start the operator.</p>
      )}
      {fallback && <p className="mt-4 rounded-lg bg-signal/10 p-3 text-xs">This run uses SIMULATED planning (no AI inference). The tool calls and printer checks are real.</p>}
      {error && <p className="mt-3 text-sm text-signal" role="alert">{error}</p>}
    </Page>
  );
}

/* ───────────── 4. Shop ───────────── */

export function JuryShop() {
  const { jobId, job, refreshJob } = useJury();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api.shop.jobs().then(setJobs, (e) => setNotice(errorMessage(e))), []);
  useEffect(() => { void load(); }, [load, job?.updatedAt]);
  if (!jobId) return <Page stage={4} title="The print shop" intro=""><NeedJob /></Page>;
  return (
    <Page stage={4} title="The print shop receives the job" next={{ to: '/jury/agent', label: 'Watch the Agent Workspace' }} intro={
      <>This is the shopkeeper's real orders table, in a jury-controlled view of the isolated demo shop. No shopkeeper credentials or
        private shop data are exposed, and you see only your own demo job: <span className="font-mono">{jobId}</span>.</>}>
      {notice && <p className="mb-3 rounded-md bg-white p-3 text-sm" role="status">{notice}</p>}
      <OrdersTable jobs={jobs} agentHref={() => '/jury/agent'} onApprove={async (id) => {
        try {
          const r = await api.shop.approve(id);
          setNotice(r.execution.state === 'demo_no_physical_print' || r.execution.state === 'pending'
            ? `Shop approval recorded. ${r.execution.message ?? `Still pending: ${r.execution.pending.join(', ')}.`}`
            : r.execution.message ?? r.execution.state);
          await Promise.all([load(), refreshJob()]);
        } catch (e) {
          setNotice(errorMessage(e));
        }
      }} />
    </Page>
  );
}

/* ───────────── 5. Agent ───────────── */

export function JuryAgent() {
  const { jobId } = useJury();
  if (!jobId) return <Page stage={5} title="Agent Workspace" intro=""><NeedJob /></Page>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-light-grey bg-white px-5 py-2 text-xs text-graphite">
        Stage 5 · The real Agent Workspace for demo job <span className="font-mono">{jobId}</span>. Every cursor action is a backend-relayed tool event;
        <span className="font-medium text-ink"> Replay run</span> replays recorded events and re-executes nothing.
        <Link to="/jury/payment" className="ml-2 text-signal underline">Next: payment →</Link>
      </p>
      <div className="min-h-0 flex-1"><Workspace auth="web" jobId={jobId} backHref="/jury/shop" /></div>
    </div>
  );
}

/* ───────────── 6. Payment ───────────── */

export function JuryPayment() {
  const { jobId, job, refreshJob } = useJury();
  const [p, setP] = useState<JuryPayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => (jobId ? api.jury.payment(jobId).then(setP, (e) => setError(errorMessage(e))) : Promise.resolve()), [jobId]);
  useEffect(() => { void load(); }, [load, job?.updatedAt]);
  if (!jobId) return <Page stage={6} title="Payment" intro=""><NeedJob /></Page>;

  const simulate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.jury.simulatePayment(jobId);
      await Promise.all([load(), refreshJob()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const real = p?.realPayment;
  return (
    <Page stage={6} title="Payment on Hedera via x402" next={{ to: '/jury/execution', label: 'Continue to execution' }} intro={
      'The browser never touches money. The quote is in INR, and the backend computes the USDC amount. The customer authorizes payment in the native Inklink app, and the x402 gate settles HTS-USDC on Hedera. The job is paid only when the backend verifies the signed settlement callback.'}>
      {error && <p className="mb-3 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      {!p ? <Loader2 className="h-5 w-5 animate-spin text-graphite" /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <Flow label="1 · Quotation (INR)" mode="live" ok={Boolean(p.quote)}
            text={p.quote ? `₹${p.quote.amountInr} · expires ${new Date(p.quote.expiresAt).toLocaleTimeString()}` : 'Get a price in the customer stage.'} />
          <Flow label="2 · Backend USDC conversion" mode={p.quote?.amountUsdc ? 'live' : 'not_configured'} ok={Boolean(p.quote?.amountUsdc)}
            text={p.quote?.amountUsdc ? `${p.quote.amountUsdc} USDC at rate ${p.quote.rate}` : 'INR_TO_USDC_RATE is not configured on this backend, so no USDC amount is offered.'} />
          <Flow label="3 · Customer authorization" mode="live" ok={p.customerApproved}
            text={p.customerApproved ? 'Customer approved the quote.' : 'Approve the quote in the customer stage.'} />
          <Flow label="4 · Native app handoff" mode={p.paymentsConfigured ? 'live' : 'not_configured'} ok={p.paymentsConfigured && p.customerApproved}
            text={p.paymentsConfigured ? 'Single-use deep link / QR opens the Inklink app.' : 'Payments are not configured here; no handoff token is issued.'} />
          <Flow label="5 · x402 payment challenge" mode={p.x402Requirement ? 'live' : 'not_configured'} ok={Boolean(p.x402Requirement)}
            text={p.x402Requirement ? `${p.x402Requirement.amount} ${p.x402Requirement.asset} → ${p.x402Requirement.payTo || '(merchant not set)'} on ${p.x402Requirement.network}` : 'Requires the USDC quote and the payment agent configuration.'} />
          <Flow label="6 · Settlement verification" mode={real?.status === 'settled' ? 'live' : p.simulated ? 'simulated' : 'pending'} ok={real?.status === 'settled' || Boolean(p.simulated)}
            text={real?.status === 'settled' ? `Verified · ${real.transactionId}` : p.simulated ? p.simulated.note : `Payment status: ${p.paymentStatus}`}
            link={real?.hashscanUrl ?? undefined} />
        </div>
      )}
      {p && !p.paymentsConfigured && p.customerApproved && !p.simulated && p.paymentStatus !== 'settled' && (
        <div className="mt-5 rounded-2xl border border-signal/50 bg-white p-5">
          <p className="text-sm font-medium">No funded Hedera settlement is configured on this backend.</p>
          <p className="mt-1 text-sm text-graphite">Use the labelled demonstration path. It records a SIMULATED settlement on the demo job only. It does not create a
            transaction id or a HashScan link, and it never changes the job's real payment status.</p>
          <button type="button" className="btn-signal mt-3" onClick={simulate} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Record a SIMULATED settlement</button>
        </div>
      )}
      {p?.customerApproved && job?.status === 'awaiting_payment' && p.paymentsConfigured && <HandoffHint />}
    </Page>
  );
}

function HandoffHint() {
  const { jobId } = useJury();
  let saved: PaymentHandoff | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(`inklink.web.handoff.${jobId}`) ?? 'null');
  } catch {
    saved = null;
  }
  return saved ? <div className="mt-5 max-w-sm"><PaymentHandoffCard handoff={saved} /></div> : null;
}

function Flow({ label, mode, ok, text, link }: { label: string; mode: string; ok: boolean; text: string; link?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        {ok ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Circle className="h-4 w-4 text-graphite" aria-hidden="true" />}
        <p className="text-sm font-medium">{label}</p>
        <span className="ml-auto"><ModeBadge mode={mode} /></span>
      </div>
      <p className="mt-1.5 text-xs text-graphite">{text}</p>
      {link && <a href={link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-signal underline">View on HashScan</a>}
    </div>
  );
}

/* ───────────── 7. Execution ───────────── */

export function JuryExecution() {
  const { jobId, job, refreshJob } = useJury();
  const [hw, setHw] = useState<ShopHardware | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.shop.hardware().then(setHw, (e) => setError(errorMessage(e))); }, [job?.updatedAt]);
  if (!jobId) return <Page stage={7} title="Physical execution" intro=""><NeedJob /></Page>;
  const paid = job?.paymentStatus === 'settled' || Boolean(job?.simulation?.payment);
  const gates: [string, boolean, string][] = [
    ['Configuration validated', Boolean(job?.configValidated), 'live'],
    ['Customer approved quote', Boolean(job?.customerApprovedQuote), 'live'],
    ['Payment verified', paid, job?.paymentStatus === 'settled' ? 'live' : job?.simulation?.payment ? 'simulated' : 'live'],
    ['Shop approved', Boolean(job?.shopApproved), 'live'],
    ['Operator requested execution', Boolean(job?.executionRequested), 'live'],
  ];
  const ex = job?.simulation?.execution;
  const printer = hw?.printerAdapter.printers.find((x) => x.id === job?.operatorConfig.printerId);

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.jury.simulateExecution(jobId);
      await refreshJob();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page stage={7} title="Execution authorization and the printer" next={{ to: '/jury/result', label: 'See the full lifecycle' }} intro={
      'The backend authorizes printing only when every gate holds, and re-validates the configuration on the real printer right before execution. The demo shop never sends a job to a printer, so execution here is SIMULATED. A job is never marked completed without a real completion event.'}>
      {error && <p className="mb-3 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-semibold">Execution gates</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {gates.map(([label, ok, mode]) => (
              <li key={label} className="flex items-center gap-2">
                {ok ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Circle className="h-4 w-4 text-graphite" aria-hidden="true" />}
                <span className={ok ? '' : 'text-graphite'}>{label}</span>
                {ok && <span className="ml-auto"><ModeBadge mode={mode} /></span>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn-primary mt-4 w-full" onClick={execute} disabled={busy || gates.some(([, ok]) => !ok)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Authorize and run SIMULATED execution
          </button>
          {gates.some(([, ok]) => !ok) && <p className="mt-2 text-xs text-graphite">Complete the earlier stages first. The backend refuses execution until every gate holds.</p>}
          {ex && (
            <div className={`mt-4 rounded-lg p-3 text-xs ${ex.state === 'SIMULATED_SUBMISSION' ? 'bg-signal/10' : 'bg-light-grey'}`}>
              <p className="flex items-center gap-2 font-medium"><ModeBadge mode="simulated" />{ex.state.replace(/_/g, ' ').toLowerCase()}</p>
              <p className="mt-1">Printer validation: <span className="font-mono">{ex.printerValidation}</span>{ex.errors.length ? ` · ${ex.errors.join(' ')}` : ''}</p>
              <p className="mt-1 text-graphite">{ex.note}</p>
            </div>
          )}
        </section>
        <section className="card p-5">
          <h2 className="text-sm font-semibold">Hardware, as reported</h2>
          {!hw ? <Loader2 className="mt-3 h-5 w-5 animate-spin text-graphite" /> : (
            <div className="mt-3 space-y-3 text-sm">
              <p className="flex items-center gap-2"><Network className="h-4 w-4 text-graphite" aria-hidden="true" />Gateway <span className="font-mono text-xs">{hw.gateway?.gatewayId}</span><span className="ml-auto"><ModeBadge mode="live" /></span></p>
              <p className="flex items-center gap-2"><Printer className="h-4 w-4 text-graphite" aria-hidden="true" />Printer adapter: {hw.printerAdapter.reachable ? `${hw.printerAdapter.printers.length} printer(s)` : hw.printerAdapter.error}
                <span className="ml-auto"><ModeBadge mode={hw.printerAdapter.reachable ? 'live' : 'unavailable'} /></span></p>
              <p className="text-xs text-graphite">Selected printer: {job?.operatorConfig.printerId ?? 'not selected'}{printer ? ` · ${printer.status}` : ''}</p>
              <DevicesCard data={hw} />
              <p className="text-xs text-graphite">Job state: <span className="font-mono">{job?.status}</span> · device <span className="font-mono">{job?.deviceStatus}</span>. A demo job is never marked completed.</p>
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

/* ───────────── 8. Result ───────────── */

export function JuryResult() {
  const { jobId, job, events } = useJury();
  const navigate = useNavigate();
  const [life, setLife] = useState<JuryLifecycle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (jobId) api.jury.lifecycle(jobId).then(setLife, (e) => setError(errorMessage(e))); }, [jobId, job?.updatedAt]);
  if (!jobId) return <Page stage={8} title="Result" intro=""><NeedJob /></Page>;

  const reset = async () => {
    if (!window.confirm('Reset the jury demo? Only your demo jobs are deleted.')) return;
    await api.jury.reset();
    navigate('/jury/customer');
    window.location.reload();
  };

  return (
    <Page stage={8} title="The whole job lifecycle" intro={`Demo job ${jobId}. Each stage shows whether it ran live or was simulated, as reported by the backend.`}>
      {error && <p className="mb-3 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      {life && (
        <ol className="flex flex-wrap items-stretch gap-2">
          {life.stages.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <div className={`w-[150px] rounded-xl border p-3 ${s.state === 'done' ? 'border-ink bg-white' : s.state === 'simulated' ? 'border-signal bg-signal/5' : 'border-light-grey bg-white/60'}`}>
                <p className="text-xs font-medium">{s.label}</p>
                <p className="mt-1 flex items-center gap-1.5"><ModeBadge mode={s.mode} /><span className="text-[10px] text-graphite">{s.state.replace(/_/g, ' ')}</span></p>
                {s.detail && <p className="mt-1 truncate text-[10px] text-graphite" title={s.detail}>{s.detail}</p>}
              </div>
              {i < life.stages.length - 1 && <ArrowRight className="h-4 w-4 text-graphite" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/jury#architecture" className="btn-ghost">View the technical architecture</Link>
        <Link to="/jury/agent" className="btn-ghost"><RotateCcw className="h-4 w-4" aria-hidden="true" />Replay the demonstration (recorded events only)</Link>
        <button type="button" className="btn-ghost" onClick={reset}>Reset the demonstration</button>
      </div>
      <section className="mt-8">
        <h2 className="label-mono mb-2">Job event history ({events.length} events)</h2>
        <ol className="max-h-[420px] overflow-y-auto rounded-xl bg-ink p-4 font-mono text-[12px] leading-6 text-paper/80">
          {events.map((e) => (
            <li key={e.seq} className="flex gap-3">
              <span className="w-8 shrink-0 text-right text-paper/40">{e.seq}</span>
              <span className="w-16 shrink-0 text-paper/40">{e.ts.slice(11, 19)}</span>
              <span className="w-44 shrink-0">{e.type}</span>
              <span className="truncate">{e.type === 'tool_started' || e.type === 'tool_succeeded' ? TOOL_LABEL[e.payload.tool] ?? e.payload.tool : summarize(e)}</span>
            </li>
          ))}
        </ol>
      </section>
      {life && life.chainRecords.length > 0 && (
        <section className="mt-6 text-xs text-graphite">0G Galileo: {life.chainRecords.length} lifecycle record(s) queued, not sent (contracts not deployed).</section>
      )}
    </Page>
  );
}
