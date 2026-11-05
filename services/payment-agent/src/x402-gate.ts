/**
 * Inklink x402 gate — an isolated Node service that sits BEHIND the main backend.
 *
 * Team decision: Hedera x402 cryptographic verification is not hand-rolled in
 * FastAPI; this service uses the official @x402/express middleware and
 * @x402/hedera server scheme, and settles through the Blocky402 facilitator.
 *
 *   POST /api/v1/jobs/{jobId}/execute
 *     unpaid -> 402 + PAYMENT-REQUIRED  (exact USDC amount + shop payTo for THIS job)
 *     paid   -> facilitator /verify + /settle, then 200 + PAYMENT-RESPONSE
 *
 * A verified payment does NOT mean the printer has completed anything. This route
 * only reports that payment was accepted; the backend owns job status and moves
 * the job to awaiting_execution when it receives the agent's signed callback.
 */

import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { HTTPRequestContext } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HEDERA_TESTNET, facilitatorConfig, loadHederaConfig } from "./config.js";
import type { RequirementsSource } from "./gate-requirements.js";

const EXECUTE_PATH = /^\/api\/v1\/jobs\/([^/]+)\/execute$/;

/** Route key uses x402's `[param]` syntax for a path segment. */
export const GATE_ROUTE_KEY = "POST /api/v1/jobs/[jobId]/execute";

export function jobIdFromPath(path: string): string | null {
  const m = EXECUTE_PATH.exec(path.split("?")[0]);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function errorBody(code: string, message: string) {
  return { success: false as const, error: { code, message } };
}

export function createX402Gate(source: RequirementsSource) {
  const cfg = loadHederaConfig();

  const facilitator = new HTTPFacilitatorClient({ url: facilitatorConfig.url });
  const resourceServer = new x402ResourceServer(facilitator).register(
    "hedera:*",
    new ExactHederaScheme({
      defaultAssets: {
        [HEDERA_TESTNET]: { asset: cfg.usdcTokenId, decimals: cfg.usdcDecimals },
      },
    }),
  );

  const requirementsFor = async (ctx: HTTPRequestContext) => {
    const jobId = jobIdFromPath(ctx.path);
    const req = jobId ? await source.get(jobId) : null;
    if (!req) throw new Error("unknown job");
    return req;
  };

  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Before any payment logic: unknown job -> 404, expired quote -> 410.
  app.post("/api/v1/jobs/:jobId/execute", async (req, res, next) => {
    try {
      const requirements = await source.get(req.params.jobId);
      if (!requirements) {
        res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown job"));
        return;
      }
      if (requirements.expiresAt && Date.parse(requirements.expiresAt) <= Date.now()) {
        res.status(410).json(errorBody("QUOTE_EXPIRED", "The quote has expired"));
        return;
      }
      next();
    } catch {
      res.status(502).json(errorBody("INTERNAL_ERROR", "Could not load payment requirements"));
    }
  });

  app.use(
    paymentMiddleware(
      {
        [GATE_ROUTE_KEY]: {
          accepts: {
            scheme: "exact",
            network: HEDERA_TESTNET,
            payTo: async (ctx) => (await requirementsFor(ctx)).payTo,
            price: async (ctx) => ({
              asset: cfg.usdcTokenId,
              amount: (await requirementsFor(ctx)).amountAtomic.toString(),
            }),
          },
          description: "Inklink print job payment",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.post("/api/v1/jobs/:jobId/execute", (req, res) => {
    res.json({ jobId: req.params.jobId, paymentAccepted: true });
  });

  return app;
}
