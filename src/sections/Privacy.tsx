import { Chapter, Eyebrow, ProgressRule, Steps, StepTabs } from '../components/ui';
import { scrollToStep, useChapter } from '../lib/chapter';
import { ui } from '../lib/store';

const ITEMS = [
  { title: 'Local Processing', body: 'Basic document and printing workflows can run through independently operated local infrastructure.' },
  { title: 'Selectable AI Trust', body: 'Choose Private, Verified or Standard inference modes when using 0G Private Computer.' },
  { title: 'Controlled Payments', body: 'Agents operate within explicit spending limits and merchant authorization policies.' },
  { title: 'Minimal On-Chain Data', body: 'Document contents and sensitive personal information should never be published to public blockchain records.' },
];

/** Privacy & security — a spatial diagram of controlled information flows. */
export default function Privacy() {
  const { step, progress } = useChapter('privacy', 4, (i) => ui.set({ privacy: i }));
  return (
    <Chapter id="privacy" label="Privacy and security" screens={3.6}>
      <Eyebrow>Built with control in mind</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        Your Documents Aren’t Our Product.
      </h2>
      <p className="mt-4 hidden text-[15px] leading-relaxed text-graphite md:block">
        Inklink is designed around local processing, controlled remote computation and minimal data
        exposure.
      </p>
      <div className="mt-6">
        <StepTabs items={ITEMS.map((i) => i.title)} step={step} onPick={(i) => scrollToStep('privacy', i, 4)} />
      </div>
      <div className="mt-6">
        <Steps step={step}>
          {ITEMS.map((it, i) => (
            <div key={i}>
              <h3 className="text-2xl font-semibold tracking-tight">{it.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink/75">{it.body}</p>
            </div>
          ))}
        </Steps>
      </div>
      <div className="mt-6">
        <ProgressRule value={progress} />
      </div>
    </Chapter>
  );
}
