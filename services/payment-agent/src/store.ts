/**
 * Payment agent state: authorizations, replay-protection nonces and payments.
 *
 * Held in memory and, once `enablePersistence(file)` is called (the server does this
 * at startup), written to a JSON file after every change so a restart does not
 * forget spent limits, used nonces, idempotency keys or in-flight payments.
 *
 *  - Writes are atomic (temp file + rename), so a crash cannot leave a half-written file.
 *  - A missing file is created. A CORRUPT file is never silently replaced: starting
 *    empty would reset every spending limit, so the agent refuses to start instead.
 *  - Persistence errors are thrown, not swallowed. A reservation that cannot be made
 *    durable must stop the payment from starting.
 *
 * The file holds no keys or secrets, but it is payment data: keep it out of git and
 * out of synced folders (see AGENT_STATE_FILE).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  PaymentPolicy,
  PaymentSettledEvent,
  PaymentStatus,
} from "@inklink/shared-schemas";

export interface PaymentRecord {
  paymentId: string;
  jobId: string;
  quoteId: string;
  authorizationId: string;
  merchantId: string;
  /** Hedera account the funds go to. Needed to resume verification after a restart. */
  payTo?: string;
  amount: string;
  asset: string;
  status: PaymentStatus;
  paymentReference: string;
  transactionId: string | null;
  settlementTimestamp: string | null;
  /** Why a payment failed, for debugging. Never contains secrets. */
  failureReason?: string;
  /** State of the signed settlement callback to the backend. */
  callbackStatus?: "pending" | "delivered" | "failed";
  callbackAttempts?: number;
  /** The exact callback body, kept so an undelivered callback can be re-sent after a restart. */
  event?: PaymentSettledEvent;
  /** The price the gate itself quoted in its 402, read before signing (when price probing is on). */
  gateQuote?: { amount: string; asset: string; payTo: string; resourceUrl: string; at: string };
  /** Set on failure: true when a transaction may have been submitted (spend kept, do not retry blindly). */
  fundsMayHaveMoved?: boolean;
  /** OfflinePay: the voucher that authorized this payment (instead of an online authorization). */
  offlineVoucherId?: string;
  /** Budget state recorded at creation for payments not backed by an online policy (audit log). */
  budgetSnapshot?: { maxPerTransaction: string; totalSpendingLimit: string; spentToDate: string };
  /** HCS spend audit entry for this settlement (only when an audit topic is configured). */
  auditStatus?: "pending" | "published" | "failed";
  auditTopicId?: string;
  auditSequenceNumber?: string;
  createdAt: string;
}

interface NonceEntry {
  signature: string;
  authorizationId: string;
}

interface Snapshot {
  version: 1;
  authorizations: PaymentPolicy[];
  nonces: Array<[string, NonceEntry]>;
  payments: PaymentRecord[];
  idempotency: Array<[string, string]>;
}

const authorizations = new Map<string, PaymentPolicy>();
/** nonce -> the signature + authorization it created (replay protection). */
const nonceIndex = new Map<string, NonceEntry>();
const payments = new Map<string, PaymentRecord>();
/** idempotency key -> paymentId */
const idempotencyIndex = new Map<string, string>();

let persistFile: string | null = null;

// ───────────────────────── persistence ─────────────────────────

function snapshot(): Snapshot {
  return {
    version: 1,
    authorizations: [...authorizations.values()],
    nonces: [...nonceIndex.entries()],
    payments: [...payments.values()],
    idempotency: [...idempotencyIndex.entries()],
  };
}

/** Synchronous sleep, only used to ride out transient file locks (e.g. cloud-sync folders). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function persist() {
  if (!persistFile) return;
  const tmp = `${persistFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot()), { mode: 0o600 });
  // Renaming over an existing file can fail briefly on Windows when a sync client or
  // antivirus holds it. Retry a few times before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, persistFile);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
        sleepSync(25 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot;
  return (
    typeof s === "object" &&
    s !== null &&
    s.version === 1 &&
    Array.isArray(s.authorizations) &&
    Array.isArray(s.nonces) &&
    Array.isArray(s.payments) &&
    Array.isArray(s.idempotency)
  );
}

/**
 * Start persisting to `file`. Loads existing state if the file exists. Throws if the
 * file is unreadable or corrupt, or the location is not writable.
 */
export function enablePersistence(file: string): { loaded: boolean } {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      parsed = null;
    }
    if (!isSnapshot(parsed)) {
      throw new Error(
        `Agent state file ${file} is unreadable or corrupt. Refusing to start: running with empty ` +
          "state would forget spent limits, used nonces and in-flight payments. Restore a backup, " +
          "or move the file aside deliberately if you accept losing that history.",
      );
    }
    clearMemory();
    for (const p of parsed.authorizations) authorizations.set(p.authorizationId, p);
    for (const [k, v] of parsed.nonces) nonceIndex.set(k, v);
    for (const r of parsed.payments) payments.set(r.paymentId, r);
    for (const [k, v] of parsed.idempotency) idempotencyIndex.set(k, v);
    persistFile = file;
    return { loaded: true };
  }

  persistFile = file;
  persist(); // create it now so an unwritable location fails at startup, not mid-payment
  return { loaded: false };
}

/** Stop writing to disk (tests). */
export function disablePersistence() {
  persistFile = null;
}

/** Forget everything held in memory without touching the file (tests / reload). */
export function clearMemory() {
  authorizations.clear();
  nonceIndex.clear();
  payments.clear();
  idempotencyIndex.clear();
}

// ───────────────────────── stores ─────────────────────────

export const nonceStore = {
  get(nonce: string) {
    return nonceIndex.get(nonce);
  },
  put(nonce: string, signature: string, authorizationId: string) {
    nonceIndex.set(nonce, { signature, authorizationId });
    persist();
  },
};

export const authStore = {
  put(policy: PaymentPolicy) {
    authorizations.set(policy.authorizationId, policy);
    persist();
  },
  get(id: string): PaymentPolicy | undefined {
    return authorizations.get(id);
  },
  update(id: string, patch: Partial<PaymentPolicy>) {
    const existing = authorizations.get(id);
    if (!existing) return;
    authorizations.set(id, { ...existing, ...patch });
    persist();
  },
};

export function idempotencyKey(
  jobId: string,
  quoteId: string,
  authorizationId: string,
): string {
  return `${jobId}:${quoteId}:${authorizationId}`;
}

export const paymentStore = {
  get(paymentId: string): PaymentRecord | undefined {
    return payments.get(paymentId);
  },
  list(): PaymentRecord[] {
    return [...payments.values()];
  },
  findByIdempotency(key: string): PaymentRecord | undefined {
    const id = idempotencyIndex.get(key);
    return id ? payments.get(id) : undefined;
  },
  put(record: PaymentRecord, idemKey: string) {
    payments.set(record.paymentId, record);
    idempotencyIndex.set(idemKey, record.paymentId);
    persist();
  },
  update(paymentId: string, patch: Partial<PaymentRecord>) {
    const existing = payments.get(paymentId);
    if (!existing) return;
    payments.set(paymentId, { ...existing, ...patch });
    persist();
  },
};
