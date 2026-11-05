import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import Printer, { PrinterCtl } from '../objects/Printer';
import Phone from '../objects/Phone';
import Document from '../objects/Document';
import { ESP32, Gateway } from '../objects/Hardware';
import { AuthToken, ComputeRack, Ledger, PrivacyShell, Quote, VerifyLattice } from '../objects/Abstract';
import ConnectionLine from '../objects/ConnectionLine';
import { BlobShadow, Selectable, SelectRing, Tag, Zone } from '../objects/Common';
import { matMatteBlack, matSignal, matLightGrey } from '../materials';
import { DEV_X, FINAL_X, GROUND_Y, LOCAL, PAY, PRIV_X, TECH_X } from '../world';
import { live, ui, useUI } from '../../lib/store';
import { Plinth, StandingPhone } from './StoryZones';

const smooth = (x: number) => {
  x = THREE.MathUtils.clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Re-render-throttled reader of a per-frame value. */
function useLevels(n: number, fn: () => number[]) {
  const [v, setV] = useState<number[]>(() => Array(n).fill(0));
  const last = useRef('');
  useFrame(() => {
    const next = fn().map((x) => Math.round(THREE.MathUtils.clamp(x, 0, 1) * 10) / 10);
    const k = next.join(',');
    if (k !== last.current) {
      last.current = k;
      setV(next);
    }
  });
  return v;
}

/* ======================= LOCAL-FIRST INFRASTRUCTURE ===================== */

export function LocalZone({ reduced }: { reduced: boolean }) {
  const lv = useLevels(4, () => {
    const p = live.active === 'local' ? live.local : live.active === 'offlinepay' ? 1 : 0;
    return [smooth(p * 4), smooth(p * 4 - 0.9), smooth(p * 4 - 1.8), smooth(p * 4 - 2.6)];
  });
  const ctl = useRef<PrinterCtl>({ emerge: 0, active: 0 });
  useFrame(() => {
    ctl.current.active = lv[2];
    ctl.current.emerge = lv[3] * 0.85;
  });
  return (
    <Zone x={141}>
      <Plinth x={LOCAL.phone} h={0.4} />
      <StandingPhone x={LOCAL.phone} top={GROUND_Y + 0.4} screen="connect" />

      <Plinth x={LOCAL.gateway} w={2.4} d={1.8} h={0.7} />
      <group position={[LOCAL.gateway, GROUND_Y + 0.7 + 0.45, 0]}>
        <Gateway reduced={reduced} />
      </group>

      <Plinth x={LOCAL.esp} w={2.0} d={1.6} h={0.7} />
      <group position={[LOCAL.esp, GROUND_Y + 0.7 + 0.04, 0]} scale={1.3}>
        <ESP32 reduced={reduced} />
      </group>

      <group position={[LOCAL.printer, 0, 0]} rotation={[0, -0.35, 0]}>
        <Printer ctl={ctl} interactive={false} />
      </group>
      <BlobShadow position={[LOCAL.printer, 0, 0.3]} size={6.5} />

      {/* the cloud — present but not required for basic printing */}
      <group position={[LOCAL.esp - 2.5, GROUND_Y + 0.95, -6]}>
        <ComputeRack lit={0} />
      </group>
      <BlobShadow position={[LOCAL.esp - 2.5, 0, -6]} size={2.5} opacity={0.4} />
      <ConnectionLine from={[LOCAL.gateway, 0.4, -0.5]} to={[LOCAL.esp - 2.5, 0.9, -6]} level={0} reduced={reduced} />

      {/* Bluetooth discovery + local Wi-Fi transfer: two parallel links */}
      <ConnectionLine from={[LOCAL.phone + 0.45, 0.9, 0.1]} to={[LOCAL.gateway - 0.8, 0.3, 0.2]} level={lv[0]} reduced={reduced} lift={0.3} />
      <ConnectionLine from={[LOCAL.phone + 0.45, 0.6, 0.1]} to={[LOCAL.gateway - 0.8, 0.05, 0.2]} level={lv[0] * 0.7} reduced={reduced} lift={0.12} speed={0.45} />
      <ConnectionLine from={[LOCAL.gateway + 0.8, 0.2, 0]} to={[LOCAL.esp - 0.8, -0.1, 0]} level={lv[1]} reduced={reduced} />
      <ConnectionLine from={[LOCAL.esp + 0.8, -0.1, 0]} to={[LOCAL.printer - 1.5, 0.1, 0.4]} level={lv[2]} reduced={reduced} />

      <Tag position={[LOCAL.phone, 2.3, 0]}>01 · Customer smartphone</Tag>
      <Tag position={[(LOCAL.phone + LOCAL.gateway) / 2, 1.75, 0]} hot={lv[0] > 0.5}>
        02 · Bluetooth + local Wi-Fi
      </Tag>
      <Tag position={[LOCAL.gateway, 1.35, 0]}>03 · Local shop gateway</Tag>
      <Tag position={[LOCAL.esp, 0.6, 0]}>04 · ESP32-S3 device</Tag>
      <Tag position={[LOCAL.printer, 1.6, 0]} hot={lv[3] > 0.5}>
        05 · Printer execution
      </Tag>
      <Tag position={[LOCAL.esp - 2.5, 1.55, -6]}>Cloud · not required for basic printing</Tag>
    </Zone>
  );
}

/* ============================== OFFLINEPAY ============================== */

export function PayZone({ reduced }: { reduced: boolean }) {
  const s = useUI();
  const online = s.pay === 'online';
  const travel = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!travel.current) return;
    const p = online ? (reduced ? 0.99 : (clock.elapsedTime % 4) / 4) : 0;
    const a = smooth(p / 0.45);
    const b = smooth((p - 0.5) / 0.4);
    const x = THREE.MathUtils.lerp(THREE.MathUtils.lerp(PAY.online - 3.4, PAY.online + 0.4, a), PAY.online + 3.6, b);
    travel.current.position.set(x, 0.9 + Math.sin(a * Math.PI) * 0.5 + Math.sin(b * Math.PI) * 0.4, 0.5);
    travel.current.scale.setScalar(online ? 0.32 : 0.001);
  });

  const o = PAY.offline;
  const n = PAY.online;
  return (
    <Zone x={180}>
      {/* ---------- Stage 01: offline authorization (paper environment) ---------- */}
      <Plinth x={o - 3} h={0.4} />
      <StandingPhone x={o - 3} top={GROUND_Y + 0.4} screen="pay" />
      <Plinth x={o + 3} w={2.6} d={1.6} h={1.0} />
      <group position={[o + 3, GROUND_Y + 1.0 + 0.36, 0]} scale={0.8}>
        <Gateway reduced={reduced} />
      </group>
      <group position={[o + 2.3, 1.45, 0.4]} rotation={[0, -0.2, 0]} scale={0.55}>
        <Quote />
      </group>
      <group position={[o, 1.2, 0.5]} scale={0.7}>
        <AuthToken state="signed" />
      </group>
      <ConnectionLine from={[o - 2.55, 1.0, 0.2]} to={[o - 0.45, 1.2, 0.5]} level={online ? 0.3 : 1} reduced={reduced} lift={0.1} />
      <ConnectionLine from={[o + 0.45, 1.2, 0.5]} to={[o + 2.4, 0.7, 0.2]} level={online ? 0.3 : 1} reduced={reduced} lift={0.1} />
      {/* disconnected antenna */}
      <mesh position={[o, 0.6, -2.6]} material={matLightGrey}>
        <cylinderGeometry args={[0.04, 0.06, 3.1, 8]} />
      </mesh>
      <mesh position={[o, 2.2, -2.6]} material={matMatteBlack}>
        <boxGeometry args={[0.5, 0.18, 0.18]} />
      </mesh>
      <Tag position={[o, 2.65, -2.6]}>{online ? 'Connectivity restored' : 'No connectivity'}</Tag>
      <Tag position={[o - 3, 2.3, 0]}>Customer agent</Tag>
      <Tag position={[o + 3, 2.4, 0]}>Shop verifies</Tag>
      <Tag position={[o, 2.0, 0.5]} hot={!online}>
        Signed authorization · not settled
      </Tag>

      {/* link between stages */}
      <ConnectionLine from={[o + 3.6, 0.6, 0]} to={[n - 3.4, 0.9, 0.5]} level={online ? 1 : 0.05} reduced={reduced} lift={0.15} />

      {/* ---------- Stage 02: on-chain settlement (ink environment) ---------- */}
      <RoundedBox args={[11, 0.12, 6]} radius={0.04} smoothness={2} position={[n, GROUND_Y + 0.06, -0.5]} material={matMatteBlack} />
      <group position={[n - 3.4, 0.9, 0.5]} scale={0.6}>
        <AuthToken state={online ? 'signed' : 'pending'} />
      </group>
      <group position={[n + 0.4, GROUND_Y + 0.12 + 0.95, -0.4]}>
        <ComputeRack lit={online ? 1 : 0} />
      </group>
      <group position={[n + 3.6, GROUND_Y + 0.12 + 0.08, 0]}>
        <Ledger count={online ? 5 : 4} />
      </group>
      <group ref={travel}>
        <mesh material={matSignal}>
          <boxGeometry args={[1, 1, 1]} />
        </mesh>
      </group>
      <ConnectionLine from={[n - 2.9, 0.9, 0.5]} to={[n - 0.3, 0.6, 0]} level={online ? 1 : 0.05} reduced={reduced} lift={0.12} />
      <ConnectionLine from={[n + 1.1, 0.6, 0]} to={[n + 3.0, 0.3, 0.2]} level={online ? 1 : 0.05} reduced={reduced} lift={0.12} />
      <Tag position={[n - 3.4, 1.7, 0.5]}>Payment Agent · x402</Tag>
      <Tag position={[n + 0.4, 1.5, -0.4]}>Hedera facilitator · verify + settle</Tag>
      <Tag position={[n + 3.6, 1.45, 0]} hot={online}>
        {online ? 'Transaction recorded' : 'Awaiting settlement'}
      </Tag>
    </Zone>
  );
}

/* ============================== TECHNOLOGY ============================== */

const TECH_NAMES = [
  'On-device intelligence',
  'Private AI computation',
  'Physical execution',
  'Autonomous payments',
  'Verifiable records',
];
const TECH_LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 2],
  [2, 4],
];

function TechModule({ i }: { i: number }) {
  const top = GROUND_Y + 0.5;
  switch (i) {
    case 0:
      return <StandingPhone x={0} top={top} scale={0.7} screen="intent" />;
    case 1:
      return (
        <group position={[0, top + 0.95 * 0.75, 0]} scale={0.75}>
          <ComputeRack />
        </group>
      );
    case 2:
      return (
        <>
          <group position={[0, top + 0.6, 0.3]} rotation={[1.0, 0, 0]}>
            <ESP32 />
          </group>
          <group position={[0, top + 0.28, -0.35]} scale={0.3}>
            <Printer interactive={false} />
          </group>
        </>
      );
    case 3:
      return (
        <>
          <group position={[0, top + 0.75, 0.2]} scale={0.7}>
            <AuthToken state="signed" />
          </group>
          <group position={[0.35, top + 0.6, -0.4]} scale={0.6}>
            <Quote />
          </group>
        </>
      );
    default:
      return (
        <>
          <group position={[0, top + 0.08, 0.2]} scale={0.8}>
            <Ledger count={4} />
          </group>
          <group position={[0, top + 1.5, 0.1]} scale={0.5}>
            <VerifyLattice />
          </group>
        </>
      );
  }
}

export function TechZone({ reduced }: { reduced: boolean }) {
  const s = useUI();
  const sel = s.tech;
  return (
    <Zone x={220}>
      {TECH_X.map((x, i) => (
        <group key={i}>
          <Plinth x={x} w={2.2} d={2.0} h={0.5} />
          <SelectRing position={[x, 0, 0]} on={sel === i} />
          <Selectable position={[x, GROUND_Y + 0.5, 0]} selected={sel === i} onSelect={() => ui.set({ tech: sel === i ? -1 : i })}>
            <group position={[0, -(GROUND_Y + 0.5), 0]}>
              <TechModule i={i} />
            </group>
          </Selectable>
          <Tag position={[x, 2.3, 0]} hot={sel === i}>
            {`0${i + 1} · ${TECH_NAMES[i]}`}
          </Tag>
        </group>
      ))}
      {TECH_LINKS.map(([a, b], k) => {
        const lvl = sel < 0 ? 0.55 : a === sel || b === sel ? 1 : 0.05;
        const far = Math.abs(a - b) > 1;
        return (
          <ConnectionLine
            key={k}
            from={[TECH_X[a] + 0.6, far ? GROUND_Y + 0.52 : 0.9, far ? 0.9 : 0]}
            to={[TECH_X[b] - 0.6, far ? GROUND_Y + 0.52 : 0.9, far ? 0.9 : 0]}
            level={lvl}
            reduced={reduced}
            lift={far ? 0.02 : 0.12}
          />
        );
      })}
    </Zone>
  );
}

/* =============================== PRIVACY ================================ */

export function PrivacyZone({ reduced }: { reduced: boolean }) {
  const s = useUI();
  const p = s.privacy;
  const hash = useRef<THREE.Mesh>(null);
  const localDoc = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = reduced ? 0.6 : (clock.elapsedTime % 3.2) / 3.2;
    if (hash.current) {
      const x0 = PRIV_X[3] - 0.2;
      const x1 = PRIV_X[3] + 2.4;
      const u = smooth(t);
      hash.current.position.set(THREE.MathUtils.lerp(x0, x1, u), 0.2 + Math.sin(u * Math.PI) * 0.9, 0.2);
      hash.current.visible = p === 3;
    }
    if (localDoc.current) {
      const u = p === 0 ? smooth(t) : 1;
      localDoc.current.position.set(PRIV_X[0] - 1.5 + 1.5 * u, 0.45 + Math.sin(u * Math.PI) * 0.6, 0.2);
    }
  });

  const x0 = PRIV_X[0];
  const x1 = PRIV_X[1];
  const x2 = PRIV_X[2];
  const x3 = PRIV_X[3];
  return (
    <Zone x={262}>
      {/* 01 Local processing: the document stays inside the local boundary */}
      <Plinth x={x0} w={2.4} d={1.8} h={0.8} />
      <group position={[x0, GROUND_Y + 0.8 + 0.36, -0.2]} scale={0.8}>
        <Gateway reduced={reduced} />
      </group>
      <group ref={localDoc} scale={0.45}>
        <Document />
      </group>
      <mesh position={[x0, GROUND_Y + 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.35, 2.39, 96]} />
        <meshBasicMaterial color="#F15A36" />
      </mesh>
      <Tag position={[x0, 1.4, 0]} hot={p === 0}>Local boundary · shop gateway</Tag>

      {/* 02 Selectable AI trust */}
      {[-1.35, 0, 1.35].map((dx, i) => (
        <group key={i}>
          <group position={[x1 + dx, GROUND_Y + 0.08, 0]} scale={0.55}>
            <PrivacyShell open={p === 1 && i === 0 ? 1 : 0} />
          </group>
          <BlobShadow position={[x1 + dx, 0, 0]} size={2} opacity={0.4} />
          <Tag position={[x1 + dx, 0.35, 0.3]} hot={p === 1 && i === 0}>
            {['Private', 'Verified', 'Standard'][i]}
          </Tag>
        </group>
      ))}

      {/* 03 Controlled payments: agent passes only through an explicit limit gate */}
      <group position={[x2 - 1.2, 0.5, 0.3]} scale={0.6}>
        <AuthToken state="signed" />
      </group>
      {[-0.55, 0.55].map((dz) => (
        <mesh key={dz} position={[x2 + 0.3, 0.05, dz]} material={matMatteBlack}>
          <boxGeometry args={[0.1, 2.0, 0.1]} />
        </mesh>
      ))}
      <mesh position={[x2 + 0.3, 0.75, 0]} material={matSignal}>
        <boxGeometry args={[0.08, 0.08, 1.2]} />
      </mesh>
      <Plinth x={x2 + 1.8} w={1.8} d={1.4} h={0.8} />
      <group position={[x2 + 1.8, GROUND_Y + 0.8 + 0.3, 0]} scale={0.65}>
        <Gateway reduced={reduced} />
      </group>
      <ConnectionLine from={[x2 - 0.8, 0.5, 0.3]} to={[x2 + 1.3, 0.3, 0]} level={p === 2 ? 1 : 0.3} reduced={reduced} lift={0.1} />
      <Tag position={[x2 + 0.3, 1.35, 0]} hot={p === 2}>Spending limit</Tag>

      {/* 04 Minimal on-chain data */}
      <Plinth x={x3 - 0.2} w={1.8} d={1.6} h={0.5} />
      <group position={[x3 - 0.2, GROUND_Y + 0.52, 0]} scale={0.7}>
        <Document />
      </group>
      <group position={[x3 + 2.4, GROUND_Y + 0.08, 0]} scale={0.7}>
        <Ledger count={4} />
      </group>
      <mesh ref={hash} material={matSignal}>
        <boxGeometry args={[0.16, 0.16, 0.16]} />
      </mesh>
      <Tag position={[x3 - 0.2, 0.25, 0.4]}>Document · stays off-chain</Tag>
      <Tag position={[x3 + 2.4, 0.45, 0]} hot={p === 3}>Job reference only</Tag>
    </Zone>
  );
}

/* ============================== DEVELOPERS ============================== */

const DEV_LABELS = ['Self-hosted gateway', 'Job API', 'Device bridge', 'Agent interface', 'Chain adapter', 'Storage module'];

export function DevZone({ reduced }: { reduced: boolean }) {
  const cells = [-3.4, 0, 3.4].flatMap((x, c) => [-1.1, 1.1].map((z, r) => ({ x: DEV_X + x, z, k: c * 2 + r })));
  return (
    <Zone x={DEV_X}>
      <RoundedBox args={[11, 0.12, 5.4]} radius={0.04} smoothness={2} position={[DEV_X, GROUND_Y + 0.06, 0]} material={matMatteBlack} />
      {cells.map(({ x, z, k }) => (
        <group key={k}>
          <group position={[x, GROUND_Y + 0.12, z]}>
            {k % 3 === 0 ? (
              <group position={[0, 0.45 * 0.7, 0]} scale={0.7}>
                <Gateway reduced={reduced} />
              </group>
            ) : k % 3 === 1 ? (
              <group position={[0, 0.04, 0]}>
                <ESP32 reduced={reduced} />
              </group>
            ) : (
              <group position={[0, 0.95 * 0.55, 0]} scale={0.55}>
                <ComputeRack lit={0.5} />
              </group>
            )}
          </group>
          <Tag position={[x, 0.55, z]}>{DEV_LABELS[k]}</Tag>
        </group>
      ))}
      {cells.slice(0, -2).map(({ x, z, k }) => (
        <ConnectionLine key={k} from={[x + 0.8, GROUND_Y + 0.2, z]} to={[x + 2.6, GROUND_Y + 0.2, z]} reduced={reduced} lift={0.02} level={0.8} />
      ))}
      {[-3.4, 0, 3.4].map((x, k) => (
        <ConnectionLine key={`v${k}`} from={[DEV_X + x, GROUND_Y + 0.2, -0.5]} to={[DEV_X + x, GROUND_Y + 0.2, 0.5]} reduced={reduced} lift={0.02} level={0.6} />
      ))}
    </Zone>
  );
}

/* ================================ FINAL ================================= */

export function FinalZone({ reduced }: { reduced: boolean }) {
  const ctl = useRef<PrinterCtl>({ emerge: 0, active: 0 });
  useFrame(() => {
    const on = live.active === 'final';
    ctl.current.active = on ? 1 : 0;
    ctl.current.emerge = on ? (reduced ? 1 : smooth(live.local * 1.6 - 0.05)) : 0;
  });
  const x = FINAL_X;
  return (
    <Zone x={x}>
      <group position={[x, 0, 0]}>
        <Printer ctl={ctl} />
      </group>
      <BlobShadow position={[x, 0, 0.4]} size={6.5} />
      <pointLight position={[x + 1.5, 3.2, 3.5]} intensity={18} distance={14} decay={2} color="#ffffff" />
      <group position={[x - 3.6, GROUND_Y + 0.05, 1.6]} rotation={[-Math.PI / 2, 0, 0.3]}>
        <Phone screen="pay" />
      </group>
      <group position={[x + 3.6, GROUND_Y + 0.45, -1.4]}>
        <Gateway reduced={reduced} />
      </group>
      <group position={[x + 3.9, GROUND_Y + 0.04, 1.4]}>
        <ESP32 reduced={reduced} />
      </group>
      <ConnectionLine from={[x - 3.2, GROUND_Y + 0.1, 1.2]} to={[x - 1.7, -0.6, 0.6]} reduced={reduced} lift={0.05} />
      <ConnectionLine from={[x + 2.8, -0.5, -1.2]} to={[x + 1.7, -0.6, -0.4]} reduced={reduced} lift={0.05} />
      <ConnectionLine from={[x + 3.4, GROUND_Y + 0.1, 1.4]} to={[x + 1.7, -0.6, 0.6]} reduced={reduced} lift={0.05} />
    </Zone>
  );
}
