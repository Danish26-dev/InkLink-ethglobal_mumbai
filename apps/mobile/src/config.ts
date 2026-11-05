/**
 * App configuration.
 *
 * The gateway address is NEVER configured here: it comes from the shop's signed
 * QR code (IPv4 hint or mDNS name) and is only trusted after the pairing
 * handshake. The cloud API is not provisioned yet.
 */

export const appConfig = {
  /** Inklink Cloud API origin. Not provisioned yet; the cloud-availability probe stays false until it is. */
  cloudOrigin: process.env.EXPO_PUBLIC_CLOUD_ORIGIN ?? "",
  agentId: "inklink_payment_agent",
  /** Spending policy lifetime offered to the customer. */
  authorizationLifetimeMs: 60 * 60_000,
};

/** Plain origin for health probes (strips a trailing /api/v1). */
export function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/api\/v1$/, "");
}
