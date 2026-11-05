import { useEffect, useState } from 'react';

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export type PerfTier = 'low' | 'mid' | 'high';

/**
 * Lightweight device / capability detection used to scale rendering quality.
 */
export function useDeviceProfile() {
  const [profile, setProfile] = useState<{
    isMobile: boolean;
    isTablet: boolean;
    tier: PerfTier;
    webgl: boolean;
  }>({ isMobile: false, isTablet: false, tier: 'high', webgl: true });

  useEffect(() => {
    const w = window.innerWidth;
    const ua = navigator.userAgent;
    const isMobile = w < 768 || /iPhone|Android.+Mobile/i.test(ua);
    const isTablet = (w >= 768 && w < 1100) || /iPad|Tablet/i.test(ua);

    // WebGL capability check
    let webgl = true;
    try {
      const c = document.createElement('canvas');
      webgl = !!(
        c.getContext('webgl2') ||
        c.getContext('webgl') ||
        c.getContext('experimental-webgl')
      );
    } catch {
      webgl = false;
    }

    const cores = navigator.hardwareConcurrency || 4;
    const mem = (navigator as any).deviceMemory || 4;
    let tier: PerfTier = 'high';
    if (isMobile || cores <= 4 || mem <= 3) tier = 'low';
    else if (isTablet || cores <= 6) tier = 'mid';

    setProfile({ isMobile, isTablet, tier, webgl });
  }, []);

  return profile;
}

/** Simple IntersectionObserver reveal hook for conventional UI content. */
export function useReveal<T extends HTMLElement>(reduced: boolean) {
  useEffect(() => {
    if (reduced) {
      document.querySelectorAll('.reveal-y').forEach((el) => el.classList.add('reveal-in'));
      return;
    }
    const els = document.querySelectorAll('.reveal-y');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            (e.target as HTMLElement).style.transitionDelay =
              (e.target as HTMLElement).dataset.delay || '0ms';
            e.target.classList.add('reveal-in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [reduced]);
}
