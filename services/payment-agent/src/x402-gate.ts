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
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HEDERA_TESTNET, facilitatorConfig, loadHederaConfig } from "./config.js";
import { PRINT_JOB_ROUTE_TEMPLATE, PRINT_JOB_TAG } from "./gate-discovery.js";
import type { RequirementsSource } from "./gate-requirements.js";

const SERVICE_NAME = "Inklink print shop";
const SERVICE_TAGS = ["printing", "inklink", PRINT_JOB_TAG];
const DESCRIPTION = "Pay for one Inklink print job (exact USDC amount quoted per job in the 402)";

/** x402 Bazaar description of how to call the paid route (official @x402/extensions helper). */
const BAZAAR_EXTENSION = declareDiscoveryExtension({
  bodyType: "json",
  input: { jobId: "job_001", paymentId: "payment_001" },
  inputSchema: {
    type: "object",
    properties: { jobId: { type: "string" }, paymentId: { type: "string" } },
  },
  pathParams: { jobId: "job_001" },
  pathParamsSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  output: { example: { jobId: "job_001", paymentAccepted: true } },
});

/**
 * Attach the Bazaar metadata to every 402 as well, so the price response itself describes
 * the endpoint. Verified live: Blocky402 settled a payment that echoed this extension.
 * Set GATE_BAZAAR_IN_402=0 to turn it off.
 */
const BAZAAR_IN_402 = process.env.GATE_BAZAAR_IN_402 !== "0";

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
  if (BAZAAR_IN_402) resourceServer.registerExtension(bazaarResourceServerExtension);

  const requirementsFor = async (ctx: HTTPRequestContext) => {
    const jobId = jobIdFromPath(ctx.path);
    const req = jobId ? await source.get(jobId) : null;
    if (!req) throw new Error("unknown job");
    return req;
  };

  const app = express();
  // Behind Cloud Run / a proxy: use X-Forwarded-Proto/Host so published URLs are https.
  app.set("trust proxy", true);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Discovery document in the x402 Bazaar `DiscoveryResourcesResponse` shape, so agents can
   * find the paid endpoint themselves. The price is per job, so `accepts` is empty here; the
   * authoritative price is the 402 for the specific job.
   */
  app.get("/discovery/resources", (req, res) => {
    const origin = process.env.GATE_PUBLIC_ORIGIN?.replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;
    res.json({
      x402Version: 2,
      items: [
        {
          resource: `${origin}${PRINT_JOB_ROUTE_TEMPLATE}`,
          type: "http",
          x402Version: 2,
          accepts: [],
          lastUpdated: new Date().toISOString(),
          description: DESCRIPTION,
          mimeType: "application/json",
          serviceName: SERVICE_NAME,
          tags: SERVICE_TAGS,
          extensions: {
            ...BAZAAR_EXTENSION,
            inklink: {
              method: "POST",
              routeTemplate: PRINT_JOB_ROUTE_TEMPLATE,
              network: HEDERA_TESTNET,
              asset: cfg.usdcTokenId,
              pricing: "per-job: POST the job's URL without payment to read the exact price from the 402",
            },
          },
        },
      ],
      pagination: { limit: 1, offset: 0, total: 1 },
    });
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
          description: DESCRIPTION,
          mimeType: "application/json",
          serviceName: SERVICE_NAME,
          tags: SERVICE_TAGS,
          ...(BAZAAR_IN_402 ? { extensions: BAZAAR_EXTENSION } : {}),
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
