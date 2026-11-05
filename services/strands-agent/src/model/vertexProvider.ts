/**
 * Vertex AI model provider for the Inklink Strands Agent.
 *
 * Uses the Strands SDK's GoogleModel (@strands-agents/sdk/models/google), which
 * is backed by @google/genai. We configure @google/genai for **Vertex AI** with
 * **Application Default Credentials (ADC)** — i.e. `{ vertexai: true, project,
 * location }` and NO apiKey. The Google auth library resolves ADC (e.g. from
 * `gcloud auth application-default login` locally, or workload identity in the
 * cloud). No API key and no service-account JSON are read by this code.
 *
 * This is the SDK-supported path (GoogleModel accepts a pre-built GoogleGenAI
 * client via `client`), not an invented API.
 */
import { GoogleGenAI } from '@google/genai';
import { GoogleModel } from '@strands-agents/sdk/models/google';
import { getConfig } from '../config.js';

/**
 * Build a Vertex-AI-backed GoogleModel using ADC. Validates required config via
 * getConfig() (throws a clear, secret-free error if misconfigured).
 */
export function buildVertexModel(): GoogleModel {
  const config = getConfig();

  // Vertex AI + ADC: no apiKey. @google/genai reads credentials from the ADC
  // provider chain. project/location target the Vertex endpoint.
  const client = new GoogleGenAI({
    vertexai: config.useVertexAi,
    project: config.googleCloudProject,
    location: config.googleCloudLocation,
  });

  // `params` are spread into the Gemini generation config by the SDK. We cap
  // output tokens to limit token-per-minute pressure (the main driver of Vertex
  // 429s under sustained load).
  const params: Record<string, unknown> = {
    temperature: config.modelTemperature,
    maxOutputTokens: config.maxOutputTokens,
  };

  // Gemini 2.5 "thinking" budget:
  //   > 0  -> cap thinking tokens to this value (lower = cheaper, but too low
  //           can break tool-calling; e.g. 0 can stall the loop).
  //   <= 0 -> DO NOT set it; let the model use its default budget (reliable
  //           tool-calling). This is the safe default.
  if (config.thinkingBudget > 0) {
    params.thinkingConfig = { thinkingBudget: config.thinkingBudget };
  }

  return new GoogleModel({
    client,
    modelId: config.vertexModelId,
    params,
  });
}
