import { MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Edges, Html, RoundedBox } from '@react-three/drei';
import { matMatteBlack, matPaperWhite, matLightGrey } from '../materials';
import { makePrintedSheet } from '../textures';

export type PrinterCtl = { emerge: number; active: number };

const staticCtl: MutableRefObject<PrinterCtl> = { current: { emerge: 0.6, active: 1 } };

const GREY = new THREE.Color('#3a3a3a');
const ORANGE = new THREE.Color('#F15A36');

const LABELS: Record<string, { pos: [number, number, number]; text: string }> = {
  body: { pos: [-1.3, -0.3, 1.5], text: 'Matte-black chassis' },
  lid: { pos: [0, 0.95, 0.4], text: 'Paper-white structure' },
  tray: { pos: [-0.25, 0.3, 2.9], text: 'Output tray' },
  input: { pos: [-0.25, 1.25, -0.9], text: 'Paper input' },
  led: { pos: [1.3, 0.5, 1.4], text: 'Status indicator' },
};

/**
 * Procedural premium desktop laser printer. Matte-black chassis, paper-white
 * lid and trays, a signal-orange status indicator, and a printed sheet that
 * slides out of the output slot onto the tray.
 */
export default function Printer({
  ctl = staticCtl,
  interactive = true,
  labels = true,
}: {
  ctl?: MutableRefObject<PrinterCtl>;
  interactive?: boolean;
  labels?: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const sheet = useRef<THREE.Mesh>(null);

  const ledMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#3a3a3a',
        emissive: '#F15A36',
        emissiveIntensity: 0,
        roughness: 0.4,
      }),
    []
  );
  const sheetTex = useMemo(() => makePrintedSheet(), []);
  const sheetMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({ map: sheetTex, roughness: 0.95, side: THREE.DoubleSide }),
    [sheetTex]
  );
  useEffect(
    () => () => {
      ledMat.dispose();
      sheetMat.dispose();
      sheetTex.dispose();
    },
    [ledMat, sheetMat, sheetTex]
  );

  useFrame(({ clock }) => {
    const c = ctl.current;
    const a = THREE.MathUtils.clamp(c.active, 0, 1);
    ledMat.color.copy(GREY).lerp(ORANGE, a);
    ledMat.emissiveIntensity = a * (1.2 + Math.sin(clock.elapsedTime * 2.4) * 0.3);
    if (sheet.current) {
      const e = THREE.MathUtils.clamp(c.emerge, 0, 1);
      sheet.current.visible = e > 0.005;
      sheet.current.position.z = 1.25 + 1.75 * e - 1.0;
    }
  });

  const h = (name: string) =>
    interactive
      ? {
          onPointerOver: (e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            setHover(name);
            document.body.style.cursor = 'pointer';
          },
          onPointerOut: () => {
            setHover((v) => (v === name ? null : v));
            document.body.style.cursor = '';
          },
        }
      : {};
  const edges = (name: string) =>
    hover === name ? <Edges threshold={20} color="#F15A36" lineWidth={2} /> : null;

  return (
    <group>
      {/* chassis */}
      <RoundedBox args={[3.4, 1.25, 2.6]} radius={0.1} smoothness={4} position={[0, -0.3, 0]} material={matMatteBlack} {...h('body')}>
        {edges('body')}
      </RoundedBox>
      {/* lid */}
      <RoundedBox args={[3.2, 0.34, 2.4]} radius={0.07} smoothness={4} position={[0, 0.5, 0]} material={matPaperWhite} {...h('lid')}>
        {edges('lid')}
      </RoundedBox>
      {/* lid seam */}
      <mesh position={[0, 0.33, 0]} material={matMatteBlack}>
        <boxGeometry args={[3.24, 0.02, 2.44]} />
      </mesh>

      {/* slanted paper input at the back */}
      {/* rear paper input: a low matte-black cassette holding a paper stack */}
      <mesh position={[-0.25, 0.82, -0.85]} rotation={[0.28, 0, 0]} material={matMatteBlack} {...h('input')}>
        <boxGeometry args={[2.2, 0.06, 0.8]} />
        {edges('input')}
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[-0.25, 0.86 + i * 0.022, -0.86]} rotation={[0.28, 0, 0]} material={matPaperWhite}>
          <boxGeometry args={[2.0 - i * 0.03, 0.02, 0.7]} />
        </mesh>
      ))}

      {/* output slot with white frame */}
      <mesh position={[-0.25, 0.05, 1.31]} material={matPaperWhite}>
        <boxGeometry args={[2.3, 0.22, 0.05]} />
      </mesh>
      <mesh position={[-0.25, 0.05, 1.335]} material={matMatteBlack}>
        <boxGeometry args={[2.1, 0.08, 0.05]} />
      </mesh>

      {/* output tray */}
      <mesh position={[-0.25, -0.025, 2.08]} material={matPaperWhite} {...h('tray')}>
        <boxGeometry args={[2.2, 0.05, 1.6]} />
        {edges('tray')}
      </mesh>
      <mesh position={[-0.25, 0.03, 2.86]} material={matPaperWhite}>
        <boxGeometry args={[2.2, 0.12, 0.05]} />
      </mesh>

      {/* the sheet */}
      <mesh ref={sheet} position={[-0.25, 0.035, 0.25]} rotation={[-Math.PI / 2, 0, 0]} material={sheetMat} visible={false}>
        <planeGeometry args={[1.5, 2.0]} />
      </mesh>

      {/* control panel + status indicator */}
      <mesh position={[1.1, 0.1, 1.31]} material={matLightGrey}>
        <boxGeometry args={[0.9, 0.5, 0.03]} />
      </mesh>
      <mesh position={[1.3, 0.28, 1.34]} rotation={[Math.PI / 2, 0, 0]} material={ledMat} {...h('led')}>
        <cylinderGeometry args={[0.07, 0.07, 0.03, 24]} />
        {edges('led')}
      </mesh>
      <mesh position={[1.0, 0.12, 1.33]} material={matMatteBlack}>
        <boxGeometry args={[0.45, 0.02, 0.02]} />
      </mesh>
      <mesh position={[1.0, 0.02, 1.33]} material={matMatteBlack}>
        <boxGeometry args={[0.3, 0.02, 0.02]} />
      </mesh>

      {/* side vent ribs (paper-white) */}
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} position={[1.71, -0.55 + i * 0.13, -0.2]} material={matLightGrey}>
          <boxGeometry args={[0.02, 0.04, 1.5]} />
        </mesh>
      ))}

      {/* feet */}
      {[
        [-1.45, 1.0],
        [1.45, 1.0],
        [-1.45, -1.0],
        [1.45, -1.0],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, -0.94, z]} material={matMatteBlack}>
          <cylinderGeometry args={[0.1, 0.11, 0.06, 12]} />
        </mesh>
      ))}

      {interactive && labels && hover && LABELS[hover] && (
        <Html position={LABELS[hover].pos} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap bg-signal px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-paper">
            {LABELS[hover].text}
          </div>
        </Html>
      )}
    </group>
  );
}
