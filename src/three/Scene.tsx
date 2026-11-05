import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import { computePose, GROUND_Y, pose, SECTION_ORDER } from './world';
import { HeroZone, WorkflowZone, WorkshopZone } from './zones/StoryZones';
import { DevZone, FinalZone, LocalZone, PayZone, PrivacyZone, TechZone } from './zones/InfraZones';
import { chapterProgress } from '../lib/chapter';
import { live, ui } from '../lib/store';
import type { PerfTier } from '../lib/useEnvironment';

const PAPER = new THREE.Color('#FAFAF7');
const INK = new THREE.Color('#111111');
const FLOOR_L = new THREE.Color('#EAEAE7');
const FLOOR_D = new THREE.Color('#161616');
const WALL_L = new THREE.Color('#F2F2EE');
const WALL_D = new THREE.Color('#141414');
const SEAM_L = new THREE.Color('#DCDCD7');
const SEAM_D = new THREE.Color('#1C1C1C');

const smooth = (x: number) => {
  x = THREE.MathUtils.clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

type Props = {
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
  tier: PerfTier;
  reduced: boolean;
};

/**
 * The continuous INKLINK atelier. Every chapter of the page has a zone in one
 * world; the camera flies between them as the reader scrolls, with the active
 * chapter's local progress driving each zone's animation.
 */
export default function Scene({ pointerRef, tier, reduced }: Props) {
  const { camera, scene, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const els = useRef<(HTMLElement | null)[]>([]);
  const curPos = useRef(new THREE.Vector3(9, 4.5, 14));
  const curTarget = useRef(new THREE.Vector3(0, 0.3, 0));
  const shift = useRef({ x: 0.17, y: 0 });
  const floorMat = useRef<THREE.MeshStandardMaterial>(null);
  const wallMat = useRef<THREE.MeshStandardMaterial>(null);
  const ambient = useRef<THREE.AmbientLight>(null);
  const bg = useMemo(() => PAPER.clone(), []);
  const fog = useMemo(() => new THREE.Fog(PAPER.clone(), 24, 70), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const grid = useRef<THREE.Mesh>(null);
  const seamMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#DCDCD7' }), []);

  useEffect(() => {
    scene.background = bg;
    scene.fog = fog;
    return () => {
      scene.background = null;
      scene.fog = null;
      cam.clearViewOffset();
    };
  }, [scene, bg, fog, cam]);

  useFrame((state, dt) => {
    dt = Math.min(dt, 0.1);
    const vh = window.innerHeight;

    // ---- which chapter is on screen, and how far through it are we ----
    if (els.current.length === 0 || !els.current[0]) {
      els.current = SECTION_ORDER.map((id) => document.getElementById(id));
    }
    let active = live.active;
    let local = live.local;
    for (let i = 0; i < SECTION_ORDER.length; i++) {
      const el = els.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= vh * 0.5 && r.bottom > vh * 0.5) {
        active = SECTION_ORDER[i];
        local = chapterProgress(el);
        break;
      }
    }
    live.active = active;
    live.local = local;
    live.f = THREE.MathUtils.clamp(local * 5, 0, 4.999);

    // ---- camera pose for this beat ----
    const s = ui.get();
    computePose(active, local, live.f, s);
    const desired = tmp.copy(pose.pos);

    // hero intro dolly: camera starts wide and settles on the printer
    if (active === 'hero') {
      const t = s.introStart < 0 ? 0 : (performance.now() - s.introStart) / 2600;
      const k = reduced ? 0 : 1 - smooth(t);
      desired.x += 3.5 * k;
      desired.y += 2.2 * k;
      desired.z += 7 * k;
    }

    // keep composition on narrow / portrait screens by backing off
    const aspect = size.width / size.height;
    const mobile = size.width < 768;
    const back = aspect < 1 ? THREE.MathUtils.clamp(1.1 / aspect, 1, 2.1) : aspect < 1.35 ? 1.15 : 1;
    if (back !== 1) {
      desired.sub(pose.target).multiplyScalar(back).add(pose.target);
    }

    // subtle pointer parallax (desktop only)
    if (!reduced && !mobile) {
      desired.x += pointerRef.current.x * 0.35;
      desired.y += pointerRef.current.y * 0.2;
    }

    const lambda = reduced ? 10 : 2.6;
    curPos.current.x = THREE.MathUtils.damp(curPos.current.x, desired.x, lambda, dt);
    curPos.current.y = THREE.MathUtils.damp(curPos.current.y, desired.y, lambda, dt);
    curPos.current.z = THREE.MathUtils.damp(curPos.current.z, desired.z, lambda, dt);
    curTarget.current.x = THREE.MathUtils.damp(curTarget.current.x, pose.target.x, lambda, dt);
    curTarget.current.y = THREE.MathUtils.damp(curTarget.current.y, pose.target.y, lambda, dt);
    curTarget.current.z = THREE.MathUtils.damp(curTarget.current.z, pose.target.z, lambda, dt);
    cam.position.copy(curPos.current);
    cam.lookAt(curTarget.current);

    // ---- composition: subject sits right of the text on desktop, above it on mobile ----
    const wide = active === 'technology' && s.tech < 0;
    const sx = mobile ? 0 : wide ? 0.12 : active === 'local' || active === 'developers' ? 0.13 : 0.17;
    const sy = mobile ? 0.17 : 0;
    shift.current.x = THREE.MathUtils.damp(shift.current.x, sx, 3, dt);
    shift.current.y = THREE.MathUtils.damp(shift.current.y, sy, 3, dt);
    cam.setViewOffset(
      size.width,
      size.height,
      -shift.current.x * size.width,
      shift.current.y * size.height,
      size.width,
      size.height
    );

    // ---- environment: paper atelier → ink commission ----
    live.dark = THREE.MathUtils.damp(live.dark, active === 'final' ? 1 : 0, 2.2, dt);
    const d = live.dark;
    bg.copy(PAPER).lerp(INK, d);
    fog.color.copy(bg);
    if (floorMat.current) floorMat.current.color.copy(FLOOR_L).lerp(FLOOR_D, d);
    if (wallMat.current) wallMat.current.color.copy(WALL_L).lerp(WALL_D, d);
    if (ambient.current) ambient.current.intensity = THREE.MathUtils.lerp(0.9, 0.35, d);
    if (grid.current) grid.current.visible = d < 0.5;
    seamMat.color.copy(SEAM_L).lerp(SEAM_D, d);
  });

  const seams = useMemo(() => Array.from({ length: 70 }, (_, i) => -30 + i * 6), []);
  useEffect(() => () => seamMat.dispose(), [seamMat]);

  return (
    <>
      {/* ---- lighting ---- */}
      <ambientLight ref={ambient} intensity={0.9} />
      <hemisphereLight args={['#ffffff', '#d8d8d2', 0.9]} />
      <directionalLight position={[6, 10, 8]} intensity={2.2} />
      <directionalLight position={[-8, 5, 4]} intensity={0.7} />

      {/* ---- the atelier: floor, technical grid, back wall with panel seams ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[170, GROUND_Y, 0]}>
        <planeGeometry args={[520, 80]} />
        <meshStandardMaterial ref={floorMat} color="#EAEAE7" roughness={0.95} />
      </mesh>
      {tier !== 'low' && (
        <Grid
          ref={grid as never}
          position={[0, GROUND_Y + 0.004, 0]}
          args={[10, 10]}
          infiniteGrid
          followCamera
          cellSize={1}
          sectionSize={4}
          cellThickness={0.6}
          sectionThickness={0.9}
          cellColor="#E0E0DC"
          sectionColor="#D2D2CD"
          fadeDistance={36}
          fadeStrength={1.4}
        />
      )}
      <mesh position={[170, 6, -8]}>
        <planeGeometry args={[520, 14]} />
        <meshStandardMaterial ref={wallMat} color="#F2F2EE" roughness={1} />
      </mesh>
      {seams.map((x) => (
        <mesh key={x} position={[x, 6, -7.98]} material={seamMat}>
          <planeGeometry args={[0.02, 14]} />
        </mesh>
      ))}

      {/* ---- story zones, left → right along the journey ---- */}
      <HeroZone reduced={reduced} />
      <WorkshopZone reduced={reduced} />
      <WorkflowZone reduced={reduced} />
      <LocalZone reduced={reduced} />
      <PayZone reduced={reduced} />
      <TechZone reduced={reduced} />
      <PrivacyZone reduced={reduced} />
      <DevZone reduced={reduced} />
      <FinalZone reduced={reduced} />
    </>
  );
}
