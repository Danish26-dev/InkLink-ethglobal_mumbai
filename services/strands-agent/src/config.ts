/**
 * Runtime configuration for the Inklink Strands Agent.
 *
 * All values come from environment variables (see .env.example).
 *
 * Model provider: Google Cloud Vertex AI (Gemini) via the Strands SDK's
 * GoogleModel, authenticated with Application Default Credentials (ADC). No API
 * key and no service-account JSON are read by application code; ADC is handled
 * by the Google auth library (e.g. `gcloud auth application-default login`
 * locally, or a workload identity in the cloud). No AWS / Bedrock settings are
 * read.
 */
import dotenv from 'dotenv';

dotenv.config();

export interface AgentConfig {
  port: number;
  /** Bind address. Loopback by default; containers set HOST=0.0.0.0. */
  host: string;
  documentEngineUrl: string;
  /** Browser origins allowed to call the agent. Empty = CORS disabled. */
  allowedOrigins: string[];

  googleCloudProject: string;
  googleCloudLocation: string;
  /** Whether to route @google/genai through Vertex AI (ADC) vs the Gemini API. */
  useVertexAi: boolean;
  vertexModelId: string;
  modelTemperature: number;
  /** Cap on output tokens per model call (reduces token-per-minute pressure). */
  maxOutputTokens: number;
  /**
   * Gemini 2.5 "thinking" token budget. <= 0 means "unset" (use the model's
   * default, which keeps tool-calling reliable). A positive value caps thinking
   * tokens; setting it too low (e.g. 0) can stall the tool-calling loop, so the
   * default is unset.
   */
  thinkingBudget: number;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    // Clear, secret-free error. Only the variable NAME is referenced.
    throw new Error(`Missing ${name}`);
  }
  return v.trim();
}

/** Parse a boolean-ish env flag ("true"/"1"/"yes"). */
function boolFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return /^(true|1|yes)$/i.test(v.trim());
}

/** Parse a comma-separated list of origins. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build and validate configuration. Throws a clear, secret-free error if a
 * required Vertex AI setting is missing. Does NOT contact Google/Vertex.
 */
export function loadConfig(): AgentConfig {
  return {
    port: parseInt(optional('PORT', '4000'), 10),
    host: optional('HOST', '127.0.0.1'),
    documentEngineUrl: optional('DOCUMENT_ENGINE_URL', 'http://localhost:5001').replace(/\/+$/, ''),
    allowedOrigins: parseOrigins(process.env.AGENT_ALLOWED_ORIGINS),

    // Vertex AI — required. Fail fast rather than guessing.
    googleCloudProject: required('GOOGLE_CLOUD_PROJECT'),
    googleCloudLocation: required('GOOGLE_CLOUD_LOCATION'),
    useVertexAi: boolFlag('GOOGLE_GENAI_USE_VERTEXAI', true),
    vertexModelId: required('VERTEX_AI_MODEL_ID'),
    modelTemperature: parseFloat(optional('MODEL_TEMPERATURE', '0')),
    maxOutputTokens: parseInt(optional('VERTEX_MAX_OUTPUT_TOKENS', '2048'), 10),
    // Default -1 = unset (use the model's default thinking budget).
    thinkingBudget: parseInt(optional('VERTEX_THINKING_BUDGET', '-1'), 10),
  };
}

/**
 * Validate required Vertex AI configuration without building the full config.
 * Returns the list of missing variable NAMES (never values). Used by startup
 * validation and tests.
 */
export function missingVertexConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT.trim() === '') missing.push('GOOGLE_CLOUD_PROJECT');
  if (!env.GOOGLE_CLOUD_LOCATION || env.GOOGLE_CLOUD_LOCATION.trim() === '') missing.push('GOOGLE_CLOUD_LOCATION');
  if (!env.VERTEX_AI_MODEL_ID || env.VERTEX_AI_MODEL_ID.trim() === '') missing.push('VERTEX_AI_MODEL_ID');
  return missing;
}

/**
 * Lazily-resolved config singleton. We do NOT throw at import time so unit
 * tests (which never call the model) can import modules without setting the
 * provider env vars. `getConfig()` validates on first real use.
 */
let _config: AgentConfig | null = null;

export function getConfig(): AgentConfig {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}

/** Test helper: reset the memoized config (not used in production). */
export function resetConfigForTests(): void {
  _config = null;
}
