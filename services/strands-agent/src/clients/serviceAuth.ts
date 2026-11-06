/**
 * Service-to-service authentication for private Cloud Run services.
 *
 * With SERVICE_AUTH=gcp-id-token, calls to the Document Engine carry a
 * Google-signed ID token for that service in `X-Serverless-Authorization`
 * (checked by Cloud Run IAM). Tokens come from the metadata server of the
 * runtime service account: no key files. Locally and in docker compose
 * SERVICE_AUTH is empty and no header is added.
 */

const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const TOKEN_TTL_MS = 50 * 60_000; // Google ID tokens are valid for 1 hour

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Cloud Run accepts the service's base URL (scheme + host) as the audience. */
export function audienceFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export async function serviceAuthHeaders(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  if ((process.env.SERVICE_AUTH ?? '').trim().toLowerCase() !== 'gcp-id-token') return {};
  const audience = audienceFor(url);
  const hit = cache.get(audience);
  if (hit && hit.expiresAt > Date.now()) return { 'X-Serverless-Authorization': `Bearer ${hit.token}` };
  try {
    const res = await fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!res.ok) throw new Error(`metadata server returned ${res.status}`);
    const token = (await res.text()).trim();
    cache.set(audience, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return { 'X-Serverless-Authorization': `Bearer ${token}` };
  } catch (err) {
    // The call proceeds without the header; Cloud Run then answers 401/403, which the
    // caller reports as a typed engine error. Never log token material.
    // eslint-disable-next-line no-console
    console.warn(`[inklink-agent] could not obtain an ID token for ${audience}: ${(err as Error).message}`);
    return {};
  }
}

/** Test helper. */
export function clearServiceAuthCache(): void {
  cache.clear();
}
