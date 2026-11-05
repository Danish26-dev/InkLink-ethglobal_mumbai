/**
 * Sanitized error mapping for model-provider / configuration failures.
 *
 * Active provider: Google Vertex AI (Gemini). The Bedrock error classification
 * below is dormant (no Bedrock model is wired); it is harmless, tested, and can
 * be removed once the provider decision for Inklink (Google ADK) is final.
 *
 * These errors are surfaced to the Inklink backend (and ultimately a user). They must
 * NEVER contain credentials, tokens, Authorization headers, or raw provider
 * internals. We map known error shapes to a stable `code` + a safe, human
 * message. A non-secret error name/status is kept for server logs only.
 */

export class AgentError extends Error {
  code: string;
  /** Non-secret detail for server logs (e.g. error name/status). Not for clients. */
  logDetail?: string;

  constructor(code: string, message: string, logDetail?: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.logDetail = logDetail;
  }
}

/** Walk the error + its `.cause` chain, returning the first match from a set of
 * known names/codes. Only reads names/codes, never messages. */
function findErrorName(err: unknown, names: Set<string>): string | null {
  let cur: any = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const n = (cur.name || cur.code || cur.__type || cur.status || '').toString();
    if (names.has(n)) return n;
    cur = cur.cause;
  }
  return null;
}

/** Extract an HTTP-ish status code from a Google/Vertex error if present. */
function findHttpStatus(err: unknown): number | null {
  let cur: any = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const s = cur.status ?? cur.statusCode ?? cur.code;
    if (typeof s === 'number' && s >= 400 && s <= 599) return s;
    cur = cur.cause;
  }
  return null;
}

const AWS_NAMES = new Set([
  'UnrecognizedClientException', 'InvalidSignatureException', 'AuthFailure',
  'ExpiredTokenException', 'ExpiredToken', 'AccessDeniedException',
  'ResourceNotFoundException', 'ValidationException', 'ThrottlingException',
  'TooManyRequestsException', 'CredentialsProviderError', 'CredentialsError',
]);

/**
 * Map an unknown error (config validation, ADC failure, or a Vertex/Gemini
 * invocation) to a sanitized AgentError. The returned `.message` is safe to
 * show; it never includes secrets.
 */
export function toAgentError(err: unknown): AgentError {
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');

  // 0. Selected model provider not configured (no fallback is attempted).
  if ((err as { code?: unknown })?.code === 'MODEL_PROVIDER_UNAVAILABLE') {
    return new AgentError(
      'MODEL_PROVIDER_UNAVAILABLE',
      'The document assistant is not available right now.',
      'ProviderUnconfigured',
    );
  }

  // 1. Missing-config errors from loadConfig(): "Missing GOOGLE_CLOUD_PROJECT" etc.
  if (/^Missing [A-Z0-9_]+$/.test(rawMessage)) {
    return new AgentError(
      'AGENT_MISCONFIGURED',
      'The document assistant is not configured correctly.',
      rawMessage,
    );
  }

  // 2. ADC / Google auth problems (no API key path; ADC not available/invalid).
  //    The Google auth library throws messages mentioning Application Default
  //    Credentials. Classify by marker, not by forwarding the message.
  if (/application default credentials|could not load the default credentials|ADC|GOOGLE_APPLICATION_CREDENTIALS/i.test(rawMessage)) {
    return new AgentError(
      'VERTEX_NO_CREDENTIALS',
      'The document assistant could not authenticate with the AI service.',
      'ADCUnavailable',
    );
  }

  // 3. Vertex/Gemini HTTP-status classification.
  const status = findHttpStatus(err);
  if (status !== null) {
    switch (status) {
      case 401:
        return new AgentError('VERTEX_AUTH_FAILED', 'The document assistant could not authenticate with the AI service.', 'HTTP 401');
      case 403:
        return new AgentError('VERTEX_ACCESS_DENIED', 'The document assistant is not permitted to use the configured AI model.', 'HTTP 403');
      case 404:
        return new AgentError('VERTEX_MODEL_UNAVAILABLE', 'The configured AI model is unavailable or invalid.', 'HTTP 404');
      case 429:
        return new AgentError('VERTEX_THROTTLED', 'The AI service is busy. Please try again shortly.', 'HTTP 429');
      case 400:
        return new AgentError('VERTEX_INVALID_REQUEST', 'The AI service rejected the request configuration.', 'HTTP 400');
      default:
        if (status >= 500) {
          return new AgentError('VERTEX_UNAVAILABLE', 'The AI service is temporarily unavailable. Please try again.', `HTTP ${status}`);
        }
    }
  }

  // 4. Dormant Bedrock classification (kept so the Bedrock path still maps
  //    cleanly if it is ever re-enabled).
  const awsName = findErrorName(err, AWS_NAMES);
  if (awsName) {
    switch (awsName) {
      case 'AccessDeniedException':
        return new AgentError('BEDROCK_ACCESS_DENIED', 'The document assistant is not permitted to use the configured AI model.', awsName);
      case 'ValidationException':
      case 'ResourceNotFoundException':
        return new AgentError('BEDROCK_MODEL_UNAVAILABLE', 'The configured AI model is unavailable or invalid.', awsName);
      case 'ThrottlingException':
      case 'TooManyRequestsException':
        return new AgentError('BEDROCK_THROTTLED', 'The AI service is busy. Please try again shortly.', awsName);
      default:
        return new AgentError('BEDROCK_AUTH_FAILED', 'The document assistant could not authenticate with the AI service.', awsName);
    }
  }

  // 5. Fallback.
  const fallbackName = (err as { name?: string })?.name || 'UnknownError';
  return new AgentError('AGENT_FAILURE', 'The document assistant could not process the request.', fallbackName);
}
