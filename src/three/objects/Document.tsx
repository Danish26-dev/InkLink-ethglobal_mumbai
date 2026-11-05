import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { makePrintedSheet } from '../textures';

let shared: { tex: THREE.Texture; mat: THREE.MeshStandardMaterial; users: number } | null = null;

/** A digital document / paper sheet with printed INKLINK job content. Lies flat in XZ. */
export default function Document({ opacity = 1 }: { opacity?: number; reduced?: boolean; float?: boolean }) {
  const mat = useMemo(() => {
    if (opacity < 1) {
      return new THREE.MeshStandardMaterial({
        map: makePrintedSheet(),
        roughness: 0.95,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      });
    }
    if (!shared) {
      const tex = makePrintedSheet();
      shared = {
        tex,
        mat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide }),
        users: 0,
      };
    }
    shared.users++;
    return shared.mat;
  }, [opacity]);

  useEffect(
    () => () => {
      if (shared && mat === shared.mat) {
        shared.users--;
        if (shared.users <= 0) {
          shared.mat.dispose();
          shared.tex.dispose();
          shared = null;
        }
      } else {
        mat.map?.dispose();
        mat.dispose();
      }
    },
    [mat]
  );

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={mat}>
        <planeGeometry args={[1.4, 1.87]} />
      </mesh>
      {/* paper thickness */}
      <mesh position={[0, -0.012, 0]}>
        <boxGeometry args={[1.4, 0.02, 1.87]} />
        <meshStandardMaterial color="#EAEAE7" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** A small stack of sheets (document stack). */
export function DocStack({ count = 6 }: { count?: number }) {
  return (
    <group>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} position={[(i % 2) * 0.03, i * 0.035, (i % 3) * 0.02]} rotation={[0, (i % 2 ? 1 : -1) * 0.03, 0]}>
          <Document />
        </group>
      ))}
    </group>
  );
}
