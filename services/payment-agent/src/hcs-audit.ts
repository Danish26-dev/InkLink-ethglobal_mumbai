/**
 * HCS spend audit log: after every mirror-node-verified settlement, the agent appends one
 * message to a Hedera Consensus Service topic that only the agent key can write to.
 *
 * Why it is tamper-evident: HCS gives every message a consensus timestamp and a running
 * hash that chains it to all earlier messages, and the topic's submit key is the agent key.
 * Nobody (including us) can edit, reorder or delete entries after the fact, and anyone can
 * read them from the mirror node or HashScan.
 *
 * Privacy: no customer identifiers, device keys, document data or job contents. The job
 * and authorization appear only as SHA-256 commitments, which the backend (which knows the
 * ids) can check but the public cannot reverse.
 *
 * The audit log never affects a payment: publishing runs after settlement, in the
 * background, and a failure is only recorded and retried.
 */

import crypto from "node:crypto";
import { canonicalJson, type PaymentSettledEvent } from "@inklink/shared-schemas";

export const SPEND_AUDIT_TYPE = "inklink.agent_spend";
/** HCS accepts up to 1024 bytes in a single (unchunked) message. */
export const HCS_MAX_MESSAGE_BYTES = 1024;

export interface SpendAuditMessage {
  v: 1;
  type: typeof SPEND_AUDIT_TYPE;
  agentId: string;
  /** The agent wallet that paid. */
  payer: string;
  merchantId: string;
  merchantAccountId: string;
  /** sha256("inklink:job:" + jobId), hex. */
  jobCommitment: string;
  /** sha256("inklink:authorization:" + authorizationId), hex. Groups spends under one budget. */
  authorizationCommitment: string;
  paymentId: string;
  amount: string;
  asset: "USDC";
  network: "hedera:testnet";
  /** The real, mirror-node-verified Hedera transaction. */
  transactionId: string;
  settledAt: string;
  /** Budget state AFTER this payment, so the log shows the agent stayed within limits. */
  budget: {
    maxPerTransaction: string;
    totalSpendingLimit: string;
    spentToDate: string;
  };
}

export interface AuditBudget {
  maxPerTransaction: string;
  totalSpendingLimit: string;
  spentToDate: string;
}

export interface AuditReceipt {
  topicId: string;
  sequenceNumber: string;
  /** The HCS submit transaction (not the payment). */
  transactionId: string;
}

/** Signs and submits one message. Implemented by the signing service (holds the key). */
export type TopicSubmitter = (topicId: string, message: string) => Promise<AuditReceipt>;

export interface AuditPublisher {
  readonly topicId: string;
  publish(message: SpendAuditMessage): Promise<AuditReceipt>;
}

function commitment(kind: string, id: string): string {
  return crypto.createHash("sha256").update(`inklink:${kind}:${id}`).digest("hex");
}

export function jobCommitment(jobId: string): string {
  return commitment("job", jobId);
}

export function authorizationCommitment(authorizationId: string): string {
  return commitment("authorization", authorizationId);
}

export function buildSpendAuditMessage(
  event: PaymentSettledEvent,
  ctx: { agentId: string; merchantId: string; authorizationId: string; budget: AuditBudget },
): SpendAuditMessage {
  return {
    v: 1,
    type: SPEND_AUDIT_TYPE,
    agentId: ctx.agentId,
    payer: event.payerAccount,
    merchantId: ctx.merchantId,
    merchantAccountId: event.merchantAccountId,
    jobCommitment: jobCommitment(event.jobId),
    authorizationCommitment: authorizationCommitment(ctx.authorizationId),
    paymentId: event.paymentId,
    amount: event.amount,
    asset: "USDC",
    network: event.network,
    transactionId: event.transactionId,
    settledAt: event.settlementTimestamp,
    budget: { ...ctx.budget },
  };
}

/** Canonical bytes, so the same entry always serializes identically. Throws if too big. */
export function serializeAuditMessage(message: SpendAuditMessage): string {
  const text = canonicalJson(message);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > HCS_MAX_MESSAGE_BYTES) {
    throw new Error(`Audit message is ${bytes} bytes; HCS single messages are limited to ${HCS_MAX_MESSAGE_BYTES}`);
  }
  return text;
}

export class HcsAuditPublisher implements AuditPublisher {
  constructor(
    readonly topicId: string,
    private readonly submit: TopicSubmitter,
  ) {
    if (!/^\d+\.\d+\.\d+$/.test(topicId)) throw new Error(`Invalid HCS topic id "${topicId}"`);
  }

  publish(message: SpendAuditMessage): Promise<AuditReceipt> {
    return this.submit(this.topicId, serializeAuditMessage(message));
  }
}

export function hashscanTopicUrl(topicId: string): string {
  return `https://hashscan.io/testnet/topic/${topicId}`;
}
