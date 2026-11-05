import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { GROUND_Y } from '../world';
import { getBlobTexture } from '../textures';

const ZoneCtx = createContext(true);

/**
 * Lazily mounts a story zone only when the camera is near it, and hides it
 * when far. Keeps draw calls and Html overlays under control.
 */
export function Zone({ x, children }: { x: number; children: ReactNode }) {
  const [mode, setMode] = useState(x === 0 ? 2 : 0);
  const m = useRef(mode);
  useFrame(({ camera }) => {
    const d = Math.abs(camera.position.x - x);
    const nm = d < 26 ? 2 : d < 50 ? 1 : 0;
    if (nm !== m.current) {
      m.current = nm;
      setMode(nm);
    }
  });
  if (mode === 0) return null;
  return (
    <group visible={mode === 2}>
      <ZoneCtx.Provider value={mode === 2}>{children}</ZoneCtx.Provider>
    </group>
  );
}

/** Small technical label anchored in 3D space. */
export function Tag({
  position,
  children,
  hot = false,
}: {
  position: [number, number, number];
  children: ReactNode;
  hot?: boolean;
}) {
  const visible = useContext(ZoneCtx);
  if (!visible) return null;
  return (
    <Html position={position} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div
        className={`whitespace-nowrap px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${
          hot ? 'bg-signal text-paper' : 'bg-ink text-paper'
        }`}
      >
        {children}
      </div>
    </Html>
  );
}

/** Soft contact shadow under an object. */
export function BlobShadow({
  position = [0, 0, 0],
  size = 3,
  opacity = 0.9,
}: {
  position?: [number, number, number];
  size?: number;
  opacity?: number;
}) {
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: getBlobTexture(),
        transparent: true,
        depthWrite: false,
        opacity,
      }),
    [opacity]
  );
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <mesh
      position={[position[0], GROUND_Y + 0.012, position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
      material={mat}
      renderOrder={-1}
    >
      <planeGeometry args={[size, size]} />
    </mesh>
  );
}

/** Clickable / tappable object wrapper with hover + selected emphasis. */
export function Selectable({
  position,
  selected,
  onSelect,
  children,
}: {
  position: [number, number, number];
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const g = useRef<THREE.Group>(null);
  const hover = useRef(false);
  useFrame((_, dt) => {
    if (!g.current) return;
    const target = selected ? 1.06 : hover.current ? 1.04 : 1;
    const s = THREE.MathUtils.damp(g.current.scale.x, target, 6, dt);
    g.current.scale.setScalar(s);
  });
  return (
    <group
      ref={g}
      position={position}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        hover.current = true;
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hover.current = false;
        document.body.style.cursor = '';
      }}
    >
      {children}
    </group>
  );
}

/** Flat ground ring used to mark the selected module. */
export function SelectRing({ position, on }: { position: [number, number, number]; on: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    const s = THREE.MathUtils.damp(ref.current.scale.x, on ? 1 : 0.001, 7, dt);
    ref.current.scale.setScalar(s);
    ref.current.visible = s > 0.01;
  });
  return (
    <mesh
      ref={ref}
      position={[position[0], GROUND_Y + 0.02, position[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[1.5, 1.57, 64]} />
      <meshBasicMaterial color="#F15A36" />
    </mesh>
  );
}
