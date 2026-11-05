import { ArrowUpRight } from 'lucide-react';
import { Chapter, Eyebrow } from '../components/ui';
import { launchInklink } from '../components/LaunchDialog';
import { scrollToSection } from '../lib/chapter';

/** Final commission — the atelier turns ink-black and the last sheet is printed. */
export default function FinalCTA() {
  return (
    <Chapter id="final" label="Get started" screens={1.6} tone="dark" wide>
      <Eyebrow dark>The Inklink commission</Eyebrow>
      <h2 className="mt-6 text-[clamp(2.3rem,5vw,4.5rem)] font-semibold leading-[0.98] tracking-tightest">
        The Next Print Job Starts Here.
      </h2>
      <p className="mt-6 max-w-md text-[15px] leading-relaxed text-paper/70 md:text-lg">
        Connect to a new generation of local, intelligent and autonomous printing infrastructure.
      </p>
      <div className="mt-8 flex flex-wrap gap-3 md:gap-4">
        <button onClick={launchInklink} className="btn-primary">
          Launch Inklink <ArrowUpRight size={18} />
        </button>
        <button onClick={() => scrollToSection('workshop')} className="btn-ghost-dark">
          Explore the Platform
        </button>
      </div>
    </Chapter>
  );
}
