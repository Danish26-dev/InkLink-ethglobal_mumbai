/**
 * Sanitized error-mapping unit tests (no network, no credentials).
 * Verifies Vertex/Google (active) and Bedrock (dormant) failures map to stable
 * codes with safe messages, and that no secret-like content leaks through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentError, AgentError } from '../../src/errors.js';

test('maps missing-config errors to AGENT_MISCONFIGURED', () => {
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_AI_MODEL_ID']) {
    const e = toAgentError(new Error(`Missing ${name}`));
    assert.equal(e.code, 'AGENT_MISCONFIGURED');
  }
});

test('maps ADC-unavailable errors to VERTEX_NO_CREDENTIALS', () => {
  const e = toAgentError(new Error('Could not load the default credentials. Browse to ...ADC...'));
  assert.equal(e.code, 'VERTEX_NO_CREDENTIALS');
});

test('maps Vertex HTTP 403 to VERTEX_ACCESS_DENIED', () => {
  const e = toAgentError(Object.assign(new Error('permission denied'), { status: 403 }));
  assert.equal(e.code, 'VERTEX_ACCESS_DENIED');
});

test('maps Vertex HTTP 401 to VERTEX_AUTH_FAILED', () => {
  const e = toAgentError(Object.assign(new Error('unauthorized'), { status: 401 }));
  assert.equal(e.code, 'VERTEX_AUTH_FAILED');
});

test('maps Vertex HTTP 404 to VERTEX_MODEL_UNAVAILABLE', () => {
  const e = toAgentError(Object.assign(new Error('model not found'), { status: 404 }));
  assert.equal(e.code, 'VERTEX_MODEL_UNAVAILABLE');
});

test('maps Vertex HTTP 429 to VERTEX_THROTTLED', () => {
  const e = toAgentError(Object.assign(new Error('rate limited'), { status: 429 }));
  assert.equal(e.code, 'VERTEX_THROTTLED');
});

test('maps a wrapped status on .cause', () => {
  const wrapped = Object.assign(new Error('model call failed'), {
    name: 'ModelError',
    cause: Object.assign(new Error('denied'), { status: 403 }),
  });
  assert.equal(toAgentError(wrapped).code, 'VERTEX_ACCESS_DENIED');
});

test('dormant Bedrock errors still classify (cause chain)', () => {
  const wrapped = Object.assign(new Error('x'), {
    name: 'ModelError',
    cause: Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
  });
  assert.equal(toAgentError(wrapped).code, 'BEDROCK_ACCESS_DENIED');
});

test('unknown errors become AGENT_FAILURE', () => {
  const e = toAgentError(new Error('something odd'));
  assert.equal(e.code, 'AGENT_FAILURE');
});

test('sanitized message never leaks a credential-shaped string from the raw error', () => {
  const raw = Object.assign(new Error('auth failed for token ya29.SECRETTOKEN12345'), { status: 401 });
  const e: AgentError = toAgentError(raw);
  assert.ok(!e.message.includes('ya29.SECRETTOKEN12345'));
  assert.equal(e.code, 'VERTEX_AUTH_FAILED');
});
