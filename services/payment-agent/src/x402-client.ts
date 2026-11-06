/**
 * x402 client — pays a protected resource using the official @x402/fetch flow.
 *
 *   1. GET resource (no payment)      -> HTTP 402 + PAYMENT-REQUIRED
 *   2. x402 policy filters options    -> only the exact vetted payment survives
 *   3. @x402/hedera signs a partially-signed TransferTransaction
 *   4. Retry with PAYMENT-SIGNATURE   -> server verifies + settles via facilitator
 *   5. Read settlement from the PAYMENT-RESPONSE header
 *
 * The settlement is read ONLY from the PAYMENT-RESPONSE header. A 200 body is not
 * proof of payment. If the header is absent we refuse to report success.
 */

import { decodePaymentResponseHeader } from "@x402/fetch";
import type { X402SettleResponse } from "@inklink/shared-schemas";
import {
  PolicyBlockedError,
  SigningService,
  type PaymentConstraints,
} from "./signing/signing-service.js";

const POLICY_BLOCK = /filtered out by policies|spend control|exceeds|not allowed/i;

/**
 * The transfer was signed and handed to the gate, but no settlement answer came back
 * (connection dropped, timeout, error status without a PAYMENT-RESPONSE). The gate may
 * have settled it, so funds MAY have moved: the spend must stay reserved.
 */
export class PaymentOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentOutcomeUnknownError";
  }
}

/** Minimal surface of SigningService used here (lets tests drive the flow without keys). */
export interface PayingFetchFactory {
  payingFetch(constraints: PaymentConstraints, onSigned?: () => void): typeof fetch;
}

export class X402Client {
  constructor(private readonly signing: PayingFetchFactory | SigningService) {}

  /**
   * `init` carries the method/body for the protected route. Inklink's paid route is
   * `POST /api/v1/jobs/{jobId}/execute`; the x402 wrapper replays the same init on
   * the paid retry.
   */
  async pay(
    resourceUrl: string,
    constraints: PaymentConstraints,
    init: RequestInit = {},
  ): Promise<X402SettleResponse> {
    let signed = false;
    const payingFetch = this.signing.payingFetch(constraints, () => {
      signed = true;
    });
    const unknown = (why: string) =>
      new PaymentOutcomeUnknownError(`Signed payment sent but the outcome is unknown: ${why}`);

    let res: Response;
    try {
      res = await payingFetch(resourceUrl, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (signed) throw unknown(msg);
      if (POLICY_BLOCK.test(msg)) {
        throw new PolicyBlockedError(
          `Merchant requirements did not match the authorized payment: ${msg}`,
        );
      }
      throw err;
    }

    const header =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (header) {
      // An explicit settlement answer (success or a facilitator refusal) is authoritative,
      // whatever the HTTP status.
      return decodePaymentResponseHeader(header) as X402SettleResponse;
    }

    const body = res.ok ? "" : await res.text().catch(() => "");
    const why = res.ok
      ? "Resource returned success without a PAYMENT-RESPONSE settlement header; refusing to treat as paid"
      : `Payment request failed (HTTP ${res.status}): ${body.slice(0, 300)}`;
    throw signed ? unknown(why) : new Error(why);
  }
}
