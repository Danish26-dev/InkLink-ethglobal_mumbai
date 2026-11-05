import { Suspense, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './Scene';
import CanvasBoundary from './CanvasBoundary';
import type { PerfTier } from '../lib/useEnvironment';

type Props = {
  tier: PerfTier;
  reduced: boolean;
  webgl: boolean;
  isMobile: boolean;
};

const FALLBACK = (
  <div
    aria-hidden
    className="fixed inset-0 z-0"
    style={{
      background: 'radial-gradient(120% 90% at 70% 20%, #FAFAF7 0%, #EAEAE7 60%, #e2e2dd 100%)',
    }}
  />
);

/**
 * Fixed full-viewport WebGL atelier. Sits above the page background and below
 * the scrolling content layer (z-0 vs z-10), so it is always visible.
 */
export default function Experience({ tier, reduced, webgl, isMobile }: Props) {
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!webgl) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      pointerRef.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      pointerRef.current.y = -(e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [webgl]);

  if (!webgl) return FALLBACK;

  const dpr: [number, number] = tier === 'low' ? [1, 1.5] : tier === 'mid' ? [1, 1.75] : [1, 2];

  return (
    <div className="fixed inset-0 z-0" aria-hidden>
      <CanvasBoundary fallback={FALLBACK}>
        <Canvas
          flat
          dpr={dpr}
          gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
          camera={{ fov: isMobile ? 50 : 40, near: 0.1, far: 120, position: [9, 4.5, 14] }}
        >
          <Suspense fallback={null}>
            <Scene pointerRef={pointerRef} tier={tier} reduced={reduced} />
          </Suspense>
        </Canvas>
      </CanvasBoundary>
    </div>
  );
}
