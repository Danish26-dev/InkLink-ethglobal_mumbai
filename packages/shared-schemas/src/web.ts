/**
 * Inklink web (PWA) and shop dashboard contracts (PROPOSED, v0.1).
 *
 * The PWA has no login and no wallet. It holds a short-lived anonymous browser
 * session issued by the backend, and hands payment over to the native app, which
 * keeps device identity, payment authorization and Hedera x402 (Contracts 5-7).
 *
 * Additive to Contracts 1-8. See docs/WEB_CONTRACTS.md.
 */

import type { IsoTimestamp } from "./common.js";
import type { JobStatus, PaymentStatus, DeviceStatus, Quote } from "./contracts.js";
import type { OperatorPrintConfig, PrinterSummary, TrustMode, TrustSelection } from "./operator-events.js";

/* POST /api/v1/web/sessions (no auth) */
export interface WebSession {
  sessionToken: string;
  expiresAt: IsoTimestamp;
  /** Anonymous reference used as `customerId` on uploads. Prefix `web_`, no PII. */
  customerReference: string;
}

/* GET /api/v1/shops (web session) */
export interface ShopChannel {
  shopId: string;
  name: string;
  /** Shopkeeper's availability toggle. */
  acceptingOrders: boolean;
  /** True only when the agent service reports its model provider is configured and reachable. */
  agentAvailable: boolean;
  description: string;
  /** The isolated jury demo shop (visible to jury sessions only). */
  demo?: boolean;
}

/* Conversation (web session that owns the job) */
export type MessageRole = "customer" | "agent" | "system";

export interface ConversationMessage {
  messageId: string;
  jobId: string;
  role: MessageRole;
  text: string;
  createdAt: IsoTimestamp;
}

/* POST /api/v1/jobs/{jobId}/messages */
export interface SendMessageRequest {
  text: string;
}

/* GET /api/v1/jobs/{jobId} (web session or shop) — full job view */
export interface JobView {
  jobId: string;
  shopId: string;
  status: JobStatus;
  paymentStatus: PaymentStatus;
  deviceStatus: DeviceStatus;
  document: {
    documentId: string;
    filename: string;
    format: "pdf" | "docx";
    size: number;
    /** True once the Document Engine produced an edited version. */
    edited: boolean;
    /** Real page count (PDF parsed, DOCX app.xml); null when unknown. */
    pageCount: number | null;
    reviewRecommended: boolean;
    notes: string[];
    /** The original is never modified; an edited copy is used only once approved. */
    editStatus: "none" | "pending_review" | "approved" | "rejected";
    /** False once the files were deleted under the retention policy. */
    available: boolean;
    /** Local sensitivity classification (labels only, never content). */
    classification: { level: "sensitive" | "non_sensitive" | "unclassified"; categories: string[]; reason: string } | null;
  } | null;
  privacy: JobPrivacy;
  operatorConfig: OperatorPrintConfig;
  /** True when the adapter validated the full config against the real printer. */
  configValidated: boolean;
  quote: Quote | null;
  customerApprovedQuote: boolean;
  /** The job's current payment, from backend records. Null before a payment starts. */
  payment: JobPayment | null;
  shopApproved: boolean;
  /** The operator called request_print_execution for the current configuration. */
  executionRequested: boolean;
  /** A print-operator run is in progress for this job. */
  runActive: boolean;
  /** Last printer-adapter submission result; `ok` means the spooler accepted it (not printed). */
  submission: { ok: boolean; state: string | null; message: string | null; submissionId?: string | null } | null;
  /** True for jobs of the isolated jury demo shop (never printed physically). */
  demo: boolean;
  /** Jury demo only: SIMULATED steps, kept apart from the real status fields. */
  simulation: {
    payment?: { state: "SIMULATED_SETTLED"; at: IsoTimestamp; note: string };
    execution?: { state: "SIMULATED_SUBMISSION" | "BLOCKED"; printerValidation: string; errors: string[]; printerId: string | null; at: IsoTimestamp; note: string };
  } | null;
  /** Events reported by ESP32-S3 / gateway devices for this job. */
  deviceEvents: { at: IsoTimestamp; deviceId: string; type: string; detail: string | null }[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * Hedera x402 payment of a job, as recorded by the backend.
 * `verificationStatus` is "verified" only after the backend accepted the HMAC-signed settlement
 * callback that the payment agent sends after its mirror-node check; transaction fields are
 * null until then.
 */
export interface JobPayment {
  paymentId: string;
  status: PaymentStatus;
  verificationStatus: "pending" | "verified" | "unverified" | "failed" | "expired";
  amount: string;
  asset: "HTS_USDC";
  network: "hedera:testnet";
  transactionId: string | null;
  hashscanUrl: string | null;
  settledAt: IsoTimestamp | null;
  verifiedAt: IsoTimestamp | null;
}

/** 0G trust-mode decision and call metadata for a job. Never includes keys, prompts or completions. */
export interface JobPrivacy {
  requestedTrustMode: TrustMode | null;
  selection: (Omit<TrustSelection, "raisedBy"> & {
    raisedBy: TrustSelection["raisedBy"];
    shopMinimumTrustMode: TrustMode | null;
    provider: string | null;
    model: string | null;
    error?: { code: string; message: string } | null;
    at: IsoTimestamp;
  }) | null;
  inferenceCalls: number;
  lastInference: {
    at: IsoTimestamp;
    trustMode: TrustMode;
    model: string;
    ok: boolean;
    provider?: string | null;
    requestId?: string | null;
    /** From 0G `x_0g_trace.tee_verified`; null = not reported by the router. */
    teeVerified?: boolean | null;
    /**
     * tee_signature_verified: the router verified this response's TEE signature.
     * provider_attested: the serving provider is published by 0G as TEE-attested at this tier
     *   (the router did not report a per-response signature result).
     * none: standard tier, no attestation.
     */
    verification?: "tee_signature_verified" | "provider_attested" | "none";
    teeType?: string | null;
    teeVerifier?: string | null;
    errorCode?: string;
  } | null;
}

/* POST /api/v1/jobs/{jobId}/quote/approve -> native-app payment handoff */
export interface PaymentHandoff {
  jobId: string;
  quoteId: string;
  /** Opaque, single-use, short-lived token. Carries no amount and no secret. */
  handoffToken: string;
  /** e.g. inklink://pay?handoff=<token>. Requires native-app support (see docs). */
  deepLink: string;
  /** Same token for scanning with the native app's camera. */
  qrText: string;
  expiresAt: IsoTimestamp;
}

/* POST /api/v1/payment-handoffs/claim (native app, paired session) */
export interface ClaimHandoffRequest {
  handoffToken: string;
}

export interface ClaimHandoffResponse {
  jobId: string;
  quoteId: string;
  shopId: string;
  quote: Quote;
}

/* Shop dashboard (shop admin token) */
export interface ShopOverview {
  shopId: string;
  name: string;
  demo?: boolean;
  acceptingOrders: boolean;
  agent: {
    available: boolean;
    provider: string;
    model: string | null;
    trustMode: string | null;
    reason: string | null;
    zeroG: ZeroGStatus;
  };
  printerAdapter: { reachable: boolean; printers: PrinterSummary[]; defaultPrinter?: string | null; error: string | null };
  payments: { configured: boolean };
  stats: {
    activeJobs: number;
    awaitingApproval: number;
    awaitingExecution: number;
    completedToday: number;
  };
}

export interface ShopConfig {
  name: string;
  description: string;
  /** INR per page, decimal strings. */
  pricePerPageMonochrome: string;
  pricePerPageColor: string;
  /** Shop-wide floor for 0G inference; can only make runs stricter. */
  minimumTrustMode?: TrustMode | null;
  /** Printer for new jobs, chosen from the adapter's discovered printers; null = adapter default. */
  defaultPrinterId?: string | null;
}

/** Which 0G trust modes have a key configured on the backend (never the keys). */
export interface ZeroGStatus {
  baseUrl: string;
  defaultTrustMode: TrustMode;
  requireTeeVerification: boolean;
  modes: Record<TrustMode, { configured: boolean; model: string }>;
}

/* GET /api/v1/shop/payments */
export interface ShopPayments {
  configured: boolean;
  network: "hedera_testnet";
  merchantAccountId: string | null;
  settlementAsset: "HTS-USDC";
  inrToUsdcRate: string | null;
  payments: {
    paymentId: string;
    jobId: string;
    quoteId: string;
    status: PaymentStatus;
    amountUsdc: string;
    amountInr: string | null;
    transactionId: string | null;
    hashscanUrl: string | null;
    jobStatus: JobStatus | null;
  }[];
  awaitingPayment: { jobId: string; status: JobStatus; paymentStatus: PaymentStatus; amountInr: string | null }[];
}

/* GET /api/v1/shop/hardware */
export interface ShopHardware {
  gateway?: { gatewayId: string; fingerprint: string; status: string };
  printerAdapter: {
    reachable: boolean; printers: PrinterSummary[]; defaultPrinter: string | null; error: string | null; url: string;
    /** Cloud backend: the shop gateway relay. `connected` only after a real authenticated poll. */
    relay?: { mode: string; configured?: boolean; connected?: boolean; lastPollAt?: number | null };
  };
  /** ESP32-S3 controllers / gateways, only as they actually reported. */
  devices?: {
    configured: boolean;
    status: "not_configured" | "never_seen" | "online" | "offline";
    items: { deviceId: string; type: string; firmware: string | null; state: string; printerId: string | null; detail: string | null; lastSeenAt: IsoTimestamp; status: "online" | "offline" }[];
  };
  jobs: { jobId: string; status: JobStatus; deviceStatus: DeviceStatus; printerId: string | null; submission: JobView["submission"] }[];
}
