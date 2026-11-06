/**
 * Turns the event currently being played into cursor motion inside the
 * printer settings window.
 *
 * Every motion is anchored to a real event:
 *   tool_started           -> cursor goes to the control the tool operates
 *                             (switching settings tab first, like a person),
 *                             opens the dropdown / aims at the option the
 *                             tool's REAL input asked for
 *   configuration_updated  -> the click that sets the value (shown as
 *                             "awaiting confirmation")
 *   tool_succeeded         -> the backend-confirmed result (check mark)
 *   tool_failed            -> the real error, nothing is marked done
 * With no event, the cursor rests.
 */
import { useEffect, useRef, useState } from 'react';
import type { OperatorEvent } from '@inklink/shared-schemas';
import { FIELD_CONTROL, TOOL_CONTROL, TOOL_LABEL, type ControlId } from '../lib/operatorState';

export type SettingsTab = 'general' | 'layout' | 'paper';

export const TAB_LABEL: Record<SettingsTab, string> = { general: 'General', layout: 'Layout', paper: 'Paper / Quality' };

/** Where each control lives in the settings window. Null = always visible (header / footer). */
export const CONTROL_TAB: Record<ControlId, SettingsTab | null> = {
  document: null,
  printer: 'general',
  copies: 'general',
  validate: null,
  submit: null,
  orientation: 'layout',
  sides: 'layout',
  paperSize: 'paper',
  colorMode: 'paper',
};

export const DROPDOWN_CONTROLS: ControlId[] = ['printer', 'paperSize', 'sides'];
export const RADIO_CONTROLS: ControlId[] = ['colorMode', 'orientation'];

export interface Visual {
  /** `data-cursor` key the pointer rests on; null = parked. */
  cursorKey: string | null;
  /** Increments on every click so the ripple replays. */
  clickTick: number;
  tab: SettingsTab;
  menu: { control: ControlId; highlight: string | null } | null;
  /** Option the agent is aiming at (radio / dropdown), before it is applied. */
  aim: { control: ControlId; value: string } | null;
  /** Characters typed into the copies field (not committed yet). */
  typing: { control: ControlId; text: string } | null;
  /** Short, factual caption next to the cursor. */
  caption: { text: string; tone: 'working' | 'pending' | 'ok' | 'error' } | null;
}

const PARKED: Visual = { cursorKey: null, clickTick: 0, tab: 'general', menu: null, aim: null, typing: null, caption: null };

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

const VALUE_WORDS: Record<string, string> = {
  monochrome: 'Black & white',
  color: 'Colour',
  portrait: 'Portrait',
  landscape: 'Landscape',
  'one-sided': 'One-sided',
  'two-sided-long-edge': 'Two-sided (long edge)',
  'two-sided-short-edge': 'Two-sided (short edge)',
};

function startCaption(tool: string, value: string | null): string {
  const v = value ? VALUE_WORDS[value] ?? value : null;
  switch (tool) {
    case 'list_printers':
      return 'Looking for printers on this computer';
    case 'check_printer_readiness':
      return `Selecting ${v ?? 'printer'} and checking it is ready`;
    case 'validate_print_config':
      return 'Validating settings with the printer';
    case 'request_print_execution':
      return 'Applying: asking the backend to print';
    case 'inspect_document':
      return 'Reading the document';
    case 'plan_operations':
      return 'Planning document edits';
    case 'execute_operation_plan':
      return 'Applying document edits';
    default:
      return `${TOOL_LABEL[tool] ?? tool}${v ? ` → ${v}` : ''}`;
  }
}

export function useVisual(current: OperatorEvent | null, reducedMotion: boolean): Visual {
  const [v, setV] = useState<Visual>(PARKED);
  const tabRef = useRef(v.tab);
  tabRef.current = v.tab;

  useEffect(() => {
    if (!current) {
      setV(PARKED);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, reducedMotion ? 0 : ms));

    switch (current.type) {
      case 'tool_started': {
        const tool = current.payload.tool;
        const control = TOOL_CONTROL[tool];
        if (!control) break;
        const value = targetValue(tool, current.payload.input ?? {});
        const tab = CONTROL_TAB[control];
        const caption = { text: startCaption(tool, value), tone: 'working' as const };
        const needTab = tab !== null && tab !== tabRef.current;
        let t = 0;
        if (needTab) {
          // Click the settings tab first, then reach for the control, like a person would.
          setV((p) => ({ ...p, cursorKey: `tab:${tab}`, menu: null, aim: null, typing: null, caption }));
          later(320, () => setV((q) => ({ ...q, tab: tab!, clickTick: q.clickTick + 1 })));
          t = 620;
          later(t, () => setV((p) => ({ ...p, cursorKey: control })));
        } else {
          setV((p) => ({ ...p, cursorKey: control, menu: null, aim: null, typing: null, caption }));
        }
        later(t + 380, () => setV((p) => ({ ...p, clickTick: p.clickTick + 1 })));
        t += 380;
        if (DROPDOWN_CONTROLS.includes(control)) {
          later(t + 260, () => setV((p) => ({ ...p, menu: { control, highlight: value } })));
          if (value) later(t + 600, () => setV((p) => ({ ...p, cursorKey: `${control}:${value}`, aim: { control, value } })));
        } else if (RADIO_CONTROLS.includes(control) && value) {
          later(t + 280, () => setV((p) => ({ ...p, cursorKey: `${control}:${value}`, aim: { control, value } })));
        } else if (control === 'copies' && value) {
          later(t + 300, () => setV((p) => ({ ...p, typing: { control, text: value } })));
        }
        break;
      }
      case 'configuration_updated': {
        const control = FIELD_CONTROL[current.payload.field];
        setV((p) => ({
          ...p,
          tab: CONTROL_TAB[control] ?? p.tab,
          cursorKey: p.cursorKey?.startsWith(`${control}:`) ? p.cursorKey : control,
          clickTick: p.clickTick + 1,
          caption: { text: 'Set. Waiting for the tool result…', tone: 'pending' },
        }));
        later(260, () => setV((p) => ({ ...p, menu: null, typing: null, aim: null })));
        break;
      }
      case 'tool_succeeded': {
        const control = TOOL_CONTROL[current.payload.tool];
        setV((p) => ({
          ...p,
          menu: p.menu?.control === control ? null : p.menu,
          typing: null,
          aim: null,
          caption: { text: 'Confirmed by the tool result', tone: 'ok' },
        }));
        break;
      }
      case 'tool_failed': {
        setV((p) => ({
          ...p,
          menu: null,
          typing: null,
          aim: null,
          caption: { text: `Failed: ${current.payload.error.message}`, tone: 'error' },
        }));
        break;
      }
      case 'agent_finished':
        setV((p) => ({ ...p, cursorKey: null, menu: null, typing: null, aim: null, caption: null }));
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
