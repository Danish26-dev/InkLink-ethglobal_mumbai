import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, FileText, Loader2, MonitorPlay } from 'lucide-react';
import type { JobView } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { recentJobs } from '../lib/recent';
import { CustomerShell } from './CustomerShell';

const STAGES: { label: string; reached: (j: JobView) => boolean }[] = [
  { label: 'Uploaded', reached: (j) => Boolean(j.document) },
  { label: 'Configured', reached: (j) => j.configValidated },
  { label: 'Quoted', reached: (j) => Boolean(j.quote) || ['awaiting_execution', 'executing', 'completed'].includes(j.status) },
  { label: 'Paid', reached: (j) => ['awaiting_execution', 'executing', 'completed'].includes(j.status) },
  { label: 'Printing', reached: (j) => ['executing', 'completed'].includes(j.status) },
  { label: 'Ready', reached: (j) => j.status === 'completed' },
];

/** /app/jobs — documents and jobs started in this browser tab, with live backend status. */
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
    <CustomerShell>
      <main className="mx-auto max-w-[1080px] px-5 py-10">
        <p className="label-mono">Recent jobs</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tightest">Your documents</h1>
        <p className="mt-1 text-sm text-graphite">Jobs started in this browser tab. They are not tied to an account.</p>

        {recent.length === 0 && (
          <div className="mt-8 rounded-2xl border border-dashed border-black/15 bg-white p-10 text-center">
            <FileText className="mx-auto h-8 w-8 text-graphite" aria-hidden="true" />
            <p className="mt-3 text-sm text-graphite">No print jobs yet.</p>
            <Link to="/app" className="btn-primary mt-4">Start printing</Link>
          </div>
        )}

        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {recent.map((r) => {
            const j = jobs[r.jobId];
            const view = j && typeof j !== 'string' ? j : null;
            return (
              <li key={r.jobId} className="rounded-2xl border border-light-grey bg-white p-5">
                <div className="flex items-start gap-4">
                  <div className="flex h-16 w-12 shrink-0 flex-col gap-1 rounded-sm border border-black/10 bg-paper p-1.5" aria-hidden="true">
                    <span className="h-1 w-2/3 rounded-sm bg-signal" />
                    {[80, 65, 90, 55].map((w) => <span key={w} className="h-0.5 rounded-sm bg-ink/15" style={{ width: `${w}%` }} />)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{view?.document?.filename ?? 'No document yet'}</p>
                    <p className="text-xs text-graphite">{r.shopName} · {new Date(r.createdAt).toLocaleString()}</p>
                    {view && (
                      <p className="mt-1 font-mono text-[11px] text-graphite">
                        {view.document ? `${view.document.pageCount ?? '?'} pages` : ''}{view.quote ? ` · ₹${view.quote.amount}` : ''}
                        {view.privacy.selection ? ` · ${view.privacy.selection.effectiveTrustMode} inference` : ''}
                      </p>
                    )}
                  </div>
                  {!j && <Loader2 className="h-4 w-4 animate-spin text-graphite" />}
                </div>
                {typeof j === 'string' && <p className="mt-3 text-xs text-signal">{j}</p>}
                {view && (
                  <ol className="mt-4 flex items-center" aria-label="Job progress">
                    {STAGES.map((s, i) => {
                      const ok = s.reached(view);
                      return (
                        <li key={s.label} className="flex flex-1 flex-col items-center gap-1">
                          <span className="flex w-full items-center">
                            <span className={`h-px flex-1 ${i === 0 ? 'opacity-0' : ok ? 'bg-ink' : 'bg-light-grey'}`} />
                            <span className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-ink' : 'border border-black/20 bg-white'}`} />
                            <span className={`h-px flex-1 ${i === STAGES.length - 1 ? 'opacity-0' : STAGES[i + 1].reached(view) ? 'bg-ink' : 'bg-light-grey'}`} />
                          </span>
                          <span className={`text-[10px] ${ok ? 'text-ink' : 'text-graphite'}`}>{s.label}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <div className="mt-4 flex gap-2">
                  <Link to={`/app/chat/${encodeURIComponent(r.shopId)}?job=${r.jobId}`} className="btn-primary px-3 py-1.5 text-xs">
                    Open job <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                  <Link to={`/app/jobs/${r.jobId}/agent`} className="btn-ghost px-3 py-1.5 text-xs">
                    <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />Watch the operator
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </CustomerShell>
  );
}
