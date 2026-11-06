import { describe, expect, it } from 'vitest';
import type { OperatorEvent } from '@inklink/shared-schemas';
import { foldEvents } from './operatorState';
import { targetValue } from '../workspace/visual';

let seq = 0;
const ev = (type: OperatorEvent['type'], payload: Record<string, unknown>, source = 'agent') =>
  ({ seq: ++seq, jobId: 'job_1', type, source, ts: '2026-11-05T10:00:00Z', payload }) as unknown as OperatorEvent;

describe('operator state fold', () => {
  it('changes a value only on configuration_updated and marks success only on tool_succeeded', () => {
    const started = [
      ev('agent_started', { runId: 'r', provider: '0g-private-computer', model: 'm', trustMode: 'private', instruction: 'A4' }),
      ev('tool_started', { runId: 'r', toolUseId: 't1', tool: 'set_paper_size', input: { paperSize: 'A4' } }),
    ];
    let s = foldEvents(started);
    expect(s.config.paperSize).toBeNull(); // the tool started, nothing changed yet
    expect(s.controlTool.paperSize?.status).toBe('running');

    const updated = [...started, ev('configuration_updated', { runId: 'r', toolUseId: 't1', field: 'paperSize', value: 'A4', config: { paperSize: 'A4' } })];
    s = foldEvents(updated);
    expect(s.config.paperSize).toBe('A4');
    expect(s.controlTool.paperSize?.status).toBe('running');

    s = foldEvents([...updated, ev('tool_succeeded', { runId: 'r', toolUseId: 't1', tool: 'set_paper_size', result: { ok: true } })]);
    expect(s.controlTool.paperSize?.status).toBe('succeeded');
  });

  it('keeps the real error on tool_failed and does not change the value', () => {
    const s = foldEvents([
      ev('tool_started', { runId: 'r', toolUseId: 't2', tool: 'check_printer_readiness', input: { printerId: 'Old Inkjet' } }),
      ev('printer_readiness_updated', { printerId: 'Old Inkjet', status: 'offline', available: false }),
      ev('tool_failed', { runId: 'r', toolUseId: 't2', tool: 'check_printer_readiness', error: { code: 'PRINTER_UNAVAILABLE', message: 'offline' } }),
    ]);
    expect(s.config.printerId).toBeNull();
    expect(s.controlTool.printer?.status).toBe('failed');
    expect(s.controlTool.printer?.error?.code).toBe('PRINTER_UNAVAILABLE');
    expect(s.readiness?.available).toBe(false);
  });

  it('invalidates validation when the configuration changes afterwards', () => {
    const s = foldEvents([
      ev('tool_started', { runId: 'r', toolUseId: 'v', tool: 'validate_print_config', input: {} }),
      ev('tool_succeeded', { runId: 'r', toolUseId: 'v', tool: 'validate_print_config', result: { ok: true } }),
      ev('configuration_updated', { runId: 'r', toolUseId: 'c', field: 'copies', value: 3, config: { copies: 3 } }),
    ]);
    expect(s.validated).toBe(false);
  });

  it('reports an unavailable provider without any tool activity', () => {
    const s = foldEvents([ev('agent_finished', { runId: 'r', outcome: 'unavailable', message: 'ZEROG_API_KEY is not set.' })]);
    expect(s.phase).toBe('unavailable');
    expect(s.tools).toHaveLength(0);
  });
});

describe('cursor targets come from the tool input', () => {
  it('maps duplex input to the option value', () => {
    expect(targetValue('set_duplex', { enabled: true })).toBe('two-sided-long-edge');
    expect(targetValue('set_duplex', { enabled: true, binding: 'short-edge' })).toBe('two-sided-short-edge');
    expect(targetValue('set_duplex', { enabled: false })).toBe('one-sided');
    expect(targetValue('list_printers', {})).toBeNull();
  });
});
