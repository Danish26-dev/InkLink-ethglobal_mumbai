import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import Printer, { PrinterCtl } from '../objects/Printer';
import Phone from '../objects/Phone';
import Document, { DocStack } from '../objects/Document';
import { Gateway } from '../objects/Hardware';
import { AuthToken, ComputeRack, PrivacyShell, Quote } from '../objects/Abstract';
import ConnectionLine from '../objects/ConnectionLine';
import Chip, { CHIP_TEXT } from '../objects/Chip';
import { BlobShadow, Selectable, SelectRing, Tag, Zone } from '../objects/Common';
import { matMatteBlack, matPaperWhite, matSignal } from '../materials';
import { GROUND_Y, WF, WS_X } from '../world';
import { live, ui, useUI } from '../../lib/store';
import { scrollToStep } from '../../lib/chapter';

const smooth = (x: number) => {
  x = THREE.MathUtils.clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Paper-white plinth whose top sits at GROUND_Y + h. */
export function Plinth({
  x,
  z = 0,
  w = 1.8,
  d = 1.8,
  h = 0.5,
  dark = false,
}: {
  x: number;
  z?: number;
  w?: number;
  d?: number;
  h?: number;
  dark?: boolean;
}) {
  return (
    <>
      <RoundedBox
        args={[w, h, d]}
        radius={0.04}
        smoothness={2}
        position={[x, GROUND_Y + h / 2, z]}
        material={dark ? matMatteBlack : matPaperWhite}
      />
      <BlobShadow position={[x, 0, z]} size={Math.max(w, d) * 1.7} opacity={0.5} />
    </>
  );
}

/** Phone standing on a small stand, top of plinth at `top`. */
export function StandingPhone({
  x,
  top,
  z = 0,
  scale = 1,
  screen = 'intent',
}: {
  x: number;
  top: number;
  z?: number;
  scale?: number;
  screen?: 'intent' | 'connect' | 'pay';
}) {
  return (
    <group position={[x, top + 1.0 * scale, z]} rotation={[-0.12, 0.15, 0]} scale={scale}>
      <Phone screen={screen} />
      <mesh position={[0, -0.85, -0.25]} rotation={[0.5, 0, 0]} material={matMatteBlack}>
        <boxGeometry args={[0.5, 0.5, 0.06]} />
      </mesh>
    </group>
  );
}

/* ============================== HERO =================================== */

export function HeroZone({ reduced }: { reduced: boolean }) {
  const ctl = useRef<PrinterCtl>({ emerge: 0, active: 0 });
  useFrame(() => {
    const s = ui.get();
    if (s.introStart < 0) {
      ctl.current.emerge = 0;
      ctl.current.active = 0;
      return;
    }
    const t = (performance.now() - s.introStart) / 1000;
    ctl.current.active = reduced ? 1 : smooth((t - 0.5) / 0.5);
    ctl.current.emerge = reduced ? 1 : smooth((t - 1.0) / 2.6);
  });
  return (
    <Zone x={0}>
      <Printer ctl={ctl} />
      <BlobShadow position={[0, 0, 0.4]} size={6.5} />
      <group position={[-3.4, GROUND_Y + 0.02, 0.9]} rotation={[0, 0.35, 0]}>
        <DocStack count={7} />
      </group>
      <BlobShadow position={[-3.4, 0, 0.9]} size={2.6} opacity={0.5} />
      <group position={[2.9, GROUND_Y + 0.05, 1.9]} rotation={[-Math.PI / 2, 0, -0.4]}>
        <Phone screen="intent" />
      </group>
      <BlobShadow position={[2.9, 0, 1.9]} size={2.4} opacity={0.5} />
    </Zone>
  );
}

/* ============================ WORKSHOP ================================= */

function LocalIntelligence({ x, on, reduced }: { x: number; on: boolean; reduced: boolean }) {
  const doc = useRef<THREE.Group>(null);
  const chips = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    const p = on && !reduced ? (clock.elapsedTime % 5) / 5 : 0.95;
    if (doc.current) {
      const u = smooth(p / 0.35);
      doc.current.position.set(
        THREE.MathUtils.lerp(x - 2.1, x - 0.05, u),
        THREE.MathUtils.lerp(1.5, 0.75, u) + Math.sin(u * Math.PI) * 0.4,
        THREE.MathUtils.lerp(0.9, 0.15, u)
      );
      doc.current.scale.setScalar(THREE.MathUtils.lerp(0.75, 0.2, u));
      doc.current.visible = p < 0.36;
    }
    chips.current.forEach((c, i) => {
      if (!c) return;
      const k = smooth((p - 0.4 - i * 0.1) / 0.12);
      c.position.set(x + 0.2 + k * 1.3, 1.65 - i * 0.42, 0.2);
      c.scale.setScalar(Math.max(0.001, k));
    });
  });
  return (
    <group>
      <Plinth x={x} h={0.4} />
      <StandingPhone x={x} top={GROUND_Y + 0.4} screen="intent" />
      <group ref={doc} rotation={[1.25, 0.2, 0]}>
        <Document />
      </group>
      {CHIP_TEXT.map((t, i) => (
        <Chip key={t} text={t} ref={(m) => (chips.current[i] = m)} />
      ))}
      {on && <Tag position={[x, 2.25, 0]} hot>Local SLM · on-device</Tag>}
    </group>
  );
}

function PrivateComputation({ x, on, reduced }: { x: number; on: boolean; reduced: boolean }) {
  const doc = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!doc.current) return;
    const p = on && !reduced ? (clock.elapsedTime % 4.5) / 4.5 : 1;
    const u = smooth(p / 0.6);
    doc.current.position.set(
      THREE.MathUtils.lerp(x - 2.3, x, u),
      THREE.MathUtils.lerp(0.9, GROUND_Y + 0.25, u) + Math.sin(u * Math.PI) * 0.5,
      THREE.MathUtils.lerp(1.2, 0, u)
    );
    doc.current.scale.setScalar(THREE.MathUtils.lerp(0.75, 0.42, u));
  });
  return (
    <group>
      <group position={[x, GROUND_Y + 0.08, 0]}>
        <PrivacyShell open={on ? 1 : 0} />
      </group>
      <BlobShadow position={[x, 0, 0]} size={3.6} />
      <group ref={doc}>
        <Document />
      </group>
      <group position={[x + 2.0, GROUND_Y + 0.95 * 0.8, -1.4]} scale={0.8}>
        <ComputeRack lit={on ? 1 : 0.25} />
      </group>
      <BlobShadow position={[x + 2.0, 0, -1.4]} size={2.2} opacity={0.5} />
      {on && (
        <>
          <Tag position={[x - 1.1, 1.0, 0.9]}>Private</Tag>
          <Tag position={[x, 1.35, 0.9]} hot>Verified</Tag>
          <Tag position={[x + 1.1, 1.0, 0.9]}>Standard</Tag>
          <Tag position={[x + 2.0, 1.0, -1.4]}>0G Private Computer</Tag>
        </>
      )}
    </group>
  );
}

function AgentPayments({ x, on, reduced }: { x: number; on: boolean; reduced: boolean }) {
  const token = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!token.current) return;
    const t = on && !reduced ? clock.elapsedTime : 0;
    token.current.position.y = 1.05 + Math.sin(t * 1.2) * 0.06;
    token.current.rotation.y = Math.sin(t * 0.6) * 0.25;
  });
  return (
    <group>
      <Plinth x={x - 2.1} h={0.4} />
      <StandingPhone x={x - 2.1} top={GROUND_Y + 0.4} screen="pay" scale={0.85} />
      <group ref={token} position={[x, 1.05, 0.3]} scale={0.75}>
        <AuthToken state={on ? 'signed' : 'pending'} />
      </group>
      <Plinth x={x + 2.1} h={1.0} w={2.0} />
      <group position={[x + 2.1, GROUND_Y + 1.0 + 0.45 * 0.8, 0]} scale={0.8}>
        <Gateway />
      </group>
      <group position={[x + 2.1, 1.55, 0.2]} rotation={[0, -0.2, 0]} scale={0.6}>
        <Quote />
      </group>
      <ConnectionLine from={[x - 1.7, 0.7, 0]} to={[x - 0.5, 1.05, 0.3]} level={on ? 1 : 0.2} reduced={reduced} />
      <ConnectionLine from={[x + 0.5, 1.05, 0.3]} to={[x + 1.5, 0.6, 0]} level={on ? 1 : 0.2} reduced={reduced} />
      {on && (
        <>
          <Tag position={[x - 2.1, 2.05, 0]}>Customer</Tag>
          <Tag position={[x, 1.85, 0.3]} hot>Payment agent · x402</Tag>
          <Tag position={[x + 2.1, 2.35, 0]}>Merchant</Tag>
        </>
      )}
    </group>
  );
}

export function WorkshopZone({ reduced }: { reduced: boolean }) {
  const s = useUI();
  const items = [LocalIntelligence, PrivateComputation, AgentPayments];
  return (
    <Zone x={40}>
      {items.map((Item, i) => (
        <Selectable
          key={i}
          position={[WS_X[i], GROUND_Y, 0]}
          selected={false}
          onSelect={() => scrollToStep('workshop', i, 3)}
        >
          <group position={[-WS_X[i], -GROUND_Y, 0]}>
            <Item x={WS_X[i]} on={s.workshop === i} reduced={reduced} />
          </group>
        </Selectable>
      ))}
    </Zone>
  );
}

/* ============================ WORKFLOW ================================= */

export function WorkflowZone({ reduced }: { reduced: boolean }) {
  const doc = useRef<THREE.Group>(null);
  const token = useRef<THREE.Group>(null);
  const quote = useRef<THREE.Group>(null);
  const chips = useRef<(THREE.Mesh | null)[]>([]);
  const ctl = useRef<PrinterCtl>({ emerge: 0, active: 0 });
  const [levels, setLevels] = useState([0, 0, 0, 0]);
  const [screen, setScreen] = useState<'connect' | 'intent' | 'pay'>('connect');
  const lastKey = useRef('');

  const gw = useMemo(() => new THREE.Vector3(WF.shop, 0.55, 0), []);

  useFrame(() => {
    const f = live.active === 'workflow' ? live.f : live.active === 'workshop' || live.active === 'hero' ? 0 : 5;

    // Document path: phone → shop (step 2) → instruction desk (step 3)
    if (doc.current) {
      const a = smooth(f - 1);
      const b = smooth(f - 2);
      let x = THREE.MathUtils.lerp(WF.phone, WF.shop, a);
      let y = THREE.MathUtils.lerp(1.0, 1.35, a) + Math.sin(a * Math.PI) * 1.1;
      x = THREE.MathUtils.lerp(x, WF.chips - 0.2, b);
      y = THREE.MathUtils.lerp(y, 2.25, b);
      doc.current.position.set(x, y, 0.45);
      doc.current.scale.setScalar(THREE.MathUtils.lerp(0.25, 0.6, a) * (1 - 0.35 * b));
      doc.current.visible = f > 0.95 && f < 4.2;
    }
    chips.current.forEach((c, i) => {
      if (!c) return;
      const k = smooth((f - 2.25 - i * 0.14) / 0.3);
      c.position.set(WF.chips, 1.45 - i * 0.44 - (1 - k) * 0.3, 0.3);
      c.scale.setScalar(Math.max(0.001, k));
    });
    const auth = smooth((f - 3) / 0.5);
    if (token.current) {
      token.current.position.set(WF.token, 0.3 + auth * 1.0, 0.6);
      token.current.scale.setScalar(Math.max(0.001, auth * 0.6));
    }
    if (quote.current) {
      quote.current.scale.setScalar(Math.max(0.001, smooth((f - 2.9) / 0.4) * 0.55));
    }
    ctl.current.active = smooth((f - 3.9) / 0.3);
    ctl.current.emerge = smooth((f - 4.1) / 0.75);

    const lv = [
      smooth(f / 0.6),
      auth,
      auth,
      smooth((f - 3.95) / 0.3),
    ].map((v) => Math.round(v * 10) / 10);
    const sc = f < 1 ? 'connect' : f < 3 ? 'intent' : 'pay';
    const key = lv.join(',') + sc;
    if (key !== lastKey.current) {
      lastKey.current = key;
      setLevels(lv);
      setScreen(sc);
    }
  });

  return (
    <Zone x={81}>
      {/* customer phone */}
      <Plinth x={WF.phone} h={0.4} />
      <StandingPhone x={WF.phone} top={GROUND_Y + 0.4} screen={screen} />

      {/* the print shop counter + gateway */}
      <Plinth x={WF.shop} w={2.6} d={1.6} h={1.0} />
      <group position={[WF.shop, GROUND_Y + 1.0 + 0.36, 0]} scale={0.8}>
        <Gateway reduced={reduced} />
      </group>
      {/* shop signage: two slim posts and a header strip */}
      {[-1.15, 1.15].map((dx) => (
        <mesh key={dx} position={[WF.shop + dx, 0.75, -0.9]} material={matMatteBlack}>
          <boxGeometry args={[0.06, 3.4, 0.06]} />
        </mesh>
      ))}
      <mesh position={[WF.shop, 2.3, -0.9]} material={matMatteBlack}>
        <boxGeometry args={[2.4, 0.36, 0.06]} />
      </mesh>
      <mesh position={[WF.shop - 0.95, 2.3, -0.86]} material={matSignal}>
        <boxGeometry args={[0.2, 0.2, 0.02]} />
      </mesh>
      <group ref={quote} position={[WF.shop - 0.9, 1.25, 0.35]} rotation={[0, 0.25, 0]}>
        <Quote />
      </group>

      {/* instruction desk: the document becomes structured, executable operations */}
      <Plinth x={WF.chips} w={1.8} d={1.2} h={0.3} />
      <group ref={doc} rotation={[1.2, -0.15, 0]} visible={false}>
        <Document />
      </group>
      {CHIP_TEXT.map((t, i) => (
        <Chip key={t} text={t} ref={(m) => (chips.current[i] = m)} />
      ))}
      <Tag position={[WF.chips, 2.0, 0.3]} hot={levels[1] < 0.5 && screen === 'intent'}>
        Structured job
      </Tag>

      {/* authorization token */}
      <group ref={token}>
        <AuthToken state="signed" />
      </group>

      {/* the executing printer */}
      <group position={[WF.printer, 0, 0]}>
        <Printer ctl={ctl} />
      </group>
      <BlobShadow position={[WF.printer, 0, 0.4]} size={6.5} />

      <ConnectionLine from={[WF.phone + 0.45, 0.9, 0.1]} to={[gw.x - 0.6, gw.y, 0.2]} level={levels[0]} reduced={reduced} />
      <ConnectionLine from={[WF.phone + 0.4, 1.0, 0.3]} to={[WF.token - 0.35, 1.3, 0.6]} level={levels[1]} reduced={reduced} lift={0.1} />
      <ConnectionLine from={[WF.token + 0.35, 1.3, 0.6]} to={[gw.x - 0.4, gw.y + 0.3, 0.2]} level={levels[2]} reduced={reduced} lift={0.1} />
      <ConnectionLine from={[gw.x + 0.6, gw.y, 0]} to={[WF.printer - 1.6, 0.3, 0.3]} level={levels[3]} reduced={reduced} lift={0.08} />

      <Tag position={[WF.phone, 2.35, 0]}>Customer</Tag>
      <Tag position={[WF.shop, 2.9, -0.9]}>Print shop · local gateway</Tag>
      <Tag position={[WF.printer - 0.2, 1.75, 0]} hot={levels[3] > 0.5}>
        Physical execution
      </Tag>
    </Zone>
  );
}
