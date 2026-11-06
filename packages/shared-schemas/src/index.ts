/**
 * @inklink/shared-schemas
 *
 * Single source of truth for Inklink's cross-module types: API Contracts 1-8,
 * the payment authorization policy, shop discovery (QR/BLE), and the x402
 * protocol shapes for Hedera.
 *
 * Consumed by apps/mobile and services/payment-agent. Mirrored in
 * docs/API_CONTRACTS.md. Breaking changes must be coordinated with the main
 * backend owner (see docs/INTEGRATION_STATUS.md).
 */

export * from "./common.js";
export * from "./wire-format.js";
export * from "./authorization.js";
export * from "./contracts.js";
export * from "./payment-policy.js";
export * from "./discovery.js";
export * from "./x402.js";
export * from "./offline-pay.js";
export * from "./operator-events.js";
export * from "./web.js";
