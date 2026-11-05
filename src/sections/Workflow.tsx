import { Chapter, Eyebrow, ProgressRule, Steps } from '../components/ui';
import { scrollToStep, useChapter } from '../lib/chapter';

const SCENES = [
  {
    title: 'Connect',
    body: 'Connect to your selected print shop through its dedicated channel, QR code or local device discovery.',
  },
  {
    title: 'Submit',
    body: 'Upload a document and describe what you need using natural-language instructions.',
  },
  {
    title: 'Understand',
    body: 'Your local assistant handles printing instructions, while 0G Private Computer powers advanced document intelligence when required.',
  },
  {
    title: 'Authorize',
    body: 'Receive a quotation and choose traditional payment or an authorized autonomous payment through Hedera x402.',
  },
  {
    title: 'Execute',
    body: "The shop's local gateway coordinates the device and monitors the physical execution workflow.",
  },
];

/** Five scroll-driven scenes along one continuous print-shop environment. */
export default function Workflow() {
  const { step, progress } = useChapter('workflow', 5);
  return (
    <Chapter id="workflow" label="How it works" screens={5}>
      <Eyebrow>The printing workflow</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        From Instruction to Physical Execution.
      </h2>

      <ol className="mt-7 grid grid-cols-5 gap-1.5 md:mt-9">
        {SCENES.map((s, i) => (
          <li key={s.title}>
            <button
              onClick={() => scrollToStep('workflow', i, 5)}
              aria-current={step === i ? 'step' : undefined}
              className="group w-full text-left"
            >
              <span className={`block h-[3px] transition-colors duration-300 ${i <= step ? 'bg-signal' : 'bg-light-grey group-hover:bg-graphite'}`} />
              <span className={`mt-2 block font-mono text-[11px] ${step === i ? 'text-signal' : 'text-graphite'}`}>0{i + 1}</span>
              <span className={`hidden text-sm font-medium sm:block ${step === i ? 'text-ink' : 'text-graphite'}`}>{s.title}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-7">
        <Steps step={step}>
          {SCENES.map((s, i) => (
            <div key={i}>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-4xl font-semibold text-light-grey md:text-5xl">0{i + 1}</span>
                <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">{s.title}</h3>
              </div>
              <p className="mt-3 text-[15px] leading-relaxed text-ink/75 md:text-base">{s.body}</p>
            </div>
          ))}
        </Steps>
      </div>
      <div className="mt-7">
        <ProgressRule value={progress} />
      </div>
    </Chapter>
  );
}
