import { useLayoutEffect, useState, type RefObject } from 'react';

interface Props {
  containerRef: RefObject<HTMLElement>;
  cursorKey: string | null;
  clickTick: number;
  active: boolean;
}

/**
 * The print operator's pointer. It only travels to the `data-cursor` element
 * named by the current real event; with no event it parks in the corner.
 */
export function OperatorCursor({ containerRef, cursorKey, clickTick, active }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [clicking, setClicking] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = container.getBoundingClientRect();
        const el = cursorKey
          ? container.querySelector<HTMLElement>(`[data-cursor="${CSS.escape(cursorKey)}"]`)
          : null;
        if (el) {
          const r = el.getBoundingClientRect();
          setPos({
            x: r.left - box.left + container.scrollLeft + Math.min(r.width * 0.35, 56),
            y: r.top - box.top + container.scrollTop + r.height * 0.55,
          });
        } else {
          setPos({ x: container.scrollLeft + box.width - 110, y: container.scrollTop + box.height - 56 });
        }
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // Menus render a frame after the key changes; measure again once they exist.
    const t = setTimeout(measure, 60);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      ro.disconnect();
    };
  }, [containerRef, cursorKey]);

  useLayoutEffect(() => {
    if (!clickTick) return;
    setClicking(false);
    const raf = requestAnimationFrame(() => setClicking(true));
    const t = setTimeout(() => setClicking(false), 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [clickTick]);

  return (
    <div
      aria-hidden="true"
      className={`operator-cursor pointer-events-none absolute left-0 top-0 z-50 ${clicking ? 'clicking' : ''} ${
        active ? 'opacity-100' : 'opacity-60'
      }`}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <span className="cursor-ring absolute -left-3 -top-3 h-6 w-6 rounded-full border-2 border-signal opacity-0" />
      <svg width="22" height="26" viewBox="0 0 22 26" className="drop-shadow-[0_2px_3px_rgba(0,0,0,0.35)]">
        <path d="M1.5 1.5 L1.5 20 L6.5 15.5 L10 23.5 L13.5 22 L10 14 L17 14 Z" fill="#111111" stroke="#FAFAF7" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="absolute left-5 top-6 whitespace-nowrap rounded bg-signal px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white">
        Operator
      </span>
    </div>
  );
}
