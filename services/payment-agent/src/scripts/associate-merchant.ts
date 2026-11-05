/**
 * One-off: associate testnet USDC to the MERCHANT (shop receiving) account.
 *
 * Only needed for a stand-in merchant you control. The real merchant account is created and
 * associated by the team lead. An association must be signed by the account's own key, so the
 * key is read from the one-time env var MERCHANT_PRIVATE_KEY. It is never read from .env,
 * never written anywhere and never logged.
 *
 *   $env:MERCHANT_PRIVATE_KEY = "<key>"      # PowerShell, this terminal only
 *   npm run setup:merchant                   # DER-encoded key (starts with 302...) or --ed25519 / --ecdsa for raw hex
 *   Remove-Item Env:MERCHANT_PRIVATE_KEY
 */

import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@x402/hedera";
import { loadHederaConfig } from "../config.js";

function parseKey(raw: string): PrivateKey {
  const key = raw.trim().replace(/^0x/i, "");
  if (process.argv.includes("--ed25519")) return PrivateKey.fromStringED25519(key);
  if (process.argv.includes("--ecdsa")) return PrivateKey.fromStringECDSA(key);
  return PrivateKey.fromStringDer(key);
}

async function main() {
  const raw = process.env.MERCHANT_PRIVATE_KEY;
  if (!raw) {
    throw new Error("Set MERCHANT_PRIVATE_KEY for this one command (see the header of this file)");
  }
  const cfg = loadHederaConfig();
  const merchant = AccountId.fromString(cfg.merchantAccountId);

  const client = Client.forTestnet().setOperator(merchant, parseKey(raw));
  try {
    console.log(`Associating USDC ${cfg.usdcTokenId} to merchant ${cfg.merchantAccountId}…`);
    const resp = await new TokenAssociateTransaction()
      .setAccountId(merchant)
      .setTokenIds([TokenId.fromString(cfg.usdcTokenId)])
      .execute(client);
    const receipt = await resp.getReceipt(client);
    console.log(`  ✓ associated (status ${receipt.status.toString()})`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("setup-merchant failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
