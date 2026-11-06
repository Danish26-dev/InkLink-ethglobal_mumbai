import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { Bot, Inbox, LayoutGrid, Loader2, LogOut, MonitorPlay, Printer, QrCode, Settings, Wallet } from 'lucide-react';
import type { ShopOverview } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { Logo } from '../components/Logo';
import { useShopSession } from './useShopSession';

export interface ShopContext {
  overview: ShopOverview | null;
  reload: () => Promise<void>;
}

export const useShop = () => useOutletContext<ShopContext>();

const NAV = [
  { to: '/shop', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/shop/jobs', label: 'Incoming orders', icon: Inbox },
  { to: '/shop/agent', label: 'Agent Workspace', icon: MonitorPlay },
  { to: '/shop/hardware', label: 'Hardware', icon: Printer },
  { to: '/shop/payments', label: 'Payments', icon: Wallet },
  { to: '/shop/settings', label: 'Shop configuration', icon: Settings },
  { to: '/shop/pairing', label: 'Pair Inklink app', icon: QrCode },
];

/** Shopkeeper dashboard shell: dark sidebar with availability, agent and printer status. */
export function ShopLayout() {
  const { session, handleAuthError, switchShop, logout } = useShopSession();
  const [overview, setOverview] = useState<ShopOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const reload = useCallback(async () => {
    try {
      setOverview(await api.shop.overview());
      setError(null);
    } catch (e) {
      if (!handleAuthError(e)) setError(errorMessage(e));
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (!session) return;
    void reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [session, reload]);

  if (!session) {
    return <div className="flex h-full items-center justify-center bg-ink text-paper/60"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking your session…</div>;
  }

  const onSwitch = async (shopId: string) => {
    try {
      await switchShop(shopId);
      setOverview(null);
      await reload();
    } catch (e) {
      if (!handleAuthError(e)) setError(errorMessage(e));
    }
  };

  const toggle = async () => {
    if (!overview) return;
    setToggling(true);
    try {
      await api.shop.setAvailability(!overview.acceptingOrders);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setToggling(false);
    }
  };

  const onlinePrinters = overview?.printerAdapter.printers.filter((p) => p.status === 'online').length ?? 0;

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col bg-ink text-paper" aria-label="Shop navigation">
        <div className="px-5 py-5"><Logo to="/shop" invert /></div>
        <div className="px-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper/50">Shop</p>
          {session.shops.length > 1 ? (
            <>
              <label htmlFor="shop-select" className="sr-only">Select shop</label>
              <select id="shop-select" value={session.activeShopId ?? ''} onChange={(e) => onSwitch(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-sm font-medium text-paper focus:outline-none">
                {session.shops.map((s) => <option key={s.shopId} value={s.shopId} className="text-ink">{s.name}</option>)}
              </select>
            </>
          ) : (
            <p className="mt-1 truncate font-medium">{overview?.name ?? session.shops[0]?.name ?? '…'}</p>
          )}
        </div>

        <div className="mx-3 mt-5 space-y-1 rounded-lg bg-white/5 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span id="avail-label">Accepting orders</span>
            <button type="button" role="switch" aria-checked={overview?.acceptingOrders ?? false} aria-labelledby="avail-label"
              onClick={toggle} disabled={!overview || toggling}
              className={`relative h-6 w-11 rounded-full transition-colors ${overview?.acceptingOrders ? 'bg-signal' : 'bg-white/20'}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${overview?.acceptingOrders ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
          <StatusLine icon={Bot} label="Agent" ok={overview?.agent.available}
            text={overview ? (overview.agent.available ? (overview.agent.provider === '0g-private-computer' ? '0G' : overview.agent.provider) : 'unavailable') : '…'} />
          {overview && (
            <div className="flex items-center gap-1 pt-1.5 text-[10px]" aria-label="0G keys configured">
              <span className="text-paper/60">0G keys</span>
              <span className="ml-auto flex gap-1">
                {(['standard', 'verified', 'private'] as const).map((m) => (
                  <span key={m} className={`rounded px-1.5 py-0.5 font-mono ${overview.agent.zeroG.modes[m].configured ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-paper/40 line-through'}`}>
                    {m.slice(0, 3)}
                  </span>
                ))}
              </span>
            </div>
          )}
          <StatusLine icon={Printer} label="Printer" ok={overview ? overview.printerAdapter.reachable && onlinePrinters > 0 : undefined}
            text={overview ? (overview.printerAdapter.reachable ? `${onlinePrinters} online` : 'adapter offline') : '…'} />
        </div>

        <nav className="mt-5 flex-1 space-y-0.5 px-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isActive ? 'bg-white/10 text-paper' : 'text-paper/65 hover:bg-white/5 hover:text-paper'}`}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
              {to === '/shop/jobs' && overview && overview.stats.awaitingApproval > 0 && (
                <span className="ml-auto rounded-full bg-signal px-1.5 font-mono text-[10px]">{overview.stats.awaitingApproval}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mx-3 flex gap-3 px-3 text-[11px] text-paper/50">
          <a href="/" className="hover:text-paper">Inklink website</a>
          <NavLink to="/app" className="hover:text-paper">Customer app</NavLink>
          <NavLink to="/demo" className="hover:text-paper">Demo</NavLink>
        </div>
        <div className="m-3 flex items-center gap-2 rounded-md bg-white/5 px-3 py-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-paper text-xs font-semibold text-ink">
            {(session.account.name || session.account.email).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-paper">{session.account.name}</span>
            <span className="block truncate text-[10px] text-paper/50">{session.account.email}</span>
          </span>
          <button type="button" onClick={logout} className="rounded-md p-1.5 text-paper/60 hover:bg-white/10 hover:text-paper" aria-label="Log out" title="Log out">
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {error && <p className="bg-signal/10 px-8 py-2 text-sm" role="alert">{error}</p>}
        <Outlet context={{ overview, reload } satisfies ShopContext} />
      </main>
    </div>
  );
}

function StatusLine({ icon: Icon, label, ok, text }: { icon: typeof Bot; label: string; ok: boolean | undefined; text: string }) {
  return (
    <div className="flex items-center gap-2 pt-1.5 text-xs">
      <Icon className="h-3.5 w-3.5 text-paper/60" aria-hidden="true" />
      <span className="text-paper/60">{label}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${ok === undefined ? 'bg-white/30' : ok ? 'bg-emerald-400' : 'bg-signal'}`} />
        <span className="max-w-[110px] truncate">{text}</span>
      </span>
    </div>
  );
}
