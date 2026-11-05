import * as THREE from 'three';
import type { UIState } from '../lib/store';

/**
 * The atelier is one continuous world. Each story beat lives in its own zone
 * along the X axis; the camera flies between zones as the reader scrolls.
 */
export const GROUND_Y = -0.95;

export { SECTION_ORDER } from '../lib/sections';

export const WS_X = [34, 40, 46];
export const WF = { phone: 74, shop: 79, chips: 82.6, token: 76.5, printer: 89 };
export const LOCAL = { phone: 133, gateway: 138, esp: 143, printer: 149 };
export const PAY = { offline: 172.5, online: 188 };
export const TECH_X = [0, 1, 2, 3, 4].map((i) => 220 + (i - 2) * 3.7);
export const PRIV_X = [0, 1, 2, 3].map((i) => 253 + i * 5.5);
export const DEV_X = 300;
export const FINAL_X = 340;

const smooth = (x: number) => {
  x = THREE.MathUtils.clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

type V3 = [number, number, number];
export const pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
const set = (p: V3, t: V3) => {
  pose.pos.set(...p);
  pose.target.set(...t);
};

const WF_POSES: { p: V3; t: V3 }[] = [
  { p: [78.8, 2.4, 7.6], t: [76.5, 0.8, 0] },
  { p: [78.2, 2.9, 7.2], t: [77, 1.2, 0] },
  { p: [83.6, 2.6, 7.4], t: [81.0, 0.9, 0] },
  { p: [77.6, 2.5, 7.6], t: [77, 1.1, 0] },
  { p: [92.6, 2.3, 6.8], t: [88.6, 0.1, 0] },
];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export function computePose(active: string, local: number, f: number, s: UIState) {
  switch (active) {
    case 'hero':
      set([4.6 - 2.2 * local, 2.3 - 0.3 * local, 7.2 - 1.0 * local], [0, 0.1, 0]);
      break;
    case 'workshop': {
      const x = WS_X[s.workshop] ?? WS_X[0];
      set([x + 1.8, 1.9, 6.4], [x, 0.55, 0]);
      break;
    }
    case 'workflow': {
      const i = Math.min(Math.floor(f), 4);
      const n = Math.min(i + 1, 4);
      // hold each pose while its step plays, then travel in the last third
      const u = i === 4 ? 0 : smooth((f - i - 0.68) / 0.32);
      _a.set(...WF_POSES[i].p).lerp(_b.set(...WF_POSES[n].p), u);
      pose.pos.copy(_a);
      _a.set(...WF_POSES[i].t).lerp(_b.set(...WF_POSES[n].t), u);
      pose.target.copy(_a);
      break;
    }
    case 'local': {
      const x = 131 + 15 * local;
      set([x, 3.0, 11.5], [x + 0.5, 0.3, 0]);
      break;
    }
    case 'offlinepay': {
      const x = s.pay === 'online' ? PAY.online + 0.4 : PAY.offline;
      set([x + 1, 3.0, 11.4], [x, 0.7, 0]);
      break;
    }
    case 'technology': {
      if (s.tech < 0) set([220, 3.2, 15.5], [220, 0.8, 0]);
      else {
        const x = TECH_X[s.tech];
        set([x + 1.4, 2.0, 6.8], [x, 0.7, 0]);
      }
      break;
    }
    case 'privacy': {
      const x = PRIV_X[s.privacy] ?? PRIV_X[0];
      const off = s.privacy === 3 ? 1.1 : 0;
      set([x + off + 1.6, 2.0, 7.4], [x + off, 0.7, 0]);
      break;
    }
    case 'developers': {
      const x = DEV_X - 3 + 6 * local;
      set([x, 2.3, 10.8], [x, 0.6, 0]);
      break;
    }
    default:
      set([FINAL_X + 3 - 1.2 * local, 2.1, 7.8], [FINAL_X, 0.15, 0]);
  }
}
