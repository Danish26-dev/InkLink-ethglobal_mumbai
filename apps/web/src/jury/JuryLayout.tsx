import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Copy, Gavel, Loader2, LogOut, RotateCcw } from 'lucide-react';
import type { JobView, OperatorEvent } from '@inklink/shared-schemas';
import { api, errorMessage, jury, type Integration, type JurySession } from '../lib/api';
import { useJobEvents } from '../lib/useJobEvents';
import { Logo } from '../components/Logo';

export const STAGES = [
  { path: '/jury', label: 'Introduction', end: true },
  { path: '/jury/customer', label: 'Customer' },
  { path: '/jury/processing', label: 'Live processing' },
  { path: '/jury/shop', label: 'Print shop' },
  { path: '/jury/agent', label: 'Agent Workspace' },
  { path: '/jury/payment', label: 'Payment' },
  { path: '/jury/execution', label: 'Execution' },
  { path: '/jury/result', label: 'Result' },
];

interface JuryCtx {
  session: JurySession;
  jobId: string | null;
  setJobId: (id: string | null) => void;
  job: JobView | null;
  refreshJob: () => Promise<void>;
  events: OperatorEvent[];
  integrations: Integration[] | null;
}

const Ctx = createContext<JuryCtx | null>(null);
export const useJury = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useJury outside JuryLayout');
  return c;
};

/**
 * The ETHGlobal jury demo shell. All pages inside reuse the real customer
 * session, shop dashboard and Agent Workspace; the API client switches to the
 * jury session, which the backend confines to the isolated demo shop.
 */
export function JuryLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  // Activate jury mode synchronously so the very first child request uses the jury session.
  const [session, setSession] = useState<JurySession | null>(() => {
    jury.activate();
    return jury.session();
  });
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);

  useEffect(() => {
    if (session) return;
    api.jury.createSession().then((s) => { jury.enter(s); setSession(s); }, (e) => setError(errorMessage(e)));
  }, [session]);

  useEffect(() => {
    jury.activate();
    return () => jury.exit();
  }, []);

  useEffect(() => {
    if (!session) return;
    api.jury.state().then((s) => setJobId((cur) => cur ?? s.currentJobId), (e) => setError(errorMessage(e)));
    api.jury.status().then((s) => setIntegrations(s.integrations), () => setIntegrations([]));
  }, [session]);

  const { events } = useJobEvents(jobId ?? undefined, 'web');

  const refreshJob = useCallback(async () => {
    if (!jobId) return setJob(null);
    try {
      setJob(await api.job(jobId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [jobId]);

  const lastSeq = events[events.length - 1]?.seq;
  useEffect(() => {
    void refreshJob();
  }, [refreshJob, lastSeq]);

  const value = useMemo(() => (session ? { session, jobId, setJobId, job, refreshJob, events, integrations } : null),
    [session, jobId, job, refreshJob, events, integrations]);

  const reset = async () => {
    if (!window.confirm('Reset the jury demo? This deletes only your demo jobs in the demo shop.')) return;
    try {
      await api.jury.reset();
      setJobId(null);
      setJob(null);
      navigate('/jury/customer');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const exit = () => {
    jury.exit();
    navigate('/portal');
  };

  if (!value) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
        {error ? (
          <>
            <p className="text-sm text-signal" role="alert">The jury demo could not start: {error}</p>
            <button type="button" className="btn-primary" onClick={() => { setError(null); setSession(null); }}>Try again</button>
          </>
        ) : <p className="flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Preparing your isolated demo…</p>}
      </div>
    );
  }

  const onAgent = location.pathname.startsWith('/jury/agent');
  return (
    <Ctx.Provider value={value}>
      <div className="flex h-full flex-col bg-paper">
        <header className="border-b border-black/10 bg-ink text-paper">
          <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
            <Logo to="/portal" invert />
            <span className="flex items-center gap-1.5 rounded-full bg-signal px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-white">
              <Gavel className="h-3 w-3" aria-hidden="true" />ETHGlobal jury demo
            </span>
            <JobChip jobId={jobId} />
            <nav aria-label="Perspective" className="ml-auto flex rounded-full bg-white/10 p-0.5 text-xs">
              {[['/jury/customer', 'Customer'], ['/jury/shop', 'Shop'], ['/jury/agent', 'Agent']].map(([to, label]) => (
                <NavLink key={to} to={to} className={({ isActive }) => `rounded-full px-3 py-1 ${isActive ? 'bg-paper text-ink' : 'text-paper/70 hover:text-paper'}`}>{label}</NavLink>
              ))}
            </nav>
            <button type="button" onClick={reset} className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-paper/70 hover:bg-white/10 hover:text-paper">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Reset demo
            </button>
            <button type="button" onClick={exit} className="flex items-center gap-1.5 rounded-md border border-white/20 px-2.5 py-1.5 text-xs hover:bg-white/10">
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />Exit Jury Demo
            </button>
          </div>
          <nav aria-label="Demo stages" className="flex gap-1 overflow-x-auto px-5 pb-2">
            {STAGES.map((s, i) => (
              <NavLink key={s.path} to={s.path} end={s.end}
                className={({ isActive }) => `flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1 text-xs ${isActive ? 'bg-white/15 text-paper' : 'text-paper/55 hover:text-paper'}`}>
                <span className="font-mono text-[10px] text-paper/40">{i + 1}</span>{s.label}
              </NavLink>
            ))}
          </nav>
        </header>
        {error && <p className="bg-signal/10 px-5 py-2 text-sm" role="alert">{error}</p>}
        <div className={`min-h-0 flex-1 ${onAgent ? 'flex flex-col' : 'overflow-y-auto'}`}><Outlet /></div>
      </div>
    </Ctx.Provider>
  );
}

function JobChip({ jobId }: { jobId: string | null }) {
  if (!jobId) return <span className="font-mono text-[11px] text-paper/50">No demo job yet</span>;
  return (
    <button type="button" onClick={() => navigator.clipboard?.writeText(jobId)} title="Copy the demo job reference"
      className="flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 font-mono text-[11px] text-paper/80 hover:bg-white/15">
      Demo job {jobId}<Copy className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

/** Small reusable label so every live / simulated / unavailable state reads the same everywhere. */
export function ModeBadge({ mode }: { mode: 'live' | 'real' | 'simulated' | 'unavailable' | 'not_configured' | 'configured' | string }) {
  const tone =
    mode === 'live' || mode === 'real' || mode === 'online' ? 'bg-emerald-100 text-emerald-800'
      : mode === 'simulated' ? 'bg-signal text-white'
        : mode === 'configured' || mode === 'configured_unverified' ? 'bg-ink text-paper'
          : 'bg-light-grey text-ink/70';
  const text = mode === 'real' ? 'live' : mode.replace(/_/g, ' ');
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}>{text}</span>;
}
