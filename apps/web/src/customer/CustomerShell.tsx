import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ArrowLeftRight } from 'lucide-react';
import { Logo } from '../components/Logo';
import { recentJobs } from '../lib/recent';

/**
 * Customer frame: a quiet top bar with the four destinations a customer needs.
 * No account, no wallet: the native Inklink app handles payment.
 */
export function CustomerShell({ shop, children }: { shop?: { id: string; name: string } | null; children: ReactNode }) {
  const navigate = useNavigate();
  const current = recentJobs()[0];
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1.5 text-[13px] transition-colors ${isActive ? 'bg-ink text-paper' : 'text-ink/70 hover:bg-light-grey hover:text-ink'}`;

  return (
    <div className="flex min-h-full flex-col bg-paper">
      <header className="sticky top-0 z-30 border-b border-light-grey bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-5">
          <Logo />
          <nav aria-label="Customer" className="ml-2 hidden items-center gap-1 md:flex">
            <NavLink to="/app" end className={link}>Start printing</NavLink>
            {current && (
              <NavLink to={`/app/chat/${encodeURIComponent(current.shopId)}?job=${current.jobId}`} className={() => link({ isActive: false })}>
                My current job
              </NavLink>
            )}
            <NavLink to="/app/jobs" className={link}>Recent jobs</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {shop && (
              <button type="button" onClick={() => navigate('/app')}
                className="flex items-center gap-2 rounded-full border border-light-grey bg-white px-3 py-1.5 text-[13px] hover:border-ink"
                title="Select another shop">
                <span className="h-2 w-2 rounded-full bg-signal" aria-hidden="true" />
                <span className="max-w-[160px] truncate">{shop.name}</span>
                <ArrowLeftRight className="h-3.5 w-3.5 text-graphite" aria-hidden="true" />
                <span className="sr-only">Select another shop</span>
              </button>
            )}
            <a href="/" className="hidden text-[13px] text-graphite hover:text-ink sm:block">About Inklink</a>
          </div>
        </div>
        {/* Compact nav for phones */}
        <nav aria-label="Customer (mobile)" className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          <NavLink to="/app" end className={link}>Start</NavLink>
          {current && <NavLink to={`/app/chat/${encodeURIComponent(current.shopId)}?job=${current.jobId}`} className={() => link({ isActive: false })}>Current job</NavLink>}
          <NavLink to="/app/jobs" className={link}>Recent</NavLink>
        </nav>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
