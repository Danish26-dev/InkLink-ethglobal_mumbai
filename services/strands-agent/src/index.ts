import app from './app.js';
import { providerStatus } from './model/providers.js';

// The service always starts so health checks can report status honestly. If
// the selected model provider is not configured, every agent run reports the
// agent as unavailable (no fallback to another provider).
const port = Number.parseInt(process.env.PORT || '4000', 10);
const host = process.env.HOST || '127.0.0.1';
const status = providerStatus();

app.listen(port, host, () => {
  // Log non-secret settings only. Never log credentials.
  // eslint-disable-next-line no-console
  console.log(`[inklink-agent] listening on http://${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`[inklink-agent] document engine: ${(process.env.DOCUMENT_ENGINE_URL || 'http://localhost:5001').replace(/\/+$/, '')}`);
  // eslint-disable-next-line no-console
  console.log(
    `[inklink-agent] model provider: ${status.provider} model=${status.model ?? '-'} ` +
      `trustMode=${status.trustMode ?? '-'} available=${status.available}` +
      (status.reason ? ` (${status.reason})` : ''),
  );
  if (!(process.env.AGENT_SERVICE_TOKEN ?? '').trim()) {
    // eslint-disable-next-line no-console
    console.warn('[inklink-agent] AGENT_SERVICE_TOKEN is not set: /api/operator/runs will refuse requests.');
  }
});
