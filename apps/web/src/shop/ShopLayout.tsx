import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { Bot, Inbox, LayoutGrid, Loader2, LogOut, MonitorPlay, Printer, QrCode, Settings, Wallet } from 'lucide-react';
import type { ShopOverview } from '@inklink/shared-schemas';
import { api, ApiError, errorMessage, shopToken } from '../lib/api';
import { Logo } from '../components/Logo';

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
  // On the shop computer the backend allows tokenless access; elsewhere the
  // first request fails with 401/403 and the token form appears.
  const [authed, setAuthed] = useState(true);
  const [overview, setOverview] = useState<ShopOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const reload = useCallback(async () => {
    try {
      setOverview(await api.shop.overview());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.code === 'UNAUTHORIZED')) {
        shopToken.clear();
        setAuthed(false);
      }
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [authed, reload]);

  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;

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
          <p className="mt-1 truncate font-medium">{overview?.name ?? '…'}</p>
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

        {shopToken.get() ? (
          <button type="button" className="m-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-paper/60 hover:bg-white/5"
            onClick={() => { shopToken.clear(); setAuthed(false); setOverview(null); }}>
            <LogOut className="h-4 w-4" aria-hidden="true" />Lock dashboard
          </button>
        ) : (
          <p className="m-3 px-3 py-2 text-[11px] text-paper/45">Open on this shop computer. Other devices need the shop admin token.</p>
        )}
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

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    shopToken.set(value.trim());
    try {
      await api.shop.overview();
      onDone();
    } catch (err) {
      shopToken.clear();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center bg-ink p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-paper p-6">
        <Logo to="/shop" />
        <h1 className="mt-6 text-xl font-semibold">Shop dashboard</h1>
        <p className="mt-1 text-sm text-graphite">Enter the shop admin token configured on this shop's backend.</p>
        <label htmlFor="shop-token" className="label-mono mt-5 block">Admin token</label>
        <input id="shop-token" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded-md border border-light-grey bg-white px-3 py-2 text-sm focus:border-ink focus:outline-none" />
        {error && <p className="mt-2 text-sm text-signal" role="alert">{error}</p>}
        <button type="submit" className="btn-primary mt-4 w-full" disabled={!value.trim() || busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Open dashboard
        </button>
      </form>
    </div>
  );
}
