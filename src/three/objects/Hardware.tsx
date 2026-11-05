import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { matMatteBlack, matPaperWhite, matSignalGlow, matGraphite, matLightGrey } from '../materials';

/** Local shop gateway — a small industrial edge box with status LED and ports. */
export function Gateway({ reduced = false }: { reduced?: boolean }) {
  const led = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (led.current && !reduced) {
      (led.current.material as THREE.MeshStandardMaterial).emissiveIntensity =
        1.1 + Math.sin(s.clock.elapsedTime * 3) * 0.4;
    }
  });
  return (
    <group>
      <RoundedBox args={[1.6, 0.9, 1.2]} radius={0.08} smoothness={4} material={matMatteBlack} />
      <mesh position={[0, 0.46, 0]} material={matPaperWhite}>
        <boxGeometry args={[1.4, 0.06, 1.0]} />
      </mesh>
      {/* LED */}
      <mesh ref={led} position={[0.55, 0.1, 0.61]} material={matSignalGlow}>
        <sphereGeometry args={[0.06, 16, 16]} />
      </mesh>
      {/* ports */}
      {Array.from({ length: 4 }).map((_, i) => (
        <mesh key={i} position={[-0.45 + i * 0.22, -0.2, 0.61]} material={matLightGrey}>
          <boxGeometry args={[0.14, 0.1, 0.03]} />
        </mesh>
      ))}
      {/* vents */}
      {Array.from({ length: 5 }).map((_, i) => (
        <mesh key={i} position={[-0.8, -0.1 + i * 0.08, 0]} material={matGraphite}>
          <boxGeometry args={[0.02, 0.03, 0.8]} />
        </mesh>
      ))}
    </group>
  );
}

/** ESP32-S3 based device module — a small PCB with a chip, antenna and headers. */
export function ESP32({ reduced = false }: { reduced?: boolean }) {
  const chipGlow = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (chipGlow.current && !reduced) {
      (chipGlow.current.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.6 + ((Math.sin(s.clock.elapsedTime * 5) + 1) / 2) * 0.9;
    }
  });
  return (
    <group>
      {/* PCB */}
      <mesh material={matMatteBlack}>
        <boxGeometry args={[1.3, 0.06, 0.9]} />
      </mesh>
      {/* chip */}
      <mesh position={[0, 0.07, 0]} material={matGraphite}>
        <boxGeometry args={[0.4, 0.08, 0.4]} />
      </mesh>
      <mesh ref={chipGlow} position={[0, 0.12, 0]} material={matSignalGlow}>
        <boxGeometry args={[0.1, 0.02, 0.1]} />
      </mesh>
      {/* antenna trace (paper white) */}
      <mesh position={[-0.5, 0.07, 0.3]} material={matPaperWhite}>
        <boxGeometry args={[0.25, 0.02, 0.3]} />
      </mesh>
      {/* pin headers */}
      {Array.from({ length: 10 }).map((_, i) => (
        <mesh key={i} position={[-0.55 + i * 0.12, 0.08, -0.4]} material={matLightGrey}>
          <boxGeometry args={[0.03, 0.08, 0.03]} />
        </mesh>
      ))}
    </group>
  );
}
