/**
 * Entry point for the internal x402 gate (npm run gate).
 *
 * With REQUIREMENTS_URL_TEMPLATE set it asks the Inklink backend what each job
 * must pay (backend-authoritative). Without it, it falls back to a FIXED dev price
 * and says so loudly: never run that against real jobs.
 */

import { loadHederaConfig, serviceConfig } from "./config.js";
import {
  BackendRequirementsSource,
  FixedRequirementsSource,
  type RequirementsSource,
} from "./gate-requirements.js";
import { createX402Gate } from "./x402-gate.js";

const cfg = loadHederaConfig();
const template = process.env.REQUIREMENTS_URL_TEMPLATE;

let source: RequirementsSource;
if (template) {
  source = new BackendRequirementsSource(
    template,
    cfg.usdcDecimals,
    process.env.BACKEND_API_TOKEN,
  );
  console.log(`[gate] pricing from backend: ${template}`);
} else {
  const price = process.env.EXAMPLE_PRICE_USDC ?? "0.10";
  source = new FixedRequirementsSource(price, cfg.merchantAccountId, cfg.usdcDecimals);
  console.warn(
    `[gate] DEV MODE: every job costs a FIXED ${price} USDC paid to ${cfg.merchantAccountId}. ` +
      "Set REQUIREMENTS_URL_TEMPLATE to price from the backend.",
  );
}

createX402Gate(source).listen(serviceConfig.gatePort, () => {
  console.log(`[gate] x402 gate listening on :${serviceConfig.gatePort}`);
});
