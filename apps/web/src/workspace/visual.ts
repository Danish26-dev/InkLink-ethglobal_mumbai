/**
 * Turns the event currently being played into cursor / menu motion.
 *
 * Every motion is anchored to a real event: a menu opens because a tool started
 * with that input, the highlighted option is the tool's actual input value, and
 * the menu closes when `configuration_updated` (the value really changed) or a
 * tool result arrives. Nothing moves without an event.
 */
import { useEffect, useState } from 'react';
import type { OperatorEvent } from '@inklink/shared-schemas';
import { FIELD_CONTROL, TOOL_CONTROL, type ControlId } from '../lib/operatorState';

export const DROPDOWN_CONTROLS: ControlId[] = ['printer', 'paperSize', 'colorMode', 'orientation', 'sides'];

export interface Visual {
  /** `data-cursor` key the pointer should rest on; null = parked. */
  cursorKey: string | null;
  /** Increments on every click so the ripple replays. */
  clickTick: number;
  menu: { control: ControlId; highlight: string | null } | null;
  /** Characters being typed into a numeric field (not committed yet). */
  typing: { control: ControlId; text: string } | null;
}

const PARKED: Visual = { cursorKey: null, clickTick: 0, menu: null, typing: null };

/** The value a tool asked for, in the control's option vocabulary. */
export function targetValue(tool: string, input: Record<string, unknown>): string | null {
  switch (tool) {
    case 'check_printer_readiness':
      return typeof input.printerId === 'string' ? input.printerId : null;
    case 'set_paper_size':
      return typeof input.paperSize === 'string' ? input.paperSize : null;
    case 'set_color_mode':
      return typeof input.colorMode === 'string' ? input.colorMode : null;
    case 'set_orientation':
      return typeof input.orientation === 'string' ? input.orientation : null;
    case 'set_duplex':
      if (input.enabled === false) return 'one-sided';
      if (input.enabled === true) return input.binding === 'short-edge' ? 'two-sided-short-edge' : 'two-sided-long-edge';
      return null;
    case 'set_copies':
      return typeof input.copies === 'number' ? String(input.copies) : null;
    default:
      return null;
  }
}

export function useVisual(current: OperatorEvent | null, reducedMotion: boolean): Visual {
  const [v, setV] = useState<Visual>(PARKED);

  useEffect(() => {
    if (!current) {
      setV(PARKED);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, reducedMotion ? 0 : ms));

    switch (current.type) {
      case 'tool_started': {
        const control = TOOL_CONTROL[current.payload.tool];
        if (!control) break;
        const value = targetValue(current.payload.tool, current.payload.input ?? {});
        setV((p) => ({ ...p, cursorKey: control, clickTick: p.clickTick + 1, menu: null, typing: null }));
        if (DROPDOWN_CONTROLS.includes(control)) {
          later(380, () => setV((p) => ({ ...p, menu: { control, highlight: value } })));
          if (value) later(700, () => setV((p) => ({ ...p, cursorKey: `${control}:${value}` })));
        } else if (control === 'copies' && value) {
          later(380, () => setV((p) => ({ ...p, typing: { control, text: value } })));
        }
        break;
      }
      case 'configuration_updated': {
        const control = FIELD_CONTROL[current.payload.field];
        setV((p) => ({
          ...p,
          // Click the option (or confirm the typed number) that the tool selected.
          cursorKey: p.menu?.control === control && p.cursorKey?.startsWith(`${control}:`) ? p.cursorKey : control,
          clickTick: p.clickTick + 1,
        }));
        later(260, () => setV((p) => ({ ...p, menu: null, typing: null, cursorKey: control })));
        break;
      }
      case 'tool_succeeded':
      case 'tool_failed': {
        const control = TOOL_CONTROL[current.payload.tool];
        setV((p) => ({
          ...p,
          menu: p.menu?.control === control ? null : p.menu,
          typing: p.typing?.control === control ? null : p.typing,
        }));
        break;
      }
      case 'agent_finished':
        setV((p) => ({ ...p, cursorKey: null, menu: null, typing: null }));
        break;
      default:
        break;
    }
    return () => timers.forEach(clearTimeout);
    // Re-run only when a different event becomes current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.seq, current?.jobId]);

  return v;
}
