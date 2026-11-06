/**
 * OfflinePay — signed offline payment authorizations ("vouchers").
 *
 * When the shop has no internet, the customer's device signs a voucher promising to pay the
 * backend-quoted USDC amount for one job. The shop verifies it locally and may start work.
 * When internet returns, each voucher is settled through the normal Hedera x402 flow and
 * reconciled against the VERIFIED on-chain settlement.
 *
 *   AUTHORIZED_OFFLINE ─▶ PENDING_SETTLEMENT ─▶ SETTLED
 *                               │      ▲
 *                               ▼      │ (retry)
 *                         SETTLEMENT_FAILED
 *
 * An offline authorization is a promise, not a payment. Nothing here ever reports a voucher
 * as SETTLED without a mirror-node-verified Hedera transaction id.
 *
 * Signed bytes = UTF-8 of canonicalJson(voucher WITHOUT `signature`). Keys, signature and
 * voucherId are Base64URL (unpadded). The type/version fields keep these signatures from
 * being valid as any other Inklink signature (QR, pairing, online authorization).
 *
 * Pure TypeScript with an injected Ed25519 verifier, so the same rules run in the app
 * (noble), in Node (node:crypto) and can be ported to Python byte for byte.
 */

import type { DecimalString, IsoTimestamp } from "./common.js";
import { base64urlDecode, canonicalJson, customerReferenceFor } from "./wire-format.js";

export const OFFLINE_PAY_TYPE = "inklink_offline_payment";
export const OFFLINE_PAY_VERSION = "1.0";
const USDC_DECIMALS = 6;

export interface OfflinePaymentVoucher {
  type: typeof OFFLINE_PAY_TYPE;
  version: typeof OFFLINE_PAY_VERSION;
  /** 16 random bytes, Base64URL. Unique per voucher; doubles as the replay nonce. */
  voucherId: string;
  jobId: string;
  quoteId: string;
  merchantId: string;
  /** The backend-quoted settlement amount in USDC (decimal string, max 6 places). */
  amount: DecimalString;
  asset: "USDC";
  /** Base64URL raw Ed25519 device key that signed this voucher. */
  devicePublicKey: string;
  /** Must equal customerReferenceFor(devicePublicKey). */
  customerReference: string;
  issuedAt: IsoTimestamp;
  /** Latest time a shop may ACCEPT the voucher. Settlement may complete later. */
  expiresAt: IsoTimestamp;
  signature: string;
}

export type OfflinePaymentState =
  | "AUTHORIZED_OFFLINE"
  | "PENDING_SETTLEMENT"
  | "SETTLED"
  | "SETTLEMENT_FAILED";

export interface OfflinePaymentRecord {
  voucher: OfflinePaymentVoucher;
  state: OfflinePaymentState;
  acceptedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  settlementAttempts: number;
  paymentId?: string;
  /** Only set once SETTLED, from a verified settlement. */
  transactionId?: string;
  verifiedAt?: IsoTimestamp;
  failureReason?: string;
}

/** What the online x402 settlement reported for the job a voucher pays for. */
export interface OfflineSettlementOutcome {
  jobId: string;
  paymentId?: string;
  paymentStatus: "SETTLED" | "FAILED";
  amount: DecimalString;
  transactionId: string | null;
  /** True only when the Hedera mirror node confirmed the transfer. */
  transactionVerified: boolean;
  verifiedAt: IsoTimestamp | null;
  failureReason?: string;
}

export interface OfflinePayPolicy {
  /** Largest single voucher accepted. */
  maxPerVoucher: DecimalString;
  /** Largest unsettled total per device (everything not yet SETTLED counts). */
  maxOutstanding: DecimalString;
  /** Longest allowed expiresAt - issuedAt. */
  maxValidityMs: number;
  /** Tolerated device clock drift for issuedAt in the future. */
  clockSkewMs: number;
}

export const DEFAULT_OFFLINE_PAY_POLICY: OfflinePayPolicy = {
  maxPerVoucher: "2.00",
  maxOutstanding: "5.00",
  maxValidityMs: 2 * 60 * 60 * 1000,
  clockSkewMs: 5 * 60 * 1000,
};

export type OfflinePayErrorCode =
  | "INVALID_VOUCHER"
  | "SIGNATURE_INVALID"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "VALIDITY_TOO_LONG"
  | "AMOUNT_INVALID"
  | "OVER_VOUCHER_LIMIT"
  | "OVER_OUTSTANDING_LIMIT"
  | "WRONG_MERCHANT"
  | "REPLAYED"
  | "DUPLICATE_JOB"
  | "UNKNOWN_VOUCHER"
  | "INVALID_TRANSITION"
  | "SETTLEMENT_MISMATCH"
  | "STORAGE_CORRUPT";

export class OfflinePayError extends Error {
  constructor(
    public code: OfflinePayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfflinePayError";
  }
}

/** (message, signatureB64u, publicKeyB64u) -> valid? Must never throw. */
export type Ed25519Verify = (message: string, signature: string, publicKey: string) => boolean;

/** The exact text the device signs. */
export function offlineVoucherSigningText(v: Omit<OfflinePaymentVoucher, "signature">): string {
  const { signature, ...unsigned } = v as OfflinePaymentVoucher;
  void signature;
  return canonicalJson(unsigned);
}

// ───────────────────────── money (decimal strings, no floats) ─────────────────────────

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;

function toMicros(amount: string): bigint {
  if (!AMOUNT.test(amount)) throw new OfflinePayError("AMOUNT_INVALID", `Invalid USDC amount "${amount}"`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

function fromMicros(units: bigint): DecimalString {
  const base = 10n ** BigInt(USDC_DECIMALS);
  return `${units / base}.${(units % base).toString().padStart(USDC_DECIMALS, "0")}`;
}

// ───────────────────────── verification ─────────────────────────

const HEDERA_TX_ID = /^\d+\.\d+\.\d+@\d+\.\d+$/;

function str(v: unknown, max = 128): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function decodedLength(v: unknown): number {
  try {
    return typeof v === "string" ? base64urlDecode(v).length : -1;
  } catch {
    return -1;
  }
}

function assertVoucherShape(raw: unknown): OfflinePaymentVoucher {
  const bad = (m: string) => new OfflinePayError("INVALID_VOUCHER", m);
  if (typeof raw !== "object" || raw === null) throw bad("Voucher must be an object");
  const o = raw as Record<string, unknown>;
  if (o.type !== OFFLINE_PAY_TYPE || o.version !== OFFLINE_PAY_VERSION) throw bad("Not an Inklink offline payment voucher");
  for (const k of ["jobId", "quoteId", "merchantId", "customerReference"] as const) {
    if (!str(o[k])) throw bad(`Missing or invalid ${k}`);
  }
  if (decodedLength(o.voucherId) !== 16) throw bad("voucherId must be 16 random bytes (Base64URL)");
  if (decodedLength(o.devicePublicKey) !== 32) throw bad("devicePublicKey is not an Ed25519 key");
  if (decodedLength(o.signature) !== 64) throw bad("signature is malformed");
  if (o.asset !== "USDC") throw bad("asset must be USDC");
  if (typeof o.amount !== "string") throw bad("amount must be a decimal string");
  for (const k of ["issuedAt", "expiresAt"] as const) {
    if (typeof o[k] !== "string" || Number.isNaN(Date.parse(o[k] as string))) throw bad(`${k} is not a timestamp`);
  }
  const allowed = new Set([
    "type", "version", "voucherId", "jobId", "quoteId", "merchantId", "amount", "asset",
    "devicePublicKey", "customerReference", "issuedAt", "expiresAt", "signature",
  ]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw bad(`Unexpected field ${k}`);
  return o as unknown as OfflinePaymentVoucher;
}

export interface VerifyVoucherOptions {
  verify: Ed25519Verify;
  /** Shop side: the merchant this ledger accepts payments for. Omit on the device. */
  merchantId?: string;
  policy?: OfflinePayPolicy;
  now?: Date;
}

/**
 * Structure -> signature -> customer binding -> amount -> merchant -> time window.
 * Throws OfflinePayError with a precise code; returns the typed voucher when valid.
 */
export function verifyOfflineVoucher(raw: unknown, opts: VerifyVoucherOptions): OfflinePaymentVoucher {
  const policy = opts.policy ?? DEFAULT_OFFLINE_PAY_POLICY;
  const now = (opts.now ?? new Date()).getTime();
  const v = assertVoucherShape(raw);

  if (!opts.verify(offlineVoucherSigningText(v), v.signature, v.devicePublicKey)) {
    throw new OfflinePayError("SIGNATURE_INVALID", "The device signature on this voucher did not verify");
  }
  if (v.customerReference !== customerReferenceFor(v.devicePublicKey)) {
    throw new OfflinePayError("INVALID_VOUCHER", "customerReference does not belong to the signing device");
  }
  const amount = toMicros(v.amount);
  if (amount <= 0n) throw new OfflinePayError("AMOUNT_INVALID", "Amount must be positive");
  if (amount > toMicros(policy.maxPerVoucher)) {
    throw new OfflinePayError("OVER_VOUCHER_LIMIT", `Offline vouchers are limited to ${policy.maxPerVoucher} USDC`);
  }
  if (opts.merchantId !== undefined && v.merchantId !== opts.merchantId) {
    throw new OfflinePayError("WRONG_MERCHANT", "This voucher is for a different shop");
  }

  const issued = Date.parse(v.issuedAt);
  const expires = Date.parse(v.expiresAt);
  if (expires <= issued) throw new OfflinePayError("INVALID_VOUCHER", "expiresAt must be after issuedAt");
  if (expires - issued > policy.maxValidityMs) {
    throw new OfflinePayError("VALIDITY_TOO_LONG", "Voucher is valid for longer than the offline policy allows");
  }
  if (issued > now + policy.clockSkewMs) throw new OfflinePayError("NOT_YET_VALID", "Voucher is issued in the future");
  if (expires <= now) throw new OfflinePayError("EXPIRED", "Voucher has expired");
  return v;
}

// ───────────────────────── persistence ─────────────────────────

export interface OfflineLedgerStorage {
  load(): OfflinePaymentRecord[];
  /** Must persist durably or throw. A failed save leaves the ledger unchanged. */
  save(records: OfflinePaymentRecord[]): void;
}

export class MemoryOfflineLedgerStorage implements OfflineLedgerStorage {
  private data: OfflinePaymentRecord[] = [];
  load() {
    return structuredCloneSafe(this.data);
  }
  save(records: OfflinePaymentRecord[]) {
    this.data = structuredCloneSafe(records);
  }
}

/**
 * Storage over any text backend (a file in Node, expo-file-system in the app). Refuses to
 * load a corrupt document instead of silently starting empty, which would forget used
 * nonces and outstanding debt.
 */
export function jsonTextStorage(io: { read(): string | null; write(text: string): void }): OfflineLedgerStorage {
  return {
    load() {
      const text = io.read();
      if (text === null || text.trim() === "") return [];
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new OfflinePayError("STORAGE_CORRUPT", "OfflinePay ledger file is not valid JSON");
      }
      const records = (doc as { records?: unknown }).records;
      if ((doc as { version?: unknown }).version !== 1 || !Array.isArray(records)) {
        throw new OfflinePayError("STORAGE_CORRUPT", "OfflinePay ledger file has an unknown format");
      }
      return records as OfflinePaymentRecord[];
    },
    save(records) {
      io.write(JSON.stringify({ version: 1, records }, null, 2));
    },
  };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ───────────────────────── ledger ─────────────────────────

export interface OfflineLedgerOptions {
  verify: Ed25519Verify;
  /** Shop side: only accept vouchers for this merchant. Omit on the device. */
  merchantId?: string;
  policy?: OfflinePayPolicy;
  storage?: OfflineLedgerStorage;
  now?: () => Date;
}

/**
 * Tracks vouchers, used nonces and per-device outstanding totals. Every mutation is
 * persisted before it takes effect. Runs on the shop (authoritative for what it accepted)
 * and on the device (so it never signs past its own offline limit, across all shops).
 */
export class OfflineLedger {
  private records = new Map<string, OfflinePaymentRecord>();
  private readonly policy: OfflinePayPolicy;
  private readonly storage: OfflineLedgerStorage;
  private readonly now: () => Date;

  constructor(private readonly opts: OfflineLedgerOptions) {
    this.policy = opts.policy ?? DEFAULT_OFFLINE_PAY_POLICY;
    this.storage = opts.storage ?? new MemoryOfflineLedgerStorage();
    this.now = opts.now ?? (() => new Date());
    for (const r of this.storage.load()) this.records.set(r.voucher.voucherId, r);
  }

  get(voucherId: string): OfflinePaymentRecord | undefined {
    const r = this.records.get(voucherId);
    return r ? structuredCloneSafe(r) : undefined;
  }

  list(state?: OfflinePaymentState): OfflinePaymentRecord[] {
    return [...this.records.values()]
      .filter((r) => !state || r.state === state)
      .map((r) => structuredCloneSafe(r));
  }

  /** The policy this ledger enforces (limits are reported in audit entries). */
  get limits(): OfflinePayPolicy {
    return { ...this.policy };
  }

  /** Unsettled total for a device. Failed settlements still count: the shop is unpaid. */
  outstanding(devicePublicKey: string): DecimalString {
    let sum = 0n;
    for (const r of this.records.values()) {
      if (r.voucher.devicePublicKey === devicePublicKey && r.state !== "SETTLED") sum += toMicros(r.voucher.amount);
    }
    return fromMicros(sum);
  }

  /** Vouchers that still need an online settlement attempt (new or previously failed). */
  pendingForSync(): OfflinePaymentRecord[] {
    return this.list().filter((r) => r.state === "AUTHORIZED_OFFLINE" || r.state === "SETTLEMENT_FAILED");
  }

  /**
   * Verify and record a voucher. Re-submitting the identical voucher is idempotent
   * (`duplicate: true`, nothing counted twice). The same voucherId with different content,
   * or a second voucher for an already-covered job, is refused.
   */
  accept(raw: unknown, opts: { verifyAt?: Date } = {}): { record: OfflinePaymentRecord; duplicate: boolean } {
    const now = this.now();
    // `verifyAt` lets the settling side check the time window as of when the shop accepted
    // the voucher (vouchers are settled after they stop being acceptable offline).
    const v = verifyOfflineVoucher(raw, {
      verify: this.opts.verify,
      merchantId: this.opts.merchantId,
      policy: this.policy,
      now: opts.verifyAt ?? now,
    });

    const existing = this.records.get(v.voucherId);
    if (existing) {
      if (canonicalJson(existing.voucher) === canonicalJson(v)) {
        return { record: structuredCloneSafe(existing), duplicate: true };
      }
      throw new OfflinePayError("REPLAYED", "This voucher id was already used with different content");
    }
    for (const r of this.records.values()) {
      if (r.voucher.jobId === v.jobId && r.voucher.merchantId === v.merchantId) {
        throw new OfflinePayError("DUPLICATE_JOB", "This job already has an offline authorization");
      }
    }
    const after = toMicros(this.outstanding(v.devicePublicKey)) + toMicros(v.amount);
    if (after > toMicros(this.policy.maxOutstanding)) {
      throw new OfflinePayError(
        "OVER_OUTSTANDING_LIMIT",
        `Unsettled offline payments would exceed ${this.policy.maxOutstanding} USDC for this device`,
      );
    }

    const ts = now.toISOString();
    const record: OfflinePaymentRecord = {
      voucher: v,
      state: "AUTHORIZED_OFFLINE",
      acceptedAt: ts,
      updatedAt: ts,
      settlementAttempts: 0,
    };
    this.commit(record);
    return { record: structuredCloneSafe(record), duplicate: false };
  }

  /** Internet is back and an online settlement was started for this voucher. */
  markPendingSettlement(voucherId: string, paymentId?: string): OfflinePaymentRecord {
    const r = this.require(voucherId);
    if (r.state === "PENDING_SETTLEMENT" && (paymentId === undefined || paymentId === r.paymentId)) {
      return structuredCloneSafe(r);
    }
    if (r.state !== "AUTHORIZED_OFFLINE" && r.state !== "SETTLEMENT_FAILED") {
      throw new OfflinePayError("INVALID_TRANSITION", `Cannot start settlement from ${r.state}`);
    }
    const next: OfflinePaymentRecord = {
      ...r,
      state: "PENDING_SETTLEMENT",
      paymentId: paymentId ?? r.paymentId,
      settlementAttempts: r.settlementAttempts + 1,
      failureReason: undefined,
      updatedAt: this.now().toISOString(),
    };
    this.commit(next);
    return structuredCloneSafe(next);
  }

  /**
   * Apply the result of the online x402 settlement. SETTLED requires a mirror-node
   * verified transaction for the same job and exactly the voucher amount; anything else
   * is refused and the voucher stays pending. Re-applying the same settled transaction is
   * idempotent; a different transaction for an already settled voucher is refused.
   */
  reconcile(voucherId: string, outcome: OfflineSettlementOutcome): OfflinePaymentRecord {
    const r = this.require(voucherId);
    const mismatch = (m: string) => new OfflinePayError("SETTLEMENT_MISMATCH", m);

    if (outcome.jobId !== r.voucher.jobId) throw mismatch("Settlement is for a different job");

    if (r.state === "SETTLED") {
      if (outcome.paymentStatus === "SETTLED" && outcome.transactionId === r.transactionId) {
        return structuredCloneSafe(r);
      }
      throw mismatch("Voucher is already settled by a different transaction");
    }
    if (r.state !== "PENDING_SETTLEMENT") {
      throw new OfflinePayError("INVALID_TRANSITION", `Cannot reconcile from ${r.state}; start settlement first`);
    }
    if (outcome.paymentId && r.paymentId && outcome.paymentId !== r.paymentId) {
      throw mismatch("Settlement is for a different payment");
    }

    const ts = this.now().toISOString();
    if (outcome.paymentStatus === "FAILED") {
      const next: OfflinePaymentRecord = {
        ...r,
        state: "SETTLEMENT_FAILED",
        failureReason: (outcome.failureReason ?? "settlement failed").slice(0, 200),
        updatedAt: ts,
      };
      this.commit(next);
      return structuredCloneSafe(next);
    }

    if (outcome.transactionVerified !== true || !outcome.verifiedAt) {
      throw mismatch("Settlement is not verified on the Hedera mirror node");
    }
    if (typeof outcome.transactionId !== "string" || !HEDERA_TX_ID.test(outcome.transactionId)) {
      throw mismatch("Settlement has no valid Hedera transaction id");
    }
    if (toMicros(outcome.amount) !== toMicros(r.voucher.amount)) {
      throw mismatch("Settled amount differs from the authorized amount");
    }
    const next: OfflinePaymentRecord = {
      ...r,
      state: "SETTLED",
      paymentId: outcome.paymentId ?? r.paymentId,
      transactionId: outcome.transactionId,
      verifiedAt: outcome.verifiedAt,
      failureReason: undefined,
      updatedAt: ts,
    };
    this.commit(next);
    return structuredCloneSafe(next);
  }

  private require(voucherId: string): OfflinePaymentRecord {
    const r = this.records.get(voucherId);
    if (!r) throw new OfflinePayError("UNKNOWN_VOUCHER", "No such offline voucher");
    return r;
  }

  /** Persist first; only then update memory, so a failed save changes nothing. */
  private commit(record: OfflinePaymentRecord) {
    const next = new Map(this.records);
    next.set(record.voucher.voucherId, structuredCloneSafe(record));
    this.storage.save([...next.values()]);
    this.records = next;
  }
}
