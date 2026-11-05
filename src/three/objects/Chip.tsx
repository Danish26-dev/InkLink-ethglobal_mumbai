import { forwardRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { makeChipTexture } from '../textures';

/** A structured, executable print instruction rendered as a physical chip. */
const Chip = forwardRef<THREE.Mesh, { text: string; position?: [number, number, number] }>(
  ({ text, position = [0, 0, 0] }, ref) => {
    const tex = useMemo(() => makeChipTexture(text), [text]);
    const mat = useMemo(
      () => new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
      [tex]
    );
    useEffect(
      () => () => {
        tex.dispose();
        mat.dispose();
      },
      [tex, mat]
    );
    return (
      <mesh ref={ref} position={position} material={mat}>
        <planeGeometry args={[1.4, 0.35]} />
      </mesh>
    );
  }
);
export default Chip;

export const CHIP_TEXT = ['PAGES 1–4', 'DUPLEX', 'COPIES × 2', 'A4 · MONO'];
