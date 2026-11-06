/**
 * Model-provider selection for the Inklink agent service.
 *
 * INKLINK_MODEL_PROVIDER chooses the inference backend explicitly:
 *   - "0g-private-computer" (default): 0G Private Computer, BROKERED BY THE
 *     INKLINK BACKEND. This service holds no 0G key. For each print-operator
 *     run the backend classifies the document, selects the trust mode
 *     (standard / verified / private) and passes a short-lived inference grant.
 *     Strands' OpenAIModel then calls the backend's OpenAI-compatible gateway,
 *     which uses the API key and `X-0G-Provider-Trust-Mode` header for exactly
 *     that mode and never downgrades.
 *   - "vertex-ai": Google Vertex AI (Gemini). Only used when selected. The
 *     backend refuses to send documents that need verified/private inference
 *     to this provider.
 *
 * There is NO automatic fallback between providers. If the selected provider
 * cannot run, `buildModel()` throws ModelUnavailableError and the caller
 * reports the agent as unavailable.
 */
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { Model } from '@strands-agents/sdk';
import { buildVertexModel } from './vertexProvider.js';
import { missingVertexConfig } from '../config.js';

export type ProviderId = '0g-private-computer' | 'vertex-ai';
export type ZeroGTrustMode = 'private' | 'verified' | 'standard';
export const ZEROG_TRUST_MODES: readonly ZeroGTrustMode[] = ['standard', 'verified', 'private'];

/** Per-run grant issued by the Inklink backend. Carries no 0G key. */
export interface InferenceGrant {
  baseUrl: string;
  token: string;
  model: string;
  trustMode: ZeroGTrustMode;
}

export interface ProviderStatus {
  provider: ProviderId | string;
  available: boolean;
  model: string | null;
  /** Trust mode is selected per run by the backend (null here). */
  trustMode: ZeroGTrustMode | null;
  /** Why the provider is unavailable; never contains a secret. */
  reason: string | null;
  /** True when inference is brokered by the backend (0G). */
  brokered: boolean;
}

export class ModelUnavailableError extends Error {
  code = 'MODEL_PROVIDER_UNAVAILABLE';
  constructor(reason: string) {
    super(reason);
    this.name = 'ModelUnavailableError';
  }
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function selectedProvider(): string {
  return env('INKLINK_MODEL_PROVIDER') || '0g-private-computer';
}

/** Non-secret description of the configured provider. Does not contact the network. */
export function providerStatus(): ProviderStatus {
  const provider = selectedProvider();
  if (provider === '0g-private-computer') {
    // Availability of each trust mode is decided by the backend (it holds the keys).
    return { provider, available: true, model: null, trustMode: null, reason: null, brokered: true };
  }
  if (provider === 'vertex-ai') {
    const missing = missingVertexConfig();
    return {
      provider,
      available: missing.length === 0,
      model: env('VERTEX_AI_MODEL_ID') || null,
      trustMode: null,
      reason: missing.length ? `Vertex AI is not configured (missing ${missing.join(', ')}).` : null,
      brokered: false,
    };
  }
  return {
    provider,
    available: false,
    model: null,
    trustMode: null,
    reason: `Unknown INKLINK_MODEL_PROVIDER "${provider}". Use 0g-private-computer or vertex-ai.`,
    brokered: false,
  };
}

/** Parse and check a grant from the backend. Returns null when it is not usable. */
export function parseGrant(raw: unknown): InferenceGrant | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { baseUrl, token, model, trustMode } = v;
  if (typeof baseUrl !== 'string' || typeof token !== 'string' || typeof model !== 'string') return null;
  if (!ZEROG_TRUST_MODES.includes(trustMode)) return null;
  if (!token || !model) return null;
  // The gateway must be the configured backend: never send a conversation elsewhere.
  const backend = (env('BACKEND_URL') || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  let target: URL;
  let expected: URL;
  try {
    target = new URL(baseUrl);
    expected = new URL(backend);
  } catch {
    return null;
  }
  if (target.origin !== expected.origin) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token, model, trustMode };
}

/** Build the selected model, or throw ModelUnavailableError. Never falls back. */
export function buildModel(grant?: InferenceGrant | null): Model {
  const provider = selectedProvider();
  if (provider === '0g-private-computer') {
    if (!grant) {
      throw new ModelUnavailableError(
        '0G inference is brokered by the Inklink backend; it was not granted for this run.',
      );
    }
    return new OpenAIModel({
      api: 'chat',
      modelId: grant.model,
      apiKey: grant.token, // backend inference grant, not a 0G key
      temperature: Number.parseFloat(env('MODEL_TEMPERATURE') || '0'),
      clientConfig: {
        baseURL: grant.baseUrl,
        // The backend never retries in another trust mode; do not hide its errors behind retries.
        maxRetries: 0,
        timeout: 200_000,
      },
    }) as unknown as Model;
  }
  if (provider === 'vertex-ai') {
    const missing = missingVertexConfig();
    if (missing.length) throw new ModelUnavailableError(`Vertex AI is not configured (missing ${missing.join(', ')}).`);
    return buildVertexModel() as unknown as Model;
  }
  throw new ModelUnavailableError(providerStatus().reason ?? 'Unknown model provider.');
}
