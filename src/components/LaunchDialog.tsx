import { useEffect, useRef, useState } from 'react';
import { X, ArrowRight } from 'lucide-react';
import { LINKS } from '../lib/config';
import { scrollToSection } from '../lib/chapter';

const EVT = 'inklink:launch';

/** Launch Inklink: opens the configured app, or explains its development status. */
export function launchInklink() {
  if (LINKS.app) {
    window.open(LINKS.app, '_blank', 'noopener,noreferrer');
    return;
  }
  window.dispatchEvent(new Event(EVT));
}

export default function LaunchDialog() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const go = (id: string) => {
    setOpen(false);
    setTimeout(() => scrollToSection(id), 50);
  };

  return (
    <dialog
      ref={ref}
      onClose={() => setOpen(false)}
      onClick={(e) => e.target === ref.current && setOpen(false)}
      aria-labelledby="launch-title"
      className="w-[min(92vw,520px)] rounded-2xl border border-light-grey bg-paper p-0 text-ink backdrop:bg-ink/60"
    >
      <div className="p-8">
        <div className="flex items-start justify-between gap-6">
          <span className="eyebrow">Launch Inklink</span>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="-mr-2 -mt-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-light-grey"
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="launch-title" className="mt-4 text-2xl font-semibold tracking-tight">
          Inklink is in active development.
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-graphite">
          The native app, shop gateway and payment integrations are being built and are not yet
          publicly available. Explore how the network is designed to work in the meantime.
        </p>
        <div className="mt-7 flex flex-col gap-2">
          {[
            ['workflow', 'See the printing workflow'],
            ['local', 'How local-first printing works'],
            ['technology', 'Explore the technology'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => go(id)}
              className="flex items-center justify-between rounded-xl border border-light-grey px-4 py-3 text-left text-sm font-medium transition-colors hover:border-ink"
            >
              {label}
              <ArrowRight size={16} className="text-signal" />
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
