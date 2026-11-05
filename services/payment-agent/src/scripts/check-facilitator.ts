/**
 * Pre-flight: confirm the facilitator supports our required configuration.
 * Run: npm run check:facilitator
 */

import { fetchSupported, verifySupported } from "../facilitator.js";

async function main() {
  const supported = await fetchSupported();
  const check = verifySupported(supported);

  console.log("Facilitator /supported kinds:");
  for (const k of supported.kinds) {
    console.log(
      `  - network=${k.network} v${k.x402Version} scheme=${k.scheme}` +
        (k.extra?.feePayer ? ` feePayer=${k.extra.feePayer}` : ""),
    );
  }

  if (check.ok) {
    console.log(`\n✅ OK — Hedera testnet exact scheme supported. feePayer=${check.feePayer}`);
    process.exit(0);
  } else {
    console.error("\n❌ Facilitator does NOT support required config:");
    for (const r of check.reasons) console.error(`   - ${r}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check-facilitator failed:", err);
  process.exit(1);
});
