import { AlertTriangle } from 'lucide-react';
import { Chapter, Eyebrow, Steps } from '../components/ui';
import { scrollToStep, useChapter } from '../lib/chapter';
import { ui } from '../lib/store';

const STAGES = [
  {
    tag: 'Stage 01 · Offline authorization',
    steps: [
      'Customer connects locally.',
      'Shop generates quotation.',
      'Customer agent creates signed payment authorization.',
      'Shop verifies the authorization.',
      'Job can proceed under the shop’s offline-risk policy.',
    ],
  },
  {
    tag: 'Stage 02 · On-chain settlement',
    steps: [
      'Connectivity returns.',
      'Payment Agent initiates x402 payment.',
      'Hedera facilitator verifies and settles.',
      'Transaction is recorded.',
    ],
  },
];

/** OfflinePay — two environments joined by a camera move; authorization ≠ settlement. */
export default function OfflinePay() {
  const { step } = useChapter('offlinepay', 2, (i) => ui.set({ pay: i === 1 ? 'online' : 'offline' }));
  return (
    <Chapter id="offlinepay" label="OfflinePay" screens={2.6}>
      <Eyebrow>A new payment experience</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        Authorize Locally. Settle When Connected.
      </h2>
      <p className="mt-4 hidden text-[15px] leading-relaxed text-graphite md:block">
        Inklink explores offline payment authorization that allows customers and shops to coordinate
        a printing job locally, with actual Hedera settlement initiated when connectivity returns.
      </p>

      <div className="mt-6 inline-flex rounded-full border border-light-grey bg-paper p-1" role="tablist">
        {['Offline', 'On-chain'].map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={step === i}
            onClick={() => scrollToStep('offlinepay', i, 2)}
            className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
              step === i ? (i === 0 ? 'bg-ink text-paper' : 'bg-signal text-paper') : 'text-graphite hover:text-ink'
            }`}
          >
            0{i + 1} · {t}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <Steps step={step}>
          {STAGES.map((s, k) => (
            <div
              key={k}
              className={`p-5 ${k === 0 ? 'border border-dashed border-ink/30 bg-paper' : 'bg-ink text-paper'}`}
            >
              <span className={`font-mono text-[11px] uppercase tracking-[0.2em] ${k === 0 ? 'text-graphite' : 'text-signal'}`}>
                {s.tag}
              </span>
              <ol className="mt-3 space-y-1.5">
                {s.steps.map((t, i) => (
                  <li key={i} className="flex gap-3 text-sm leading-snug">
                    <span className={`font-mono ${k === 0 ? 'text-graphite' : 'text-paper/50'}`}>{i + 1}</span>
                    <span className={k === 0 ? 'text-ink/85' : 'text-paper/90'}>{t}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </Steps>
      </div>

      <p className="mt-4 flex items-start gap-2.5 text-xs leading-relaxed text-ink/70">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-signal" />
        Offline authorization is not completed blockchain settlement. Deferred payment remains
        subject to merchant risk policies.
      </p>
    </Chapter>
  );
}
