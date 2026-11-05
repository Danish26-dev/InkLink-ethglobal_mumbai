/**
 * MOCK Inklink backend + shop gateway — LOCAL DEV ONLY. Not production.
 *
 * Stands in for the main lead's FastAPI backend and local gateway so the mobile app
 * and the payment agent can be built and tested without them. It follows the agreed
 * contracts and rules, and is the executable reference for how the real backend
 * should behave:
 *
 *   app ──(session token)──▶ this backend ──(bearer token)──▶ payment agent ──▶ x402 gate ──▶ Hedera
 *                                   ▲                                   │
 *                                   └──── signed settlement callback ───┘
 *
 *  - Pairing: signed QR + Ed25519 challenge-response, then a short-lived session token.
 *  - The backend (not the app) converts INR→USDC (MOCK rate, rounded up) and tells the
 *    agent exactly what to pay.
 *  - A payment becomes `settled` ONLY on a verified, signed callback. The agent saying
 *    "settled" over a status poll is NOT enough. Duplicate callbacks are idempotent.
 *  - Settlement moves the job to awaiting_execution, never to completed. The device
 *    progression after that is a MOCK timer, standing in for the ESP32.
 */

import crypto from "node:crypto";
import os from "node:os";
import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import type {
  CreateJobRequest,
  CreateJobResponse,
  DocumentUploadResponse,
  JobStatusResponse,
  PaymentStatus,
  PaymentStatusResponse,
  PaymentSettledEvent,
  Quote,
  Shop,
} from "@inklink/shared-schemas";
import { verifyCallback } from "./callback-auth.js";
import { inrToUsdc } from "./fx.js";
import { SessionStore, buildQrPayload, createGatewayIdentity } from "./gateway-crypto.js";

// ───────────────────────── configuration ─────────────────────────
const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

const PORT = Number(env("PORT", "8000"));
const SHOP_ID = env("SHOP_ID", "shop_001");
const GATEWAY_ID = env("GATEWAY_ID", "gateway_001");
const MDNS_NAME = env("GATEWAY_MDNS", "gateway-001.local");
const AGENT_URL = env("AGENT_URL", "http://localhost:4021");
const GATE_URL = env("GATE_URL", "http://localhost:4022");
const INTERNAL_API_TOKEN = env("INTERNAL_API_TOKEN"); // backend -> agent
const BACKEND_API_TOKEN = env("BACKEND_API_TOKEN"); // gate -> backend (requirements lookup)
const CALLBACK_SECRET = env("PAYMENT_EVENT_SIGNING_SECRET");
const MERCHANT_ACCOUNT_ID = env("MERCHANT_ACCOUNT_ID");
const MOCK_RATE = env("MOCK_INR_TO_USDC_RATE", "0.005"); // USDC per INR — MOCK, not a market rate
const SESSION_TTL_MS = Number(env("SESSION_TTL_SECONDS", "900")) * 1000;
const QUOTE_TTL_MS = 5 * 60_000; // rate snapshot validity; quote expiry = payment deadline
const MAX_UPLOAD = 25 * 1024 * 1024;

const paymentsConfigured = Boolean(INTERNAL_API_TOKEN && CALLBACK_SECRET && MERCHANT_ACCOUNT_ID);

// ───────────────────────── state ─────────────────────────
interface QuoteRecord {
  quoteId: string;
  jobId: string;
  merchantId: string;
  inr: string;
  usdc: string;
  rate: string;
  capturedAt: string;
  expiresAt: string;
}

interface JobState {
  jobId: string;
  shopId: string;
  documentId: string | null;
  createdAt: string;
  status: JobStatusResponse["status"];
  paymentStatus: PaymentStatus;
  deviceStatus: JobStatusResponse["deviceStatus"];
  latestQuoteId?: string;
}

interface PaymentRecord {
  paymentId: string;
  jobId: string;
  quoteId: string;
  merchantId: string;
  amountUsdc: string;
  status: PaymentStatus;
  transactionId: string | null;
}

const jobs = new Map<string, JobState>();
const quotes = new Map<string, QuoteRecord>();
const payments = new Map<string, PaymentRecord>();
const paymentByJobQuote = new Map<string, string>();
const uploadsByIdempotencyKey = new Map<string, DocumentUploadResponse>();

const identity = createGatewayIdentity();
const sessions = new SessionStore(SESSION_TTL_MS);

const SHOP: Shop = {
  shopId: SHOP_ID,
  gatewayId: GATEWAY_ID,
  name: "Campus Print Shop (MOCK)",
  protocolVersion: "1.0",
  capabilities: { localPrinting: true, pdf: true, docx: true, aiEditing: true, offlineMode: true },
  connection: { localGatewayAvailable: true, internetAvailable: true },
};

// ───────────────────────── helpers ─────────────────────────
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const errorBody = (code: string, message: string) => ({ success: false as const, error: { code, message } });

/** First non-virtual private IPv4, so the QR carries a usable LAN hint. */
function detectLanIp(): string | undefined {
  const skip = /vEthernet|VMware|VirtualBox|WSL|Loopback|Hyper-V|docker|vbox/i;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}
const LAN_IP = env("GATEWAY_IP") || detectLanIp();

const hashscanFor = (tx: string) =>
  `https://hashscan.io/testnet/transaction/${tx.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;

async function callAgent(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_API_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ───────────────────────── app ─────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "64kb",
    // Keep the RAW bytes: the callback signature is over exactly what was sent.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
);

const upload = multer({ limits: { fileSize: MAX_UPLOAD } });

app.get("/health", (_req, res) => res.json({ ok: true })); // unauthenticated; nothing sensitive

// Session auth for every /api/v1 route except pairing and the internal service routes.
app.use("/api/v1", (req, res, next) => {
  if (req.path === "/pairing/verify" || req.path.startsWith("/internal/")) return next();
  const token = /^Bearer (.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  const state = sessions.check(token);
  if (state === "ok") return next();
  res
    .status(401)
    .json(errorBody(state === "expired" ? "SESSION_EXPIRED" : "UNAUTHORIZED", "Pair with the shop to start a session"));
});

// ── Pairing handshake ──
app.post("/api/v1/pairing/verify", (req, res) => {
  const challenge = req.body?.challenge;
  if (typeof challenge !== "string" || challenge.length < 16 || challenge.length > 256 || !/^[A-Za-z0-9_-]+$/.test(challenge)) {
    res.status(400).json(errorBody("PAIRING_FAILED", "challenge must be a Base64URL string (16-256 chars)"));
    return;
  }
  const session = sessions.issue();
  res.json({
    signedChallenge: identity.sign(challenge),
    gatewayId: GATEWAY_ID,
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
  });
});

// ── Contract 1 ──
app.get("/api/v1/shops/:shopId", (req, res) => {
  if (req.params.shopId !== SHOP.shopId) {
    res.status(404).json(errorBody("SHOP_NOT_FOUND", "Unknown shop"));
    return;
  }
  res.json(SHOP);
});

// ── Contract 3 (call first; mints the authoritative jobId) ──
app.post("/api/v1/jobs", (req, res) => {
  const body = req.body as CreateJobRequest;
  const jobId = id("job");
  const now = new Date().toISOString();
  jobs.set(jobId, {
    jobId,
    shopId: body.shopId,
    documentId: body.documentId ?? null,
    createdAt: now,
    status: "created",
    paymentStatus: "created",
    deviceStatus: "unknown",
  });
  const resp: CreateJobResponse = { jobId, status: "created", createdAt: now };
  res.json(resp);
});

// ── Contract 2 (multipart; honors Idempotency-Key) ──
app.post("/api/v1/documents", upload.single("file"), (req, res) => {
  const { jobId } = req.body as { jobId?: string };
  const file = req.file;
  if (!file) {
    res.status(400).json(errorBody("UPLOAD_FAILED", "Missing file"));
    return;
  }
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "Create the job before uploading"));
    return;
  }

  const key = req.header("idempotency-key");
  if (key && uploadsByIdempotencyKey.has(key)) {
    res.json(uploadsByIdempotencyKey.get(key)); // duplicate retry: same record, no new document
    return;
  }

  const name = file.originalname.toLowerCase();
  const isPdf = name.endsWith(".pdf") && file.buffer.subarray(0, 5).toString() === "%PDF-";
  const isDocx = name.endsWith(".docx") && file.buffer.subarray(0, 2).toString() === "PK";
  if (!isPdf && !isDocx) {
    res.status(415).json(errorBody("UNSUPPORTED_FORMAT", "Only valid PDF and DOCX files are supported"));
    return;
  }

  const documentId = id("doc");
  job.documentId = documentId;
  const resp: DocumentUploadResponse = {
    documentId,
    jobId: job.jobId,
    filename: file.originalname,
    format: isPdf ? "pdf" : "docx",
    size: file.size,
    status: "uploaded",
  };
  if (key) uploadsByIdempotencyKey.set(key, resp);
  res.json(resp);
});

// ── Contract 4: INR quote + backend-computed USDC settlement ──
app.post("/api/v1/jobs/:jobId/quote", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown job"));
    return;
  }
  const now = Date.now();
  const inr = "20.00"; // MOCK price
  const usdc = inrToUsdc(inr, MOCK_RATE);
  const rec: QuoteRecord = {
    quoteId: id("quote"),
    jobId: job.jobId,
    merchantId: job.shopId,
    inr,
    usdc,
    rate: MOCK_RATE,
    capturedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
  quotes.set(rec.quoteId, rec);
  job.latestQuoteId = rec.quoteId;
  job.status = "awaiting_payment";

  const quote: Quote = {
    quoteId: rec.quoteId,
    jobId: rec.jobId,
    merchantId: rec.merchantId,
    amount: rec.inr,
    asset: "INR",
    expiresAt: rec.expiresAt,
    paymentMethods: paymentsConfigured ? ["traditional", "hedera_x402"] : ["traditional"],
    settlement: paymentsConfigured
      ? { asset: "HTS-USDC", amount: rec.usdc, rate: rec.rate, capturedAt: rec.capturedAt }
      : undefined,
  };
  res.json(quote);
});

// ── Contract 5: device-signed spending policy (verified by the payment agent) ──
app.post("/api/v1/payments/authorizations", async (req, res) => {
  if (!paymentsConfigured) return notConfigured(res);
  try {
    const r = await callAgent("POST", "/api/v1/payments/authorizations", req.body);
    res.status(r.status).json(r.json ?? errorBody("INTERNAL_ERROR", "Payment service returned no body"));
  } catch {
    res.status(503).json(errorBody("INTERNAL_ERROR", "Payment service is unreachable"));
  }
});

// ── Contract 6: the BACKEND decides the amount, merchant and resource ──
app.post("/api/v1/payments", async (req, res) => {
  if (!paymentsConfigured) return notConfigured(res);
  const { jobId, quoteId, authorizationId, paymentMethod } = req.body ?? {};
  if (paymentMethod !== "hedera_x402" || ![jobId, quoteId, authorizationId].every((v) => typeof v === "string")) {
    res.status(400).json(errorBody("PAYMENT_FAILED", "jobId, quoteId, authorizationId and paymentMethod=hedera_x402 are required"));
    return;
  }
  const job = jobs.get(jobId);
  const quote = quotes.get(quoteId);
  if (!job || !quote || quote.jobId !== jobId) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown job or quote"));
    return;
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    res.status(410).json(errorBody("QUOTE_EXPIRED", "The quote has expired; request a new quote"));
    return;
  }

  try {
    const r = await callAgent("POST", "/api/v1/payments", {
      jobId,
      quoteId,
      authorizationId,
      paymentMethod,
      merchantId: quote.merchantId,
      settlementAmount: quote.usdc, // authoritative: computed here, never by the app
      resourceUrl: `${GATE_URL}/api/v1/jobs/${encodeURIComponent(jobId)}/execute`,
      quoteExpiresAt: quote.expiresAt,
    });
    if (r.status !== 200) {
      res.status(r.status).json(r.json ?? errorBody("INTERNAL_ERROR", "Payment service error"));
      return;
    }
    const existing = payments.get(r.json.paymentId);
    if (!existing) {
      payments.set(r.json.paymentId, {
        paymentId: r.json.paymentId,
        jobId,
        quoteId,
        merchantId: quote.merchantId,
        amountUsdc: quote.usdc,
        status: "processing",
        transactionId: null,
      });
      paymentByJobQuote.set(`${jobId}:${quoteId}`, r.json.paymentId);
      job.paymentStatus = "processing";
    }
    res.json(r.json);
  } catch {
    res.status(503).json(errorBody("INTERNAL_ERROR", "Payment service is unreachable"));
  }
});

// ── Contract 7: authoritative status = what THIS backend has verified ──
app.get("/api/v1/payments/:paymentId", async (req, res) => {
  const rec = payments.get(req.params.paymentId);
  if (!rec) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown paymentId"));
    return;
  }
  if (rec.status === "processing" && paymentsConfigured) {
    // Learn about FAILURES from the agent. Never learn about SUCCESS this way:
    // `settled` only ever comes from the verified, signed callback below.
    try {
      const r = await callAgent("GET", `/api/v1/payments/${rec.paymentId}`);
      if (r.status === 200 && (r.json.status === "failed" || r.json.status === "expired")) {
        rec.status = r.json.status;
        const job = jobs.get(rec.jobId);
        if (job) job.paymentStatus = rec.status;
      }
    } catch { /* keep processing */ }
  }
  const out: PaymentStatusResponse = {
    paymentId: rec.paymentId,
    jobId: rec.jobId,
    status: rec.status,
    network: "hedera_testnet",
    transactionId: rec.status === "settled" ? rec.transactionId : null,
    amount: rec.amountUsdc,
    asset: "USDC",
    merchantId: rec.merchantId,
  };
  res.json(out);
});

// ── Contract 8 ──
app.get("/api/v1/jobs/:jobId/status", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown job"));
    return;
  }
  const resp: JobStatusResponse = {
    jobId: job.jobId,
    status: job.status,
    paymentStatus: job.paymentStatus,
    deviceStatus: job.deviceStatus,
    updatedAt: new Date().toISOString(),
  };
  res.json(resp);
});

// ───────────────────────── internal (service-to-service) ─────────────────────────

/** Signed settlement callback from the payment agent. */
app.post("/api/v1/internal/payment-settled", (req, res) => {
  if (!paymentsConfigured) return notConfigured(res);
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const auth = raw ? verifyCallback(raw, req.headers, CALLBACK_SECRET) : { ok: false as const, reason: "MISSING_HEADERS" as const };
  if (!auth.ok) {
    console.warn(`[callback] rejected: ${auth.reason}`);
    res.status(401).json(errorBody("UNAUTHORIZED", "Invalid callback signature"));
    return;
  }

  const e = req.body as PaymentSettledEvent;
  const rec = payments.get(e?.paymentId);
  const bad = (m: string) => {
    console.warn(`[callback] ${e?.paymentId}: ${m}`);
    res.status(422).json(errorBody("SETTLEMENT_UNVERIFIED", m));
  };
  if (!rec) return void res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown paymentId"));
  if (e.status !== "settled" || e.network !== "hedera:testnet" || e.asset !== "HTS_USDC") return bad("unexpected status/network/asset");
  if (e.jobId !== rec.jobId) return bad("jobId does not match the payment");
  if (e.amount !== rec.amountUsdc) return bad("amount does not match the quote");
  if (e.merchantAccountId !== MERCHANT_ACCOUNT_ID) return bad("merchant account does not match");
  if (typeof e.transactionId !== "string" || !/^\d+\.\d+\.\d+@\d+\.\d+$/.test(e.transactionId)) return bad("malformed transactionId");
  if (e.hashscanUrl !== hashscanFor(e.transactionId)) return bad("hashscanUrl is not derived from the transaction id");

  // Idempotent: paymentId is the key. A duplicate must change nothing and trigger nothing.
  if (rec.status === "settled") {
    if (rec.transactionId === e.transactionId) return void res.json({ ok: true, duplicate: true });
    return bad("payment already settled with a different transaction");
  }

  rec.status = "settled";
  rec.transactionId = e.transactionId;
  const job = jobs.get(rec.jobId);
  if (job) {
    job.paymentStatus = "settled";
    job.status = "awaiting_execution"; // payment authorizes execution; it does NOT complete the job
    job.deviceStatus = "ready";
    mockDeviceProgress(job);
  }
  console.log(`[callback] ${rec.paymentId} settled: ${e.hashscanUrl}`);
  res.json({ ok: true });
});

/**
 * PROPOSED endpoint (not yet agreed with the backend owner): lets the x402 gate ask
 * what a job must pay. Point the gate at it with REQUIREMENTS_URL_TEMPLATE.
 */
app.get("/api/v1/internal/jobs/:jobId/payment-requirements", (req, res) => {
  const token = /^Bearer (.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (!BACKEND_API_TOKEN || token !== BACKEND_API_TOKEN) {
    res.status(401).json(errorBody("UNAUTHORIZED", "Invalid service token"));
    return;
  }
  const job = jobs.get(req.params.jobId);
  const quote = job?.latestQuoteId ? quotes.get(job.latestQuoteId) : undefined;
  if (!job || !quote) {
    res.status(404).json(errorBody("JOB_NOT_FOUND", "No quote for this job"));
    return;
  }
  res.json({
    jobId: job.jobId,
    merchantAccountId: MERCHANT_ACCOUNT_ID,
    amount: quote.usdc,
    expiresAt: quote.expiresAt,
  });
});

// ───────────────────────── mock device (stands in for the ESP32) ─────────────────────────
function mockDeviceProgress(job: JobState) {
  setTimeout(() => {
    job.status = "executing";
    job.deviceStatus = "processing";
  }, 4000);
  setTimeout(() => {
    job.status = "completed";
    job.deviceStatus = "ready";
  }, 10000);
}

/** Dev-only shortcut that FAKES a settled payment. Off unless explicitly enabled. */
if (env("MOCK_ALLOW_SIMULATE") === "1") {
  app.post("/api/v1/jobs/:jobId/_simulate", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return void res.status(404).json(errorBody("JOB_NOT_FOUND", "Unknown job"));
    job.paymentStatus = "settled";
    job.status = "awaiting_execution";
    job.deviceStatus = "ready";
    mockDeviceProgress(job);
    res.json({ ok: true, simulated: true, warning: "NOT a real payment" });
  });
}

// ───────────────────────── dev helpers + errors ─────────────────────────
const qrText = () =>
  JSON.stringify(
    buildQrPayload(identity, {
      shopId: SHOP_ID,
      gatewayId: GATEWAY_ID,
      mdns: MDNS_NAME,
      ip: LAN_IP,
      port: PORT,
      ttlMs: 60 * 60_000,
    }),
  );

app.get("/_dev/qr", (_req, res) => res.type("text/plain").send(qrText()));

function notConfigured(res: express.Response) {
  res.status(503).json(
    errorBody(
      "INTERNAL_ERROR",
      "Payments are not configured on this mock backend (set INTERNAL_API_TOKEN, PAYMENT_EVENT_SIGNING_SECRET, MERCHANT_ACCOUNT_ID)",
    ),
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json(errorBody("DOCUMENT_TOO_LARGE", "Documents are limited to 25 MB"));
    return;
  }
  console.error("[mock-gateway] error:", err?.message ?? err);
  res.status(500).json(errorBody("INTERNAL_ERROR", "Unexpected error"));
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[mock-gateway] listening on :${PORT}  (MOCK — not production)`);
  console.log(`[mock-gateway] LAN address hint in QR: ${LAN_IP ?? "none (set GATEWAY_IP)"}`);
  if (!paymentsConfigured) {
    console.warn("[mock-gateway] payments NOT configured: quotes will offer no Hedera option");
  }
  const text = qrText();
  console.log("\nScan this with the Inklink app (valid 1 hour):\n");
  console.log(await QRCode.toString(text, { type: "terminal", small: true }));
  console.log("Or paste this text into 'Enter code manually':\n" + text + "\n");
});
