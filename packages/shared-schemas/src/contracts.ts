/**
 * Inklink API Contracts 1-8 (v0.1 baseline).
 *
 * These mirror docs/API_CONTRACTS.md. The main backend owner (XYZ) owns final
 * schema approval; this file is the client-side source of truth for the native
 * app and payment service until a breaking change is coordinated.
 *
 * Base URLs:
 *   Local: http://<gateway-local-ip>:8000/api/v1   (discovered, never hardcoded)
 *   Cloud: https://<inklink-cloud-run-url>/api/v1   (not provisioned yet)
 */

import type {
  DecimalString,
  DisplayAsset,
  DocumentFormat,
  IsoTimestamp,
  SettlementAsset,
} from "./common.js";

/* ───────────── CONTRACT 1 — Shop Discovery ─────────────
 * GET /shops/{shopId}
 */
export interface ShopCapabilities {
  localPrinting: boolean;
  pdf: boolean;
  docx: boolean;
  aiEditing: boolean;
  offlineMode: boolean;
}

export interface ShopConnection {
  localGatewayAvailable: boolean;
  internetAvailable: boolean;
}

export interface Shop {
  shopId: string;
  gatewayId: string;
  name: string;
  protocolVersion: string;
  capabilities: ShopCapabilities;
  connection: ShopConnection;
}

/* ───────────── CONTRACT 2 — Document Upload ─────────────
 * POST /documents  (multipart/form-data)
 * Fields: file, shopId, customerId, jobId
 * NOTE: jobId must already exist (created via Contract 3 first). The app does
 * NOT generate authoritative job IDs.
 */
export interface DocumentUploadFields {
  shopId: string;
  customerId: string;
  jobId: string;
}

export interface DocumentUploadResponse {
  documentId: string;
  jobId: string;
  filename: string;
  format: DocumentFormat;
  size: number;
  status: "uploaded";
}

/* ───────────── CONTRACT 3 — Create Print Job ─────────────
 * POST /jobs   (CALL THIS FIRST — it returns the authoritative jobId)
 */
export type ColourMode = "colour" | "grayscale";
/** Same sizes the local printer agent supports (OPERATOR_PAPER_SIZES). A3 is not supported. */
export type PaperSize = "A4" | "Letter" | "Legal";
/** Same values as OPERATOR_ORIENTATIONS (local printer agent). */
export type PrintOrientation = "portrait" | "landscape";
/** Same values as OPERATOR_SIDES (local printer agent). */
export type PrintSides = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";

export interface PrintConfig {
  copies: number;
  pageRange: string; // e.g. "1-5" or "all"
  colourMode: ColourMode; // backend maps grayscale -> monochrome, colour -> color
  paperSize: PaperSize;
  /** Optional for backward compatibility; the app always sends it. */
  orientation?: PrintOrientation;
  /** Optional for backward compatibility; the app always sends it. */
  sides?: PrintSides;
}

export interface CreateJobRequest {
  shopId: string;
  documentId?: string; // optional at creation; linked after upload
  printConfig: PrintConfig;
}

export interface CreateJobResponse {
  jobId: string;
  status: "created";
  createdAt: IsoTimestamp;
}

/* ───────────── CONTRACT 4 — Generate Quotation ─────────────
 * POST /jobs/{jobId}/quote
 * Quote is in INR (display). For hedera_x402 the backend converts INR -> USDC
 * using a rate snapshot bound to quote expiry. The app NEVER computes USDC.
 */
export type PaymentMethod = "traditional" | "hedera_x402";

/**
 * Authoritative USDC settlement details, calculated by the BACKEND and only
 * displayed by the app. Policy (agreed): rate snapshot valid 5 minutes, USDC to 6
 * decimal places, rounded UP so the shop is never undercharged. The quote expiry
 * is also the payment deadline.
 */
export interface QuoteSettlement {
  asset: "HTS-USDC";
  /** Exact USDC the customer will pay, decimal string, max 6 decimals. */
  amount: DecimalString;
  /** INR -> USDC rate used for this snapshot (decimal string). */
  rate: DecimalString;
  capturedAt: IsoTimestamp;
}

export interface Quote {
  quoteId: string;
  jobId: string;
  merchantId: string;
  amount: DecimalString; // INR display amount
  asset: DisplayAsset; // "INR"
  expiresAt: IsoTimestamp;
  paymentMethods: PaymentMethod[];
  /** Present when paymentMethods includes "hedera_x402". */
  settlement?: QuoteSettlement;
}

/* ───────────── CONTRACT 5 — Authorize Payment Agent ─────────────
 * POST /payments/authorizations
 * Authorization must be backed by a real customer approval mechanism, not a bare
 * JSON request. For the hackathon the approval binds the customer to a spending
 * policy enforced server-side before every payment (see docs/SECURITY.md).
 */
export interface AuthorizePaymentRequest {
  /** Anonymous per-install id; must equal customerReferenceFor(devicePublicKey). */
  customerReference: string;
  agentId: string; // e.g. "inklink_payment_agent"
  merchantId: string; // single merchant or first of an allowlist
  maxPerTransaction: DecimalString; // in settlement asset
  totalSpendingLimit: DecimalString; // in settlement asset
  asset: SettlementAsset; // "USDC"
  expiresAt: IsoTimestamp;
  /** Base64URL, at least 16 random bytes. Single use (replay protection). */
  nonce: string;
  /** Base64URL raw Ed25519 public key (32 bytes) of the customer's device key. */
  devicePublicKey: string;
  /**
   * Base64URL Ed25519 signature over
   * canonicalJson(authorizationSigningPayload(request)) — see authorization.ts.
   */
  signature: string;
}

export type AuthorizationStatus = "active" | "expired" | "revoked" | "exhausted";

export interface AuthorizePaymentResponse {
  authorizationId: string;
  status: AuthorizationStatus;
  merchantId: string;
  maxPerTransaction: DecimalString;
}

/* ───────────── CONTRACT 6 — Initiate Payment ─────────────
 * POST /payments
 */
export interface InitiatePaymentRequest {
  jobId: string;
  quoteId: string;
  authorizationId: string;
  paymentMethod: PaymentMethod;
}

export interface InitiatePaymentResponse {
  paymentId: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
}

/**
 * INTERNAL request: Inklink backend -> Payment Agent (never from the app).
 * The backend supplies the authoritative settlement amount; the agent refuses to
 * pay anything that differs from it. Requires `Authorization: Bearer <token>`.
 */
export interface AgentInitiatePaymentRequest extends InitiatePaymentRequest {
  merchantId: string;
  /** USDC decimal string computed by the backend from the INR quote. */
  settlementAmount: DecimalString;
  /** The x402-protected resource to pay, e.g. .../api/v1/jobs/{jobId}/execute. */
  resourceUrl: string;
  /**
   * Authoritative backend quote expiry = payment deadline. Required: the agent refuses
   * to start a payment without it, or after it.
   */
  quoteExpiresAt: IsoTimestamp;
}

/* ───────────── CONTRACT 7 — Payment Status ─────────────
 * GET /payments/{paymentId}
 * Only "settled" after ACTUAL on-chain settlement verification.
 */
export type PaymentStatus =
  | "created"
  | "pending"
  | "awaiting_authorization"
  | "processing"
  | "settled"
  | "failed"
  | "expired"
  | "refunded";

export interface PaymentStatusResponse {
  paymentId: string;
  jobId: string;
  status: PaymentStatus;
  network: "hedera_testnet";
  transactionId: string | null; // real Hedera tx id once settled, else null
  amount: DecimalString; // settlement amount (USDC)
  asset: SettlementAsset;
  merchantId: string;
}

/* ───────────── CONTRACT 8 — Job Status ─────────────
 * GET /jobs/{jobId}/status
 * Backend owns authoritative job/payment status. App polls; never self-authorizes.
 */
export type JobStatus =
  | "created"
  | "awaiting_payment"
  | "awaiting_execution"
  | "executing"
  | "completed"
  | "cancelled"
  | "failed";

export type DeviceStatus =
  | "unknown"
  | "offline"
  | "ready"
  | "processing"
  | "paper_unavailable"
  | "jam"
  | "error";

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  paymentStatus: PaymentStatus;
  deviceStatus: DeviceStatus;
  updatedAt: IsoTimestamp;
}
