/**
 * Where the x402 gate learns what a job must pay.
 *
 * The amount and payee are BACKEND-AUTHORITATIVE: the gate never invents or
 * accepts them from the caller. Two sources:
 *
 *  - FixedRequirementsSource   DEV ONLY. One fixed price/payee for every job.
 *  - BackendRequirementsSource Asks the Inklink backend. The URL is supplied by
 *    config (REQUIREMENTS_URL_TEMPLATE), because the backend endpoint for this is
 *    PROPOSED and not yet agreed. Expected JSON:
 *      { "jobId": "...", "merchantAccountId": "0.0.X", "amount": "0.10",
 *        "expiresAt": "ISO-8601" }   // amount = exact USDC decimal string
 */

import { toSmallestUnit } from "./money.js";

export interface JobPaymentRequirements {
  jobId: string;
  /** Exact amount in USDC smallest units. */
  amountAtomic: bigint;
  /** Shop's Hedera receiving account. */
  payTo: string;
  /** Quote expiry = payment deadline. */
  expiresAt?: string;
}

export interface RequirementsSource {
  /** null = unknown job. Throws on backend/transport failure. */
  get(jobId: string): Promise<JobPaymentRequirements | null>;
}

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;

/** DEV ONLY: every job costs the same and pays the same account. */
export class FixedRequirementsSource implements RequirementsSource {
  constructor(
    private readonly amountDecimal: string,
    private readonly payTo: string,
    private readonly decimals: number,
  ) {}

  async get(jobId: string): Promise<JobPaymentRequirements> {
    return {
      jobId,
      amountAtomic: toSmallestUnit(this.amountDecimal, this.decimals),
      payTo: this.payTo,
    };
  }
}

/** Validate and normalise the backend's response. Pure, so it is unit tested. */
export function parseBackendRequirements(
  json: unknown,
  jobId: string,
  decimals: number,
): JobPaymentRequirements {
  const o = (json ?? {}) as Record<string, unknown>;
  if (o.jobId !== jobId) throw new Error("requirements jobId does not match the request");
  if (typeof o.merchantAccountId !== "string" || !ACCOUNT_ID.test(o.merchantAccountId)) {
    throw new Error("requirements merchantAccountId is not a Hedera account id");
  }
  if (typeof o.amount !== "string") throw new Error("requirements amount must be a decimal string");
  const amountAtomic = toSmallestUnit(o.amount, decimals); // throws on bad/over-precise input
  if (amountAtomic <= 0n) throw new Error("requirements amount must be positive");
  if (o.expiresAt !== undefined && Number.isNaN(Date.parse(String(o.expiresAt)))) {
    throw new Error("requirements expiresAt is not a valid timestamp");
  }
  return {
    jobId,
    amountAtomic,
    payTo: o.merchantAccountId,
    expiresAt: o.expiresAt === undefined ? undefined : String(o.expiresAt),
  };
}

export class BackendRequirementsSource implements RequirementsSource {
  private cache = new Map<string, { at: number; value: JobPaymentRequirements | null }>();

  constructor(
    private readonly urlTemplate: string,
    private readonly decimals: number,
    private readonly bearerToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 5_000,
  ) {
    if (!urlTemplate.includes("{jobId}")) {
      throw new Error("REQUIREMENTS_URL_TEMPLATE must contain {jobId}");
    }
  }

  async get(jobId: string): Promise<JobPaymentRequirements | null> {
    const hit = this.cache.get(jobId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const res = await this.fetchImpl(
      this.urlTemplate.replace("{jobId}", encodeURIComponent(jobId)),
      { headers: this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {} },
    );
    let value: JobPaymentRequirements | null;
    if (res.status === 404) {
      value = null;
    } else if (!res.ok) {
      throw new Error(`Backend requirements lookup failed (HTTP ${res.status})`);
    } else {
      value = parseBackendRequirements(await res.json(), jobId, this.decimals);
    }
    this.cache.set(jobId, { at: Date.now(), value });
    return value;
  }
}
