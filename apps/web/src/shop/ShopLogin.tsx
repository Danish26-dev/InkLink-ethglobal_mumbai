import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Lock } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Logo } from '../components/Logo';

/** /shop/login — shopkeeper login. The backend validates and sets an HttpOnly session cookie. */
export function ShopLogin() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = safeNext(search.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(search.get('expired') ? 'Your session has expired. Please log in again.' : null);

  // Already logged in: go straight to the dashboard.
  useEffect(() => {
    api.shopAuth.me().then(() => navigate(next, { replace: true }), () => undefined);
  }, [navigate, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.shopAuth.login(email.trim(), password);
      setPassword('');
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <aside className="hidden flex-col justify-between bg-ink p-10 text-paper lg:flex">
        <Logo to="/portal" invert />
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-paper/50">Shopkeeper</p>
          <h1 className="mt-4 max-w-md text-4xl font-semibold leading-tight tracking-tightest">
            Run your print shop with an <span className="text-signal">autonomous operator</span>.
          </h1>
          <p className="mt-4 max-w-sm text-sm text-paper/60">Incoming jobs, the Agent Workspace, printers, payments and shop settings, in one place.</p>
        </div>
        <p className="text-xs text-paper/40">Customers never need an account here. Their identity and payments live in the Inklink app.</p>
      </aside>

      <main className="flex items-center justify-center bg-paper p-6">
        <form onSubmit={submit} className="w-full max-w-sm" aria-labelledby="login-title">
          <Link to="/portal" className="mb-8 inline-flex items-center gap-1.5 text-sm text-graphite hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to the portal
          </Link>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-paper"><Lock className="h-5 w-5" aria-hidden="true" /></div>
          <h2 id="login-title" className="mt-5 text-2xl font-semibold tracking-tight">Shopkeeper login</h2>
          <p className="mt-1 text-sm text-graphite">Sign in to manage your shop.</p>

          <label htmlFor="email" className="label-mono mt-8 block">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-light-grey bg-white px-3 py-2.5 text-sm focus:border-ink focus:outline-none" />
          <label htmlFor="password" className="label-mono mt-4 block">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-light-grey bg-white px-3 py-2.5 text-sm focus:border-ink focus:outline-none" />

          {error && <p className="mt-4 rounded-lg bg-signal/10 p-3 text-sm" role="alert">{error}</p>}

          <button type="submit" className="btn-primary mt-6 w-full py-2.5" disabled={busy || !email || !password}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Log in
          </button>
          <p className="mt-6 text-xs leading-relaxed text-graphite">
            Accounts are created by the shop's administrator on the Inklink backend. There are no default credentials.
            Judges: use the <Link to="/jury" className="text-signal underline">ETHGlobal jury demo</Link>, which needs no account.
          </p>
        </form>
      </main>
    </div>
  );
}

/** Only allow redirects back into the shop area. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/shop') && !raw.startsWith('//') && !raw.startsWith('/shop/login') ? raw : '/shop';
}
