import { useEffect, useState } from 'react';
import Logo from './Logo';

/** Brief, elegant preloader. Resolves quickly so visitors aren't made to wait. */
export default function Preloader({ onDone }: { onDone: () => void }) {
  const [hide, setHide] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setHide(true), 1100);
    const t2 = setTimeout(onDone, 1750);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onDone]);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-paper transition-all duration-700 ease-cinema ${
        hide ? 'pointer-events-none -translate-y-full opacity-0' : 'opacity-100'
      }`}
      aria-hidden={hide}
    >
      <div className="animate-[fadeIn_0.6s_ease]">
        <Logo size={56} showWordmark={false} />
      </div>
      <div className="mt-8 h-px w-40 overflow-hidden bg-light-grey">
        <div className="h-full w-full origin-left animate-[load_1.1s_cubic-bezier(0.16,1,0.3,1)_forwards] bg-signal" />
      </div>
      <span className="mt-5 font-mono text-[11px] uppercase tracking-[0.35em] text-graphite">
        Entering the Atelier
      </span>
      <style>{`
        @keyframes load { from { transform: scaleX(0) } to { transform: scaleX(1) } }
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.9) } to { opacity: 1; transform: none } }
      `}</style>
    </div>
  );
}
