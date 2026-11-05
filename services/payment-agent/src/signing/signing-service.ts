/**
 * Signing service — the ONLY module that loads the agent wallet private key.
 *
 * Uses the official @x402/hedera client signer. The key never leaves this file:
 * it is not returned, logged, or exposed to callers, an LLM, or the app.
 *
 * Defence in depth: before the signer is ever invoked, an x402 *policy* runs
 * inside the client and drops every payment option that does not exactly match
 * the vetted PaymentIntent (merchant account, asset, network, amount). If nothing
 * matches, no signature is produced. This is on top of the authorization-policy
 * check in payment-agent.ts (allowlist, per-tx max, total limit, expiry).
 */

import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { HEDERA_TESTNET, loadHederaConfig } from "../config.js";
import { toSmallestUnit } from "../money.js";

/** What a single payment is allowed to be. Derived from the vetted intent. */
export interface PaymentConstraints {
  /** Hedera account that must receive the funds. */
  payTo: string;
  /** Decimal-string amount in the settlement asset (USDC). */
  amount: string;
}

export class PolicyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyBlockedError";
  }
}

/** Accept raw hex (with/without 0x) or DER; normalise to what the SDK parses. */
function parseEcdsaKey(raw: string): PrivateKey {
  const cleaned = raw.trim().replace(/^0x/i, "");
  return PrivateKey.fromStringECDSA(cleaned);
}

export class SigningService {
  private readonly cfg = loadHederaConfig();
  private readonly signer = createClientHederaSigner(
    this.cfg.agentAccountId,
    parseEcdsaKey(this.cfg.agentPrivateKey),
    { network: HEDERA_TESTNET },
  );

  /** Public account id is safe to expose; the key is not. */
  get agentAccountId(): string {
    return this.cfg.agentAccountId;
  }

  /**
   * Build a fetch that transparently handles a 402 for exactly ONE vetted payment.
   * A fresh x402 client is created per payment so constraints can never leak
   * across payments.
   */
  payingFetch(constraints: PaymentConstraints): typeof fetch {
    const expectedAtomic = toSmallestUnit(constraints.amount, this.cfg.usdcDecimals);
    const { usdcTokenId } = this.cfg;

    const matchesIntent = (r: PaymentRequirements): boolean => {
      try {
        return (
          r.scheme === "exact" &&
          r.network === HEDERA_TESTNET &&
          r.asset === usdcTokenId &&
          r.payTo === constraints.payTo &&
          BigInt(r.amount) === expectedAtomic
        );
      } catch {
        return false;
      }
    };

    const client = new x402Client()
      .register("hedera:*", new ExactHederaScheme(this.signer))
      // Hard cap: this one payment can never exceed the vetted amount.
      .setSpendControls({
        allowedAssets: [
          {
            network: HEDERA_TESTNET,
            asset: usdcTokenId,
            maxAmountPerPayment: expectedAtomic.toString(),
          },
        ],
      })
      // Drop every option that is not exactly the vetted payment.
      .registerPolicy((_version, requirements) => requirements.filter(matchesIntent));

    return wrapFetchWithPayment(fetch, client);
  }
}
