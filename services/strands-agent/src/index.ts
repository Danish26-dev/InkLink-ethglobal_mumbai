import app from './app.js';
import { getConfig, missingVertexConfig } from './config.js';

// Startup validation: fail fast with a clear, secret-free message if required
// Vertex AI configuration is missing. This does NOT contact Google/Vertex — it
// only checks that the non-secret settings are present. Credentials themselves
// are resolved later by Application Default Credentials (ADC) when a request is
// processed.
const missing = missingVertexConfig();
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[inklink-agent] Cannot start: missing required configuration: ${missing.join(', ')}`);
  // eslint-disable-next-line no-console
  console.error(
    '[inklink-agent] Set these in strands-agent/.env (see .env.example). Google credentials use ' +
      'Application Default Credentials (ADC); run `gcloud auth application-default login` locally.',
  );
  process.exit(1);
}

const config = getConfig();

app.listen(config.port, config.host, () => {
  // Log non-secret settings only. Never log credentials.
  // eslint-disable-next-line no-console
  console.log(`[inklink-agent] listening on http://${config.host}:${config.port}`);
  // eslint-disable-next-line no-console
  console.log(`[inklink-agent] document engine: ${config.documentEngineUrl}`);
  // eslint-disable-next-line no-console
  console.log(
    `[inklink-agent] model: Vertex AI (${config.vertexModelId}) ` +
      `location=${config.googleCloudLocation} vertexai=${config.useVertexAi}`,
  );
});
