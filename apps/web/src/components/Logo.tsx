import { Link } from 'react-router-dom';

/** PWA assets live under the Vite base (/pwa/). */
export const ICON = `${import.meta.env.BASE_URL}icon.svg`;

export function Logo({ to = '/app', invert = false }: { to?: string; invert?: boolean }) {
  return (
    <Link to={to} className="flex items-center gap-2" aria-label="Inklink home">
      <img src={ICON} alt="" className="h-6 w-6" />
      <span className={`text-[15px] font-semibold tracking-tightest ${invert ? 'text-paper' : 'text-ink'}`}>Inklink</span>
    </Link>
  );
}
