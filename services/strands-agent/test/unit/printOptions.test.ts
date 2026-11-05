/**
 * Unit tests for the set_print_options agent tool and the printOptions schema
 * (no network, no credentials, no document engine).
 *
 * These are the regression tests for the root-cause fix: the agent previously
 * had NO way to capture printer settings (color/paper/orientation/sides), so it
 * told customers those options were "not supported". set_print_options now
 * records a structured print PROPOSAL into the per-request context; the Backend
 * validates and applies it against the real printer.
 *
 * We assert the tool:
 *   - parses every requested print setting into ctx.printOptions,
 *   - maps the six supported fields exactly,
 *   - rejects unsupported enum values (does not silently drop them),
 *   - accumulates across multiple calls (merge, not overwrite),
 *   - never mutates ctx on a rejected call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, type DocumentContext } from '../../src/tools/documentTools.js';
import { printOptions } from '../../src/schema.js';

function newCtx(): DocumentContext {
  return { fileBuffer: Buffer.from(''), filename: 'x.docx' };
}

/**
 * Invoke a tool the same way the integration tests do: first arg is the raw
 * input object, second is the (unused) tool context. The callback returns a
 * JSON string, which we parse for assertions.
 */
async function invoke(
  tool: ReturnType<typeof buildTools>['setPrintOptions'],
  input: Record<string, unknown>,
) {
  const raw = (await tool.invoke(input as never, {} as never)) as string;
  return JSON.parse(raw);
}

test('set_print_options tool exposes the expected name', () => {
  const tools = buildTools(newCtx());
  assert.equal(tools.setPrintOptions.name, 'set_print_options');
  assert.equal(typeof tools.setPrintOptions.invoke, 'function');
});

test('captures all six requested print settings into ctx.printOptions', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  const result = await invoke(setPrintOptions, {
    printerId: 'HP-LaserJet',
    copies: 2,
    colorMode: 'monochrome',
    paperSize: 'A4',
    orientation: 'portrait',
    sides: 'two-sided-long-edge',
  });
  assert.equal(result.recorded, true);
  assert.deepEqual(ctx.printOptions, {
    printerId: 'HP-LaserJet',
    copies: 2,
    colorMode: 'monochrome',
    paperSize: 'A4',
    orientation: 'portrait',
    sides: 'two-sided-long-edge',
  });
});

test('records only the fields the customer asked for (all fields optional)', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  const result = await invoke(setPrintOptions, { colorMode: 'color', orientation: 'landscape' });
  assert.equal(result.recorded, true);
  assert.deepEqual(ctx.printOptions, { colorMode: 'color', orientation: 'landscape' });
});

test('accumulates across multiple calls (merge, not overwrite)', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  await invoke(setPrintOptions, { colorMode: 'monochrome' });
  await invoke(setPrintOptions, { paperSize: 'A4' });
  const result = await invoke(setPrintOptions, { sides: 'two-sided-long-edge', copies: 3 });
  assert.equal(result.recorded, true);
  assert.deepEqual(ctx.printOptions, {
    colorMode: 'monochrome',
    paperSize: 'A4',
    sides: 'two-sided-long-edge',
    copies: 3,
  });
});

test('a later call overrides an earlier value for the same field', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  await invoke(setPrintOptions, { copies: 2 });
  await invoke(setPrintOptions, { copies: 5 });
  assert.equal(ctx.printOptions?.copies, 5);
});

test('rejects an unsupported colorMode and does not record it', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  // 'cmyk' is not an allowed colorMode. The Strands input schema or the strict
  // printOptions parse must reject it; either way nothing is recorded.
  let recorded: any = 'not-run';
  try {
    const result = await invoke(setPrintOptions, { colorMode: 'cmyk' });
    recorded = result.recorded;
  } catch {
    // Input-schema rejection throws before the callback runs — also acceptable.
    recorded = false;
  }
  assert.notEqual(recorded, true);
  assert.equal(ctx.printOptions, undefined);
});

test('rejects an unsupported sides value and does not record it', async () => {
  const ctx = newCtx();
  const { setPrintOptions } = buildTools(ctx);
  let recorded: any = 'not-run';
  try {
    const result = await invoke(setPrintOptions, { sides: 'triple-sided' });
    recorded = result.recorded;
  } catch {
    recorded = false;
  }
  assert.notEqual(recorded, true);
  assert.equal(ctx.printOptions, undefined);
});

// ---- Direct schema assertions (independent of the SDK tool wrapper) --------

test('printOptions schema accepts a full valid config', () => {
  const r = printOptions.safeParse({
    printerId: 'p1',
    copies: 10,
    colorMode: 'color',
    paperSize: 'Letter',
    orientation: 'landscape',
    sides: 'two-sided-short-edge',
  });
  assert.equal(r.success, true);
});

test('printOptions schema is strict: rejects unknown keys', () => {
  const r = printOptions.safeParse({ colorMode: 'color', stapler: true });
  assert.equal(r.success, false);
});

test('printOptions schema rejects copies out of range', () => {
  assert.equal(printOptions.safeParse({ copies: 0 }).success, false);
  assert.equal(printOptions.safeParse({ copies: 1000 }).success, false);
});

test('printOptions schema rejects a bad paperSize', () => {
  assert.equal(printOptions.safeParse({ paperSize: 'A3' }).success, false);
});
