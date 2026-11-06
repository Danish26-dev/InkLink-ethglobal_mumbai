import { Link } from 'react-router-dom';

export function Logo({ to = '/', invert = false }: { to?: string; invert?: boolean }) {
  return (
    <Link to={to} className="flex items-center gap-2" aria-label="Inklink home">
      <img src="/icon.svg" alt="" className="h-6 w-6" />
      <span className={`text-[15px] font-semibold tracking-tightest ${invert ? 'text-paper' : 'text-ink'}`}>Inklink</span>
    </Link>
  );
}
