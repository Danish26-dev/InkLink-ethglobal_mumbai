import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, MonitorPlay } from 'lucide-react';
import type { JobView } from '@inklink/shared-schemas';
import { api, ApiError, errorMessage } from '../lib/api';
import { Workspace } from '../workspace/Workspace';
import { Logo } from '../components/Logo';

/**
 * /shop/agent[/:jobId] — the autonomous Agent Workspace for the shopkeeper.
 * Without a job id it opens the most relevant order (a running one first).
 */
export function ShopAgentPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<{ text: string; auth: boolean } | null>(null);

  useEffect(() => {
    const load = () =>
      api.shop.jobs().then(setJobs, (e) =>
        setError({ text: errorMessage(e), auth: e instanceof ApiError && (e.status === 401 || e.status === 403) }),
      );
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  if (error && !jobs) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Logo to="/shop" />
        <p className="text-sm text-signal" role="alert">{error.text}</p>
        {error.auth && <Link to="/shop" className="btn-primary">Unlock the shop dashboard</Link>}
      </div>
    );
  }
  if (!jobs) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-graphite" /></div>;

  const chosen = jobId ?? (jobs.find((j) => j.runActive) ?? jobs[0])?.jobId;
  if (!chosen) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Logo to="/shop" />
        <MonitorPlay className="h-8 w-8 text-graphite" aria-hidden="true" />
        <p className="text-sm text-graphite">No orders yet. The Agent Workspace opens once a customer sends a document.</p>
        <Link to="/app" className="btn-ghost">Open the customer app</Link>
      </div>
    );
  }

  const picker = (
    <label className="flex items-center gap-2 text-xs">
      <span className="sr-only">Order</span>
      <select value={chosen} onChange={(e) => navigate(`/shop/agent/${e.target.value}`)}
        className="rounded-md border border-light-grey bg-white px-2 py-1 font-mono text-[11px]">
        {jobs.map((j) => (
          <option key={j.jobId} value={j.jobId}>
            {j.jobId} · {j.document?.filename ?? 'no document'} · {j.status.replace(/_/g, ' ')}{j.runActive ? ' · running' : ''}
          </option>
        ))}
      </select>
    </label>
  );

  return <Workspace key={chosen} auth="shop" jobId={chosen} headerExtra={picker} />;
}
