/**
 * REAL Vertex AI smoke test (opt-in, NEVER faked).
 *
 * This performs an ACTUAL Gemini request through the Strands GoogleModel using
 * Vertex AI + Application Default Credentials (ADC). It is GATED and SKIPS
 * (does not fake success) unless:
 *   - RUN_VERTEX_TESTS=1
 *   - GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / VERTEX_AI_MODEL_ID are set
 * and ADC is available (e.g. `gcloud auth application-default login`).
 *
 * Two levels:
 *   1) a minimal model round-trip (proves auth + model access), and
 *   2) a full agent run that produces a validated OperationPlan via the real
 *      model (needs the Document Engine for the tools).
 *
 * Run:
 *   RUN_VERTEX_TESTS=1 DOCUMENT_ENGINE_URL=http://127.0.0.1:5001 \
 *     npx tsx --test test/integration/vertex.smoke.test.ts
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@strands-agents/sdk';
import { buildVertexModel } from '../../src/model/vertexProvider.js';
import { buildTools, type DocumentContext } from '../../src/tools/documentTools.js';
import { planningOrchestrator } from '../../src/services/orchestrator.js';
import { documentEngine } from '../../src/clients/documentEngineClient.js';
import { makeDocx } from '../helpers/docxFixture.js';

const configured = Boolean(
  process.env.GOOGLE_CLOUD_PROJECT &&
    process.env.GOOGLE_CLOUD_LOCATION &&
    process.env.VERTEX_AI_MODEL_ID,
);
const enabled = process.env.RUN_VERTEX_TESTS === '1' && configured;
let engineUp = false;

before(async () => {
  if (!enabled) {
    console.warn(
      '\n[SKIP] Real Vertex AI tests disabled. To run: set RUN_VERTEX_TESTS=1, ' +
        'GOOGLE_CLOUD_PROJECT/LOCATION, VERTEX_AI_MODEL_ID, and ADC ' +
        '(`gcloud auth application-default login`).\n',
    );
    return;
  }
  engineUp = await documentEngine.health();
});

test('REAL: Vertex AI model round-trip (auth + model access)', async (t) => {
  if (!enabled) return t.skip('vertex disabled');
  const agent = new Agent({
    model: buildVertexModel(),
    systemPrompt: 'Reply with exactly the single word: OK',
    printer: false,
  });
  const result: any = await agent.invoke('Say OK');
  const text = JSON.stringify(result?.lastMessage ?? result ?? '');
  assert.ok(text.length > 0, 'model returned a response');
});

test('REAL: agent produces a validated plan + copies as a print option via Vertex', async (t) => {
  if (!enabled) return t.skip('vertex disabled');
  if (!engineUp) return t.skip('document engine unavailable');

  const fileBuffer = await makeDocx('Author: Alice', 'Report by Alice.');
  const result = await planningOrchestrator.runEdit({
    instruction: 'Change Alice to Bobby and make 3 copies.',
    fileBuffer,
    filename: 'report.docx',
  });

  assert.equal(result.executed, true, 'agent should execute a plan');
  assert.ok(result.document, 'expected a Document Engine result');
  assert.equal(result.document!.changes.total_replacements, 2);
  assert.equal(result.printOptions?.copies, 3, 'copies must be captured as a print option');
});

test('REAL: ambiguous instruction asks for clarification (no edit) via Vertex', async (t) => {
  if (!enabled) return t.skip('vertex disabled');
  if (!engineUp) return t.skip('document engine unavailable');

  const fileBuffer = await makeDocx('Attendees: John Smith, John Doe, and Jane Roe.');
  const result = await planningOrchestrator.runEdit({
    instruction: 'Change the name and print it.',
    fileBuffer,
    filename: 'attendees.docx',
  });
  assert.equal(result.executed, false, 'must not edit on an ambiguous request');
});
