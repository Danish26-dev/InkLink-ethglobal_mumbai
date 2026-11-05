// Unit tests for the local printer agent's strict config validation.
// Run: node --test   (from local-printer-agent/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrintConfig } from '../src/printConfig.js';

const printers = [
  { id: 'Printer A', name: 'Printer A' },
  { id: 'Printer B', name: 'Printer B' },
];

const valid = {
  printerId: 'Printer A',
  copies: 3,
  colorMode: 'monochrome',
  paperSize: 'A4',
  orientation: 'portrait',
  sides: 'one-sided',
};

test('accepts a valid config and returns a normalized value with only allowlisted keys', () => {
  const r = validatePrintConfig({ ...valid, extra: 'ignored' }, printers);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value).sort(), [
    'colorMode', 'copies', 'orientation', 'paperSize', 'printerId', 'sides',
  ]);
  assert.equal(r.value.extra, undefined);
});

test('rejects unknown printerId', () => {
  const r = validatePrintConfig({ ...valid, printerId: 'Ghost' }, printers);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Unknown printerId/.test(e)));
});

test('rejects invalid copies (0, 1000, non-integer)', () => {
  assert.equal(validatePrintConfig({ ...valid, copies: 0 }, printers).ok, false);
  assert.equal(validatePrintConfig({ ...valid, copies: 1000 }, printers).ok, false);
  assert.equal(validatePrintConfig({ ...valid, copies: 2.5 }, printers).ok, false);
});

test('rejects values outside the allowlist (no silent substitution)', () => {
  assert.equal(validatePrintConfig({ ...valid, colorMode: 'cmyk' }, printers).ok, false);
  assert.equal(validatePrintConfig({ ...valid, paperSize: 'A3' }, printers).ok, false);
  assert.equal(validatePrintConfig({ ...valid, orientation: 'sideways' }, printers).ok, false);
  assert.equal(validatePrintConfig({ ...valid, sides: 'triple-sided' }, printers).ok, false);
});

test('rejects a missing/empty config object', () => {
  assert.equal(validatePrintConfig(null, printers).ok, false);
  assert.equal(validatePrintConfig({}, printers).ok, false);
});
