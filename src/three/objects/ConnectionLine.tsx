import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

type Props = {
  from: [number, number, number];
  to: [number, number, number];
  /** 0..1 visibility / emphasis of this link */
  level?: number;
  reduced?: boolean;
  lift?: number;
  speed?: number;
};

/**
 * A thin signal-orange link between two points with a travelling pulse that
 * shows direction of data / authorization flow.
 */
export default function ConnectionLine({
  from,
  to,
  level = 1,
  reduced = false,
  lift = 0.18,
  speed = 0.3,
}: Props) {
  const key = from.join(',') + '|' + to.join(',');
  const pulse = useRef<THREE.Mesh>(null);

  const { curve, geo, mat } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += a.distanceTo(b) * lift;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const geo = new THREE.TubeGeometry(curve, 40, 0.013, 6, false);
    const mat = new THREE.MeshBasicMaterial({ color: '#F15A36', transparent: true });
    return { curve, geo, mat };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, lift]);

  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat]
  );

  useFrame(({ clock }) => {
    mat.opacity = 0.06 + 0.8 * level;
    if (!pulse.current) return;
    pulse.current.visible = level > 0.3;
    const t = reduced ? 0.5 : (clock.elapsedTime * speed) % 1;
    pulse.current.position.copy(curve.getPoint(t));
  });

  return (
    <group>
      <mesh geometry={geo} material={mat} />
      <mesh ref={pulse}>
        <sphereGeometry args={[0.075, 12, 12]} />
        <meshBasicMaterial color="#F15A36" />
      </mesh>
    </group>
  );
}
