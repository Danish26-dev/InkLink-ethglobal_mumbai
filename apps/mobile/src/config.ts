/**
 * App configuration.
 *
 * The gateway address is NEVER trusted from configuration alone: it comes from the
 * shop's signed QR code (IPv4 hint, mDNS name, or a signed cloud origin) and is only
 * trusted after the pairing handshake proves the shop's key.
 */

export const appConfig = {
  /**
   * Inklink cloud backend origin for this build (EAS profile env, e.g. the staging
   * Cloud Run URL). Used for the cloud-availability probe and as a last-resort pairing
   * candidate; a gateway reached through it must still pass the handshake.
   */
  cloudOrigin: (process.env.EXPO_PUBLIC_CLOUD_ORIGIN ?? "").replace(/\/+$/, ""),
  agentId: "inklink_payment_agent",
  /** Spending policy lifetime offered to the customer. */
  authorizationLifetimeMs: 60 * 60_000,
};

/** Plain origin for health probes (strips a trailing /api/v1). */
export function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/api\/v1$/, "");
}
