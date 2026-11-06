import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, isAllowed, loadConfig, paymentView } from '../src/gateway.mjs';

const BASE = {
  BACKEND_URL: 'https://backend.example.run.app',
  GATEWAY_TOKEN: 'gw-token',
  PRINTER_AGENT_URL: 'http://127.0.0.1:7777',
  PRINTER_AGENT_TOKEN: 'pa-token',
};
const quiet = { log() {}, warn() {} };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('config: requires backend + token, https only for remote backends', () => {
  assert.throws(() => loadConfig({}), /BACKEND_URL, GATEWAY_TOKEN/);
  assert.throws(() => loadConfig({ ...BASE, BACKEND_URL: 'http://backend.example.com' }), /https/);
  assert.equal(loadConfig({ ...BASE, BACKEND_URL: 'http://127.0.0.1:8000/' }).backendUrl, 'http://127.0.0.1:8000');
  assert.equal(loadConfig(BASE).displayHost, '127.0.0.1');
});

test('allowlist: adapter operations only', () => {
  assert.ok(isAllowed('GET', '/printers'));
  assert.ok(isAllowed('GET', '/printers/HP%20One/availability'));
  assert.ok(isAllowed('POST', '/validate'));
  assert.ok(isAllowed('POST', '/print'));
  assert.ok(!isAllowed('DELETE', '/printers'));
  assert.ok(!isAllowed('GET', '/../etc/passwd'));
  assert.ok(!isAllowed('POST', '/printers'));
});

test('print: downloads the referenced PDF with the gateway token and forwards base64', async () => {
  const calls = [];
  const pdf = Buffer.from('%PDF-1.4 hello');
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://backend.example.run.app/api/v1/gateway/documents/')) {
      assert.equal(init.headers.authorization, 'Bearer gw-token');
      return new Response(pdf, { status: 200 });
    }
    if (String(url) === 'http://127.0.0.1:7777/print') {
      assert.equal(init.headers['x-printer-agent-token'], 'pa-token');
      const body = JSON.parse(init.body);
      assert.equal(Buffer.from(body.documentBase64, 'base64').toString(), '%PDF-1.4 hello');
      assert.deepEqual(body.config, { printerId: 'p1' });
      return json(200, { ok: true, state: 'PRINT_SUBMITTED' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const gw = createGateway(loadConfig(BASE), { fetchImpl, log: quiet });
  const out = await gw.handleRequest({
    id: 'rq_1', method: 'POST', path: '/print',
    body: { config: { printerId: 'p1' }, document: { path: '/api/v1/gateway/documents/abcdefghijklmnopqrstuvwx' } },
  });
  assert.deepEqual(out, { id: 'rq_1', status: 200, body: { ok: true, state: 'PRINT_SUBMITTED' } });
  assert.equal(calls.length, 2);
});

test('print: a document reference outside the relay path is refused (no SSRF)', async () => {
  const gw = createGateway(loadConfig(BASE), { fetchImpl: async () => { throw new Error('must not fetch'); }, log: quiet });
  const out = await gw.handleRequest({ id: 'rq_2', method: 'POST', path: '/print',
    body: { config: {}, document: { path: 'https://evil.example/x' } } });
  assert.equal(out.status, 502);
  assert.equal(out.body.error.code, 'INVALID_DOCUMENT_REFERENCE');
});

test('disallowed or failing operations are answered, never thrown', async () => {
  const gw = createGateway(loadConfig(BASE), { fetchImpl: async () => { throw new TypeError('fetch failed'); }, log: quiet });
  assert.equal((await gw.handleRequest({ id: 'a', method: 'POST', path: '/shell' })).status, 403);
  const down = await gw.handleRequest({ id: 'b', method: 'GET', path: '/printers' });
  assert.equal(down.status, 502);
  assert.equal(down.body.error.code, 'PRINTER_ADAPTER_UNREACHABLE');
});

test('poll round: executes requests, posts results, keeps display status only', async () => {
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/v1/gateway/poll')) {
      assert.equal(init.headers.authorization, 'Bearer gw-token');
      return json(200, {
        requests: [{ id: 'rq_9', method: 'GET', path: '/printers' }],
        events: [{ jobId: 'job_1', type: 'job_status_updated', ts: 't1', payload: { status: 'executing', paymentStatus: 'settled' } }],
      });
    }
    if (u === 'http://127.0.0.1:7777/printers') return json(200, { ok: true, printers: [] });
    if (u.endsWith('/api/v1/gateway/results')) {
      posted.push(JSON.parse(init.body));
      return json(200, { ok: true, accepted: 1 });
    }
    throw new Error(`unexpected ${u}`);
  };
  const gw = createGateway(loadConfig(BASE), { fetchImpl, log: quiet });
  await gw.pollOnce();
  assert.deepEqual(posted, [{ results: [{ id: 'rq_9', status: 200, body: { ok: true, printers: [] } }] }]);
  const view = gw.displayState();
  assert.equal(view.backendConnected, true);
  assert.deepEqual(view.jobs, [{ jobId: 'job_1', status: 'executing', paymentStatus: 'settled', updatedAt: 't1' }]);
});

test('display: settlement proof appears only for a settled payment, job status untouched', () => {
  const gw = createGateway(loadConfig(BASE), { log: quiet });
  gw.applyEvents([
    { jobId: 'job_2', type: 'job_status_updated', ts: 't1', payload: { status: 'awaiting_payment', paymentStatus: 'pending' } },
    { jobId: 'job_2', type: 'payment_status_updated', ts: 't2', payload: { status: 'processing' } },
  ]);
  let job = gw.displayState().jobs[0];
  assert.equal(job.status, 'awaiting_payment');
  assert.equal(job.paymentStatus, 'processing');
  assert.equal(job.payment.verified, false);
  assert.equal(job.payment.transactionId, null);
  gw.applyEvents([{ jobId: 'job_2', type: 'payment_status_updated', ts: 't3', payload: {
    paymentId: 'pay_1', status: 'settled', transactionId: '0.0.11330279@1793967953.517115964', network: 'hedera:testnet',
    amount: '0.05', asset: 'HTS_USDC', settledAt: 's', verifiedAt: 'v',
    hashscanUrl: 'https://hashscan.io/testnet/transaction/0.0.11330279-1793967953-517115964' } }]);
  job = gw.displayState().jobs[0];
  assert.equal(job.status, 'awaiting_payment');
  assert.equal(job.paymentStatus, 'settled');
  assert.deepEqual(job.payment, { paymentId: 'pay_1', status: 'settled', verified: true, amount: '0.05', asset: 'HTS_USDC',
    network: 'hedera:testnet', transactionId: '0.0.11330279@1793967953.517115964', settledAt: 's', verifiedAt: 'v',
    hashscanUrl: 'https://hashscan.io/testnet/transaction/0.0.11330279-1793967953-517115964' });
});

test('display: never verified without a real tx id and backend verification', () => {
  for (const payload of [
    { status: 'settled', amount: '0.05' },                                       // no tx id
    { status: 'settled', transactionId: 'fake-tx', verifiedAt: 'v' },              // not a Hedera tx id
    { status: 'settled', transactionId: '0.0.1@1.2' },                              // backend never verified
    { status: 'processing', transactionId: '0.0.1@1.2', verifiedAt: 'v' },          // not settled
  ]) {
    const v = paymentView(payload);
    assert.equal(v.verified, false, JSON.stringify(payload));
    assert.equal(v.transactionId, null);
  }
  const failed = paymentView({ status: 'failed', amount: '0.05', asset: 'HTS_USDC', network: 'hedera:testnet' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.amount, '0.05');
});

test('display endpoint: token enforced when configured', async () => {
  const gw = createGateway(loadConfig({ ...BASE, DISPLAY_TOKEN: 'disp' }), { log: quiet });
  const server = gw.createDisplayServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/display`)).status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/display`, { headers: { authorization: 'Bearer disp' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).gatewayId, 'gateway_001');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    server.close();
  }
});
