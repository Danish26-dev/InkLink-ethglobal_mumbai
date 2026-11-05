/**
 * Wallet readiness check (and optional USDC association) for the agent account
 * and the merchant account on Hedera testnet.
 *
 *   npm run setup:wallet                # read-only report
 *   npm run setup:wallet -- --associate # also associate testnet USDC to the agent
 *
 * Reads balances from the mirror node REST API (no SDK quirks). The only SDK call
 * is the optional TokenAssociateTransaction, via the SDK that @x402/hedera
 * re-exports (a single SDK instance avoids the duplicate-install instanceof bug).
 */

import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@x402/hedera";
import { loadHederaConfig } from "../config.js";
import { fromSmallestUnit } from "../money.js";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

interface MirrorAccount {
  balance: { balance: number; tokens: { token_id: string; balance: number }[] };
}

async function fetchAccount(accountId: string): Promise<MirrorAccount | null> {
  const res = await fetch(`${MIRROR}/accounts/${accountId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node returned HTTP ${res.status} for ${accountId}`);
  return (await res.json()) as MirrorAccount;
}

function report(label: string, accountId: string, acct: MirrorAccount | null, cfg: ReturnType<typeof loadHederaConfig>) {
  console.log(`\n${label}  ${accountId}`);
  if (!acct) {
    console.log("  ✗ account not found on testnet");
    return { exists: false, associated: false, usdc: 0n };
  }
  const hbar = Number(acct.balance.balance) / 1e8;
  const tok = acct.balance.tokens.find((t) => t.token_id === cfg.usdcTokenId);
  const usdc = tok ? BigInt(tok.balance) : 0n;
  console.log(`  HBAR: ${hbar}`);
  console.log(
    tok
      ? `  ✓ USDC ${cfg.usdcTokenId} associated, balance ${fromSmallestUnit(usdc, cfg.usdcDecimals)}`
      : `  ✗ USDC ${cfg.usdcTokenId} NOT associated`,
  );
  return { exists: true, associated: Boolean(tok), usdc };
}

async function main() {
  const cfg = loadHederaConfig();
  const wantAssociate = process.argv.includes("--associate");

  const agent = report("AGENT   ", cfg.agentAccountId, await fetchAccount(cfg.agentAccountId), cfg);
  const merchant = report("MERCHANT", cfg.merchantAccountId, await fetchAccount(cfg.merchantAccountId), cfg);

  if (wantAssociate && agent.exists && !agent.associated) {
    console.log("\nAssociating USDC to the agent account…");
    const client = Client.forTestnet().setOperator(
      AccountId.fromString(cfg.agentAccountId),
      PrivateKey.fromStringECDSA(cfg.agentPrivateKey.trim().replace(/^0x/i, "")),
    );
    try {
      const resp = await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(cfg.agentAccountId))
        .setTokenIds([TokenId.fromString(cfg.usdcTokenId)])
        .execute(client);
      const receipt = await resp.getReceipt(client);
      console.log(`  ✓ associated (status ${receipt.status.toString()})`);
      agent.associated = true;
    } finally {
      client.close();
    }
  }

  console.log("\n── Next steps ──");
  const todo: string[] = [];
  if (!agent.exists) todo.push("Create the agent account at https://portal.hedera.com/ (ECDSA key) and set HEDERA_AGENT_* in .env");
  if (agent.exists && !agent.associated) todo.push("Associate USDC to the agent: npm run setup:wallet -- --associate");
  if (agent.associated && agent.usdc === 0n) todo.push("Mint test USDC to the agent at https://faucet.circle.com/ (choose Hedera Testnet)");
  if (!merchant.exists) todo.push("Set MERCHANT_ACCOUNT_ID to a real testnet account (the shop's receiving account)");
  if (merchant.exists && !merchant.associated) todo.push("The MERCHANT account must also associate USDC, or settlement fails with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
  if (todo.length === 0) {
    console.log("✅ Ready. Run: npm run demo:pay");
  } else {
    todo.forEach((t, i) => console.log(`${i + 1}. ${t}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("setup-wallet failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
