import Logo from '../components/Logo';
import { scrollToSection } from '../lib/chapter';
import { LINKS } from '../lib/config';

type L = { label: string; section?: string; href?: string };

const COLUMNS: { title: string; links: L[] }[] = [
  {
    title: 'Platform',
    links: [
      { label: 'Overview', section: 'workshop' },
      { label: 'How It Works', section: 'workflow' },
      { label: 'Local Mode', section: 'local' },
      { label: 'Document Intelligence', section: 'workshop' },
      { label: 'Payments', section: 'offlinepay' },
    ],
  },
  {
    title: 'Infrastructure',
    links: [
      { label: '0G Private Computer', section: 'technology' },
      { label: 'Hedera', section: 'technology' },
      { label: 'Physical AI', section: 'local' },
      { label: 'Developer Resources', section: 'developers' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: 'Discord', href: LINKS.discord },
      { label: 'Contact', href: LINKS.contact ? `mailto:${LINKS.contact}` : '' },
    ],
  },
];

/** Footer. In-page links scroll; external ones render only when configured. */
export default function Footer() {
  return (
    <footer className="relative z-10 bg-ink pb-10 pt-20 text-paper" aria-label="Footer">
      <div className="section-shell">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <Logo dark />
            <p className="mt-6 text-sm font-medium text-paper/80">Your Document. Your Agent. Your Control.</p>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-paper/55">
              A decentralized printing network connecting customers with independent print shops
              through intelligent agents, privacy-preserving computation and autonomous payments.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:col-span-7">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="eyebrow !text-paper/50">{col.title}</h3>
                <ul className="mt-5 space-y-3">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      {l.section ? (
                        <button onClick={() => scrollToSection(l.section!)} className="text-sm text-paper/75 transition-colors hover:text-paper">
                          {l.label}
                        </button>
                      ) : l.href ? (
                        <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-sm text-paper/75 transition-colors hover:text-paper">
                          {l.label}
                        </a>
                      ) : (
                        <span className="text-sm text-paper/35">
                          {l.label} <span className="font-mono text-[10px] uppercase tracking-wider">· soon</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-paper/10 pt-7 text-sm text-paper/50 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} INKLINK. In active development.</span>
          <div className="flex gap-6">
            {['Privacy', 'Terms', 'Status'].map((t) => (
              <span key={t} className="text-paper/40">
                {t} <span className="font-mono text-[10px] uppercase tracking-wider">· soon</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
