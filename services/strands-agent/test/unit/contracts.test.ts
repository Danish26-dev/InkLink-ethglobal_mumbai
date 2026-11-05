/**
 * Cross-module contract tests for the migrated services (no network, no
 * credentials). They pin the agreements between the three modules so they
 * cannot silently drift apart:
 *
 *   agent print options  <->  local-printer-agent/src/printConfig.js
 *   agent operation plan <->  document-engine/app/editing/schema.py
 *   agent prompt / HTTP  <->  Inklink contract (no copies-as-edit, approval, no open CORS)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MAX_COPIES,
  MAX_OPERATIONS,
  MAX_TEXT_LENGTH,
  SUPPORTED_OPERATIONS,
  operationPlan,
  printColorModes,
  printOrientations,
  printPaperSizes,
  printSides,
} from '../../src/schema.js';
import { SYSTEM_PROMPT } from '../../src/services/orchestrator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

async function loadPrinterConfig(): Promise<any> {
  // Built from a variable so TypeScript does not try to type-resolve the JS module.
  const target = pathToFileURL(path.join(repoRoot, 'local-printer-agent', 'src', 'printConfig.js')).href;
  return import(target);
}

function engineSchemaConstant(name: string): number {
  const src = readFileSync(path.join(repoRoot, 'document-engine', 'app', 'editing', 'schema.py'), 'utf8');
  const m = src.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'));
  assert.ok(m, `${name} not found in document-engine schema.py`);
  return Number(m![1]);
}

test('print-option allowlists match the local printer adapter exactly', async () => {
  const lpa = await loadPrinterConfig();
  assert.deepEqual([...printColorModes], lpa.COLOR_MODES);
  assert.deepEqual([...printPaperSizes], lpa.PAPER_SIZES);
  assert.deepEqual([...printOrientations], lpa.ORIENTATIONS);
  assert.deepEqual([...printSides], lpa.SIDES);
  assert.equal(MAX_COPIES, lpa.MAX_COPIES);
});

test('a complete agent print proposal passes the adapter validation unchanged', async () => {
  const lpa = await loadPrinterConfig();
  const proposal = {
    printerId: 'Printer A',
    copies: 2,
    colorMode: 'monochrome',
    paperSize: 'A4',
    orientation: 'portrait',
    sides: 'two-sided-long-edge',
  };
  const r = lpa.validatePrintConfig(proposal, [{ id: 'Printer A' }]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value, proposal);
});

test('operation-plan limits match the document engine', () => {
  assert.equal(MAX_OPERATIONS, engineSchemaConstant('MAX_OPERATIONS'));
  assert.equal(MAX_TEXT_LENGTH, engineSchemaConstant('MAX_TEXT_LENGTH'));
});

test('copies are not a document operation anywhere in the agent contract', () => {
  assert.deepEqual([...SUPPORTED_OPERATIONS], ['replace_text']);
  assert.equal(operationPlan.safeParse({ operations: [{ type: 'set_copies', copies: 2 }] }).success, false);
  const engineSrc = readFileSync(path.join(repoRoot, 'document-engine', 'app', 'editing', 'schema.py'), 'utf8');
  assert.equal(/class\s+SetCopiesOperation/.test(engineSrc), false, 'engine must not define SetCopiesOperation');
});

test('system prompt follows the Inklink contract', () => {
  assert.match(SYSTEM_PROMPT, /Inklink/, 'prompt identifies the product');
  assert.equal(SYSTEM_PROMPT.includes('set_copies'), false, 'copies are print options');
  assert.match(SYSTEM_PROMPT, /approv/i, 'approval before printing must be stated');
  assert.equal(/preview IS generated/i.test(SYSTEM_PROMPT), false, 'no unsupported preview claim');
});

test('agent HTTP service does not emit CORS headers unless configured', async () => {
  const saved = process.env.AGENT_ALLOWED_ORIGINS;
  delete process.env.AGENT_ALLOWED_ORIGINS;
  const { default: app } = await import('../../src/app.js');
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await new Promise((r) => server.close(r));
    if (saved !== undefined) process.env.AGENT_ALLOWED_ORIGINS = saved;
  }
});
