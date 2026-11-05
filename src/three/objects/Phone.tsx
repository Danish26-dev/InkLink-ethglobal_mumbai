import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { matMatteBlack } from '../materials';
import { makePhoneTexture } from '../textures';

/** Smartphone running the native INKLINK app (screen content is drawn per use). */
export default function Phone({ screen = 'intent' }: { screen?: 'intent' | 'connect' | 'pay'; reduced?: boolean }) {
  const tex = useMemo(() => makePhoneTexture(screen), [screen]);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), [tex]);
  useEffect(
    () => () => {
      tex.dispose();
      mat.dispose();
    },
    [tex, mat]
  );
  return (
    <group>
      <RoundedBox args={[1.0, 2.0, 0.1]} radius={0.12} smoothness={4} material={matMatteBlack} />
      <mesh position={[0, 0, 0.054]} material={mat}>
        <planeGeometry args={[0.88, 1.76]} />
      </mesh>
    </group>
  );
}
