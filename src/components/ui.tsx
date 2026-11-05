import { ReactNode } from 'react';

export function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px w-8 bg-signal" />
      <span className={`eyebrow ${dark ? '!text-paper/60' : ''}`}>{children}</span>
    </div>
  );
}

export function StatHint({ label, dark = false }: { label: string; dark?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 text-sm ${dark ? 'text-paper/80' : 'text-ink/80'}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal" />
      {label}
    </div>
  );
}

/**
 * A scroll chapter: a tall section whose viewport sticks while the 3D camera
 * performs the chapter's story. Text sits in a panel (left on desktop, bottom
 * on mobile) over a soft scrim; the rest of the screen belongs to the atelier.
 */
export function Chapter({
  id,
  label,
  screens,
  tone = 'light',
  children,
  aside,
  wide = false,
}: {
  id: string;
  label: string;
  screens: number;
  tone?: 'light' | 'dark';
  children: ReactNode;
  aside?: ReactNode;
  wide?: boolean;
}) {
  const dark = tone === 'dark';
  return (
    <section
      id={id}
      aria-label={label}
      className="pointer-events-none relative"
      style={{ height: `${screens * 100}vh` }}
    >
      <div className="sticky top-0 h-[100vh] w-full overflow-hidden">
        {/* desktop scrim (left) */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 hidden w-[62%] md:block"
          style={{
            background: dark
              ? 'linear-gradient(90deg, rgba(17,17,17,0.94) 0%, rgba(17,17,17,0.78) 55%, rgba(17,17,17,0) 100%)'
              : 'linear-gradient(90deg, rgba(250,250,247,0.96) 0%, rgba(250,250,247,0.82) 55%, rgba(250,250,247,0) 100%)',
          }}
        />
        {/* mobile scrim (bottom) */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[72%] md:hidden"
          style={{
            background: dark
              ? 'linear-gradient(0deg, rgba(17,17,17,0.97) 0%, rgba(17,17,17,0.92) 62%, rgba(17,17,17,0) 100%)'
              : 'linear-gradient(0deg, rgba(250,250,247,0.98) 0%, rgba(250,250,247,0.93) 62%, rgba(250,250,247,0) 100%)',
          }}
        />
        <div className="section-shell relative flex h-full items-end pb-7 pt-20 md:items-center md:pb-0 md:pt-16">
          <div
            className={`pointer-events-auto w-full ${
              wide ? 'md:max-w-[560px] lg:max-w-[640px]' : 'md:max-w-[480px] lg:max-w-[540px]'
            } ${
              dark ? 'text-paper' : 'text-ink'
            }`}
          >
            {children}
          </div>
        </div>
        {aside}
      </div>
    </section>
  );
}

/** Stacks variants in one grid cell so switching steps never shifts layout. */
export function Steps({ step, children }: { step: number; children: ReactNode[] }) {
  return (
    <div className="grid">
      {children.map((c, i) => (
        <div
          key={i}
          aria-hidden={i !== step}
          className={`[grid-area:1/1] transition-all duration-700 ease-cinema ${
            i === step ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
          }`}
        >
          {c}
        </div>
      ))}
    </div>
  );
}

/** Numbered step selector shared by the scroll chapters. */
export function StepTabs({
  items,
  step,
  onPick,
  dark = false,
}: {
  items: string[];
  step: number;
  onPick: (i: number) => void;
  dark?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist">
      {items.map((t, i) => (
        <button
          key={t}
          role="tab"
          aria-selected={step === i}
          onClick={() => onPick(i)}
          className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors duration-300 ${
            step === i
              ? 'border-signal bg-signal text-paper'
              : dark
                ? 'border-paper/20 text-paper/70 hover:border-paper/60'
                : 'border-ink/15 text-ink/70 hover:border-ink/50'
          }`}
        >
          <span className="mr-1.5 font-mono">{String(i + 1).padStart(2, '0')}</span>
          {t}
        </button>
      ))}
    </div>
  );
}

/** Thin progress rule. */
export function ProgressRule({ value }: { value: number }) {
  return (
    <div className="h-px w-full bg-light-grey">
      <div className="h-px bg-signal transition-[width] duration-200" style={{ width: `${value * 100}%` }} />
    </div>
  );
}
