import { Chapter, Eyebrow, ProgressRule, Steps, StepTabs } from '../components/ui';
import { scrollToStep, useChapter } from '../lib/chapter';
import { ui } from '../lib/store';

const EXPERIENCES = [
  {
    tab: 'Local Intelligence',
    title: 'Intelligence at the Edge.',
    body: 'A lightweight language model runs directly inside the native application, understanding instructions and coordinating printing workflows without requiring constant cloud connectivity.',
    scene: 'A document enters the phone. The on-device model reads the instruction and structured print operations emerge.',
  },
  {
    tab: 'Private Computation',
    title: 'Your Documents. Your Control.',
    body: 'Use 0G Private Computer for advanced document intelligence with selectable Private, Verified and Standard inference modes.',
    scene: 'The document descends into a layered computation environment. Each layer represents a selectable trust mode.',
  },
  {
    tab: 'Autonomous Payments',
    title: 'Agents That Can Pay.',
    body: 'Enable authorized payment agents to process printing quotations through Hedera x402, with spending limits and verifiable settlement.',
    scene: 'A quotation meets an authorization token. The payment agent links the customer and the merchant.',
  },
];

/** Product introduction — three interactive dioramas, one per capability. */
export default function Workshop() {
  const { step, progress } = useChapter('workshop', 3, (i) => ui.set({ workshop: i }));
  return (
    <Chapter id="workshop" label="Platform" screens={3}>
      <Eyebrow>Introducing Inklink</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        Not Another Printing App. A New Printing Network.
      </h2>
      <p className="mt-4 hidden text-[15px] leading-relaxed text-graphite md:block">
        Inklink connects independent print shops, intelligent software agents and physical devices
        through an open, locally executable infrastructure.
      </p>
      <div className="mt-6">
        <StepTabs items={EXPERIENCES.map((e) => e.tab)} step={step} onPick={(i) => scrollToStep('workshop', i, 3)} />
      </div>
      <div className="mt-6">
        <Steps step={step}>
          {EXPERIENCES.map((e, i) => (
            <div key={i}>
              <span className="font-mono text-xs text-signal">Experience 0{i + 1}</span>
              <h3 className="mt-2 text-2xl font-semibold tracking-tight md:text-[1.7rem]">{e.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink/75">{e.body}</p>
              <p className="mt-4 hidden border-l-2 border-signal pl-3 text-sm text-graphite md:block">{e.scene}</p>
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
