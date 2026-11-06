import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { ArrowRight, FileText, Gavel, Smartphone, Store } from 'lucide-react';
import { Logo } from '../components/Logo';

/** Deep link that opens the native Inklink (Expo) app; its scheme is `inklink` (apps/mobile/app.json). */
const APP_LINK = 'inklink://';

/** /portal — the application entry: Customer, Shopkeeper, ETHGlobal Jury. */
export function Portal() {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(APP_LINK, { margin: 1, width: 132, color: { dark: '#111111', light: '#FFFFFF' } }).then(setQr, () => setQr(null));
  }, []);

  return (
    <div className="min-h-full bg-paper">
      <header className="mx-auto flex h-16 max-w-[1240px] items-center px-6">
        <Logo to="/portal" />
        <a href="/" className="ml-auto text-sm text-graphite hover:text-ink">About Inklink</a>
      </header>

      <main className="mx-auto max-w-[1240px] px-6 pb-16 pt-6">
        <p className="label-mono">Inklink portal</p>
        <h1 className="mt-3 max-w-3xl text-[clamp(2rem,4.2vw,3.4rem)] font-semibold leading-[1.04] tracking-tightest">
          How would you like to use <span className="text-signal">Inklink</span>?
        </h1>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {/* Customer: paper card, document-first */}
          <section className="flex flex-col rounded-3xl border border-light-grey bg-white p-7" aria-labelledby="customer-title">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-paper text-signal"><FileText className="h-6 w-6" aria-hidden="true" /></span>
            <p className="label-mono mt-6">Customer</p>
            <h2 id="customer-title" className="mt-2 text-2xl font-semibold tracking-tight">Print a document</h2>
            <p className="mt-2 text-sm leading-relaxed text-graphite">Print documents through your nearby Inklink-enabled print shop.</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-ink/80">
              <li>· No account, no wallet in the browser</li>
              <li>· Sensitive files run in a private TEE</li>
              <li>· Payment is approved in the Inklink app</li>
            </ul>
            <div className="mt-auto pt-6">
              <Link to="/app" className="btn-primary w-full py-3">Continue as Customer <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
              <div className="mt-4 flex items-center gap-3 rounded-2xl bg-paper p-3">
                {qr && <img src={qr} alt="Code that opens the Inklink app" className="h-16 w-16 rounded-md" />}
                <div className="text-xs">
                  <p className="font-medium">Have the Inklink app?</p>
                  <p className="text-graphite">Your account and payments live there.</p>
                  <a href={APP_LINK} className="mt-1 inline-flex items-center gap-1 text-signal underline"><Smartphone className="h-3.5 w-3.5" aria-hidden="true" />Open the app</a>
                </div>
              </div>
            </div>
          </section>

          {/* Shopkeeper: ink card, operational */}
          <section className="flex flex-col rounded-3xl bg-ink p-7 text-paper" aria-labelledby="shop-title">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-paper"><Store className="h-6 w-6" aria-hidden="true" /></span>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-paper/50">Shopkeeper</p>
            <h2 id="shop-title" className="mt-2 text-2xl font-semibold tracking-tight">Run your print shop</h2>
            <p className="mt-2 text-sm leading-relaxed text-paper/60">Manage your print shop, incoming jobs, autonomous agents and printing infrastructure.</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-paper/80">
              <li>· Incoming orders and approvals</li>
              <li>· Agent Workspace on a real printer</li>
              <li>· Hardware and Hedera payments</li>
            </ul>
            <div className="mt-auto pt-6">
              <Link to="/shop/login" className="btn w-full bg-paper py-3 text-ink hover:bg-white">Shopkeeper Login <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
            </div>
          </section>

          {/* Jury: signal card, guided */}
          <section className="flex flex-col rounded-3xl bg-signal p-7 text-white" aria-labelledby="jury-title">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20"><Gavel className="h-6 w-6" aria-hidden="true" /></span>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-white/70">ETHGlobal jury</p>
            <h2 id="jury-title" className="mt-2 text-2xl font-semibold tracking-tight">Explore Inklink end to end</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/85">Explore Inklink through an interactive, end-to-end product demonstration.</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-white/90">
              <li>· Upload your own PDF, follow one real job</li>
              <li>· Customer, shop and agent perspectives</li>
              <li>· Live vs simulated always labelled</li>
            </ul>
            <div className="mt-auto pt-6">
              <Link to="/jury" className="btn w-full bg-ink py-3 text-paper hover:bg-black">Explore Inklink <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
