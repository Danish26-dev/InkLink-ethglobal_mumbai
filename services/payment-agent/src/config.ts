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
  /**
   * Durable agent state (spent limits, nonces, payments). Keep it OUT of git and out of a
   * cloud-synced folder (OneDrive/Dropbox can lock files mid-write).
   */
  stateFile: optional("AGENT_STATE_FILE", ".data/agent-state.json"),
  /**
   * HCS topic for the tamper-evident spend audit log (create it with `npm run setup:audit-topic`).
   * Unset = audit log off; payments work the same either way.
   */
  auditTopicId: optional("HCS_AUDIT_TOPIC_ID", "") || null,
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

/**
 * The paying agent wallet and the shop's receiving wallet must be different accounts.
 * Paying yourself would "settle" without moving value and make a demo meaningless.
 */
export function assertWalletsSeparate(agentAccountId: string, merchantAccountId: string): void {
  if (agentAccountId.trim() === merchantAccountId.trim()) {
    throw new Error(
      "MERCHANT_ACCOUNT_ID must differ from HEDERA_AGENT_ACCOUNT_ID: the payment agent wallet and the merchant receiving wallet must be separate accounts",
    );
  }
}

/** Loaded lazily — only needed when actually signing/settling. */
export function loadHederaConfig() {
  const agentAccountId = required("HEDERA_AGENT_ACCOUNT_ID");
  const merchantAccountId = required("MERCHANT_ACCOUNT_ID");
  assertWalletsSeparate(agentAccountId, merchantAccountId);
  return {
    network: HEDERA_TESTNET,
    agentAccountId,
    agentPrivateKey: required("HEDERA_AGENT_PRIVATE_KEY"),
    usdcTokenId: optional("HTS_USDC_TOKEN_ID", TESTNET_USDC_TOKEN_ID),
    usdcDecimals: Number(optional("HTS_USDC_DECIMALS", "6")),
    merchantId: optional("MERCHANT_ID", "shop_001"),
    merchantAccountId,
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
