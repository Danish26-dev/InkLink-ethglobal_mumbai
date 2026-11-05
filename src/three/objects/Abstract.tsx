import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { matMatteBlack, matPaperWhite, matLightGrey, matSignal, matLayer, matDome } from '../materials';

/**
 * Signed payment authorization — a machined token. `state` drives emphasis:
 * 'pending' (graphite), 'signed' (orange seal), 'settled' (solid orange core).
 */
export function AuthToken({ state = 'signed' }: { state?: 'pending' | 'signed' | 'settled'; reduced?: boolean; settled?: boolean }) {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={matMatteBlack}>
        <cylinderGeometry args={[0.62, 0.62, 0.16, 6]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.09]} material={state === 'settled' ? matSignal : matPaperWhite}>
        <cylinderGeometry args={[0.42, 0.42, 0.03, 6]} />
      </mesh>
      {state !== 'pending' && (
        <mesh position={[0, 0, 0.12]} material={matSignal}>
          <torusGeometry args={[0.28, 0.035, 10, 6]} />
        </mesh>
      )}
    </group>
  );
}

/** A quotation slip. */
export function Quote() {
  return (
    <group>
      <RoundedBox args={[1.1, 1.5, 0.04]} radius={0.02} smoothness={2} material={matPaperWhite} />
      <mesh position={[-0.2, 0.55, 0.025]} material={matSignal}>
        <boxGeometry args={[0.5, 0.08, 0.01]} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[0, 0.28 - i * 0.17, 0.025]} material={matMatteBlack}>
          <boxGeometry args={[i === 3 ? 0.5 : 0.8, 0.03, 0.01]} />
        </mesh>
      ))}
      <mesh position={[0.22, -0.5, 0.025]} material={matMatteBlack}>
        <boxGeometry args={[0.45, 0.12, 0.01]} />
      </mesh>
    </group>
  );
}

/** Cryptographic verification lattice — a measured node frame, no spinning. */
export function VerifyLattice() {
  const nodes = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) pts.push([x * 0.5, y * 0.5, z * 0.5]);
    return pts;
  }, []);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1.0, 1.0, 1.0)), []);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#111111" />
      </lineSegments>
      {nodes.map((p, i) => (
        <mesh key={i} position={p} material={i === 13 ? matSignal : matMatteBlack}>
          <boxGeometry args={[0.08, 0.08, 0.08]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Protected computation environment — stacked architectural layers around a
 * document core. `open` 0..1 separates the layers to reveal the processing core.
 */
export function PrivacyShell({ open = 0 }: { open?: number; reduced?: boolean }) {
  const g = useRef<THREE.Group>(null);
  const cur = useRef(open);
  useFrame((_, dt) => {
    cur.current = THREE.MathUtils.damp(cur.current, open, 4, dt);
    if (!g.current) return;
    g.current.children.forEach((c, i) => {
      if (c.userData.layer !== undefined) c.position.y = 0.3 + c.userData.layer * (0.3 + cur.current * 0.25);
    });
  });
  return (
    <group ref={g}>
      <RoundedBox args={[2.0, 0.16, 2.0]} radius={0.04} smoothness={2} material={matMatteBlack} />
      <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]} material={matPaperWhite}>
        <planeGeometry args={[0.7, 0.9]} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} userData={{ layer: i }} position={[0, 0.3 + i * 0.3, 0]} rotation={[-Math.PI / 2, 0, 0]} material={matLayer}>
          <planeGeometry args={[1.7 - i * 0.25, 1.7 - i * 0.25]} />
        </mesh>
      ))}
      <mesh position={[0, 0.08, 0]} material={matDome}>
        <sphereGeometry args={[1.25, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {[-0.85, 0.85].map((x) =>
        [-0.85, 0.85].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.55, z]} material={matLightGrey}>
            <boxGeometry args={[0.05, 0.9, 0.05]} />
          </mesh>
        ))
      )}
    </group>
  );
}

/** Generic server / remote compute rack module. */
export function ComputeRack({ lit = 1 }: { lit?: number }) {
  return (
    <group>
      <RoundedBox args={[1.3, 1.9, 1.1]} radius={0.06} smoothness={3} position={[0, 0, 0]} material={matMatteBlack} />
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[0, 0.6 - i * 0.4, 0.56]}>
          <mesh material={matLightGrey}>
            <boxGeometry args={[1.05, 0.28, 0.02]} />
          </mesh>
          <mesh position={[0.4, 0, 0.015]} material={i < lit * 4 ? matSignal : matMatteBlack}>
            <boxGeometry args={[0.07, 0.07, 0.01]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Ledger record blocks — stacked, thin, documentary. */
export function Ledger({ count = 4 }: { count?: number }) {
  return (
    <group>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} position={[0, i * 0.22, 0]}>
          <RoundedBox args={[1.4, 0.16, 0.9]} radius={0.03} smoothness={2} material={i === count - 1 ? matPaperWhite : matLightGrey} />
          <mesh position={[-0.5, 0, 0.455]} material={i === count - 1 ? matSignal : matMatteBlack}>
            <boxGeometry args={[0.18, 0.05, 0.01]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
