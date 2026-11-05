/**
 * Model-provider selection for the Inklink agent service.
 *
 * INKLINK_MODEL_PROVIDER chooses the inference backend explicitly:
 *   - "0g-private-computer" (default): 0G Private Computer router, an
 *     OpenAI-compatible endpoint. Privacy is requested per call with the
 *     `X-0G-Provider-Trust-Mode` header.
 *   - "vertex-ai": Google Vertex AI (Gemini). Only used when selected.
 *
 * There is NO automatic fallback between providers. If the selected provider is
 * not configured, `providerStatus()` reports it as unavailable with a reason and
 * `buildModel()` throws; callers must surface that instead of pretending the
 * agent works.
 *
 * Credentials (ZEROG_API_KEY) are read on the server only and never returned by
 * any endpoint; `providerStatus()` carries no secret.
 */
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { Model } from '@strands-agents/sdk';
import { buildVertexModel } from './vertexProvider.js';
import { missingVertexConfig } from '../config.js';

export type ProviderId = '0g-private-computer' | 'vertex-ai';
export type ZeroGTrustMode = 'private' | 'verified' | 'standard';

export const ZEROG_DEFAULT_BASE_URL = 'https://router-api.0g.ai/v1';
export const ZEROG_TRUST_HEADER = 'X-0G-Provider-Trust-Mode';

export interface ProviderStatus {
  provider: ProviderId | string;
  available: boolean;
  model: string | null;
  /** Requested privacy mode (0G only). */
  trustMode: ZeroGTrustMode | null;
  /** Why the provider is unavailable; never contains a secret. */
  reason: string | null;
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

interface ZeroGConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  trustMode: ZeroGTrustMode;
  temperature: number;
}

function zeroGConfig(): { config: ZeroGConfig | null; reason: string | null; trustMode: ZeroGTrustMode | null } {
  const rawMode = (env('ZEROG_TRUST_MODE') || 'private').toLowerCase();
  if (!['private', 'verified', 'standard'].includes(rawMode)) {
    return { config: null, reason: 'ZEROG_TRUST_MODE must be private, verified or standard.', trustMode: null };
  }
  const trustMode = rawMode as ZeroGTrustMode;
  const missing = ['ZEROG_API_KEY', 'ZEROG_MODEL_ID'].filter((n) => !env(n));
  if (missing.length > 0) {
    return { config: null, reason: `0G Private Computer is not configured (missing ${missing.join(', ')}).`, trustMode };
  }
  const baseUrl = (env('ZEROG_BASE_URL') || ZEROG_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) {
    return { config: null, reason: 'ZEROG_BASE_URL must be an https URL.', trustMode };
  }
  return {
    config: {
      apiKey: env('ZEROG_API_KEY'),
      model: env('ZEROG_MODEL_ID'),
      baseUrl,
      trustMode,
      temperature: Number.parseFloat(env('MODEL_TEMPERATURE') || '0'),
    },
    reason: null,
    trustMode,
  };
}

/** Non-secret description of the configured provider. Does not contact the network. */
export function providerStatus(): ProviderStatus {
  const provider = selectedProvider();
  if (provider === '0g-private-computer') {
    const { config, reason, trustMode } = zeroGConfig();
    return {
      provider,
      available: config !== null,
      model: config?.model ?? (env('ZEROG_MODEL_ID') || null),
      trustMode,
      reason,
    };
  }
  if (provider === 'vertex-ai') {
    const missing = missingVertexConfig();
    return {
      provider,
      available: missing.length === 0,
      model: env('VERTEX_AI_MODEL_ID') || null,
      trustMode: null,
      reason: missing.length ? `Vertex AI is not configured (missing ${missing.join(', ')}).` : null,
    };
  }
  return {
    provider,
    available: false,
    model: null,
    trustMode: null,
    reason: `Unknown INKLINK_MODEL_PROVIDER "${provider}". Use 0g-private-computer or vertex-ai.`,
  };
}

/** Headers sent on every 0G request. `standard` sends none (it is the router default). */
export function zeroGHeaders(trustMode: ZeroGTrustMode): Record<string, string> {
  return trustMode === 'standard' ? {} : { [ZEROG_TRUST_HEADER]: trustMode };
}

/** Build the selected model, or throw ModelUnavailableError. Never falls back. */
export function buildModel(): Model {
  const provider = selectedProvider();
  if (provider === '0g-private-computer') {
    const { config, reason } = zeroGConfig();
    if (!config) throw new ModelUnavailableError(reason ?? '0G Private Computer is not configured.');
    return new OpenAIModel({
      api: 'chat',
      modelId: config.model,
      apiKey: config.apiKey,
      temperature: config.temperature,
      clientConfig: {
        baseURL: config.baseUrl,
        defaultHeaders: zeroGHeaders(config.trustMode),
        maxRetries: 2,
        timeout: 120_000,
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
