/**
 * Inklink Print Operator — job event stream (PROPOSED contract, v0.1).
 *
 * Delivered by the Inklink backend over Server-Sent Events:
 *   GET /api/v1/jobs/{jobId}/events
 *
 * Every event is a fact the backend has observed. In particular:
 *   - `tool_succeeded` is emitted only after the tool's deterministic code
 *     returned a successful result; `tool_failed` carries the real error.
 *   - `configuration_updated` is emitted by the tool that changed the value,
 *     after validation passed, before its `tool_succeeded`.
 *   - `payment_status_updated` with `settled` is emitted only after the backend
 *     verified the signed settlement callback (Contract 7 rules).
 *   - `execution_authorized` is emitted only by the backend, never the model.
 *
 * Additive to API Contracts 1-8: it does not change any existing endpoint,
 * status enum, network or asset. See docs/OPERATOR_EVENTS.md.
 */

import type { IsoTimestamp } from "./common.js";
import type { DeviceStatus, JobStatus, PaymentStatus } from "./contracts.js";

/* ───────────── Print configuration as the operator sees it ─────────────
 * Values use the local printer adapter's vocabulary (it validates them against
 * the real printer). Mapping to Contract 3 `PrintConfig` is the backend's job:
 * colour <-> color, grayscale <-> monochrome; A3 is not supported by the adapter.
 */
export const OPERATOR_PAPER_SIZES = ["A4", "Letter", "Legal"] as const;
export const OPERATOR_COLOR_MODES = ["color", "monochrome"] as const;
export const OPERATOR_ORIENTATIONS = ["portrait", "landscape"] as const;
export const OPERATOR_SIDES = ["one-sided", "two-sided-long-edge", "two-sided-short-edge"] as const;
export const OPERATOR_MAX_COPIES = 999;

export type OperatorPaperSize = (typeof OPERATOR_PAPER_SIZES)[number];
export type OperatorColorMode = (typeof OPERATOR_COLOR_MODES)[number];
export type OperatorOrientation = (typeof OPERATOR_ORIENTATIONS)[number];
export type OperatorSides = (typeof OPERATOR_SIDES)[number];

/** `null` means "not set yet". */
export interface OperatorPrintConfig {
  printerId: string | null;
  paperSize: OperatorPaperSize | null;
  colorMode: OperatorColorMode | null;
  copies: number | null;
  orientation: OperatorOrientation | null;
  sides: OperatorSides | null;
}

export type OperatorConfigField = keyof OperatorPrintConfig;

export const EMPTY_OPERATOR_CONFIG: OperatorPrintConfig = {
  printerId: null,
  paperSize: null,
  colorMode: null,
  copies: null,
  orientation: null,
  sides: null,
};

/* ───────────── Allowlisted operator tools ───────────── */
export const OPERATOR_TOOLS = [
  "inspect_document",
  "plan_operations",
  "execute_operation_plan",
  "list_printers",
  "check_printer_readiness",
  "set_paper_size",
  "set_color_mode",
  "set_copies",
  "set_orientation",
  "set_duplex",
  "validate_print_config",
  "request_print_execution",
] as const;
export type OperatorToolName = (typeof OPERATOR_TOOLS)[number];

/* ───────────── Printer discovery (from the local printer adapter) ───────────── */
export type PrinterAvailability = "online" | "offline" | "unknown" | "not_found";

export interface PrinterSummary {
  id: string;
  name: string;
  status: PrinterAvailability;
  isDefault: boolean;
  /** `null` = the adapter cannot query it; never assumed. */
  supportsColor: boolean | null;
  supportsDuplex: boolean | null;
}

/* ───────────── Events ───────────── */
export type OperatorEventSource = "agent" | "backend" | "payment" | "device";

export interface AgentStartedPayload {
  runId: string;
  /** Provider actually used for this run (explicitly configured; never a silent fallback). */
  provider: "0g-private-computer" | "vertex-ai";
  model: string;
  /** Privacy mode requested from 0G for every inference call; null for other providers. */
  trustMode: "private" | "verified" | "standard" | null;
  instruction: string;
}

/** Customer-visible narration from the model's text output (not hidden reasoning). */
export interface AgentThinkingPayload {
  runId: string;
  text: string;
}

export interface ToolStartedPayload {
  runId: string;
  toolUseId: string;
  tool: OperatorToolName;
  input: Record<string, unknown>;
}

export interface ToolSucceededPayload {
  runId: string;
  toolUseId: string;
  tool: OperatorToolName;
  result: Record<string, unknown>;
}

export interface ToolFailedPayload {
  runId: string;
  toolUseId: string;
  tool: OperatorToolName | string;
  error: { code: string; message: string };
}

export interface DocumentProcessedPayload {
  runId: string;
  /**
   * Document Engine scratch job holding the edited file. Internal: the backend
   * downloads the file, then deletes the engine job, and strips this field
   * before relaying the event to browsers.
   */
  engineJobId?: string;
  totalReplacements: number;
  outputFormat: "pdf" | "docx";
  pageCount: number | null;
  reviewRecommended: boolean;
  notes: string[];
}

export interface ConfigurationUpdatedPayload {
  runId: string;
  toolUseId: string;
  field: OperatorConfigField;
  value: string | number | null;
  config: OperatorPrintConfig;
}

export interface PrinterReadinessUpdatedPayload {
  printerId: string | null;
  status: PrinterAvailability;
  available: boolean;
  /** Present when the update came from a discovery call. */
  printers?: PrinterSummary[];
}

export type ApprovalKind = "customer_quote" | "shop" | "payment";

export interface ApprovalRequiredPayload {
  kind: ApprovalKind;
  reason: string;
}

export interface PaymentStatusUpdatedPayload {
  paymentId: string | null;
  status: PaymentStatus;
  /** Real Hedera transaction id, only once settled and verified. */
  transactionId: string | null;
  hashscanUrl: string | null;
}

export interface ExecutionAuthorizedPayload {
  authorizedBy: "backend";
  /** Local printer adapter result state, e.g. "PRINT_SUBMITTED" (spooler accepted, not printed). */
  submissionState: string | null;
}

export interface JobStatusUpdatedPayload {
  status: JobStatus;
  paymentStatus: PaymentStatus;
  deviceStatus: DeviceStatus;
}

export type AgentRunOutcome = "completed" | "needs_clarification" | "failed" | "unavailable";

export interface AgentFinishedPayload {
  runId: string;
  outcome: AgentRunOutcome;
  message: string;
}

export interface OperatorEventPayloads {
  agent_started: AgentStartedPayload;
  agent_thinking: AgentThinkingPayload;
  tool_started: ToolStartedPayload;
  tool_succeeded: ToolSucceededPayload;
  tool_failed: ToolFailedPayload;
  document_processed: DocumentProcessedPayload;
  configuration_updated: ConfigurationUpdatedPayload;
  printer_readiness_updated: PrinterReadinessUpdatedPayload;
  approval_required: ApprovalRequiredPayload;
  payment_status_updated: PaymentStatusUpdatedPayload;
  execution_authorized: ExecutionAuthorizedPayload;
  job_status_updated: JobStatusUpdatedPayload;
  agent_finished: AgentFinishedPayload;
}

export type OperatorEventType = keyof OperatorEventPayloads;

export const OPERATOR_EVENT_TYPES = [
  "agent_started",
  "agent_thinking",
  "tool_started",
  "tool_succeeded",
  "tool_failed",
  "document_processed",
  "configuration_updated",
  "printer_readiness_updated",
  "approval_required",
  "payment_status_updated",
  "execution_authorized",
  "job_status_updated",
  "agent_finished",
] as const satisfies readonly OperatorEventType[];

/** One SSE message. `seq` is monotonically increasing per job and is the SSE `id`. */
export type OperatorEvent = {
  [K in OperatorEventType]: {
    seq: number;
    jobId: string;
    type: K;
    source: OperatorEventSource;
    ts: IsoTimestamp;
    payload: OperatorEventPayloads[K];
  };
}[OperatorEventType];

/**
 * Agent-side event emitted by the Print Operator Harness (agent -> backend,
 * NDJSON stream). The backend assigns `seq`, `jobId` and `source` before
 * relaying it as an `OperatorEvent`.
 */
export type HarnessEvent = {
  [K in OperatorEventType]: { type: K; ts: IsoTimestamp; payload: OperatorEventPayloads[K] };
}[OperatorEventType];
