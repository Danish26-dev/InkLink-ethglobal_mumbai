// HTTP-level tests for the local printer agent's security guards.
// Run: node --test   (from local-printer-agent/)
//
// The app is imported without binding its real port; each test talks to an
// ephemeral loopback listener. No print job is ever submitted: every /print
// request here is rejected by validation before the spooler is reached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/index.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('health is reachable and identifies the Inklink adapter', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'inklink-local-printer-agent');
});

test('browser requests from an unknown origin are refused (cannot drive the printer from a web page)', async () => {
  const res = await fetch(`${base}/printers`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('cross-origin /print is refused before any validation or spooling', async () => {
  const res = await fetch(`${base}/print`, {
    ...json({ config: {}, documentBase64: Buffer.from('%PDF-1.7').toString('base64') }),
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});

test('/print requires a document', async () => {
  const res = await fetch(`${base}/print`, json({ config: {} }));
  assert.equal(res.status, 400);
});

test('/print refuses bytes that are not a PDF', async () => {
  const res = await fetch(
    `${base}/print`,
    json({ config: {}, documentBase64: Buffer.from('MZ\x90\x00 not a pdf').toString('base64') }),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /Only PDF/);
});

test('malformed JSON gets a clean 400, not a crash', async () => {
  const res = await fetch(`${base}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"config":',
  });
  assert.equal(res.status, 400);
  // The server is still alive afterwards.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('printer discovery returns real OS data or an honest error (never fabricated)', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only provider');
  const res = await fetch(`${base}/printers`);
  const body = await res.json();
  if (res.status === 200) {
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.printers));
    for (const p of body.printers) {
      assert.equal(typeof p.id, 'string');
      assert.equal(p.supportsColor, null, 'unqueryable capabilities must stay unknown');
      assert.equal(p.supportsDuplex, null, 'unqueryable capabilities must stay unknown');
    }
  } else {
    assert.equal(res.status, 502);
    assert.equal(body.ok, false);
  }
});
