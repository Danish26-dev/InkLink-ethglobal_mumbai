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
import type { OperatorPrintConfig, PrinterSummary } from "./operator-events.js";

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
    reviewRecommended: boolean;
    notes: string[];
  } | null;
  operatorConfig: OperatorPrintConfig;
  /** True when the adapter validated the full config against the real printer. */
  configValidated: boolean;
  quote: Quote | null;
  customerApprovedQuote: boolean;
  shopApproved: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
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
  acceptingOrders: boolean;
  agent: {
    available: boolean;
    provider: string;
    model: string | null;
    trustMode: string | null;
    reason: string | null;
  };
  printerAdapter: { reachable: boolean; printers: PrinterSummary[]; error: string | null };
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
}
