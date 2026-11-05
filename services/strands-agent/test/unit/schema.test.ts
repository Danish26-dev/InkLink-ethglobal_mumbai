/**
 * Unit tests for the closed operation schema (no network, no AWS).
 * Covers requirement cases: unknown operation rejection, malicious operation
 * (run_python) rejection, and valid single/multiple operation plans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationPlan } from '../../src/schema.js';

test('accepts a single valid replace_text operation', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'replace_text', find: 'John', replace: 'Jane' }],
  });
  assert.equal(r.success, true);
});

test('accepts multiple replace_text operations, including a page-scoped one', () => {
  const r = operationPlan.safeParse({
    operations: [
      { type: 'replace_text', find: 'Sam Rivera Lee', replace: 'Taylor Q Morgan' },
      { type: 'replace_text', find: 'Draft', replace: 'Final', pages: { from: 1, to: 2 } },
    ],
  });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.operations.length, 2);
});

test('rejects the retired set_copies operation (copies are print options in Inklink)', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'set_copies', copies: 3 }],
  });
  assert.equal(r.success, false);
});

test('rejects a plan mixing replace_text with set_copies', () => {
  const r = operationPlan.safeParse({
    operations: [
      { type: 'replace_text', find: 'John', replace: 'Jane' },
      { type: 'set_copies', copies: 3 },
    ],
  });
  assert.equal(r.success, false);
});

test('rejects an unknown operation type', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'reformat_everything', style: 'fancy' }],
  });
  assert.equal(r.success, false);
});

test('rejects a malicious run_python operation', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'run_python', code: "os.system('rm -rf /')" }],
  });
  assert.equal(r.success, false);
});

test('rejects replace_text with a blank find', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'replace_text', find: '   ', replace: 'x' }],
  });
  assert.equal(r.success, false);
});

test('rejects a page range that ends before it starts', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'replace_text', find: 'a', replace: 'b', pages: { from: 3, to: 1 } }],
  });
  assert.equal(r.success, false);
});

test('rejects replace_text missing the replace field', () => {
  const r = operationPlan.safeParse({
    operations: [{ type: 'replace_text', find: 'John' }],
  });
  assert.equal(r.success, false);
});
