/**
 * A desktop-style printer settings window operated by the print operator.
 *
 * Every value shown comes from the folded event stream:
 *   - a value appears only after `configuration_updated` for that field,
 *   - it shows "awaiting result" until the tool's `tool_succeeded` arrives,
 *   - a `tool_failed` shows the real error on the control,
 *   - readiness comes from `printer_readiness_updated`.
 * Controls the printer adapter cannot set (quality, paper source, page range)
 * are shown disabled with the driver default, never as configured.
 */
import { Check, ChevronDown, FileText, Loader2, Minus, Plus, Printer, TriangleAlert } from 'lucide-react';
import {
  OPERATOR_PAPER_SIZES,
  OPERATOR_SIDES,
  type JobView,
  type PrinterSummary,
} from '@inklink/shared-schemas';
import type { ControlId, OperatorState, ToolCall } from '../lib/operatorState';
import { TAB_LABEL, type SettingsTab, type Visual } from './visual';

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

/* ───────────── status helpers (all derived from real events) ───────────── */

type FieldStatus = 'idle' | 'working' | 'pending' | 'confirmed' | 'failed';

function fieldKey(control: ControlId): string {
  return control === 'printer' ? 'printerId' : control;
}

function statusOf(state: OperatorState, control: ControlId): FieldStatus {
  const call = state.controlTool[control];
  if (!call) return 'idle';
  if (call.status === 'failed') return 'failed';
  if (call.status === 'succeeded') return 'confirmed';
  const touched = (state.touched as Record<string, number | undefined>)[fieldKey(control)];
  return touched && touched > call.startedSeq ? 'pending' : 'working';
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

/* ───────────── window ───────────── */

export function PrinterDialog({ state, visual, document }: Props) {
  const tab = visual.tab;
  const printerName = state.printers.find((p) => p.id === state.config.printerId)?.name ?? state.config.printerId;
  const listing = state.controlTool.printer?.tool === 'list_printers' && state.controlTool.printer.status === 'running';

  return (
    <div className="w-full max-w-[1040px] overflow-visible rounded-[10px] border border-black/15 bg-[#F6F6F3] shadow-[0_40px_90px_-40px_rgba(17,17,17,0.55),0_2px_6px_rgba(17,17,17,0.08)]">
      {/* Title bar */}
      <div className="flex items-center gap-3 rounded-t-[10px] border-b border-black/10 bg-gradient-to-b from-[#EDEDEA] to-[#E4E4E0] px-4 py-2">
        <div className="flex gap-2" aria-hidden="true">
          <span className="h-3 w-3 rounded-full bg-[#F15A36]/80" />
          <span className="h-3 w-3 rounded-full bg-[#D9D9D4]" />
          <span className="h-3 w-3 rounded-full bg-[#D9D9D4]" />
        </div>
        <Printer className="ml-2 h-4 w-4 text-ink/70" aria-hidden="true" />
        <h2 className="text-[13px] font-medium text-ink">
          Print · Printing Preferences{document ? <span className="text-graphite"> — {document.filename}</span> : null}
        </h2>
        <span className="ml-auto rounded bg-ink px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-paper">Operated by Inklink agent</span>
      </div>

      <div className="grid gap-0 md:grid-cols-[1fr_290px]">
        <div className="flex min-w-0 flex-col p-5">
          {/* Printer + readiness (always visible) */}
          <div className="grid grid-cols-[96px_1fr] items-start gap-3">
            <span className="pt-2.5 text-[13px] text-ink/70" id="label-printer">Printer</span>
            <div>
              <Dropdown control="printer" state={state} visual={visual}
                value={printerName}
                leading={<Printer className="h-4 w-4 text-ink/60" aria-hidden="true" />}
                options={printerOptions(state.printers, visual)}
                emptyMenu={listing ? 'Searching for printers on this computer…' : 'No printers discovered yet.'} />
              <Readiness state={state} />
            </div>
          </div>

          {/* Tabs */}
          <div role="tablist" aria-label="Printer settings" className="mt-5 flex gap-1 border-b border-black/10">
            {(Object.keys(TAB_LABEL) as SettingsTab[]).map((t) => (
              <div key={t} role="tab" aria-selected={tab === t} data-cursor={`tab:${t}`}
                className={`-mb-px rounded-t-md border px-4 py-2 text-[13px] transition-colors ${
                  tab === t ? 'border-black/10 border-b-[#F6F6F3] bg-[#F6F6F3] font-medium text-ink' : 'border-transparent text-ink/55'
                }`}>
                {TAB_LABEL[t]}
              </div>
            ))}
          </div>

          <div role="tabpanel" className="min-h-[268px] rounded-b-md border border-t-0 border-black/10 bg-white/70 p-5">
            {tab === 'general' && (
              <div className="space-y-5">
                <FieldRow label="Copies" control="copies" state={state}><Copies state={state} visual={visual} /></FieldRow>
                <FieldRow label="Pages" note="The whole document is printed (page ranges are not set by the operator)">
                  <Disabled text="All pages" />
                </FieldRow>
                <FieldRow label="Document" control="document" state={state}><DocumentStrip state={state} document={document} /></FieldRow>
              </div>
            )}
            {tab === 'layout' && (
              <div className="space-y-5">
                <FieldRow label="Orientation" control="orientation" state={state}>
                  <RadioCards control="orientation" state={state} visual={visual}
                    options={[
                      { value: 'portrait', label: 'Portrait', icon: <PageIcon landscape={false} /> },
                      { value: 'landscape', label: 'Landscape', icon: <PageIcon landscape /> },
                    ]} />
                </FieldRow>
                <FieldRow label="Two-sided" control="sides" state={state}>
                  <Dropdown control="sides" state={state} visual={visual}
                    value={state.config.sides ? SIDES_LABEL[state.config.sides] : null}
                    options={OPERATOR_SIDES.map((v) => ({ value: v, label: SIDES_LABEL[v] }))} />
                </FieldRow>
              </div>
            )}
            {tab === 'paper' && (
              <div className="space-y-5">
                <FieldRow label="Paper size" control="paperSize" state={state}>
                  <Dropdown control="paperSize" state={state} visual={visual}
                    value={state.config.paperSize ? PAPER_LABEL[state.config.paperSize] : null}
                    options={OPERATOR_PAPER_SIZES.map((v) => ({ value: v, label: PAPER_LABEL[v] }))} />
                </FieldRow>
                <FieldRow label="Colour" control="colorMode" state={state}>
                  <RadioCards control="colorMode" state={state} visual={visual}
                    options={[
                      { value: 'color', label: 'Colour', icon: <span className="h-5 w-5 rounded-full bg-[conic-gradient(#F15A36,#3B6FB6,#E8C547,#F15A36)]" /> },
                      { value: 'monochrome', label: 'Black & white', icon: <span className="h-5 w-5 rounded-full bg-[linear-gradient(90deg,#111_50%,#ddd_50%)]" /> },
                    ]} />
                </FieldRow>
                <FieldRow label="Quality" note="Driver default; the printer adapter cannot set quality"><Disabled text="Standard (driver default)" /></FieldRow>
                <FieldRow label="Paper source" note="Driver default; the printer adapter cannot select a tray"><Disabled text="Automatically select" /></FieldRow>
              </div>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="border-t border-black/10 bg-[#EFEFEB] p-5 md:border-l md:border-t-0">
          <PagePreview state={state} document={document} />
        </div>
      </div>

      {/* Footer: validation + apply */}
      <div className="flex flex-wrap items-center gap-3 rounded-b-[10px] border-t border-black/10 bg-[#EDEDEA] px-5 py-3">
        <FooterStatus state={state} />
        <div className="ml-auto flex items-center gap-2">
          <ActionButton control="validate" label="Check settings" doneLabel="Settings valid" state={state} visual={visual} done={state.validated} />
          <span className="rounded-md border border-black/10 bg-white/60 px-4 py-1.5 text-[13px] text-ink/40" aria-disabled="true">Cancel</span>
          <ActionButton control="submit" label="Apply" doneLabel="Applied" state={state} visual={visual} done={state.executionRequested} primary />
        </div>
      </div>
    </div>
  );
}

/* ───────────── rows & controls ───────────── */

function FieldRow({ label, control, state, note, children }: {
  label: string; control?: ControlId; state?: OperatorState; note?: string; children: React.ReactNode;
}) {
  const call = control && state ? state.controlTool[control] : undefined;
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-3">
      <span className="pt-2.5 text-[13px] text-ink/70" id={control ? `label-${control}` : undefined}>{label}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{children}</div>
          {control && state && <StatusBadge status={statusOf(state, control)} />}
        </div>
        {note && <p className="mt-1 text-[11px] text-graphite">{note}</p>}
        <ToolError call={call} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: FieldStatus }) {
  if (status === 'idle') return <span className="w-[112px]" aria-hidden="true" />;
  const map = {
    working: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: 'Operating', cls: 'text-graphite' },
    pending: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, text: 'Awaiting result', cls: 'text-signal' },
    confirmed: { icon: <Check className="h-3.5 w-3.5" />, text: 'Confirmed', cls: 'text-emerald-700' },
    failed: { icon: <TriangleAlert className="h-3.5 w-3.5" />, text: 'Failed', cls: 'text-signal' },
  }[status];
  return (
    <span className={`flex w-[112px] items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${map.cls}`} role="status">
      {map.icon}{map.text}
    </span>
  );
}

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

function Dropdown({ control, state, visual, value, options, leading, emptyMenu }: {
  control: ControlId; state: OperatorState; visual: Visual; value: string | null; options: Option[];
  leading?: React.ReactNode; emptyMenu?: string;
}) {
  const open = visual.menu?.control === control;
  const selected = rawValue(state, control);
  const status = statusOf(state, control);
  const target = visual.cursorKey === control;
  return (
    <div className="relative">
      <div data-cursor={control} role="combobox" aria-labelledby={`label-${control}`} aria-expanded={open} aria-readonly="true"
        className={`flex min-h-[38px] items-center gap-2 rounded-md border bg-white px-3 py-2 text-[13px] shadow-[inset_0_1px_0_rgba(0,0,0,0.03)] transition-all ${
          open || target ? 'border-ink ring-2 ring-signal/30' : status === 'failed' ? 'border-signal' : 'border-black/15'
        }`}>
        {leading}
        <span className={`truncate ${value ? (status === 'pending' ? 'text-ink/60 italic' : 'text-ink') : 'text-graphite'}`}>{value ?? 'Not set'}</span>
        <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-ink/50 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </div>
      {open && (
        <ul role="listbox" aria-labelledby={`label-${control}`}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-md border border-black/15 bg-white py-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.35)]">
          {options.length === 0 && <li className="flex items-center gap-2 px-3 py-2 text-[13px] text-graphite"><Loader2 className="h-3.5 w-3.5 animate-spin" />{emptyMenu}</li>}
          {options.map((o) => {
            const hl = visual.menu?.highlight === o.value;
            return (
              <li key={o.value} role="option" aria-selected={selected === o.value} data-cursor={`${control}:${o.value}`}
                className={`flex items-center gap-2 px-3 py-2 text-[13px] ${hl ? 'bg-ink text-paper' : o.disabled ? 'text-graphite' : 'text-ink'}`}>
                <span className="w-4">{selected === o.value && <Check className="h-4 w-4" aria-hidden="true" />}</span>
                <span className="truncate">{o.label}</span>
                {o.hint && <span className={`ml-auto shrink-0 font-mono text-[10px] ${hl ? 'text-paper/70' : 'text-graphite'}`}>{o.hint}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RadioCards({ control, state, visual, options }: {
  control: ControlId; state: OperatorState; visual: Visual; options: { value: string; label: string; icon: React.ReactNode }[];
}) {
  const selected = rawValue(state, control);
  const status = statusOf(state, control);
  return (
    <div role="radiogroup" aria-labelledby={`label-${control}`} data-cursor={control} className="flex flex-wrap gap-3">
      {options.map((o) => {
        const isSel = selected === o.value;
        const aimed = visual.aim?.control === control && visual.aim.value === o.value;
        return (
          <div key={o.value} role="radio" aria-checked={isSel} data-cursor={`${control}:${o.value}`}
            className={`flex min-w-[140px] items-center gap-3 whitespace-nowrap rounded-lg border bg-white px-3 py-2.5 text-[13px] transition-all ${
              isSel ? (status === 'pending' ? 'border-signal/70 ring-2 ring-signal/20' : 'border-ink ring-2 ring-ink/10') : aimed ? 'border-ink/60 ring-2 ring-signal/30' : 'border-black/15'
            }`}>
            <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${isSel ? 'border-ink' : 'border-black/30'}`}>
              {isSel && <span className="h-2 w-2 rounded-full bg-ink" />}
            </span>
            {o.icon}
            <span>{o.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Copies({ state, visual }: { state: OperatorState; visual: Visual }) {
  const typing = visual.typing?.control === 'copies' ? visual.typing.text : null;
  const status = statusOf(state, 'copies');
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex h-[38px] w-9 items-center justify-center rounded-md border border-black/15 bg-white text-ink/40" aria-hidden="true"><Minus className="h-4 w-4" /></span>
      <div data-cursor="copies" role="spinbutton" aria-labelledby="label-copies" aria-readonly="true" aria-valuenow={state.config.copies ?? undefined}
        className={`flex h-[38px] w-20 items-center justify-center gap-1 rounded-md border bg-white font-mono text-sm transition-all ${
          typing || visual.cursorKey === 'copies' ? 'border-ink ring-2 ring-signal/30' : status === 'failed' ? 'border-signal' : 'border-black/15'
        }`}>
        {typing ? (
          <><span className="bg-signal/15 px-0.5">{typing}</span><span className="h-4 w-px animate-pulse bg-ink" aria-hidden="true" /></>
        ) : (
          <span className={state.config.copies ? (status === 'pending' ? 'italic text-ink/60' : '') : 'text-graphite'}>{state.config.copies ?? '—'}</span>
        )}
      </div>
      <span className="flex h-[38px] w-9 items-center justify-center rounded-md border border-black/15 bg-white text-ink/40" aria-hidden="true"><Plus className="h-4 w-4" /></span>
    </div>
  );
}

function Disabled({ text }: { text: string }) {
  return (
    <div className="flex min-h-[38px] items-center rounded-md border border-dashed border-black/15 bg-[#F2F2EF] px-3 text-[13px] text-graphite" aria-disabled="true">
      {text}
    </div>
  );
}

function DocumentStrip({ state, document }: { state: OperatorState; document: JobView['document'] }) {
  const call = state.controlTool.document;
  return (
    <div data-cursor="document" className="flex items-center gap-3 rounded-md border border-black/10 bg-white px-3 py-2">
      <FileText className="h-4 w-4 text-signal" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-[13px]">{document?.filename ?? 'No document uploaded'}</p>
        <p className="font-mono text-[10px] text-graphite">
          {document ? `${document.format.toUpperCase()} · ${document.pageCount ?? '?'} pages${document.edited ? ' · edited copy' : ''}` : '—'}
          {call && ` · ${call.tool.replace(/_/g, ' ')}`}
        </p>
      </div>
    </div>
  );
}

function Readiness({ state }: { state: OperatorState }) {
  const r = state.readiness;
  const forSelected = r && (r.printerId === state.config.printerId || r.printerId === null);
  if (!r) return <p className="mt-1.5 text-[11px] text-graphite">Status: not checked</p>;
  const tone = r.available && r.status === 'online' ? 'bg-emerald-500' : r.status === 'offline' || r.status === 'not_found' ? 'bg-signal' : 'bg-graphite';
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink/70" role="status">
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      {!r.printerId ? `${state.printers.length} printer(s) discovered` : `Status: ${r.status} · ${r.printerId}`}
      {forSelected && r.available ? ' · ready' : ''}
    </p>
  );
}

function FooterStatus({ state }: { state: OperatorState }) {
  const v = state.controlTool.validate;
  const s = state.controlTool.submit;
  let text = 'Waiting for the operator';
  let tone = 'text-graphite';
  if (s?.status === 'succeeded') {
    const msg = typeof s.result?.message === 'string' ? s.result.message : 'Execution requested.';
    text = msg;
    tone = 'text-ink';
  } else if (s?.status === 'failed' || v?.status === 'failed') {
    const err = (s?.status === 'failed' ? s : v)!.error;
    text = err ? `${err.code}: ${err.message}` : 'Failed';
    tone = 'text-signal';
  } else if (state.validated) {
    text = 'Settings validated against the real printer';
    tone = 'text-emerald-700';
  } else if (state.tools.length > 0) {
    text = 'Not validated since the last change';
  }
  return <p className={`max-w-[520px] text-[12px] ${tone}`} role="status">{text}</p>;
}

function ActionButton({ control, label, doneLabel, state, visual, done, primary }: {
  control: ControlId; label: string; doneLabel: string; state: OperatorState; visual: Visual; done: boolean; primary?: boolean;
}) {
  const call = state.controlTool[control];
  const running = call?.status === 'running';
  const target = visual.cursorKey === control;
  return (
    <div data-cursor={control}
      className={`inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-[13px] font-medium transition-all ${
        primary ? 'bg-ink text-paper' : 'border border-black/20 bg-white text-ink'
      } ${target ? 'ring-2 ring-signal/50' : ''} ${running ? 'scale-[0.98]' : ''}`}>
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {done ? doneLabel : label}
    </div>
  );
}

function ToolError({ call }: { call?: ToolCall }) {
  if (!call || call.status !== 'failed' || !call.error) return null;
  return (
    <p className="mt-1.5 text-[11px] text-signal" role="alert">
      <span className="font-mono">{call.error.code}</span> · {call.error.message}
    </p>
  );
}

function PageIcon({ landscape }: { landscape: boolean }) {
  return (
    <span className={`flex items-start justify-start border border-ink/50 bg-white p-0.5 ${landscape ? 'h-4 w-6' : 'h-6 w-4'}`} aria-hidden="true">
      <span className="h-0.5 w-2 bg-ink/50" />
    </span>
  );
}

/* ───────────── preview ───────────── */

function PagePreview({ state, document }: { state: OperatorState; document: JobView['document'] }) {
  const { config } = state;
  const [w0, h0] = PAPER_MM[config.paperSize ?? 'A4'];
  const landscape = config.orientation === 'landscape';
  const [w, h] = landscape ? [h0, w0] : [w0, h0];
  const scale = 200 / Math.max(w, h);
  const mono = config.colorMode === 'monochrome';
  const stack = Math.min(Math.max((config.copies ?? 1) - 1, 0), 2);
  const duplex = config.sides && config.sides !== 'one-sided';
  return (
    <div className="flex h-full flex-col">
      <p className="label-mono mb-3">Preview</p>
      <div className="relative flex h-[240px] items-center justify-center rounded-md bg-[#E3E3DE]">
        <div className="relative transition-all duration-500 ease-cinema" style={{ width: w * scale, height: h * scale }}>
          {Array.from({ length: stack }).map((_, i) => (
            <div key={i} className="absolute inset-0 border border-black/10 bg-white" style={{ transform: `translate(${(i + 1) * 5}px, ${(i + 1) * -5}px)`, zIndex: -1 - i }} />
          ))}
          <div className={`absolute inset-0 flex flex-col gap-1.5 border border-black/10 bg-white p-3 shadow-sm transition-[filter] duration-500 ${mono ? 'grayscale' : ''}`}>
            <div className="h-2 w-2/3 rounded-sm bg-signal" />
            {Array.from({ length: landscape ? 5 : 9 }).map((_, i) => (
              <div key={i} className="h-1 rounded-sm bg-ink/15" style={{ width: `${92 - ((i * 17) % 30)}%` }} />
            ))}
            <div className="mt-auto h-6 w-1/2 rounded-sm bg-[#3B6FB6]/40" />
          </div>
          {duplex && <span className="absolute -bottom-6 left-0 right-0 text-center font-mono text-[10px] text-ink/60">↻ printed on both sides</span>}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-2 gap-y-1.5 font-mono text-[11px] text-graphite">
        <dt>Sheets</dt><dd className="text-right text-ink">{sheets(document?.pageCount ?? null, config.copies, duplex)}</dd>
        <dt>Copies</dt><dd className="text-right text-ink">{config.copies ?? '—'}</dd>
        <dt>Paper</dt><dd className="text-right text-ink">{config.paperSize ?? '—'}</dd>
        <dt>Colour</dt><dd className="text-right text-ink">{config.colorMode ? COLOR_LABEL[config.colorMode] : '—'}</dd>
      </dl>
    </div>
  );
}

function sheets(pages: number | null, copies: number | null, duplex: boolean | null | '') {
  if (!pages || !copies) return '—';
  return String(Math.ceil(pages / (duplex ? 2 : 1)) * copies);
}
