import { useEffect, useState } from 'react';
import { Menu, X, ArrowUpRight } from 'lucide-react';
import Logo from './Logo';
import { launchInklink } from './LaunchDialog';
import { scrollToSection } from '../lib/chapter';

const NAV_LINKS = [
  { id: 'workshop', label: 'Platform', match: ['workshop'] },
  { id: 'workflow', label: 'How It Works', match: ['workflow'] },
  { id: 'local', label: 'Infrastructure', match: ['local', 'offlinepay'] },
  { id: 'technology', label: 'Technology', match: ['technology', 'privacy'] },
  { id: 'developers', label: 'Developers', match: ['developers'] },
];

/** Minimal sticky navigation that stays subordinate to the 3D scene. */
export default function Navigation({ activeId, scrolled }: { activeId: string; scrolled: boolean }) {
  const [open, setOpen] = useState(false);
  const dark = activeId === 'final';

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (id: string) => {
    setOpen(false);
    scrollToSection(id);
  };

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-500 ${
        scrolled
          ? dark
            ? 'border-b border-paper/10 bg-ink/80 backdrop-blur-md'
            : 'border-b border-light-grey bg-paper/80 backdrop-blur-md'
          : 'bg-transparent'
      }`}
    >
      <nav aria-label="Primary" className="mx-auto flex h-16 max-w-content items-center justify-between px-6 md:px-10 lg:px-16">
        <Logo dark={dark} />

        <ul className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((l) => {
            const on = l.match.includes(activeId);
            return (
              <li key={l.id}>
                <button
                  onClick={() => go(l.id)}
                  aria-current={on ? 'true' : undefined}
                  className={`relative text-sm transition-colors duration-200 ${
                    on ? (dark ? 'text-paper' : 'text-ink') : dark ? 'text-paper/60 hover:text-paper' : 'text-graphite hover:text-ink'
                  }`}
                >
                  {l.label}
                  <span className={`absolute -bottom-1.5 left-0 h-px bg-signal transition-all duration-300 ${on ? 'w-full' : 'w-0'}`} />
                </button>
              </li>
            );
          })}
        </ul>

        <div className="hidden items-center gap-4 md:flex">
          <button
            onClick={() => go('workflow')}
            className={`text-sm font-medium transition-colors ${dark ? 'text-paper/80 hover:text-paper' : 'text-ink/80 hover:text-ink'}`}
          >
            Explore App
          </button>
          <button onClick={launchInklink} className="btn-primary !px-5 !py-2.5">
            Launch Inklink <ArrowUpRight size={16} />
          </button>
        </div>

        <button
          className={`flex h-10 w-10 items-center justify-center rounded-full border md:hidden ${
            dark ? 'border-paper/20 text-paper' : 'border-light-grey bg-paper/80 text-ink'
          }`}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="fixed inset-0 top-16 z-40 overflow-y-auto bg-paper px-6 pb-10 pt-6 md:hidden">
          <ul className="flex flex-col">
            {NAV_LINKS.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => go(l.id)}
                  className={`w-full border-b border-light-grey py-4 text-left text-2xl font-medium ${
                    l.match.includes(activeId) ? 'text-signal' : 'text-ink'
                  }`}
                >
                  {l.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-col gap-3">
            <button onClick={() => go('workflow')} className="btn-secondary w-full">
              Explore App
            </button>
            <button
              onClick={() => {
                setOpen(false);
                launchInklink();
              }}
              className="btn-primary w-full"
            >
              Launch Inklink <ArrowUpRight size={16} />
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
