import { useSyncExternalStore } from 'react';

/** React-visible UI selections that also steer the 3D camera. */
export type UIState = {
  workshop: number; // 0..2
  tech: number; // -1 = full architecture, 0..4
  pay: 'offline' | 'online';
  privacy: number; // 0..3
  introStart: number; // performance.now() when preloader finished, -1 before
};

let state: UIState = { workshop: 0, tech: -1, pay: 'offline', privacy: 0, introStart: -1 };
const subs = new Set<() => void>();

export const ui = {
  get: () => state,
  set(p: Partial<UIState>) {
    state = { ...state, ...p };
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

export const useUI = () => useSyncExternalStore(ui.subscribe, ui.get);

/** Per-frame mutable scene state (not React state). Written by the Scene, read by zones. */
export const live = {
  active: 'hero',
  local: 0,
  f: 0, // workflow progress 0..5
  dark: 0, // 0 = paper environment, 1 = ink environment
};
