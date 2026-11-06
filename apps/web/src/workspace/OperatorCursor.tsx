import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Visual } from './visual';

interface Props {
  containerRef: RefObject<HTMLElement>;
  visual: Visual;
  active: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The print operator's pointer. It only travels to the `data-cursor` element
 * named by the current real event, outlines that target, and shows a short
 * factual caption. With no event it rests in the corner.
 */
export function OperatorCursor({ containerRef, visual, active }: Props) {
  const { cursorKey, clickTick, caption } = visual;
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [target, setTarget] = useState<Box | null>(null);
  const [clicking, setClicking] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = container.getBoundingClientRect();
        const el = cursorKey ? container.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(cursorKey)}"]`) : null;
        if (el) {
          const r = el.getBoundingClientRect();
          const x = r.left - box.left + container.scrollLeft;
          const y = r.top - box.top + container.scrollTop;
          setTarget({ x, y, w: r.width, h: r.height });
          setPos({ x: x + Math.min(r.width * 0.4, 70), y: y + r.height * 0.6 });
        } else {
          setTarget(null);
          setPos({ x: container.scrollLeft + box.width - 140, y: container.scrollTop + box.height - 70 });
        }
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // Menus and tabs render a frame after the key changes; measure again once they exist.
    const t1 = setTimeout(measure, 60);
    const t2 = setTimeout(measure, 200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
    };
  }, [containerRef, cursorKey, visual.tab, visual.menu]);

  useLayoutEffect(() => {
    if (!clickTick) return;
    setClicking(false);
    const raf = requestAnimationFrame(() => setClicking(true));
    const t = setTimeout(() => setClicking(false), 420);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [clickTick]);

  const tone =
    caption?.tone === 'ok' ? 'bg-emerald-600' : caption?.tone === 'error' ? 'bg-signal' : caption?.tone === 'pending' ? 'bg-ink/80' : 'bg-ink';

  return (
    <>
      {/* Current target outline */}
      {target && (
        <div aria-hidden="true" className="operator-target pointer-events-none absolute left-0 top-0 z-30 rounded-md border-2 border-signal/70"
          style={{ transform: `translate(${target.x - 4}px, ${target.y - 4}px)`, width: target.w + 8, height: target.h + 8 }} />
      )}
      <div aria-hidden="true"
        className={`operator-cursor pointer-events-none absolute left-0 top-0 z-50 ${clicking ? 'clicking' : ''} ${active ? 'opacity-100' : 'opacity-70'}`}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
        <span className="cursor-ring absolute -left-3 -top-3 h-6 w-6 rounded-full border-2 border-signal opacity-0" />
        <svg width="24" height="28" viewBox="0 0 22 26" className="drop-shadow-[0_3px_4px_rgba(0,0,0,0.35)]">
          <path d="M1.5 1.5 L1.5 20 L6.5 15.5 L10 23.5 L13.5 22 L10 14 L17 14 Z" fill="#111111" stroke="#FAFAF7" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <div className="absolute left-6 top-7 flex w-[280px] flex-col items-start gap-1">
          <span className="rounded bg-signal px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-white">Strands agent</span>
          {caption && (
            <span className={`rounded-md px-2 py-1 text-[11px] leading-snug text-white shadow-lg ${tone}`}>{caption.text}</span>
          )}
        </div>
      </div>
      {/* Screen readers get the same caption as a live status. */}
      <p className="sr-only" role="status" aria-live="polite">{caption?.text ?? ''}</p>
    </>
  );
}
