import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { Check, Circle, Loader2, MonitorPlay, RefreshCw } from 'lucide-react';
import type { JobView, PrinterSummary, ShopConfig, ShopHardware, ShopPayments, TrustMode } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { COLOR_LABEL, PAPER_LABEL, SIDES_LABEL } from '../workspace/PrinterDialog';
import { useShop } from './ShopLayout';

function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tightest">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-graphite">{subtitle}</p>}
        </div>
        <div className="ml-auto flex gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}

/* ───────────── Overview ───────────── */

export function ShopOverviewPage() {
  const { overview } = useShop();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  useEffect(() => {
    api.shop.jobs().then(setJobs, () => setJobs([]));
  }, [overview]);
  if (!overview) return <Page title="Overview"><Loader2 className="h-5 w-5 animate-spin text-graphite" /></Page>;
  const s = overview.stats;
  return (
    <Page title="Overview" subtitle="What needs your attention right now.">
      <div className="grid gap-4 md:grid-cols-3">
        <StatusCard title="Shop availability" ok={overview.acceptingOrders}
          value={overview.acceptingOrders ? 'Accepting orders' : 'Paused'} detail="Toggle in the sidebar." />
        <StatusCard title="Print operator" ok={overview.agent.available}
          value={overview.agent.available ? 'Available' : 'Unavailable'}
          detail={overview.agent.available
            ? `${overview.agent.provider} · 0G keys: ${(['standard', 'verified', 'private'] as const).filter((m) => overview.agent.zeroG.modes[m].configured).join(', ') || 'none'}`
            : overview.agent.reason ?? ''} />
        <StatusCard title="Printer adapter" ok={overview.printerAdapter.reachable}
          value={overview.printerAdapter.reachable ? `${overview.printerAdapter.printers.length} printer(s)` : 'Not reachable'}
          detail={overview.printerAdapter.error ?? `${overview.printerAdapter.printers.filter((p) => p.status === 'online').length} online`} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Active orders" value={s.activeJobs} />
        <Stat label="Waiting for your approval" value={s.awaitingApproval} highlight={s.awaitingApproval > 0} />
        <Stat label="Paid, ready to print" value={s.awaitingExecution} />
        <Stat label="Completed today" value={s.completedToday} />
      </div>
      {!overview.payments.configured && (
        <p className="mt-4 rounded-lg border border-light-grey bg-white p-3 text-sm text-graphite">
          Payments are not configured on this backend, so customers can get a price but cannot pay yet.
        </p>
      )}
      <h2 className="label-mono mb-3 mt-8">Recent orders</h2>
      <OrdersTable jobs={jobs?.slice(0, 5) ?? null} compact />
    </Page>
  );
}

export function StatusCard({ title, ok, value, detail }: { title: string; ok: boolean; value: string; detail: string }) {
  return (
    <div className="card p-4">
      <p className="label-mono">{title}</p>
      <p className="mt-2 flex items-center gap-2 text-lg font-medium">
        <span className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-signal'}`} />{value}
      </p>
      <p className="mt-1 truncate text-xs text-graphite" title={detail}>{detail}</p>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`card p-4 ${highlight ? 'border-signal' : ''}`}>
      <p className="text-3xl font-semibold tracking-tightest">{value}</p>
      <p className="mt-1 text-xs text-graphite">{label}</p>
    </div>
  );
}

/* ───────────── Orders ───────────── */

export function ShopOrdersPage() {
  const { reload } = useShop();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api.shop.jobs().then(setJobs, (e) => setError(errorMessage(e))), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, okMsg?: (r: unknown) => string) => {
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (okMsg) setNotice(okMsg(r));
      await Promise.all([load(), reload()]);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Page title="Incoming orders" subtitle="Approve an order to allow printing. Printing starts only when payment is verified and the configuration was validated.">
      {error && <p className="mb-3 rounded-md bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      {notice && <p className="mb-3 rounded-md bg-white p-3 text-sm" role="status">{notice}</p>}
      <OrdersTable jobs={jobs}
        onApprove={(id) => act(() => api.shop.approve(id), (r) => {
          const ex = (r as { execution: { state: string; pending: string[]; message?: string } }).execution;
          return ex.state === 'submitted' ? 'Sent to the printer.' : ex.message || `Approved. Still waiting for: ${ex.pending.join(', ') || ex.state}.`;
        })}
        onComplete={(id) => act(() => api.shop.complete(id), () => 'Marked as completed. The customer was notified.')} />
    </Page>
  );
}

export function OrdersTable({ jobs, compact, onApprove, onComplete, agentHref }: {
  jobs: JobView[] | null; compact?: boolean; onApprove?: (id: string) => void; onComplete?: (id: string) => void;
  agentHref?: (jobId: string) => string;
}) {
  if (!jobs) return <Loader2 className="h-5 w-5 animate-spin text-graphite" />;
  if (jobs.length === 0) return <p className="card p-6 text-sm text-graphite">No orders yet.</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-light-grey">
          <tr className="label-mono">
            <th className="px-4 py-3 font-normal">Order</th>
            <th className="px-4 py-3 font-normal">Document</th>
            <th className="px-4 py-3 font-normal">Settings</th>
            <th className="px-4 py-3 font-normal">Price</th>
            <th className="px-4 py-3 font-normal">Status</th>
            {!compact && <th className="px-4 py-3 font-normal">Gates</th>}
            <th className="px-4 py-3 font-normal"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-light-grey">
          {jobs.map((j) => {
            const c = j.operatorConfig;
            return (
              <tr key={j.jobId} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-mono text-xs">{j.jobId}</p>
                  <p className="text-xs text-graphite">{new Date(j.createdAt).toLocaleString()}</p>
                </td>
                <td className="max-w-[180px] px-4 py-3">
                  {j.document ? (
                    <>
                      <p className="truncate">{j.document.filename}</p>
                      <p className="font-mono text-[11px] text-graphite">{j.document.format.toUpperCase()} · {j.document.pageCount ?? '?'} p{j.document.edited ? ' · edited' : ''}</p>
                    </>
                  ) : <span className="text-graphite">—</span>}
                </td>
                <td className="px-4 py-3 text-xs">
                  {c.paperSize || c.colorMode ? (
                    <>
                      <p>{[c.copies && `${c.copies}×`, c.colorMode && COLOR_LABEL[c.colorMode], c.paperSize && PAPER_LABEL[c.paperSize]?.split(' · ')[0]].filter(Boolean).join(' · ')}</p>
                      <p className="text-graphite">{c.sides ? SIDES_LABEL[c.sides]?.split(' · ')[0] : ''}{c.printerId ? ` · ${c.printerId}` : ''}</p>
                    </>
                  ) : <span className="text-graphite">Not configured</span>}
                </td>
                <td className="px-4 py-3">{j.quote ? `₹${j.quote.amount}` : <span className="text-graphite">—</span>}</td>
                <td className="px-4 py-3">
                  <StatusPill status={j.status} />
                  <p className="mt-1 font-mono text-[10px] text-graphite">pay {j.paymentStatus} · dev {j.deviceStatus}</p>
                  {j.submission && !j.submission.ok && <p className="mt-1 max-w-[200px] text-[11px] text-signal">{j.submission.message}</p>}
                </td>
                {!compact && (
                  <td className="px-4 py-3">
                    <ul className="space-y-0.5 text-xs">
                      <Gate ok={j.configValidated} label="Config validated" />
                      <Gate ok={j.customerApprovedQuote} label="Customer approved" />
                      <Gate ok={j.paymentStatus === 'settled'} label="Payment verified" />
                      <Gate ok={j.shopApproved} label="Shop approved" />
                      <Gate ok={j.executionRequested} label="Operator requested" />
                    </ul>
                  </td>
                )}
                <td className="px-4 py-3">
                  <div className="flex flex-col items-end gap-2">
                    <Link to={agentHref ? agentHref(j.jobId) : `/shop/agent/${j.jobId}`} className="btn-ghost px-2.5 py-1.5 text-xs">
                      <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />Workspace
                    </Link>
                    {onApprove && !j.shopApproved && !['completed', 'cancelled', 'failed'].includes(j.status) && (
                      <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => onApprove(j.jobId)}>Approve</button>
                    )}
                    {onComplete && j.status === 'executing' && (
                      <button type="button" className="btn-signal px-2.5 py-1.5 text-xs" onClick={() => onComplete(j.jobId)}>Mark completed</button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StatusPill({ status }: { status: JobView['status'] }) {
  const tone =
    status === 'completed' ? 'bg-emerald-100 text-emerald-800'
      : status === 'executing' ? 'bg-ink text-paper'
        : status === 'awaiting_execution' ? 'bg-signal/15 text-ink'
          : status === 'failed' || status === 'cancelled' ? 'bg-signal text-white'
            : 'bg-light-grey text-ink';
  return <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${tone}`}>{status.replace(/_/g, ' ')}</span>;
}

function Gate({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? '' : 'text-graphite'}`}>
      {ok ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}{label}
    </li>
  );
}

/* ───────────── Hardware ───────────── */

export function ShopHardwarePage() {
  const [data, setData] = useState<ShopHardware | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.shop.hardware());
    } catch (e) {
      setData({ printerAdapter: { reachable: false, printers: [], defaultPrinter: null, error: errorMessage(e), url: '' }, jobs: [] });
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void scan();
    const t = setInterval(() => void scan(), 10_000); // gateway and printer status as the backend sees it
    return () => clearInterval(t);
  }, [scan]);
  const adapter = data?.printerAdapter;
  const relay = adapter?.relay;

  return (
    <Page title="Hardware" subtitle="The local printer adapter on this computer, the printers it discovers, and jobs at the printer."
      actions={<button type="button" className="btn-ghost" onClick={scan} disabled={busy}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />Discover</button>}>
      {adapter && (
        <div className="card mb-4 flex items-center gap-3 p-4 text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${adapter.reachable ? 'bg-emerald-500' : 'bg-signal'}`} />
          <span className="font-medium">Printer adapter {adapter.reachable ? 'reachable' : 'not reachable'}</span>
          <span className="font-mono text-xs text-graphite">{adapter.url}</span>
          {!adapter.reachable && <span className="text-signal">{adapter.error}</span>}
        </div>
      )}
      {relay?.mode === 'relay' && (
        <div className="card mb-4 p-4 text-sm">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${relay.connected ? 'bg-emerald-500' : 'bg-signal'}`} />
            <span className="font-medium">Shop gateway {relay.connected ? 'connected' : 'not connected'}</span>
            {relay.lastPollAt && <span className="text-xs text-graphite">last contact {new Date(relay.lastPollAt * 1000).toLocaleTimeString()}</span>}
          </div>
          {!relay.connected && (
            <p className="mt-2 text-xs text-graphite">
              This backend runs in the cloud and reaches the printer only through the shop gateway on the shop computer. Start the printer adapter
              and <code>services/shop-gateway</code> there (<code>npm start</code>) with this backend&apos;s URL and its GATEWAY_TOKEN. The status turns
              connected after its first authenticated poll.
            </p>
          )}
        </div>
      )}
      {data && <DevicesCard data={data} />}
      {data && data.jobs.length > 0 && (
        <div className="card mb-4 p-4">
          <p className="label-mono mb-2">At the printer</p>
          <ul className="space-y-1 text-sm">
            {data.jobs.map((j) => (
              <li key={j.jobId} className="flex flex-wrap gap-3">
                <span className="font-mono text-xs">{j.jobId}</span>
                <StatusPill status={j.status} />
                <span className="text-xs text-graphite">device {j.deviceStatus}{j.printerId ? ` · ${j.printerId}` : ''}</span>
                {j.submission && <span className="text-xs text-graphite">spooler: {j.submission.state}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {adapter?.printers.map((p) => (
          <div key={p.id} className="card p-4">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${p.status === 'online' ? 'bg-emerald-500' : p.status === 'offline' ? 'bg-signal' : 'bg-graphite'}`} />
              <p className="font-medium">{p.name}</p>
              {p.isDefault && <span className="ml-auto rounded bg-light-grey px-1.5 py-0.5 font-mono text-[10px]">DEFAULT</span>}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-1 text-xs">
              <dt className="text-graphite">Status</dt><dd>{p.status}</dd>
              <dt className="text-graphite">Colour</dt><dd>{cap(p.supportsColor)}</dd>
              <dt className="text-graphite">Two-sided</dt><dd>{cap(p.supportsDuplex)}</dd>
              <dt className="text-graphite">Id</dt><dd className="truncate font-mono">{p.id}</dd>
            </dl>
          </div>
        ))}
        {adapter?.reachable && adapter.printers.length === 0 && <p className="card p-6 text-sm text-graphite">No printers found on this computer.</p>}
      </div>
    </Page>
  );
}

/* ───────────── Payments ───────────── */

export function ShopPaymentsPage() {
  const [data, setData] = useState<ShopPayments | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.shop.payments().then(setData, (e) => setError(errorMessage(e)));
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  return (
    <Page title="Payments" subtitle="Hedera x402 payments are authorized in the customer's Inklink app. A payment shows as settled only after the backend verified the signed settlement.">
      {error && <p className="mb-3 rounded-md bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <StatusCard title="Payments" ok={data.configured} value={data.configured ? 'Configured' : 'Not configured'}
              detail={data.configured ? `${data.settlementAsset} on ${data.network}` : 'Set the payment env vars on the backend (see .env.example).'} />
            <StatusCard title="Merchant account" ok={Boolean(data.merchantAccountId)} value={data.merchantAccountId ?? 'Not set'} detail="Hedera account that receives USDC." />
            <StatusCard title="INR → USDC rate" ok={Boolean(data.inrToUsdcRate)} value={data.inrToUsdcRate ?? 'Not set'} detail="Configured rate used for quotes." />
          </div>
          <h2 className="label-mono mb-3 mt-8">Payments</h2>
          {data.payments.length === 0 ? <p className="card p-6 text-sm text-graphite">No payments yet.</p> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-light-grey">
                  <tr className="label-mono"><th className="px-4 py-3 font-normal">Payment</th><th className="px-4 py-3 font-normal">Order</th>
                    <th className="px-4 py-3 font-normal">Amount</th><th className="px-4 py-3 font-normal">Status</th><th className="px-4 py-3 font-normal">Hedera</th></tr>
                </thead>
                <tbody className="divide-y divide-light-grey">
                  {data.payments.map((p) => (
                    <tr key={p.paymentId}>
                      <td className="px-4 py-3 font-mono text-xs">{p.paymentId}</td>
                      <td className="px-4 py-3 font-mono text-xs">{p.jobId}</td>
                      <td className="px-4 py-3">{p.amountUsdc} USDC{p.amountInr ? <span className="text-xs text-graphite"> · ₹{p.amountInr}</span> : null}</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-light-grey px-2 py-0.5 font-mono text-[11px]">{p.status}</span></td>
                      <td className="px-4 py-3">{p.hashscanUrl ? <a href={p.hashscanUrl} target="_blank" rel="noreferrer" className="text-signal underline">{p.transactionId}</a> : <span className="text-graphite">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 className="label-mono mb-3 mt-8">Waiting for payment</h2>
          {data.awaitingPayment.length === 0 ? <p className="text-sm text-graphite">None.</p> : (
            <ul className="space-y-1 text-sm">
              {data.awaitingPayment.map((j) => (
                <li key={j.jobId} className="flex gap-3"><span className="font-mono text-xs">{j.jobId}</span><span>{j.amountInr ? `₹${j.amountInr}` : 'no quote'}</span><span className="text-graphite">payment {j.paymentStatus}</span></li>
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}

/** Gateway and ESP32-S3 controllers, exactly as they reported (never assumed online). */
export function DevicesCard({ data }: { data: ShopHardware }) {
  const d = data.devices;
  const label = !d ? 'Unknown' : d.status === 'not_configured' ? 'Not configured' : d.status === 'never_seen' ? 'No device has reported' : d.status;
  return (
    <div className="card mb-4 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${d?.status === 'online' ? 'bg-emerald-500' : d?.status === 'offline' ? 'bg-signal' : 'bg-graphite'}`} />
        <span className="font-medium">ESP32-S3 controller</span>
        <span className="text-graphite">{label}</span>
        {data.gateway && <span className="ml-auto font-mono text-[11px] text-graphite">gateway {data.gateway.gatewayId} · key {data.gateway.fingerprint}</span>}
      </div>
      {d?.status === 'not_configured' && (
        <p className="mt-2 text-xs text-graphite">Set DEVICE_TOKEN on the backend and flash the controller to report to /api/v1/devices/heartbeat. Until then no device status is shown.</p>
      )}
      {d && d.items.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {d.items.map((i) => (
            <li key={i.deviceId} className="flex flex-wrap gap-3">
              <span className="font-mono">{i.deviceId}</span><span>{i.type}</span><span className={i.status === 'online' ? 'text-emerald-700' : 'text-signal'}>{i.status}</span>
              <span className="text-graphite">state {i.state}{i.firmware ? ` · fw ${i.firmware}` : ''} · last seen {new Date(i.lastSeenAt).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function cap(v: boolean | null) {
  return v === null ? 'Unknown (driver not queryable)' : v ? 'Supported' : 'Not supported';
}

/* ───────────── Settings ───────────── */

export function ShopSettingsPage() {
  const { reload } = useShop();
  const [cfg, setCfg] = useState<ShopConfig | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ reachable: boolean; printers: PrinterSummary[]; error: string | null } | null>(null);
  const discover = useCallback(() => {
    api.shop.printers().then(setFound, (e) => setFound({ reachable: false, printers: [], error: errorMessage(e) }));
  }, []);
  useEffect(() => {
    api.shop.config().then(({ name, description, pricePerPageMonochrome, pricePerPageColor, minimumTrustMode, defaultPrinterId }) =>
      setCfg({ name, description, pricePerPageMonochrome, pricePerPageColor, minimumTrustMode: minimumTrustMode ?? null,
        defaultPrinterId: defaultPrinterId ?? null }), (e) => setStatus(errorMessage(e)));
    discover();
  }, [discover]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.shop.saveConfig(cfg);
      setStatus('Saved.');
      await reload();
    } catch (err) {
      setStatus(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!cfg) return <Page title="Shop configuration">{status ? <p className="text-sm text-signal">{status}</p> : <Loader2 className="h-5 w-5 animate-spin text-graphite" />}</Page>;
  const field = (key: 'name' | 'description' | 'pricePerPageMonochrome' | 'pricePerPageColor', label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label htmlFor={`cfg-${key}`} className="label-mono">{label}</label>
      <input id={`cfg-${key}`} value={cfg[key]} onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })} {...props}
        className="mt-1 w-full rounded-md border border-light-grey bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none" />
    </div>
  );
  return (
    <Page title="Shop configuration" subtitle="Shown to customers in the Inklink app and used for quotes.">
      <form onSubmit={save} className="card max-w-xl space-y-4 p-6">
        {field('name', 'Shop name', { required: true, maxLength: 80 })}
        {field('description', 'Description', { maxLength: 280 })}
        <div className="grid grid-cols-2 gap-4">
          {field('pricePerPageMonochrome', 'Black & white · ₹ per page', { inputMode: 'decimal', pattern: '\\d{1,6}(\\.\\d{1,2})?', required: true })}
          {field('pricePerPageColor', 'Colour · ₹ per page', { inputMode: 'decimal', pattern: '\\d{1,6}(\\.\\d{1,2})?', required: true })}
        </div>
        <div>
          <label htmlFor="cfg-trust" className="label-mono">Minimum 0G trust mode</label>
          <select id="cfg-trust" value={cfg.minimumTrustMode ?? ''}
            onChange={(e) => setCfg({ ...cfg, minimumTrustMode: (e.target.value || null) as TrustMode | null })}
            className="mt-1 w-full rounded-md border border-light-grey bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none">
            <option value="">Follow the document policy (sensitive → Private)</option>
            <option value="verified">At least Verified</option>
            <option value="private">Always Private</option>
          </select>
          <p className="mt-1 text-xs text-graphite">This can only make inference stricter. Sensitive and unclassified documents always use Private.</p>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <label htmlFor="cfg-printer" className="label-mono">Printer for new jobs</label>
            <button type="button" className="ml-auto text-xs text-graphite underline" onClick={discover}>Discover printers</button>
          </div>
          {found && !found.reachable ? (
            <p className="mt-1 rounded-md bg-signal/10 p-2 text-xs" role="alert">
              {found.error ?? 'The printer adapter is not reachable.'} Start the printer adapter and the shop gateway on the shop computer, then discover again.
            </p>
          ) : found && found.printers.length === 0 ? (
            <p className="mt-1 text-xs text-graphite">The printer adapter found no printers. Install or switch on a printer on the shop computer, then discover again.</p>
          ) : (
            <select id="cfg-printer" value={cfg.defaultPrinterId ?? ''} disabled={!found}
              onChange={(e) => setCfg({ ...cfg, defaultPrinterId: e.target.value || null })}
              className="mt-1 w-full rounded-md border border-light-grey bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none">
              <option value="">The adapter&apos;s default printer</option>
              {found?.printers.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.status}{p.isDefault ? ' · default' : ''}</option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-graphite">Only printers the adapter discovered can be chosen. If the chosen printer is offline, the first online printer is used.</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save</button>
          {status && <span className="text-sm text-graphite" role="status">{status}</span>}
        </div>
      </form>
    </Page>
  );
}

/* ───────────── Pairing ───────────── */

export function ShopPairingPage() {
  const [qr, setQr] = useState<{ img: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.shop.pairingQr();
      setQr({ img: await QRCode.toDataURL(r.qrText, { margin: 1, width: 320 }), expiresAt: r.expiresAt });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <Page title="Pair Inklink app" subtitle="Customers scan this signed code with the Inklink app to connect to this shop and pay."
      actions={<button type="button" className="btn-ghost" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden="true" />New code</button>}>
      {error && <p className="mb-4 rounded-md bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
      {qr && (
        <div className="card inline-block p-6 text-center">
          <img src={qr.img} alt="Shop pairing code for the Inklink app" className="h-64 w-64" />
          <p className="mt-2 font-mono text-[11px] text-graphite">Signed · valid until {new Date(qr.expiresAt).toLocaleTimeString()}</p>
        </div>
      )}
    </Page>
  );
}
