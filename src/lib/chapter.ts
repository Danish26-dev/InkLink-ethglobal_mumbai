import { useEffect, useState } from 'react';

/** Progress 0..1 through a tall sticky chapter element. */
export function chapterProgress(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const span = r.height - window.innerHeight;
  if (span <= 0) return r.top <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -r.top / span));
}

/** Scroll so that step `i` of `n` in chapter `id` is centred. */
export function scrollToStep(id: string, i: number, n: number) {
  const el = document.getElementById(id);
  if (!el) return;
  const span = el.offsetHeight - window.innerHeight;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({
    top: el.offsetTop + span * ((i + 0.5) / n),
    behavior: reduced ? 'auto' : 'smooth',
  });
}

export function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: el.offsetTop, behavior: reduced ? 'auto' : 'smooth' });
}

/** Current step index of a chapter, and its raw progress. */
export function useChapter(id: string, steps: number, onStep?: (i: number) => void) {
  const [state, setState] = useState({ step: 0, progress: 0 });
  useEffect(() => {
    let raf = 0;
    let lastStep = -1;
    let lastP = -1;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) {
        const p = chapterProgress(el);
        const step = Math.min(steps - 1, Math.floor(p * steps));
        if (step !== lastStep || Math.abs(p - lastP) > 0.01) {
          if (step !== lastStep) onStep?.(step);
          lastStep = step;
          lastP = p;
          setState({ step, progress: p });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, steps]);
  return state;
}
