/**
 * Common types shared across all Inklink API contracts.
 *
 * Source of truth for v0.1 integration. Any breaking change MUST be coordinated
 * with the main backend owner before implementation (see docs/INTEGRATION_STATUS.md).
 */

/** ISO-8601 timestamp string, e.g. "2026-11-05T12:30:00.000Z". */
export type IsoTimestamp = string;

/**
 * Monetary amount as a DECIMAL STRING. Never use floating-point arithmetic for
 * payment amounts (locked decision). e.g. "20.00".
 */
export type DecimalString = string;

/**
 * Standard Inklink error envelope. Used across all APIs. The HTTP status code
 * must also reflect the actual error.
 */
export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Successful responses return the payload directly (not wrapped). */
export type ApiResult<T> = T | ErrorEnvelope;

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === false &&
    "error" in value
  );
}

/** Known error codes. Extend as the contract grows (coordinate changes). */
export type ErrorCode =
  | "SHOP_UNAVAILABLE"
  | "SHOP_NOT_FOUND"
  | "GATEWAY_UNREACHABLE"
  | "INVALID_QR"
  | "QR_EXPIRED"
  | "SIGNATURE_INVALID"
  | "PAIRING_FAILED"
  | "DOCUMENT_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "UPLOAD_FAILED"
  | "JOB_NOT_FOUND"
  | "QUOTE_EXPIRED"
  | "UNAUTHORIZED"
  | "SESSION_EXPIRED"
  | "AUTHORIZATION_INVALID"
  | "AUTHORIZATION_SIGNATURE_INVALID"
  | "AUTHORIZATION_REPLAYED"
  | "RESOURCE_NOT_ALLOWED"
  | "FACILITATOR_UNAVAILABLE"
  | "POLICY_VIOLATION"
  | "PAYMENT_FAILED"
  | "SETTLEMENT_UNVERIFIED"
  | "FACILITATOR_UNSUPPORTED"
  | "INTERNAL_ERROR";

/** Supported document formats in the initial scope. No OCR / scanned PDFs. */
export type DocumentFormat = "pdf" | "docx";

/** Display/quote asset vs. on-chain settlement asset are intentionally distinct. */
export type DisplayAsset = "INR";
export type SettlementAsset = "USDC"; // HTS-USDC on Hedera Testnet (locked decision)
