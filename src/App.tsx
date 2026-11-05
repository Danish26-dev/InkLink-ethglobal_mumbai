import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

import Navigation from './components/Navigation';
import Preloader from './components/Preloader';
import LaunchDialog from './components/LaunchDialog';

import Hero from './sections/Hero';
import Workshop from './sections/Workshop';
import Workflow from './sections/Workflow';
import LocalFirst from './sections/LocalFirst';
import OfflinePay from './sections/OfflinePay';
import Technology from './sections/Technology';
import Privacy from './sections/Privacy';
import Developers from './sections/Developers';
import FinalCTA from './sections/FinalCTA';
import Footer from './sections/Footer';

import { useDeviceProfile, usePrefersReducedMotion } from './lib/useEnvironment';
import { ui } from './lib/store';
import { SECTION_ORDER } from './lib/sections';

// The 3D atelier is code-split so text and navigation render immediately.
const Experience = lazy(() => import('./three/Experience'));

export default function App() {
  const reduced = usePrefersReducedMotion();
  const { isMobile, tier, webgl } = useDeviceProfile();

  const [loaded, setLoaded] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeId, setActiveId] = useState('hero');
  const heroPlayed = useRef(false);

  // Nav background + active chapter (the one crossing the viewport centre).
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      setScrolled(window.scrollY > 40);
      const mid = window.innerHeight / 2;
      for (const id of SECTION_ORDER) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top <= mid && r.bottom > mid) {
          if (id !== last) {
            last = id;
            setActiveId(id);
          }
          break;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onLoaded = useCallback(() => {
    setLoaded(true);
    ui.set({ introStart: performance.now() });
  }, []);

  // Hero typography reveal, timed with the camera dolly and the sheet emerging.
  useEffect(() => {
    if (!loaded || heroPlayed.current) return;
    heroPlayed.current = true;
    const items = gsap.utils.toArray<HTMLElement>('.hero-anim');
    if (reduced) {
      gsap.set(items, { opacity: 1, y: 0 });
      return;
    }
    gsap.fromTo(
      items,
      { opacity: 0, y: 34 },
      { opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: 0.12, delay: 0.9 }
    );
  }, [loaded, reduced]);

  return (
    <>
      <a
        href="#workshop"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>

      <Preloader onDone={onLoaded} />

      <Suspense fallback={null}>
        <Experience tier={tier} reduced={reduced} webgl={webgl} isMobile={isMobile} />
      </Suspense>

      <Navigation activeId={activeId} scrolled={scrolled} />

      <main className="relative z-10">
        <Hero />
        <Workshop />
        <Workflow />
        <LocalFirst />
        <OfflinePay />
        <Technology />
        <Privacy />
        <Developers />
        <FinalCTA />
      </main>
      <Footer />
      <LaunchDialog />
    </>
  );
}
