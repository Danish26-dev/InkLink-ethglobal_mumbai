/**
 * One-off: create the HCS topic used as the agent's tamper-evident spend audit log.
 *
 *   npm run setup:audit-topic
 *
 * The topic's submit key is the agent key (only the agent can append) and it has no admin
 * key (it can never be updated or deleted). Costs a small amount of testnet HBAR from the
 * agent account. Put the printed id in HCS_AUDIT_TOPIC_ID.
 */

import { hashscanTopicUrl } from "../hcs-audit.js";
import { SigningService } from "../signing/signing-service.js";

async function main() {
  if (process.env.HCS_AUDIT_TOPIC_ID) {
    console.log(`HCS_AUDIT_TOPIC_ID is already set (${process.env.HCS_AUDIT_TOPIC_ID}). Not creating another topic.`);
    return;
  }
  const signing = new SigningService();
  try {
    const topicId = await signing.createAuditTopic("Inklink payment agent spend audit log (v1)");
    console.log(`Created audit topic ${topicId}`);
    console.log(`HashScan: ${hashscanTopicUrl(topicId)}`);
    console.log(`Add to services/payment-agent/.env:  HCS_AUDIT_TOPIC_ID=${topicId}`);
  } finally {
    signing.close();
  }
}

main().catch((err) => {
  console.error("setup:audit-topic failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
