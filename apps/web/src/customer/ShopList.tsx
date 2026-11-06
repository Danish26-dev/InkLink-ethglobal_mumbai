import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, Loader2, Lock, MapPin, Smartphone } from 'lucide-react';
import type { ShopChannel } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { recentJobs } from '../lib/recent';
import { CustomerShell } from './CustomerShell';

/** /app — start printing: pick a nearby shop and open a print session. */
export function ShopList() {
  const navigate = useNavigate();
  const [shops, setShops] = useState<ShopChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = recentJobs()[0];

  useEffect(() => {
    api.shops().then(setShops, (e) => setError(errorMessage(e)));
  }, []);

  return (
    <CustomerShell>
      <main className="mx-auto grid max-w-[1280px] gap-10 px-5 py-10 lg:grid-cols-[1.1fr_1fr] lg:py-16">
        <section>
          <p className="label-mono">Start printing</p>
          <h1 className="mt-4 max-w-xl text-[clamp(2.2rem,4.6vw,3.8rem)] font-semibold leading-[1.02] tracking-tightest">
            Your document, <span className="text-signal">printed right</span> at a shop near you.
          </h1>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-graphite">
            Upload a PDF or Word file, say how you want it printed, and the shop's autonomous print operator sets up the
            printer. You approve the price, pay in the Inklink app and collect your pages.
          </p>
          <ol className="mt-8 grid max-w-lg gap-3 sm:grid-cols-3">
            {[
              [FileText, 'Upload', 'PDF or DOCX, up to 25 MB'],
              [Lock, 'Private by default', 'Sensitive files run in a sealed TEE'],
              [Smartphone, 'Pay in the app', 'No wallet in the browser'],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof FileText;
              return (
                <li key={title as string} className="rounded-xl border border-light-grey bg-white p-4">
                  <I className="h-5 w-5 text-signal" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">{title as string}</p>
                  <p className="mt-0.5 text-xs text-graphite">{text as string}</p>
                </li>
              );
            })}
          </ol>
          {current && (
            <Link to={`/app/chat/${encodeURIComponent(current.shopId)}?job=${current.jobId}`}
              className="mt-8 flex max-w-lg items-center gap-3 rounded-xl bg-ink px-5 py-4 text-paper transition-opacity hover:opacity-90">
              <span className="flex-1">
                <span className="block text-sm font-medium">Continue your current job</span>
                <span className="block font-mono text-[11px] text-paper/60">{current.shopName} · {current.jobId}</span>
              </span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
        </section>

        <section aria-labelledby="shops-heading">
          <div className="rounded-2xl border border-light-grey bg-white p-2">
            <div className="flex items-center gap-2 px-4 pb-2 pt-3">
              <MapPin className="h-4 w-4 text-signal" aria-hidden="true" />
              <h2 id="shops-heading" className="text-sm font-medium">Print shops</h2>
              <span className="ml-auto font-mono text-[11px] text-graphite">{shops ? `${shops.length} available` : ''}</span>
            </div>
            {error && <p className="m-3 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}
            {!shops && !error && <p className="flex items-center gap-2 p-4 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Finding shops…</p>}
            <ul className="space-y-2 p-2">
              {shops?.map((s) => (
                <li key={s.shopId}>
                  <button type="button" disabled={!s.acceptingOrders} onClick={() => navigate(`/app/chat/${encodeURIComponent(s.shopId)}`)}
                    className="group flex w-full items-center gap-4 rounded-xl border border-light-grey p-4 text-left transition-all hover:border-ink hover:shadow-[0_12px_30px_-18px_rgba(17,17,17,0.5)] disabled:opacity-60">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-paper font-semibold">{s.name.slice(0, 1)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{s.name}</span>
                      <span className="block truncate text-sm text-graphite">{s.description || 'Local print shop'}</span>
                      <span className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        <span className={`rounded-full px-2 py-0.5 ${s.acceptingOrders ? 'bg-emerald-50 text-emerald-800' : 'bg-signal/10 text-ink'}`}>
                          {s.acceptingOrders ? 'Open now' : 'Not accepting orders'}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 ${s.agentAvailable ? 'bg-paper text-ink' : 'bg-light-grey text-graphite'}`}>
                          Print operator {s.agentAvailable ? 'online' : 'unavailable'}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-sm font-medium text-signal opacity-0 transition-opacity group-hover:opacity-100 group-disabled:hidden">
                      Start <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-4 px-2 text-xs text-graphite">
            No login needed. <Link to="/shop" className="underline hover:text-ink">Run a print shop?</Link> ·{' '}
            <Link to="/demo" className="underline hover:text-ink">Judge walkthrough</Link>
          </p>
        </section>
      </main>
    </CustomerShell>
  );
}
