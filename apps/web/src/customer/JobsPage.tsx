import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, MonitorPlay, Printer } from 'lucide-react';
import type { JobView } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { recentJobs } from '../lib/recent';
import { Logo } from '../components/Logo';

const STATUS_TEXT: Record<JobView['status'], string> = {
  created: 'Setting up',
  awaiting_payment: 'Waiting for payment',
  awaiting_execution: 'Paid · waiting for the shop',
  executing: 'Printing',
  completed: 'Ready for collection',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** /app/jobs — orders started in this browser tab, with live backend status. */
export function JobsPage() {
  const recent = recentJobs();
  const [jobs, setJobs] = useState<Record<string, JobView | string>>({});

  useEffect(() => {
    const load = () =>
      recent.forEach((r) =>
        api.job(r.jobId).then(
          (j) => setJobs((m) => ({ ...m, [r.jobId]: j })),
          (e) => setJobs((m) => ({ ...m, [r.jobId]: errorMessage(e) })),
        ),
      );
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <header className="flex items-center gap-3 px-5 py-4">
        <Link to="/app" className="btn-ghost px-2.5 py-1.5" aria-label="Back to shops"><ArrowLeft className="h-4 w-4" /></Link>
        <Logo />
      </header>
      <main className="flex-1 px-5 pb-10">
        <h1 className="mt-2 text-2xl font-semibold tracking-tightest">Your orders</h1>
        <p className="mt-1 text-sm text-graphite">Orders started in this tab. They are not tied to an account.</p>
        {recent.length === 0 && (
          <div className="card mt-6 p-6 text-sm text-graphite">
            No orders yet. <Link to="/app" className="text-signal underline">Pick a shop</Link> to start one.
          </div>
        )}
        <ul className="mt-6 space-y-3">
          {recent.map((r) => {
            const j = jobs[r.jobId];
            return (
              <li key={r.jobId} className="card p-4">
                <div className="flex items-center gap-3">
                  <Printer className="h-5 w-5 text-graphite" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{r.shopName}</p>
                    <p className="font-mono text-[11px] text-graphite">{r.jobId}</p>
                  </div>
                  {!j ? <Loader2 className="h-4 w-4 animate-spin text-graphite" /> : typeof j === 'string' ? null : (
                    <span className="rounded-full bg-light-grey px-2 py-0.5 text-xs">{STATUS_TEXT[j.status]}</span>
                  )}
                </div>
                {typeof j === 'string' && <p className="mt-2 text-xs text-signal">{j}</p>}
                {j && typeof j !== 'string' && (
                  <div className="mt-3 space-y-1 text-xs text-graphite">
                    <p>{j.document ? `${j.document.filename} · ${j.document.pageCount ?? '?'} pages` : 'No document yet'}{j.quote ? ` · ₹${j.quote.amount}` : ''}</p>
                    <p>payment {j.paymentStatus} · printer {j.deviceStatus}{j.privacy.selection ? ` · ${j.privacy.selection.effectiveTrustMode} inference` : ''}</p>
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <Link to={`/app/chat/${encodeURIComponent(r.shopId)}?job=${r.jobId}`} className="btn-ghost px-2.5 py-1.5 text-xs">Open conversation</Link>
                  <Link to={`/app/jobs/${r.jobId}/agent`} className="btn-ghost px-2.5 py-1.5 text-xs"><MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />Watch operator</Link>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
