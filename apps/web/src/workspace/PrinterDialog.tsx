import { Check, ChevronDown, Loader2, Minus, Plus, Printer, TriangleAlert, FileText } from 'lucide-react';
import {
  OPERATOR_COLOR_MODES,
  OPERATOR_ORIENTATIONS,
  OPERATOR_PAPER_SIZES,
  OPERATOR_SIDES,
  type JobView,
  type PrinterSummary,
} from '@inklink/shared-schemas';
import type { ControlId, OperatorState, ToolCall } from '../lib/operatorState';
import type { Visual } from './visual';

export const PAPER_LABEL: Record<string, string> = {
  A4: 'A4 · 210 × 297 mm',
  Letter: 'Letter · 8.5 × 11 in',
  Legal: 'Legal · 8.5 × 14 in',
};
export const COLOR_LABEL: Record<string, string> = { color: 'Colour', monochrome: 'Black & white' };
export const ORIENTATION_LABEL: Record<string, string> = { portrait: 'Portrait', landscape: 'Landscape' };
export const SIDES_LABEL: Record<string, string> = {
  'one-sided': 'One-sided',
  'two-sided-long-edge': 'Two-sided · flip on long edge',
  'two-sided-short-edge': 'Two-sided · flip on short edge',
};
const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], Letter: [216, 279], Legal: [216, 356] };

interface Option {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface Props {
  state: OperatorState;
  visual: Visual;
  document: JobView['document'];
}

export function PrinterDialog({ state, visual, document }: Props) {
  const { config } = state;
  const printers = printerOptions(state.printers, visual);
  const printerName = state.printers.find((p) => p.id === config.printerId)?.name ?? config.printerId;
  const listing = state.controlTool.printer?.tool === 'list_printers' && state.controlTool.printer.status === 'running';

  return (
    <div className="card w-full max-w-[760px] overflow-visible shadow-[0_24px_60px_-28px_rgba(17,17,17,0.45)]">
      {/* Window chrome */}
      <div className="flex items-center gap-3 rounded-t-xl border-b border-light-grey bg-[#F3F3F0] px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-3 w-3 rounded-full bg-[#E5E5E1]" />
          <span className="h-3 w-3 rounded-full bg-[#E5E5E1]" />
          <span className="h-3 w-3 rounded-full bg-[#E5E5E1]" />
        </div>
        <Printer className="h-4 w-4 text-graphite" aria-hidden="true" />
        <h2 className="text-sm font-medium">Print</h2>
        <span className="ml-auto font-mono text-[11px] text-graphite">operated by Inklink</span>
      </div>

      <div className="grid gap-6 p-5 md:grid-cols-[220px_1fr]">
        <PagePreview state={state} document={document} />

        <div className="flex flex-col gap-3">
          <DocumentStrip state={state} document={document} />

          <Row label="Printer" control="printer" state={state} visual={visual}
            value={printerName ? printerName : null}
            adornment={state.readiness && config.printerId === state.readiness.printerId ? <ReadinessDot status={state.readiness.status} /> : null}
            options={printers}
            emptyMenu={listing ? 'Searching for printers on this computer…' : 'No printers discovered yet.'} />
          <Row label="Paper size" control="paperSize" state={state} visual={visual}
            value={config.paperSize ? PAPER_LABEL[config.paperSize] : null}
            options={OPERATOR_PAPER_SIZES.map((v) => ({ value: v, label: PAPER_LABEL[v] }))} />
          <Row label="Colour" control="colorMode" state={state} visual={visual}
            value={config.colorMode ? COLOR_LABEL[config.colorMode] : null}
            options={OPERATOR_COLOR_MODES.map((v) => ({ value: v, label: COLOR_LABEL[v] }))} />
          <CopiesRow state={state} visual={visual} />
          <Row label="Orientation" control="orientation" state={state} visual={visual}
            value={config.orientation ? ORIENTATION_LABEL[config.orientation] : null}
            options={OPERATOR_ORIENTATIONS.map((v) => ({ value: v, label: ORIENTATION_LABEL[v] }))} />
          <Row label="Two-sided" control="sides" state={state} visual={visual}
            value={config.sides ? SIDES_LABEL[config.sides] : null}
            options={OPERATOR_SIDES.map((v) => ({ value: v, label: SIDES_LABEL[v] }))} />

          <div className="grid grid-cols-[110px_1fr] items-center gap-3">
            <span className="text-sm text-graphite">Quality</span>
            <div className="rounded-md border border-dashed border-light-grey px-3 py-2 text-sm text-graphite" aria-disabled="true">
              Driver default · not configurable via adapter
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-light-grey pt-4">
            <ActionButton control="validate" label="Validate with printer" state={state} visual={visual}
              done={state.validated} doneLabel="Validated" />
            <ActionButton control="submit" label="Request print" state={state} visual={visual} primary
              done={state.executionRequested} doneLabel="Requested" />
          </div>
          <ToolMessage call={state.controlTool.validate} />
          <ToolMessage call={state.controlTool.submit} />
        </div>
      </div>
    </div>
  );
}

/* ───────────── rows ───────────── */

function printerOptions(list: PrinterSummary[], visual: Visual): Option[] {
  const opts: Option[] = list.map((p) => ({
    value: p.id,
    label: p.name,
    hint: `${p.status}${p.isDefault ? ' · default' : ''}`,
    disabled: p.status === 'offline' || p.status === 'not_found',
  }));
  const wanted = visual.menu?.control === 'printer' ? visual.menu.highlight : null;
  if (wanted && !opts.some((o) => o.value === wanted)) opts.push({ value: wanted, label: wanted, hint: 'not discovered' });
  return opts;
}

function rawValue(state: OperatorState, control: ControlId): string | null {
  const c = state.config;
  const map: Partial<Record<ControlId, string | number | null>> = {
    printer: c.printerId,
    paperSize: c.paperSize,
    colorMode: c.colorMode,
    orientation: c.orientation,
    sides: c.sides,
    copies: c.copies,
  };
  const v = map[control];
  return v === null || v === undefined ? null : String(v);
}

function fieldTouched(state: OperatorState, control: ControlId): boolean {
  const field = control === 'printer' ? 'printerId' : control;
  return Boolean((state.touched as Record<string, number | undefined>)[field]);
}

interface RowProps {
  label: string;
  control: ControlId;
  state: OperatorState;
  visual: Visual;
  value: string | null;
  options: Option[];
  adornment?: React.ReactNode;
  emptyMenu?: string;
}

function Row({ label, control, state, visual, value, options, adornment, emptyMenu }: RowProps) {
  const call = state.controlTool[control];
  const open = visual.menu?.control === control;
  const selected = rawValue(state, control);
  const menuId = `menu-${control}`;
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3">
      <span className="pt-2 text-sm text-graphite" id={`label-${control}`}>
        {label}
      </span>
      <div className="relative">
        <div
          data-cursor={control}
          role="combobox"
          aria-labelledby={`label-${control}`}
          aria-expanded={open}
          aria-controls={menuId}
          aria-readonly="true"
          className={`flex min-h-[38px] items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm transition-colors ${
            open ? 'border-ink ring-2 ring-ink/10' : call?.status === 'failed' ? 'border-signal' : 'border-light-grey'
          }`}
        >
          {adornment}
          <span className={value ? 'text-ink' : 'text-graphite'}>{value ?? 'Not set'}</span>
          {fieldTouched(state, control) && <span className="h-1.5 w-1.5 rounded-full bg-signal" title="Set by the operator in this run" />}
          <span className="ml-auto flex items-center gap-2">
            <StatusIcon call={call} />
            <ChevronDown className={`h-4 w-4 text-graphite transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        </div>
        {open && (
          <ul id={menuId} role="listbox" aria-labelledby={`label-${control}`}
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-md border border-ink/15 bg-white py-1 shadow-xl">
            {options.length === 0 && <li className="px-3 py-2 text-sm text-graphite">{emptyMenu ?? 'No options.'}</li>}
            {options.map((o) => {
              const highlighted = visual.menu?.highlight === o.value;
              return (
                <li key={o.value} role="option" aria-selected={selected === o.value} aria-disabled={o.disabled}
                  data-cursor={`${control}:${o.value}`}
                  className={`flex items-center gap-2 px-3 py-2 text-sm ${highlighted ? 'bg-ink text-paper' : ''} ${
                    o.disabled && !highlighted ? 'text-graphite' : ''
                  }`}>
                  <span className="w-4">{selected === o.value && <Check className="h-4 w-4" aria-hidden="true" />}</span>
                  <span>{o.label}</span>
                  {o.hint && <span className={`ml-auto font-mono text-[11px] ${highlighted ? 'text-paper/70' : 'text-graphite'}`}>{o.hint}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <ToolMessage call={call} />
      </div>
    </div>
  );
}

function CopiesRow({ state, visual }: { state: OperatorState; visual: Visual }) {
  const call = state.controlTool.copies;
  const typing = visual.typing?.control === 'copies' ? visual.typing.text : null;
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3">
      <span className="pt-2 text-sm text-graphite" id="label-copies">Copies</span>
      <div>
        <div className="flex items-center gap-2">
          <span className="flex h-[38px] w-9 items-center justify-center rounded-md border border-light-grey text-graphite" aria-hidden="true">
            <Minus className="h-4 w-4" />
          </span>
          <div data-cursor="copies" role="spinbutton" aria-labelledby="label-copies" aria-readonly="true"
            aria-valuenow={state.config.copies ?? undefined}
            className={`flex h-[38px] w-24 items-center justify-center gap-1 rounded-md border bg-white font-mono text-sm ${
              typing ? 'border-ink ring-2 ring-ink/10' : call?.status === 'failed' ? 'border-signal' : 'border-light-grey'
            }`}>
            {typing ? (
              <>
                <span className="bg-ink/10 px-0.5">{typing}</span>
                <span className="h-4 w-px animate-pulse bg-ink" aria-hidden="true" />
              </>
            ) : (
              <span className={state.config.copies ? '' : 'text-graphite'}>{state.config.copies ?? '—'}</span>
            )}
          </div>
          <span className="flex h-[38px] w-9 items-center justify-center rounded-md border border-light-grey text-graphite" aria-hidden="true">
            <Plus className="h-4 w-4" />
          </span>
          {fieldTouched(state, 'copies') && <span className="h-1.5 w-1.5 rounded-full bg-signal" title="Set by the operator in this run" />}
          <StatusIcon call={call} />
        </div>
        <ToolMessage call={call} />
      </div>
    </div>
  );
}

function ActionButton({ control, label, state, visual, primary, done, doneLabel }: {
  control: ControlId; label: string; state: OperatorState; visual: Visual; primary?: boolean; done: boolean; doneLabel: string;
}) {
  const call = state.controlTool[control];
  const pressed = visual.cursorKey === control && call?.status === 'running';
  return (
    <div data-cursor={control} aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all ${
        primary ? 'bg-ink text-paper' : 'border border-ink/20 bg-white'
      } ${pressed ? 'scale-[0.97] opacity-80' : ''}`}>
      {call?.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : done ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
      {done ? doneLabel : label}
    </div>
  );
}

/* ───────────── document + preview ───────────── */

function DocumentStrip({ state, document }: { state: OperatorState; document: JobView['document'] }) {
  const call = state.controlTool.document;
  return (
    <div data-cursor="document" className="flex items-center gap-3 rounded-md border border-light-grey bg-paper px-3 py-2">
      <FileText className="h-4 w-4 text-graphite" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm">{document?.filename ?? 'No document uploaded'}</p>
        <p className="font-mono text-[11px] text-graphite">
          {document ? `${document.format.toUpperCase()} · ${document.pageCount ?? '?'} pages${document.edited ? ' · edited' : ''}` : '—'}
          {call && ` · ${call.tool.replace(/_/g, ' ')}`}
        </p>
      </div>
      <span className="ml-auto"><StatusIcon call={call} /></span>
    </div>
  );
}

function PagePreview({ state, document }: { state: OperatorState; document: JobView['document'] }) {
  const { config } = state;
  const [w0, h0] = PAPER_MM[config.paperSize ?? 'A4'];
  const landscape = config.orientation === 'landscape';
  const [w, h] = landscape ? [h0, w0] : [w0, h0];
  const scale = 180 / Math.max(w, h);
  const mono = config.colorMode === 'monochrome';
  const stack = Math.min(Math.max((config.copies ?? 1) - 1, 0), 2);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex h-[210px] w-full items-center justify-center rounded-lg bg-[#EFEFEC]">
        <div className="relative transition-all duration-500 ease-cinema" style={{ width: w * scale, height: h * scale }}>
          {Array.from({ length: stack }).map((_, i) => (
            <div key={i} className="absolute inset-0 rounded-sm border border-light-grey bg-white"
              style={{ transform: `translate(${(i + 1) * 5}px, ${(i + 1) * -5}px)`, zIndex: -1 - i }} />
          ))}
          <div className={`absolute inset-0 flex flex-col gap-1.5 rounded-sm border border-light-grey bg-white p-3 shadow-sm transition-[filter] duration-500 ${mono ? 'grayscale' : ''}`}>
            <div className="h-2 w-2/3 rounded-sm bg-signal" />
            {Array.from({ length: landscape ? 5 : 9 }).map((_, i) => (
              <div key={i} className="h-1 rounded-sm bg-ink/15" style={{ width: `${92 - ((i * 17) % 30)}%` }} />
            ))}
            <div className="mt-auto h-6 w-1/2 rounded-sm bg-[#3B6FB6]/40" />
          </div>
        </div>
      </div>
      <dl className="grid w-full grid-cols-2 gap-x-2 gap-y-1 font-mono text-[11px] text-graphite">
        <dt>Pages</dt><dd className="text-right text-ink">{document?.pageCount ?? '—'}</dd>
        <dt>Copies</dt><dd className="text-right text-ink">{config.copies ?? '—'}</dd>
        <dt>Sides</dt><dd className="text-right text-ink">{config.sides ? (config.sides === 'one-sided' ? '1' : '2') : '—'}</dd>
      </dl>
    </div>
  );
}

/* ───────────── status ───────────── */

function StatusIcon({ call }: { call?: ToolCall }) {
  if (!call) return null;
  if (call.status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-graphite" aria-label="In progress" />;
  if (call.status === 'succeeded') return <Check className="h-4 w-4 text-emerald-600" aria-label="Succeeded" />;
  return <TriangleAlert className="h-4 w-4 text-signal" aria-label="Failed" />;
}

function ToolMessage({ call }: { call?: ToolCall }) {
  if (!call || call.status !== 'failed' || !call.error) return null;
  return (
    <p className="mt-1 text-xs text-signal" role="alert">
      <span className="font-mono">{call.error.code}</span> · {call.error.message}
    </p>
  );
}

function ReadinessDot({ status }: { status: string }) {
  const color = status === 'online' ? 'bg-emerald-500' : status === 'offline' || status === 'not_found' ? 'bg-signal' : 'bg-graphite';
  return <span className={`h-2 w-2 rounded-full ${color}`} title={`Printer ${status}`} />;
}
