/**
 * Configuration unit tests (no network, no credentials).
 *
 * Verifies:
 *  - config loads from environment variables (Vertex AI active provider)
 *  - missing GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / VERTEX_AI_MODEL_ID
 *    are each detected
 *  - the model id is NOT hardcoded (comes from the environment)
 *  - validation errors never contain secret values
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, missingVertexConfig, resetConfigForTests } from '../../src/config.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    resetConfigForTests();
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
  }
}

const VALID = {
  GOOGLE_CLOUD_PROJECT: 'inklink-test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  GOOGLE_GENAI_USE_VERTEXAI: 'True',
  VERTEX_AI_MODEL_ID: 'gemini-2.5-flash',
  MODEL_TEMPERATURE: '0',
};

test('loads Vertex AI configuration from environment variables', () => {
  withEnv({ ...VALID, PORT: '4100', DOCUMENT_ENGINE_URL: 'http://localhost:5050/' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.googleCloudProject, 'inklink-test-project');
    assert.equal(cfg.googleCloudLocation, 'global');
    assert.equal(cfg.useVertexAi, true);
    assert.equal(cfg.vertexModelId, 'gemini-2.5-flash');
    assert.equal(cfg.port, 4100);
    assert.equal(cfg.documentEngineUrl, 'http://localhost:5050'); // trailing slash stripped
  });
});

test('detects missing GOOGLE_CLOUD_PROJECT', () => {
  withEnv({ ...VALID, GOOGLE_CLOUD_PROJECT: undefined }, () => {
    assert.deepEqual(missingVertexConfig(), ['GOOGLE_CLOUD_PROJECT']);
    assert.throws(() => loadConfig(), /Missing GOOGLE_CLOUD_PROJECT/);
  });
});

test('detects missing GOOGLE_CLOUD_LOCATION', () => {
  withEnv({ ...VALID, GOOGLE_CLOUD_LOCATION: undefined }, () => {
    assert.deepEqual(missingVertexConfig(), ['GOOGLE_CLOUD_LOCATION']);
    assert.throws(() => loadConfig(), /Missing GOOGLE_CLOUD_LOCATION/);
  });
});

test('detects missing VERTEX_AI_MODEL_ID', () => {
  withEnv({ ...VALID, VERTEX_AI_MODEL_ID: undefined }, () => {
    assert.deepEqual(missingVertexConfig(), ['VERTEX_AI_MODEL_ID']);
    assert.throws(() => loadConfig(), /Missing VERTEX_AI_MODEL_ID/);
  });
});

test('model id is NOT hardcoded — differs per environment', () => {
  let a: string | undefined;
  let b: string | undefined;
  withEnv({ ...VALID, VERTEX_AI_MODEL_ID: 'gemini-2.5-flash' }, () => {
    a = loadConfig().vertexModelId;
  });
  withEnv({ ...VALID, VERTEX_AI_MODEL_ID: 'gemini-2.5-pro' }, () => {
    b = loadConfig().vertexModelId;
  });
  assert.equal(a, 'gemini-2.5-flash');
  assert.equal(b, 'gemini-2.5-pro');
  assert.notEqual(a, b);
});

test('GOOGLE_GENAI_USE_VERTEXAI flag parses truthy/falsey values', () => {
  withEnv({ ...VALID, GOOGLE_GENAI_USE_VERTEXAI: 'False' }, () => {
    assert.equal(loadConfig().useVertexAi, false);
  });
  withEnv({ ...VALID, GOOGLE_GENAI_USE_VERTEXAI: '1' }, () => {
    assert.equal(loadConfig().useVertexAi, true);
  });
});

test('validation errors never contain secret-looking values', () => {
  withEnv(
    {
      ...VALID,
      GOOGLE_CLOUD_PROJECT: undefined,
      // A stray credential-shaped value in the environment must never surface.
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/path/key.json',
    },
    () => {
      try {
        loadConfig();
        assert.fail('expected loadConfig to throw');
      } catch (err) {
        const msg = (err as Error).message;
        assert.ok(!msg.includes('/secret/path/key.json'), 'secret path must not appear in error');
        assert.match(msg, /Missing GOOGLE_CLOUD_PROJECT/);
      }
    },
  );
});

test('binds to loopback and disables CORS by default', () => {
  withEnv({ ...VALID, HOST: undefined, AGENT_ALLOWED_ORIGINS: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.host, '127.0.0.1');
    assert.deepEqual(cfg.allowedOrigins, []);
  });
});

test('parses a comma-separated origin allowlist', () => {
  withEnv({ ...VALID, AGENT_ALLOWED_ORIGINS: 'https://a.example, https://b.example ,' }, () => {
    assert.deepEqual(loadConfig().allowedOrigins, ['https://a.example', 'https://b.example']);
  });
});

test('no AWS / Bedrock settings are read into the config', () => {
  withEnv({ ...VALID, AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'x' }, () => {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    assert.equal('awsRegion' in cfg, false);
    assert.equal('bedrockModelId' in cfg, false);
  });
});
