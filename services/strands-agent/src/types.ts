/**
 * Shared types for the Strands Agent. Re-exports the zod operation schema and
 * defines the shapes exchanged with the Document Engine and the caller (the
 * Inklink backend).
 */
export {
  operation,
  operationPlan,
  replaceTextOperation,
  printOptions,
  SUPPORTED_OPERATIONS,
  type Operation,
  type OperationPlan,
  type PrintOptions,
} from './schema.js';

/** Minimal shape of the Document Engine /process response the agent cares about. */
export interface ProcessResultLike {
  job_id: string;
  input_format: string;
  output_format: string;
  output_filename: string;
  changes: {
    total_replacements: number;
    operations: Array<{ type: string; description: string; details: Record<string, unknown> }>;
    /** Present for native PDF edits: "native_pdf". */
    strategy?: string;
  };
  /** Structural/layout validation report from the engine (safe to expose). */
  validation?: {
    ok: boolean;
    output_format: string;
    page_count: number | null;
    strategy: string | null;
    review_recommended: boolean;
    structure: Record<string, unknown>;
    notes: string[];
  };
  download_url: string;
}

/**
 * What the agent returns for one edit request. This is a PROPOSAL: the caller
 * (Inklink backend) owns authoritative job status, customer approval and
 * payment, and must not treat `executed` as "approved" or "printed".
 */
export interface AgentEditResult {
  /** True if the agent produced and executed a valid plan (or recorded print options only). */
  executed: boolean;
  /** Human-readable message for the end user (no internal tool details). */
  message: string;
  /** The validated plan, if one was produced. */
  plan?: import('./schema.js').OperationPlan;
  /** Document Engine result, if execution happened. */
  document?: ProcessResultLike;
  /** True when the agent needs the user to clarify an ambiguous instruction. */
  needsClarification?: boolean;
  /** Machine-readable error code when something failed. */
  errorCode?: string;
  /**
   * Structured PRINT OPTIONS the customer requested, including copies. This is
   * the agent's proposal; the backend validates it and the local printer
   * adapter re-validates it against the real printer. Omitted when none were
   * requested.
   */
  printOptions?: import('./schema.js').PrintOptions;
  /**
   * True when the instruction was PRINT-SETTINGS-ONLY: the agent recorded print
   * options but performed NO document edit (and none was requested). This is a
   * success, not a clarification.
   */
  printOptionsOnly?: boolean;
}
