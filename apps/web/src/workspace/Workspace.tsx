import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw, TriangleAlert } from 'lucide-react';
import type { JobView } from '@inklink/shared-schemas';
import { api, errorMessage, type AuthKind } from '../lib/api';
import { foldEvents } from '../lib/operatorState';
import { usePlayback } from '../lib/usePlayback';
import { useJobEvents } from '../lib/useJobEvents';
import { useReducedMotion } from '../lib/useReducedMotion';
import { Logo } from '../components/Logo';
import { OperatorCursor } from './OperatorCursor';
import { PrinterDialog } from './PrinterDialog';
import { AgentPanel, ConfigPanel, EventStream } from './Panels';
import { useVisual } from './visual';

const REFRESH_ON = new Set(['job_status_updated', 'approval_required', 'document_processed', 'agent_finished', 'payment_status_updated', 'execution_authorized']);

/**
 * Agent Workspace: watch the print operator configure the real printer.
 * The cursor, menus and values are driven only by backend tool events.
 */
export function Workspace({ auth, jobId: forcedJobId, headerExtra }: { auth: AuthKind; jobId?: string; headerExtra?: ReactNode }) {
  const params = useParams<{ jobId: string }>();
  const jobId = forcedJobId ?? params.jobId;
  const reducedMotion = useReducedMotion();
  const { events, state: stream } = useJobEvents(jobId, auth);
  const playback = usePlayback(events, true);
  const state = useMemo(() => foldEvents(playback.playedEvents), [playback.playedEvents]);
  const visual = useVisual(playback.current, reducedMotion);
  const stageRef = useRef<HTMLDivElement>(null);

  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ available: boolean | null; reason: string | null }>({ available: null, reason: null });

  // Job snapshot (document info, approvals) — refreshed when the stream reports a change.
  const lastRaw = events[events.length - 1];
  useEffect(() => {
    if (!jobId) return;
    if (lastRaw && !REFRESH_ON.has(lastRaw.type)) return;
    api.job(jobId, auth).then(setJob, (e) => setError(errorMessage(e)));
  }, [jobId, auth, lastRaw?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (auth === 'shop') {
      api.shop.overview().then(
        (o) => setAgent({ available: o.agent.available, reason: o.agent.reason }),
        () => setAgent({ available: null, reason: null }),
      );
    } else {
      api.shops().then(
        (s) => setAgent({ available: s[0]?.agentAvailable ?? false, reason: s[0]?.agentAvailable ? null : 'The print operator is not configured or not reachable right now.' }),
        () => setAgent({ available: null, reason: null }),
      );
    }
  }, [auth, state.run?.outcome]);

  const back = auth === 'shop' ? '/shop/jobs' : job ? `/app/chat/${job.shopId}?job=${jobId}` : '/app/jobs';
  const unavailable = state.run?.outcome === 'unavailable';

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="flex items-center gap-4 border-b border-light-grey bg-white px-5 py-3">
        <Link to={back} className="btn-ghost px-2.5 py-1.5" aria-label="Back"><ArrowLeft className="h-4 w-4" /></Link>
        <Logo to={auth === 'shop' ? '/shop' : '/app'} />
        <div className="h-5 w-px bg-light-grey" />
        <h1 className="text-sm font-medium">Agent Workspace</h1>
        {headerExtra ?? <span className="font-mono text-[11px] text-graphite">{jobId}</span>}
        <div className="ml-auto flex items-center gap-3">
          {playback.backlog > 0 && <span className="font-mono text-[11px] text-graphite">{playback.backlog} queued</span>}
          {playback.replaying && (
            <span className="rounded bg-signal/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink">Replay of recorded events</span>
          )}
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={playback.restart}
            disabled={events.length === 0 || playback.replaying} title="Replays this job's recorded backend events; nothing is re-executed">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Replay run
          </button>
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-graphite" role="status">
            <span className={`h-2 w-2 rounded-full ${stream === 'live' ? 'bg-emerald-500' : stream === 'reconnecting' ? 'pulse-dot bg-signal' : 'bg-graphite'}`} />
            {stream}
          </span>
        </div>
      </header>

      {error && <p className="bg-signal/10 px-5 py-2 text-sm" role="alert">{error}</p>}

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_190px] lg:grid-cols-[272px_minmax(0,1fr)_292px]">
        <div className="hidden min-h-0 lg:flex"><AgentPanel state={state} job={job} agentAvailable={agent.available} agentReason={agent.reason} /></div>

        {/* The "desktop" the agent works on. */}
        <main ref={stageRef} aria-label="Printer settings operated by the agent"
          className="relative flex min-h-0 flex-col items-center overflow-auto bg-[radial-gradient(circle_at_30%_20%,#E9E9E5,#D8D8D3)] p-6 [&>*:first-child]:mt-auto [&>*:last-child]:mb-auto">
          {unavailable && (
            <div className="mb-4 flex w-full max-w-[1040px] items-start gap-3 rounded-lg border border-signal/40 bg-[#FBE9E4] p-3 text-sm" role="alert">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
              <div>
                <p className="font-medium">Print operator did not run. No printer settings were changed and the document was not sent to any model.</p>
                <p className="text-graphite">{state.run?.finishMessage}</p>
              </div>
            </div>
          )}
          <PrinterDialog state={state} visual={visual} document={job?.document ?? null} />
          <OperatorCursor containerRef={stageRef} visual={visual} active={Boolean(state.run?.active)} />
        </main>

        <div className="hidden min-h-0 lg:flex"><ConfigPanel state={state} job={job} /></div>

        <div className="min-h-0 lg:col-span-3"><EventStream events={events} played={playback.played} /></div>
      </div>
    </div>
  );
}
