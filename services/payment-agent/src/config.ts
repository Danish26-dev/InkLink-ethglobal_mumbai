import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

/** Secrets must be real: no defaults, and long enough not to be guessable. */
function requiredSecret(name: string, minLength = 16): string {
  const v = required(name).trim();
  if (v.length < minLength) {
    throw new Error(
      `${name} must be at least ${minLength} characters. Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return v;
}

/** Hedera testnet USDC (Circle). Mint test USDC at https://faucet.circle.com/ */
export const TESTNET_USDC_TOKEN_ID = "0.0.429274";
export const HEDERA_TESTNET = "hedera:testnet" as const;

/** The only agent identity this service pays on behalf of. */
export const AGENT_ID = optional("AGENT_ID", "inklink_payment_agent");

/**
 * Facilitator is fixed by team decision: Blocky402 on Hedera testnet. There is
 * deliberately NO automatic fallback to another facilitator, network or asset; if
 * it is unavailable the payment fails with a clear error.
 */
export const facilitatorConfig = {
  url: optional("FACILITATOR_URL", "https://api.testnet.blocky402.com"),
};

export const serviceConfig = {
  port: Number(optional("PORT", "4021")),
  gatePort: Number(optional("GATE_PORT", "4022")),
  backendEventUrl: optional(
    "BACKEND_EVENT_URL",
    "http://localhost:8000/api/v1/internal/payment-settled",
  ),
  callbackMaxAttempts: Number(optional("CALLBACK_MAX_ATTEMPTS", "8")),
};

/** Secrets and trust boundaries for the HTTP service. Fails fast if absent. */
export function loadServerSecurityConfig() {
  return {
    /** Bearer token the Inklink backend must present to call this service. */
    internalApiToken: requiredSecret("INTERNAL_API_TOKEN"),
    /** HMAC secret shared with the backend for the settlement callback. */
    callbackSigningSecret: requiredSecret("PAYMENT_EVENT_SIGNING_SECRET"),
    /** Origins of x402 gates this agent is allowed to pay. Anything else is refused. */
    allowedResourceOrigins: optional("ALLOWED_RESOURCE_ORIGINS", "http://localhost:4022")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Loaded lazily — only needed when actually signing/settling. */
export function loadHederaConfig() {
  return {
    network: HEDERA_TESTNET,
    agentAccountId: required("HEDERA_AGENT_ACCOUNT_ID"),
    agentPrivateKey: required("HEDERA_AGENT_PRIVATE_KEY"),
    usdcTokenId: optional("HTS_USDC_TOKEN_ID", TESTNET_USDC_TOKEN_ID),
    usdcDecimals: Number(optional("HTS_USDC_DECIMALS", "6")),
    merchantId: optional("MERCHANT_ID", "shop_001"),
    merchantAccountId: required("MERCHANT_ACCOUNT_ID"),
  };
}

/**
 * Map an Inklink merchantId (what the customer's policy allowlists) to the
 * Hedera account that must receive the payment. A payment whose payTo differs
 * from this account is refused before signing.
 */
export function resolveMerchantAccount(merchantId: string): string | null {
  const cfg = loadHederaConfig();
  return merchantId === cfg.merchantId ? cfg.merchantAccountId : null;
}
