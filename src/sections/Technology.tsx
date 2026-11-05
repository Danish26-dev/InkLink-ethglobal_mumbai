import { Smartphone, ShieldCheck, Cpu, Coins, FileCheck2, ArrowLeft, MousePointer2 } from 'lucide-react';
import { Chapter, Eyebrow } from '../components/ui';
import { ui, useUI } from '../lib/store';

const MODULES = [
  { icon: Smartphone, name: 'On-Device Intelligence', tech: 'Local SLM', status: 'Designed around', desc: 'Understands user intent and coordinates printing instructions directly on the native application.' },
  { icon: ShieldCheck, name: 'Private AI Computation', tech: '0G Private Computer', status: 'Integration in progress', desc: 'Provides remote document intelligence with selectable trust modes.' },
  { icon: Cpu, name: 'Physical Execution', tech: 'ESP32-S3 + Local Gateway', status: 'Designed around', desc: 'Coordinates sensors, device states and physical execution.' },
  { icon: Coins, name: 'Autonomous Payments', tech: 'Hedera x402', status: 'Integration in progress', desc: 'Enables autonomous agent payments with controlled spending authorization.' },
  { icon: FileCheck2, name: 'Verifiable Records', tech: '0G Storage + 0G Galileo + Hedera HCS', status: 'Powered by', desc: 'Supports execution records, job references and payment auditability.' },
];

/** Interactive infrastructure: select a module (here or in 3D) to focus the camera on it. */
export default function Technology() {
  const { tech } = useUI();
  const m = tech >= 0 ? MODULES[tech] : null;
  return (
    <Chapter id="technology" label="Technology" screens={1.8}>
      <Eyebrow>Under the hood</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        One Network. Multiple Intelligence Layers.
      </h2>

      <ul className="mt-6 flex gap-1.5 overflow-x-auto pb-1 md:flex-col md:overflow-visible">
        {MODULES.map((mod, i) => (
          <li key={mod.name} className="shrink-0">
            <button
              onClick={() => ui.set({ tech: tech === i ? -1 : i })}
              aria-pressed={tech === i}
              className={`flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors duration-300 md:py-2.5 ${
                tech === i ? 'border-ink bg-ink text-paper' : 'border-light-grey bg-paper/70 hover:border-ink/40'
              }`}
            >
              <mod.icon size={16} className={tech === i ? 'text-signal' : 'text-graphite'} />
              <span className="whitespace-nowrap text-sm font-medium">{mod.name}</span>
              <span className={`ml-auto hidden font-mono text-[11px] md:inline ${tech === i ? 'text-paper/50' : 'text-graphite'}`}>0{i + 1}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-5 min-h-[128px]">
        {m ? (
          <div key={m.name}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-ink">{m.tech}</span>
              <span className="border border-ink/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-graphite">{m.status}</span>
            </div>
            <p className="mt-2 text-[15px] leading-relaxed text-ink/75">{m.desc}</p>
            <button
              onClick={() => ui.set({ tech: -1 })}
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-ink underline-offset-4 hover:underline"
            >
              <ArrowLeft size={15} /> Return to full architecture
            </button>
          </div>
        ) : (
          <p className="flex items-start gap-2.5 text-sm leading-relaxed text-graphite">
            <MousePointer2 size={15} className="mt-0.5 shrink-0 text-signal" />
            Select a module, here or directly in the scene, to focus the camera and reveal its
            connections. Components are at different stages; none are presented as production
            deployments.
          </p>
        )}
      </div>
    </Chapter>
  );
}
