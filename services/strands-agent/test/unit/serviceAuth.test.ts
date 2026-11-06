/**
 * Cloud Run ID-token headers for the Document Engine (no network: fetch is injected).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceFor, clearServiceAuthCache, serviceAuthHeaders } from '../../src/clients/serviceAuth.js';

function fakeMetadata(calls: string[]): typeof fetch {
  return (async (input: any, init?: any) => {
    calls.push(String(input));
    assert.equal(init?.headers?.['Metadata-Flavor'], 'Google');
    return new Response(`id-token-${calls.length}`, { status: 200 });
  }) as typeof fetch;
}

test('no header unless SERVICE_AUTH=gcp-id-token', async () => {
  const prev = process.env.SERVICE_AUTH;
  delete process.env.SERVICE_AUTH;
  try {
    const calls: string[] = [];
    assert.deepEqual(await serviceAuthHeaders('https://engine.a.run.app/process', fakeMetadata(calls)), {});
    assert.equal(calls.length, 0);
  } finally {
    if (prev !== undefined) process.env.SERVICE_AUTH = prev;
  }
});

test('ID token per audience (service base URL), cached', async () => {
  const prev = process.env.SERVICE_AUTH;
  process.env.SERVICE_AUTH = 'gcp-id-token';
  clearServiceAuthCache();
  try {
    const calls: string[] = [];
    const a = await serviceAuthHeaders('https://engine.a.run.app/process', fakeMetadata(calls));
    const b = await serviceAuthHeaders('https://engine.a.run.app/inspect', fakeMetadata(calls));
    assert.deepEqual(a, { 'X-Serverless-Authorization': 'Bearer id-token-1' });
    assert.deepEqual(b, a);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /audience=https%3A%2F%2Fengine\.a\.run\.app&/);
    assert.equal(audienceFor('http://127.0.0.1:5001/x'), 'http://127.0.0.1:5001');
  } finally {
    clearServiceAuthCache();
    if (prev === undefined) delete process.env.SERVICE_AUTH;
    else process.env.SERVICE_AUTH = prev;
  }
});

test('metadata failure: call proceeds without a header', async () => {
  const prev = process.env.SERVICE_AUTH;
  process.env.SERVICE_AUTH = 'gcp-id-token';
  clearServiceAuthCache();
  try {
    const failing = (async () => new Response('no', { status: 404 })) as typeof fetch;
    assert.deepEqual(await serviceAuthHeaders('https://engine.a.run.app/process', failing), {});
  } finally {
    if (prev === undefined) delete process.env.SERVICE_AUTH;
    else process.env.SERVICE_AUTH = prev;
  }
});
