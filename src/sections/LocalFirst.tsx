import { WifiOff, Bluetooth, Cpu, Workflow as WorkflowIcon, Radio, HardDrive } from 'lucide-react';
import { Chapter, Eyebrow, ProgressRule, Steps } from '../components/ui';
import { useChapter } from '../lib/chapter';

const FEATURES = [
  { icon: Radio, label: 'Direct local connectivity' },
  { icon: Bluetooth, label: 'Bluetooth device discovery' },
  { icon: WifiOff, label: 'Local Wi-Fi document transfer' },
  { icon: Cpu, label: 'On-device SLM' },
  { icon: WorkflowIcon, label: 'Local job orchestration' },
  { icon: HardDrive, label: 'Independent device execution' },
];

const ACCURACY = [
  { mode: 'Local printing', detail: 'Works without internet when the shop’s local infrastructure is available.', tone: 'bg-signal' },
  { mode: 'Remote 0G inference', detail: 'Requires connectivity.', tone: 'bg-graphite/50' },
  { mode: 'Hedera settlement', detail: 'Requires connectivity.', tone: 'bg-graphite/50' },
  { mode: 'OfflinePay', detail: 'Signed offline authorization with deferred settlement, subject to merchant acceptance.', tone: 'bg-signal/50' },
];

/** Local-first infrastructure: the camera tracks the chain phone → gateway → ESP32 → printer. */
export default function LocalFirst() {
  const { step, progress } = useChapter('local', 2);
  return (
    <Chapter id="local" label="Local-first infrastructure" screens={2.6}>
      <Eyebrow>Built to work locally</Eyebrow>
      <h2 className="mt-5 text-[clamp(1.8rem,3.6vw,3rem)] font-semibold leading-[1.02] tracking-tightest">
        Your Printing Shouldn’t Depend on the Cloud.
      </h2>
      <div className="mt-6">
        <Steps step={step}>
          <div>
            <p className="text-[15px] leading-relaxed text-ink/75">
              Inklink is designed so basic printing can operate independently of centralized
              infrastructure. Connect locally, transfer documents and coordinate printing jobs
              directly with a shop’s local gateway.
            </p>
            <ul className="mt-6 hidden grid-cols-2 gap-x-6 gap-y-3 sm:grid">
              {FEATURES.map((f) => (
                <li key={f.label} className="flex items-center gap-3 text-sm text-ink/85">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-light-grey bg-paper text-signal">
                    <f.icon size={15} />
                  </span>
                  {f.label}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="bg-ink px-5 py-4 text-lg font-semibold leading-snug text-paper">
              Even when cloud services are unavailable, basic local printing can continue.
            </p>
            <ul className="mt-4 divide-y divide-light-grey border-y border-light-grey bg-paper/70">
              {ACCURACY.map((a) => (
                <li key={a.mode} className="flex items-start gap-3 py-2.5">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.tone}`} />
                  <p className="text-sm leading-snug">
                    <span className="font-medium text-ink">{a.mode}.</span>{' '}
                    <span className="text-graphite">{a.detail}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </Steps>
      </div>
      <div className="mt-6">
        <ProgressRule value={progress} />
      </div>
    </Chapter>
  );
}
