import { ArrowUpRight, ArrowDown, MousePointer2 } from 'lucide-react';
import { Chapter, Eyebrow, StatHint } from '../components/ui';
import { launchInklink } from '../components/LaunchDialog';
import { scrollToSection } from '../lib/chapter';

/** Cinematic opening: typography over the live 3D printer reveal. */
export default function Hero() {
  return (
    <Chapter
      id="hero"
      label="Introduction"
      screens={1.5}
      wide
      aside={
        <>
          <div className="pointer-events-none absolute bottom-8 right-10 hidden items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-graphite lg:flex">
            <MousePointer2 size={13} className="text-signal" />
            Hover the printer to inspect it
          </div>
          <button
            onClick={() => scrollToSection('workshop')}
            className="pointer-events-auto absolute bottom-7 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-graphite transition-colors hover:text-ink md:flex"
            aria-label="Scroll to explore"
          >
            <span className="eyebrow">Scroll to explore</span>
            <ArrowDown size={16} />
          </button>
        </>
      }
    >
      <div className="hero-anim hidden md:block">
        <Eyebrow>Decentralized agentic printing network</Eyebrow>
      </div>
      <h1 className="hero-anim mt-5 text-[clamp(2.3rem,5.2vw,4.7rem)] font-semibold leading-[0.98] tracking-tightest md:mt-6">
        Printing, Reimagined for an <span className="text-signal">Autonomous World.</span>
      </h1>
      <p className="hero-anim mt-5 max-w-[34rem] text-[15px] leading-relaxed text-graphite md:mt-7 md:text-lg">
        Connect documents, intelligent agents, autonomous payments and physical printing
        infrastructure in one open network. Process locally, edit intelligently and execute
        wherever you print.
      </p>
      <div className="hero-anim mt-6 flex flex-wrap items-center gap-3 md:mt-9 md:gap-4">
        <button onClick={launchInklink} className="btn-primary">
          Launch Inklink <ArrowUpRight size={18} />
        </button>
        <button onClick={() => scrollToSection('technology')} className="btn-secondary">
          Explore the Technology
        </button>
      </div>
      <div className="hero-anim mt-6 hidden flex-wrap gap-x-6 gap-y-2 sm:flex md:mt-10">
        <StatHint label="Local-first printing" />
        <StatHint label="Private AI intelligence" />
        <StatHint label="Autonomous payments" />
      </div>
    </Chapter>
  );
}
