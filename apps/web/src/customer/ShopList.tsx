import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Loader2, Printer, Store } from 'lucide-react';
import type { ShopChannel } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { recentJobs, rememberJob } from '../lib/recent';
import { Logo } from '../components/Logo';

/** Customer home: pick a print shop. No login, no wallet. */
export function ShopList() {
  const navigate = useNavigate();
  const [shops, setShops] = useState<ShopChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const recent = recentJobs();

  useEffect(() => {
    api.shops().then(setShops, (e) => setError(errorMessage(e)));
  }, []);

  const open = async (shop: ShopChannel) => {
    setOpening(shop.shopId);
    setError(null);
    try {
      const job = await api.createJob(shop.shopId);
      rememberJob({ jobId: job.jobId, shopId: shop.shopId, shopName: shop.name, createdAt: job.createdAt });
      navigate(`/chat/${job.jobId}`);
    } catch (e) {
      setError(errorMessage(e));
      setOpening(null);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo />
        <span className="label-mono">No login needed</span>
      </header>

      <main className="flex-1 px-5 pb-10">
        <h1 className="mt-4 text-3xl font-semibold tracking-tightest">Print nearby.</h1>
        <p className="mt-2 text-graphite">Pick a shop, send your document and tell the print operator what you need.</p>

        {error && <p className="mt-4 rounded-md bg-signal/10 p-3 text-sm" role="alert">{error}</p>}

        <h2 className="label-mono mb-3 mt-8">Shops</h2>
        {!shops && !error && <p className="flex items-center gap-2 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Loading shops…</p>}
        <ul className="space-y-3">
          {shops?.map((s) => (
            <li key={s.shopId}>
              <button type="button" onClick={() => open(s)} disabled={!s.acceptingOrders || opening !== null}
                className="card flex w-full items-center gap-4 p-4 text-left transition-colors hover:border-ink disabled:opacity-60">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-paper"><Store className="h-5 w-5" aria-hidden="true" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block truncate text-sm text-graphite">{s.description || 'Local print shop'}</span>
                  <span className="mt-1 flex gap-3 font-mono text-[11px]">
                    <span className={s.acceptingOrders ? 'text-emerald-700' : 'text-signal'}>{s.acceptingOrders ? 'Open' : 'Not accepting orders'}</span>
                    <span className={s.agentAvailable ? 'text-emerald-700' : 'text-graphite'}>Operator {s.agentAvailable ? 'online' : 'unavailable'}</span>
                  </span>
                </span>
                {opening === s.shopId ? <Loader2 className="h-5 w-5 animate-spin text-graphite" /> : <ChevronRight className="h-5 w-5 text-graphite" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>

        {recent.length > 0 && (
          <>
            <h2 className="label-mono mb-3 mt-8">Your orders in this tab</h2>
            <ul className="space-y-2">
              {recent.map((j) => (
                <li key={j.jobId}>
                  <button type="button" onClick={() => navigate(`/chat/${j.jobId}`)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-light-grey/60">
                    <Printer className="h-4 w-4 text-graphite" aria-hidden="true" />
                    <span className="text-sm">{j.shopName}</span>
                    <span className="ml-auto font-mono text-[11px] text-graphite">{j.jobId}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>

      <footer className="px-5 pb-6 text-xs text-graphite">
        Payment is completed in the Inklink app. This page never asks for a wallet or card.
      </footer>
    </div>
  );
}
