import { ArrowUpRight, Github } from 'lucide-react';
import { Chapter, Eyebrow } from '../components/ui';
import { scrollToSection } from '../lib/chapter';
import { ui } from '../lib/store';
import { LINKS } from '../lib/config';

const FEATURES = [
  'Self-hostable shop infrastructure',
  'Modular backend architecture',
  'Structured job APIs',
  'Device integration',
  'Open agent interfaces',
  'Blockchain interoperability',
];

/** Developers — open, modular infrastructure. GitHub CTA only if a real URL is configured. */
export default function Developers() {
  return (
    <Chapter id="developers" label="Developers" screens={1.6}>
      <Eyebrow>Built to be open</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        Printing Infrastructure Should Be Open.
      </h2>
      <p className="mt-4 text-[15px] leading-relaxed text-ink/75">
        Inklink is designed around independently operated shop gateways, modular agent interfaces
        and open communication protocols.
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-x-5 gap-y-2">
        {FEATURES.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-ink/85">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-signal" />
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-7 flex flex-wrap gap-3">
        <button
          onClick={() => {
            ui.set({ tech: -1 });
            scrollToSection('technology');
          }}
          className="btn-primary"
        >
          Explore the Developer Architecture <ArrowUpRight size={18} />
        </button>
        {LINKS.github && (
          <a href={LINKS.github} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            <Github size={17} /> GitHub
          </a>
        )}
      </div>
    </Chapter>
  );
}
