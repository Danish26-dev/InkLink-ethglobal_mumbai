/**
 * Pure fold of the job event stream into what the UI shows.
 *
 * Nothing here invents state: a value appears only because the backend relayed
 * the event that established it (`configuration_updated` changes a value,
 * `tool_succeeded` marks a step done, `tool_failed` carries the real error).
 */
import {
  EMPTY_OPERATOR_CONFIG,
  type AgentRunOutcome,
  type ApprovalKind,
  type DeviceStatus,
  type JobStatus,
  type OperatorConfigField,
  type OperatorEvent,
  type OperatorPrintConfig,
  type PaymentStatus,
  type PrinterAvailability,
  type PrinterSummary,
} from '@inklink/shared-schemas';

export type ControlId =
  | 'document'
  | 'printer'
  | 'paperSize'
  | 'colorMode'
  | 'copies'
  | 'orientation'
  | 'sides'
  | 'validate'
  | 'submit';

/** Which dialog control each allowlisted tool operates. */
export const TOOL_CONTROL: Record<string, ControlId> = {
  inspect_document: 'document',
  plan_operations: 'document',
  execute_operation_plan: 'document',
  list_printers: 'printer',
  check_printer_readiness: 'printer',
  set_paper_size: 'paperSize',
  set_color_mode: 'colorMode',
  set_copies: 'copies',
  set_orientation: 'orientation',
  set_duplex: 'sides',
  validate_print_config: 'validate',
  request_print_execution: 'submit',
};

export const FIELD_CONTROL: Record<OperatorConfigField, ControlId> = {
  printerId: 'printer',
  paperSize: 'paperSize',
  colorMode: 'colorMode',
  copies: 'copies',
  orientation: 'orientation',
  sides: 'sides',
};

export const TOOL_LABEL: Record<string, string> = {
  inspect_document: 'Inspect document',
  plan_operations: 'Plan document edits',
  execute_operation_plan: 'Apply document edits',
  list_printers: 'List printers',
  check_printer_readiness: 'Check printer readiness',
  set_paper_size: 'Set paper size',
  set_color_mode: 'Set colour mode',
  set_copies: 'Set copies',
  set_orientation: 'Set orientation',
  set_duplex: 'Set two-sided printing',
  validate_print_config: 'Validate configuration',
  request_print_execution: 'Request print execution',
};

export interface ToolCall {
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  status: 'running' | 'succeeded' | 'failed';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  startedSeq: number;
}

export type Phase =
  | 'idle'
  | 'unavailable'
  | 'reading_document'
  | 'editing_document'
  | 'selecting_printer'
  | 'configuring'
  | 'validating'
  | 'requesting_execution'
  | 'awaiting_approvals'
  | 'printing'
  | 'completed'
  | 'needs_clarification'
  | 'failed';

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Waiting for an instruction',
  unavailable: 'Print operator unavailable',
  reading_document: 'Reading the document',
  editing_document: 'Editing the document',
  selecting_printer: 'Selecting a printer',
  configuring: 'Configuring print settings',
  validating: 'Validating against the printer',
  requesting_execution: 'Requesting print execution',
  awaiting_approvals: 'Waiting for approvals',
  printing: 'Sent to the printer',
  completed: 'Print completed',
  needs_clarification: 'Needs your input',
  failed: 'Run failed',
};

export interface OperatorState {
  run: {
    runId: string;
    provider: string;
    model: string;
    trustMode: string | null;
    instruction: string;
    active: boolean;
    outcome: AgentRunOutcome | null;
    finishMessage: string | null;
  } | null;
  thinking: string | null;
  /** Customer-visible model text of the current run (agent_thinking), oldest first. */
  narration: string[];
  config: OperatorPrintConfig;
  /** Config fields set during the current run (for the "changed" marker). */
  touched: Partial<Record<OperatorConfigField, number>>;
  validated: boolean;
  printers: PrinterSummary[];
  readiness: { printerId: string | null; status: PrinterAvailability; available: boolean } | null;
  tools: ToolCall[];
  /** Latest tool call per control. */
  controlTool: Partial<Record<ControlId, ToolCall>>;
  document: {
    totalReplacements: number;
    outputFormat: string;
    pageCount: number | null;
    reviewRecommended: boolean;
    notes: string[];
  } | null;
  approvals: ApprovalKind[];
  executionRequested: boolean;
  executionAuthorized: { submissionState: string | null } | null;
  payment: { status: PaymentStatus; transactionId: string | null; hashscanUrl: string | null } | null;
  job: { status: JobStatus; paymentStatus: PaymentStatus; deviceStatus: DeviceStatus } | null;
  phase: Phase;
}

export const INITIAL_STATE: OperatorState = {
  run: null,
  thinking: null,
  narration: [],
  config: { ...EMPTY_OPERATOR_CONFIG },
  touched: {},
  validated: false,
  printers: [],
  readiness: null,
  tools: [],
  controlTool: {},
  document: null,
  approvals: [],
  executionRequested: false,
  executionAuthorized: null,
  payment: null,
  job: null,
  phase: 'idle',
};

function phaseForTool(tool: string): Phase {
  switch (tool) {
    case 'inspect_document':
      return 'reading_document';
    case 'plan_operations':
    case 'execute_operation_plan':
      return 'editing_document';
    case 'list_printers':
    case 'check_printer_readiness':
      return 'selecting_printer';
    case 'validate_print_config':
      return 'validating';
    case 'request_print_execution':
      return 'requesting_execution';
    default:
      return 'configuring';
  }
}

export function reduce(s: OperatorState, e: OperatorEvent): OperatorState {
  switch (e.type) {
    case 'agent_started':
      return {
        ...s,
        run: {
          runId: e.payload.runId,
          provider: e.payload.provider,
          model: e.payload.model,
          trustMode: e.payload.trustMode,
          instruction: e.payload.instruction,
          active: true,
          outcome: null,
          finishMessage: null,
        },
        thinking: null,
        narration: [],
        touched: {},
        phase: 'reading_document',
      };
    case 'agent_thinking':
      return { ...s, thinking: e.payload.text, narration: [...s.narration, e.payload.text].slice(-8) };
    case 'tool_started': {
      const call: ToolCall = {
        toolUseId: e.payload.toolUseId,
        tool: e.payload.tool,
        input: e.payload.input ?? {},
        status: 'running',
        startedSeq: e.seq,
      };
      const control = TOOL_CONTROL[e.payload.tool];
      return {
        ...s,
        tools: [...s.tools, call],
        controlTool: control ? { ...s.controlTool, [control]: call } : s.controlTool,
        phase: phaseForTool(e.payload.tool),
      };
    }
    case 'tool_succeeded':
    case 'tool_failed': {
      const ok = e.type === 'tool_succeeded';
      let updated: ToolCall | undefined;
      const tools = s.tools.map((t) => {
        if (t.toolUseId !== e.payload.toolUseId) return t;
        updated = ok
          ? { ...t, status: 'succeeded', result: (e.payload as { result: Record<string, unknown> }).result }
          : { ...t, status: 'failed', error: (e.payload as { error: { code: string; message: string } }).error };
        return updated;
      });
      // A backend-side failure can arrive without a matching tool_started.
      if (!updated) {
        updated = {
          toolUseId: e.payload.toolUseId,
          tool: e.payload.tool,
          input: {},
          status: ok ? 'succeeded' : 'failed',
          ...(ok ? {} : { error: (e.payload as { error: { code: string; message: string } }).error }),
          startedSeq: e.seq,
        };
        tools.push(updated);
      }
      const control = TOOL_CONTROL[e.payload.tool];
      let printers = s.printers;
      if (ok && e.payload.tool === 'list_printers') {
        const list = (e.payload as { result: { printers?: PrinterSummary[] } }).result?.printers;
        if (Array.isArray(list)) printers = list;
      }
      return {
        ...s,
        tools,
        printers,
        controlTool: control ? { ...s.controlTool, [control]: updated } : s.controlTool,
        validated: ok && e.payload.tool === 'validate_print_config' ? true : s.validated,
        executionRequested: ok && e.payload.tool === 'request_print_execution' ? true : s.executionRequested,
      };
    }
    case 'configuration_updated':
      return {
        ...s,
        config: { ...EMPTY_OPERATOR_CONFIG, ...e.payload.config },
        touched: { ...s.touched, [e.payload.field]: e.seq },
        validated: false, // any change needs a fresh validation
        executionRequested: false,
      };
    case 'printer_readiness_updated':
      return {
        ...s,
        readiness: { printerId: e.payload.printerId, status: e.payload.status, available: e.payload.available },
        printers: e.payload.printers ?? s.printers,
      };
    case 'document_processed':
      return {
        ...s,
        document: {
          totalReplacements: e.payload.totalReplacements,
          outputFormat: e.payload.outputFormat,
          pageCount: e.payload.pageCount,
          reviewRecommended: e.payload.reviewRecommended,
          notes: e.payload.notes ?? [],
        },
      };
    case 'approval_required':
      return { ...s, approvals: s.approvals.includes(e.payload.kind) ? s.approvals : [...s.approvals, e.payload.kind] };
    case 'payment_status_updated':
      return {
        ...s,
        payment: { status: e.payload.status, transactionId: e.payload.transactionId, hashscanUrl: e.payload.hashscanUrl },
      };
    case 'execution_authorized':
      return { ...s, executionAuthorized: { submissionState: e.payload.submissionState }, phase: 'printing' };
    case 'job_status_updated': {
      const job = { status: e.payload.status, paymentStatus: e.payload.paymentStatus, deviceStatus: e.payload.deviceStatus };
      let phase = s.phase;
      if (job.status === 'completed') phase = 'completed';
      else if (job.status === 'executing') phase = 'printing';
      return { ...s, job, phase };
    }
    case 'agent_finished': {
      const outcome = e.payload.outcome;
      const phase: Phase =
        outcome === 'unavailable'
          ? 'unavailable'
          : outcome === 'failed'
            ? 'failed'
            : outcome === 'needs_clarification'
              ? 'needs_clarification'
              : s.executionAuthorized
                ? 'printing'
                : s.executionRequested
                  ? 'awaiting_approvals'
                  : 'idle';
      return {
        ...s,
        run: s.run
          ? { ...s.run, active: false, outcome, finishMessage: e.payload.message }
          : {
              runId: e.payload.runId,
              provider: 'unknown',
              model: '',
              trustMode: null,
              instruction: '',
              active: false,
              outcome,
              finishMessage: e.payload.message,
            },
        phase,
      };
    }
    default:
      return s;
  }
}

export function foldEvents(events: OperatorEvent[]): OperatorState {
  return events.reduce(reduce, INITIAL_STATE);
}
