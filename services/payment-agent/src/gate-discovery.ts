/**
 * Endpoint discovery and price reading, so the agent FINDS the paid endpoint and checks its
 * price itself instead of trusting whatever URL and amount it was handed.
 *
 *   1. discover: GET <gate>/discovery/resources (x402 Bazaar `DiscoveryResourcesResponse`
 *      shape) and pick the Inklink print-job resource and its route template.
 *   2. quote:    POST the job's execute URL without payment and read the 402
 *      `PAYMENT-REQUIRED` header: the exact amount, pay-to account and asset for THIS job.
 *
 * The agent then compares the quote with the customer's signed budget and the backend's
 * amount, and only then lets the x402 client sign (which re-checks the same exact match).
 */

import { decodePaymentRequiredHeader } from "@x402/core/http";

export const PRINT_JOB_TAG = "print-job";
export const PRINT_JOB_ROUTE_TEMPLATE = "/api/v1/jobs/:jobId/execute";
const TIMEOUT_MS = 8000;

export interface GateQuote {
  scheme: string;
  network: string;
  asset: string;
  /** Smallest units (USDC: 6 decimals). */
  amount: string;
  payTo: string;
}

export class GateDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDiscoveryError";
  }
}

async function withTimeout(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw new GateDiscoveryError(`Gate unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(t);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new GateDiscoveryError(`Not a URL: ${url}`);
  }
}

/** Find the print-job endpoint for `jobId` from the gate's published discovery document. */
export async function discoverPrintJobEndpoint(
  gateOrigin: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const origin = originOf(gateOrigin);
  const res = await withTimeout(`${origin}/discovery/resources`, { headers: { Accept: "application/json" } }, fetchImpl);
  if (!res.ok) throw new GateDiscoveryError(`Discovery returned HTTP ${res.status}`);
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new GateDiscoveryError("Discovery document is not JSON");
  }
  const items = (doc as { items?: unknown }).items;
  if ((doc as { x402Version?: unknown }).x402Version !== 2 || !Array.isArray(items)) {
    throw new GateDiscoveryError("Discovery document is not an x402 v2 resource list");
  }
  for (const item of items as Array<Record<string, any>>) {
    const meta = item?.extensions?.inklink;
    if (
      item?.type === "http" &&
      Array.isArray(item.tags) &&
      item.tags.includes(PRINT_JOB_TAG) &&
      meta?.method === "POST" &&
      meta?.routeTemplate === PRINT_JOB_ROUTE_TEMPLATE &&
      typeof item.resource === "string" &&
      originOf(item.resource) === origin // never follow a listing to another host
    ) {
      return `${origin}${PRINT_JOB_ROUTE_TEMPLATE.replace(":jobId", encodeURIComponent(jobId))}`;
    }
  }
  throw new GateDiscoveryError("The gate does not list an Inklink print-job resource");
}

/** Ask the endpoint its price without paying: the 402's accepted payment options. */
export async function quoteFromGate(resourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<GateQuote[]> {
  const res = await withTimeout(
    resourceUrl,
    { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" },
    fetchImpl,
  );
  if (res.status !== 402) {
    throw new GateDiscoveryError(`Expected 402 Payment Required from the gate, got HTTP ${res.status}`);
  }
  const header = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required");
  if (!header) throw new GateDiscoveryError("402 response has no PAYMENT-REQUIRED header");
  let decoded: { accepts?: unknown };
  try {
    decoded = decodePaymentRequiredHeader(header) as { accepts?: unknown };
  } catch {
    throw new GateDiscoveryError("PAYMENT-REQUIRED header could not be decoded");
  }
  if (!Array.isArray(decoded.accepts)) throw new GateDiscoveryError("402 lists no payment options");
  return (decoded.accepts as Array<Record<string, unknown>>)
    .filter((a) => typeof a.amount === "string" && typeof a.payTo === "string" && typeof a.asset === "string")
    .map((a) => ({
      scheme: String(a.scheme),
      network: String(a.network),
      asset: String(a.asset),
      amount: String(a.amount),
      payTo: String(a.payTo),
    }));
}
