import { useEffect, useRef, useState } from 'react';
import { X, ArrowRight } from 'lucide-react';
import { LINKS, openLink } from '../lib/config';

const EVT = 'inklink:launch';

/** Launch Inklink: lets the visitor choose the customer app, shop dashboard or demo. */
export function launchInklink() {
  window.dispatchEvent(new Event(EVT));
}

/** Open the customer app directly (no login, no wallet). */
export function openCustomerApp() {
  openLink(LINKS.app);
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

  const go = (url: string) => {
    setOpen(false);
    openLink(url);
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
          Where would you like to start?
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-graphite">
          No account and no wallet needed. Payment is completed in the Inklink mobile app.
        </p>
        <div className="mt-7 flex flex-col gap-2">
          {[
            [LINKS.app, 'Print a document', 'Pick a nearby shop and chat with its print operator'],
            [LINKS.shop, 'Run a print shop', 'Orders, printers, payments and shop settings'],
            [LINKS.agent, 'Watch the Agent Workspace', 'The autonomous operator configuring a real printer'],
            [LINKS.demo, 'Judge walkthrough', 'Guided demo with live system checks'],
          ].map(([url, label, hint]) => (
            <button
              key={label}
              onClick={() => go(url)}
              className="flex items-center justify-between gap-4 rounded-xl border border-light-grey px-4 py-3 text-left transition-colors hover:border-ink"
            >
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-graphite">{hint}</span>
              </span>
              <ArrowRight size={16} className="shrink-0 text-signal" />
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
