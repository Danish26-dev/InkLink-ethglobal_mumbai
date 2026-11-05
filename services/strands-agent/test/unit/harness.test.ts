/**
 * Print Operator Harness tests (no model, no network beyond a loopback fixture).
 *
 * A tiny in-process HTTP server stands in for the local printer adapter and the
 * backend execution gate, so the tools' real HTTP code runs against known
 * responses. This fixture exists only in tests.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMPTY_OPERATOR_CONFIG, type HarnessEvent } from '@inklink/shared-schemas';
import { buildOperatorTools, type OperatorRunContext } from '../../src/harness/operatorTools.js';
import { installOperatorHooks, domainFailure } from '../../src/harness/hooks.js';
import { providerStatus, buildModel, zeroGHeaders, ModelUnavailableError } from '../../src/model/providers.js';
import { runPrintOperator } from '../../src/harness/operator.js';

let server: http.Server;
let backendCalls = 0;
let lastValidateBody: any = null;

before(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/printers') {
        return send(200, {
          ok: true,
          printers: [
            { id: 'Office Laser', name: 'Office Laser', status: 'online', isDefault: true, supportsColor: null, supportsDuplex: null },
            { id: 'Old Inkjet', name: 'Old Inkjet', status: 'offline', isDefault: false, supportsColor: null, supportsDuplex: null },
          ],
          defaultPrinter: 'Office Laser',
        });
      }
      if (req.url === '/printers/Office%20Laser/availability') return send(200, { ok: true, available: true, status: 'online' });
      if (req.url === '/printers/Old%20Inkjet/availability') return send(200, { ok: true, available: false, status: 'offline' });
      if (req.url === '/validate') {
        lastValidateBody = JSON.parse(raw);
        return send(200, { ok: true, errors: [] });
      }
      if (req.url?.startsWith('/api/v1/internal/jobs/job_1/execution-requests')) {
        backendCalls += 1;
        return send(200, { accepted: true, state: 'awaiting_customer_approval', pending: ['customer_quote', 'payment'], message: 'Recorded.' });
      }
      send(404, { error: { code: 'NOT_FOUND' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  process.env.PRINTER_AGENT_URL = `http://127.0.0.1:${port}`;
  process.env.BACKEND_URL = `http://127.0.0.1:${port}`;
  process.env.AGENT_SERVICE_TOKEN = 'test-service-token-0123456789';
});

after(() => new Promise<void>((r) => server.close(() => r())));

function newCtx(events: HarnessEvent[]): OperatorRunContext {
  return {
    jobId: 'job_1',
    runId: 'run_1',
    config: { ...EMPTY_OPERATOR_CONFIG },
    validated: false,
    printers: null,
    emit: (e) => events.push(e),
  };
}

const call = async (t: { invoke: (i: never, c: never) => unknown }, input: object, toolUseId = 'tu_1') =>
  (await t.invoke(input as never, { toolUse: { toolUseId, name: 'x', input } } as never)) as any;

/* ───────────── tools ───────────── */

test('set_paper_size changes the value and publishes configuration_updated with the real toolUseId', async () => {
  const events: HarnessEvent[] = [];
  const ctx = newCtx(events);
  ctx.validated = true;
  const tools = buildOperatorTools(ctx);
  const out = await call(tools.setPaperSize, { paperSize: 'A4' }, 'tu_paper');
  assert.equal(out.ok, true);
  assert.equal(ctx.config.paperSize, 'A4');
  assert.equal(ctx.validated, false, 'a change must invalidate a previous validation');
  const upd = events.find((e) => e.type === 'configuration_updated');
  assert.ok(upd && upd.type === 'configuration_updated');
  assert.equal(upd.payload.toolUseId, 'tu_paper');
  assert.equal(upd.payload.field, 'paperSize');
  assert.equal(upd.payload.config.paperSize, 'A4');
});

test('set_duplex maps enabled/binding to the adapter sides vocabulary', async () => {
  const ctx = newCtx([]);
  const tools = buildOperatorTools(ctx);
  await call(tools.setDuplex, { enabled: true });
  assert.equal(ctx.config.sides, 'two-sided-long-edge');
  await call(tools.setDuplex, { enabled: true, binding: 'short-edge' });
  assert.equal(ctx.config.sides, 'two-sided-short-edge');
  await call(tools.setDuplex, { enabled: false });
  assert.equal(ctx.config.sides, 'one-sided');
});

test('list_printers returns real adapter data and publishes printer_readiness_updated', async () => {
  const events: HarnessEvent[] = [];
  const ctx = newCtx(events);
  const out = await call(buildOperatorTools(ctx).listPrinters, {});
  assert.equal(out.ok, true);
  assert.equal(out.printers.length, 2);
  assert.ok(events.some((e) => e.type === 'printer_readiness_updated'));
  assert.equal(ctx.printers?.length, 2);
});

test('check_printer_readiness selects an online printer and refuses an offline one', async () => {
  const events: HarnessEvent[] = [];
  const ctx = newCtx(events);
  const tools = buildOperatorTools(ctx);
  await call(tools.listPrinters, {});

  const offline = await call(tools.checkPrinterReadiness, { printerId: 'Old Inkjet' });
  assert.equal(offline.ok, false);
  assert.equal(offline.code, 'PRINTER_UNAVAILABLE');
  assert.equal(ctx.config.printerId, null, 'an unavailable printer must not be selected');

  const ghost = await call(tools.checkPrinterReadiness, { printerId: 'Ghost' });
  assert.equal(ghost.code, 'PRINTER_NOT_FOUND');

  const online = await call(tools.checkPrinterReadiness, { printerId: 'Office Laser' });
  assert.equal(online.ok, true);
  assert.equal(ctx.config.printerId, 'Office Laser');
});

test('validate_print_config refuses an incomplete config, then validates a complete one with the adapter', async () => {
  const ctx = newCtx([]);
  const tools = buildOperatorTools(ctx);
  const incomplete = await call(tools.validatePrintConfig, {});
  assert.equal(incomplete.code, 'CONFIG_INCOMPLETE');

  Object.assign(ctx.config, {
    printerId: 'Office Laser',
    paperSize: 'A4',
    colorMode: 'monochrome',
    copies: 2,
    orientation: 'portrait',
    sides: 'two-sided-long-edge',
  });
  const ok = await call(tools.validatePrintConfig, {});
  assert.equal(ok.ok, true);
  assert.equal(ctx.validated, true);
  assert.deepEqual(lastValidateBody.config, ctx.config);
});

test('request_print_execution never calls the backend before validation succeeded', async () => {
  const ctx = newCtx([]);
  const before = backendCalls;
  const out = await call(buildOperatorTools(ctx).requestPrintExecution, {});
  assert.equal(out.code, 'CONFIG_NOT_VALIDATED');
  assert.equal(backendCalls, before);
});

test('request_print_execution relays the backend decision (it cannot print by itself)', async () => {
  const ctx = newCtx([]);
  ctx.validated = true;
  const out = await call(buildOperatorTools(ctx).requestPrintExecution, {});
  assert.equal(out.ok, true);
  assert.equal(out.state, 'awaiting_customer_approval');
  assert.deepEqual(out.pending, ['customer_quote', 'payment']);
});

/* ───────────── hooks ───────────── */

function fakeAgent() {
  const hooks = new Map<string, (e: any) => void>();
  return {
    hooks,
    addHook(cls: { name: string }, cb: (e: any) => void) {
      hooks.set(cls.name, cb);
      return () => {};
    },
  };
}

test('BeforeToolCall cancels non-allowlisted tools and publishes tool_failed', () => {
  const events: HarnessEvent[] = [];
  const agent = fakeAgent();
  installOperatorHooks(agent as never, newCtx(events), { doc: null });
  const ev: any = { toolUse: { name: 'run_shell', toolUseId: 'tu_x', input: {} }, cancel: false };
  agent.hooks.get('BeforeToolCallEvent')!(ev);
  assert.ok(ev.cancel, 'the call must be cancelled');
  const failed = events.find((e) => e.type === 'tool_failed');
  assert.ok(failed && failed.type === 'tool_failed');
  assert.equal(failed.payload.error.code, 'TOOL_NOT_ALLOWED');
  assert.ok(!events.some((e) => e.type === 'tool_started'));
});

test('BeforeToolCall re-validates printer-tool arguments and cancels invalid ones', () => {
  const events: HarnessEvent[] = [];
  const agent = fakeAgent();
  installOperatorHooks(agent as never, newCtx(events), { doc: null });
  const ev: any = { toolUse: { name: 'set_paper_size', toolUseId: 'tu_bad', input: { paperSize: 'A3' } }, cancel: false };
  agent.hooks.get('BeforeToolCallEvent')!(ev);
  assert.ok(ev.cancel);
  const failed = events.find((e) => e.type === 'tool_failed');
  assert.ok(failed && failed.type === 'tool_failed' && failed.payload.error.code === 'INVALID_ARGUMENTS');

  // The cancelled call must not later be reported as succeeded.
  agent.hooks.get('AfterToolCallEvent')!({
    toolUse: ev.toolUse,
    result: { status: 'error', content: [{ text: 'cancelled' }] },
  });
  assert.ok(!events.some((e) => e.type === 'tool_succeeded'));
  assert.equal(events.filter((e) => e.type === 'tool_failed').length, 1);
});

test('AfterToolCall publishes tool_succeeded only for a real success, tool_failed for ok:false', () => {
  const events: HarnessEvent[] = [];
  const agent = fakeAgent();
  installOperatorHooks(agent as never, newCtx(events), { doc: null });
  const start = (id: string, name: string, input: object) =>
    agent.hooks.get('BeforeToolCallEvent')!({ toolUse: { name, toolUseId: id, input }, cancel: false });
  const finish = (id: string, name: string, body: object) =>
    agent.hooks.get('AfterToolCallEvent')!({
      toolUse: { name, toolUseId: id, input: {} },
      result: { status: 'success', content: [{ text: JSON.stringify(body) }] },
    });

  start('tu_ok', 'set_copies', { copies: 2 });
  finish('tu_ok', 'set_copies', { ok: true, copies: 2 });
  start('tu_fail', 'validate_print_config', {});
  finish('tu_fail', 'validate_print_config', { ok: false, code: 'CONFIG_INVALID', message: 'Printer rejected duplex.' });

  const ok = events.find((e) => e.type === 'tool_succeeded');
  assert.ok(ok && ok.type === 'tool_succeeded' && ok.payload.toolUseId === 'tu_ok');
  const fail = events.find((e) => e.type === 'tool_failed');
  assert.ok(fail && fail.type === 'tool_failed');
  assert.equal(fail.payload.toolUseId, 'tu_fail');
  assert.equal(fail.payload.error.code, 'CONFIG_INVALID');
  assert.equal(events.filter((e) => e.type === 'tool_succeeded').length, 1);
});

test('document tool failures are recognised (plan invalid / edit not executed)', () => {
  assert.equal(domainFailure('plan_operations', { valid: false })?.code, 'PLAN_INVALID');
  assert.ok(domainFailure('execute_operation_plan', { executed: false, code: 'scanned_pdf', error: 'Scanned PDF' }));
  assert.equal(domainFailure('inspect_document', { chars: 10, text: '…' }), null);
});

test('tool-call budget cancels runaway loops', () => {
  const events: HarnessEvent[] = [];
  const agent = fakeAgent();
  installOperatorHooks(agent as never, newCtx(events), { doc: null, maxToolCalls: 2 });
  const evs = [0, 1, 2].map((i) => ({ toolUse: { name: 'list_printers', toolUseId: `tu_${i}`, input: {} }, cancel: false as any }));
  evs.forEach((e) => agent.hooks.get('BeforeToolCallEvent')!(e));
  assert.ok(!evs[0].cancel && !evs[1].cancel);
  assert.ok(evs[2].cancel);
});

/* ───────────── provider (no fallback) ───────────── */

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  const r = fn();
  if (r instanceof Promise) return r.finally(restore);
  restore();
}

const VERTEX_PRESENT = {
  GOOGLE_CLOUD_PROJECT: 'inklink-test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_AI_MODEL_ID: 'gemini-2.5-flash',
};

test('0G is the default provider and reports unavailable without credentials, even if Vertex is configured', () => {
  withEnv({ INKLINK_MODEL_PROVIDER: undefined, ZEROG_API_KEY: undefined, ZEROG_MODEL_ID: undefined, ...VERTEX_PRESENT }, () => {
    const s = providerStatus();
    assert.equal(s.provider, '0g-private-computer');
    assert.equal(s.available, false);
    assert.match(s.reason ?? '', /ZEROG_API_KEY/);
    assert.throws(() => buildModel(), ModelUnavailableError, 'must not fall back to Vertex');
  });
});

test('configured 0G is available, requests private mode by default, and status never contains the key', () => {
  withEnv({ INKLINK_MODEL_PROVIDER: '0g-private-computer', ZEROG_API_KEY: 'sk-test-secret-value', ZEROG_MODEL_ID: 'glm-5-fp8', ZEROG_TRUST_MODE: undefined }, () => {
    const s = providerStatus();
    assert.equal(s.available, true);
    assert.equal(s.trustMode, 'private');
    assert.ok(!JSON.stringify(s).includes('sk-test-secret-value'));
    assert.deepEqual(zeroGHeaders('private'), { 'X-0G-Provider-Trust-Mode': 'private' });
    assert.ok(buildModel());
  });
});

test('trust mode is validated and standard sends no override header', () => {
  assert.deepEqual(zeroGHeaders('standard'), {});
  withEnv({ INKLINK_MODEL_PROVIDER: undefined, ZEROG_API_KEY: 'k', ZEROG_MODEL_ID: 'm', ZEROG_TRUST_MODE: 'yolo' }, () => {
    assert.equal(providerStatus().available, false);
  });
});

test('unknown providers are unavailable', () => {
  withEnv({ INKLINK_MODEL_PROVIDER: 'some-other-llm' }, () => {
    assert.equal(providerStatus().available, false);
  });
});

test('an operator run with an unavailable provider ends with agent_finished(unavailable) and calls no tools', async () => {
  const events: HarnessEvent[] = [];
  await withEnv({ INKLINK_MODEL_PROVIDER: undefined, ZEROG_API_KEY: undefined, ZEROG_MODEL_ID: undefined }, () =>
    runPrintOperator({
      jobId: 'job_1',
      runId: 'run_x',
      instruction: 'Print 2 copies in black and white',
      document: null,
      defaults: {},
      emit: (e) => events.push(e),
    }),
  );
  assert.equal(events.length, 1);
  const only = events[0];
  assert.ok(only.type === 'agent_finished' && only.payload.outcome === 'unavailable');
});

/* ───────────── route auth ───────────── */

test('operator run endpoint refuses wrong tokens and refuses to run without a configured token', async () => {
  const { default: app } = await import('../../src/app.js');
  const srv = await new Promise<http.Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/operator/runs`;
    const form = () => {
      const f = new FormData();
      f.set('instruction', 'Print it');
      f.set('jobId', 'job_1');
      f.set('runId', 'run_1');
      return f;
    };
    const wrong = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: form() });
    assert.equal(wrong.status, 401);

    await withEnv({ AGENT_SERVICE_TOKEN: undefined }, async () => {
      const unconfigured = await fetch(url, { method: 'POST', body: form() });
      assert.equal(unconfigured.status, 503);
    });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
