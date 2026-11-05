/**
 * Wiring unit test (no network, no credentials).
 *
 * Proves the real Strands SDK + Google (Vertex) provider objects construct and
 * the orchestrator/tools import cleanly. Constructing a GoogleModel with a
 * Vertex-configured client does NOT make a network call or require ADC, so this
 * is credential-free. It does NOT invoke the model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@strands-agents/sdk';
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { GoogleGenAI } from '@google/genai';
import { buildTools } from '../../src/tools/documentTools.js';
import { buildVertexModel } from '../../src/model/vertexProvider.js';
import { PlanningOrchestrator } from '../../src/services/orchestrator.js';
import { resetConfigForTests } from '../../src/config.js';

const VALID_ENV = {
  GOOGLE_CLOUD_PROJECT: 'inklink-test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  GOOGLE_GENAI_USE_VERTEXAI: 'True',
  VERTEX_AI_MODEL_ID: 'gemini-2.5-flash',
};

function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    resetConfigForTests();
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
  }
}

test('GoogleGenAI constructs for Vertex AI without an API key (ADC path)', () => {
  // No apiKey -> ADC. Construction does not perform a network call.
  const client = new GoogleGenAI({ vertexai: true, project: 'inklink-test-project', location: 'global' });
  assert.ok(client);
});

test('buildVertexModel constructs a GoogleModel from env config', () => {
  withEnv(VALID_ENV, () => {
    const model = buildVertexModel();
    assert.ok(model instanceof GoogleModel);
    assert.equal(model.getConfig().modelId, 'gemini-2.5-flash');
  });
});

test('Agent constructs with the Vertex model and the four Inklink tools', () => {
  withEnv(VALID_ENV, () => {
    const tools = buildTools({ fileBuffer: Buffer.from(''), filename: 'x.docx' });
    const agent = new Agent({
      model: buildVertexModel(),
      systemPrompt: 'test',
      tools: [tools.inspectDocument, tools.planOperations, tools.executeOperationPlan, tools.setPrintOptions],
      printer: false,
    });
    assert.ok(agent);
  });
});

test('PlanningOrchestrator instantiates', () => {
  assert.ok(new PlanningOrchestrator());
});

test('tools expose the expected names and invoke method', () => {
  const tools = buildTools({ fileBuffer: Buffer.from(''), filename: 'x.docx' });
  assert.equal(tools.inspectDocument.name, 'inspect_document');
  assert.equal(tools.planOperations.name, 'plan_operations');
  assert.equal(tools.executeOperationPlan.name, 'execute_operation_plan');
  assert.equal(typeof tools.planOperations.invoke, 'function');
});
