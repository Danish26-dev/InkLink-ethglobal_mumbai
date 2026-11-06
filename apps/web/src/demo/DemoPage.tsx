import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Circle, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ShopOverview, TrustMode } from '@inklink/shared-schemas';
import { api, errorMessage } from '../lib/api';
import { Logo } from '../components/Logo';

type Check = { label: string; state: 'ok' | 'warn' | 'fail' | 'pending'; detail: string };

const MODES: TrustMode[] = ['standard', 'verified', 'private'];

/** /demo — ETHGlobal judge walkthrough with live checks of the running stack. */
export function DemoPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    const out: Check[] = [];
    let health: Awaited<ReturnType<typeof api.health>> | null = null;
    try {
      health = await api.health();
      out.push({ label: 'Inklink backend (FastAPI)', state: 'ok', detail: 'Reachable at /api (port 8000).' });
    } catch (e) {
      out.push({ label: 'Inklink backend (FastAPI)', state: 'fail', detail: errorMessage(e) });
    }
    if (health) {
      const configured = MODES.filter((m) => health!.zeroG.modes[m]);
      out.push({
        label: '0G Private Computer keys',
        state: configured.length === 3 ? 'ok' : configured.length ? 'warn' : 'fail',
        detail: `${MODES.map((m) => `${m}: ${health!.zeroG.modes[m] ? 'configured' : 'missing'}`).join(' · ')} · default ${health.zeroG.defaultTrustMode}`,
      });
      out.push({
        label: 'Hedera x402 payments',
        state: health.paymentsConfigured ? 'ok' : 'warn',
        detail: health.paymentsConfigured ? 'Configured on the backend.' : 'Not configured: quotes work, payment cannot complete.',
      });
    }
    let overview: ShopOverview | null = null;
    try {
      overview = await api.shop.overview();
    } catch {
      overview = null;
    }
    if (overview) {
      out.push({
        label: 'Print operator (Strands agent)',
        state: overview.agent.available ? 'ok' : 'fail',
        detail: overview.agent.available ? `${overview.agent.provider} · inference brokered by the backend` : overview.agent.reason ?? 'Unavailable',
      });
      const online = overview.printerAdapter.printers.filter((p) => p.status === 'online').length;
      out.push({
        label: 'Local printer adapter',
        state: overview.printerAdapter.reachable ? (online ? 'ok' : 'warn') : 'fail',
        detail: overview.printerAdapter.reachable ? `${overview.printerAdapter.printers.length} printer(s), ${online} online` : overview.printerAdapter.error ?? 'Not reachable',
      });
    } else {
      out.push({ label: 'Shop status', state: 'warn', detail: 'Open this page on the shop computer to see agent and printer status.' });
    }
    setChecks(out);
    setBusy(false);
  }, []);

  useEffect(() => void run(), [run]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="flex items-center gap-4">
        <Logo />
        <span className="label-mono">ETHGlobal judge walkthrough</span>
        <a href="/" className="ml-auto text-sm text-graphite underline">Landing page</a>
      </header>

      <h1 className="mt-8 text-4xl font-semibold tracking-tightest">Inklink in three minutes.</h1>
      <p className="mt-2 max-w-2xl text-graphite">
        A customer sends a document from a browser with no login and no wallet. An autonomous print operator configures a real
        printer, with inference on 0G Private Computer at the trust level the document requires. Payment is authorized in the
        native app over Hedera x402, and nothing prints until every approval is in place.
      </p>

      <section className="mt-8">
        <div className="mb-3 flex items-center">
          <h2 className="label-mono">Live system check</h2>
          <button type="button" className="btn-ghost ml-auto px-2.5 py-1 text-xs" onClick={run} disabled={busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />Re-check
          </button>
        </div>
        <ul className="card divide-y divide-light-grey">
          {checks.length === 0 && <li className="flex items-center gap-2 p-4 text-sm text-graphite"><Loader2 className="h-4 w-4 animate-spin" />Checking…</li>}
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-3 p-4 text-sm">
              {c.state === 'ok' ? <Check className="h-4 w-4 text-emerald-600" aria-label="OK" /> : c.state === 'pending'
                ? <Circle className="h-4 w-4 text-graphite" /> : <TriangleAlert className={`h-4 w-4 ${c.state === 'fail' ? 'text-signal' : 'text-amber-600'}`} aria-label={c.state} />}
              <div>
                <p className="font-medium">{c.label}</p>
                <p className="text-xs text-graphite">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="label-mono mb-3">Walkthrough</h2>
        <ol className="space-y-3">
          {[
            ['Customer, no login', 'Pick the shop. An anonymous session is created; no account, no wallet.', '/app'],
            ['Upload and instruct', 'Attach a PDF and send "2 copies, black and white, A4, double-sided". The document is classified on the backend first; sensitive or unreadable documents run Private.', '/app'],
            ['Agent Workspace', 'Watch the operator click through the printer dialog. Every cursor move is a real tool event; the left panel shows the 0G trust mode and TEE verification.', '/shop/agent'],
            ['Review and price', 'Edited copies need your approval, the original is never changed. Get a price from the real page count.', '/app/jobs'],
            ['Pay in the native app', 'Approve the quote: a single-use deep link / QR hands payment to the Inklink app (Hedera x402).', '/app/jobs'],
            ['Shop approves', 'Incoming orders show every gate. Printing starts only when all of them are satisfied.', '/shop/jobs'],
          ].map(([title, text, to], i) => (
            <li key={title} className="card flex items-start gap-4 p-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink font-mono text-xs text-paper">{i + 1}</span>
              <div className="flex-1">
                <p className="font-medium">{title}</p>
                <p className="text-sm text-graphite">{text}</p>
              </div>
              <Link to={to} className="btn-ghost px-2.5 py-1.5 text-xs">Open <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="label-mono mb-3">Trust-mode policy</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ['Standard', 'Non-sensitive, public documents and general print instructions. Any 0G provider; no attestation.'],
            ['Verified', 'Provable execution (TeeML or TeeTLS). The upstream provider may still see plaintext, so it is not used for sensitive documents.'],
            ['Private', 'Personal, financial, identity or confidential content, any unclassifiable document, or when the customer asks. TeeML only, sealed in a TEE.'],
          ].map(([t, d]) => (
            <div key={t} className="card p-4"><p className="font-medium">{t}</p><p className="mt-1 text-xs text-graphite">{d}</p></div>
          ))}
        </div>
        <p className="mt-3 text-xs text-graphite">
          The effective mode is the strictest of the document policy, the customer's choice and the shop minimum. If no provider
          qualifies, the run fails clearly; Inklink never retries with a weaker mode or another key.
        </p>
      </section>

      <section className="mt-10 pb-10">
        <h2 className="label-mono mb-3">Repeatable scenarios</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-light-grey">
              {[
                ['Sensitive document', 'Upload a PDF/DOCX containing a PAN, bank account or "Confidential"', 'Classified sensitive; the run uses Private, even if Auto/Standard was chosen'],
                ['Public document', 'Upload a timetable or notice', 'Standard, unless the customer picks Verified or Private'],
                ['Private key missing', 'Leave ZERO_G_PRIVATE_API_KEY empty, upload a sensitive file', 'The run does not start; nothing is sent to 0G or the agent'],
                ['Offline printer', 'Ask for a printer that is offline', 'check_printer_readiness fails; the printer is not selected'],
                ['Change after validation', 'Send "make it 3 copies"', 'Validation is cleared and re-run; the earlier quote is withdrawn'],
                ['Shop paused', 'Toggle Accepting orders off in /shop', 'New orders are refused with SHOP_UNAVAILABLE'],
              ].map(([n, how, exp]) => (
                <tr key={n}><td className="px-4 py-3 font-medium">{n}</td><td className="px-4 py-3 text-graphite">{how}</td><td className="px-4 py-3">{exp}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
