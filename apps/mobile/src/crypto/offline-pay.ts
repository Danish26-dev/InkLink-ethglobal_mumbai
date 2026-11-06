/**
 * OfflinePay on the device: build and sign an offline payment voucher.
 *
 * Pure: the caller supplies the secret key, the 16 random voucher-id bytes and the clock,
 * so the exact bytes can be reproduced and verified by any implementation. The private key
 * never leaves the device.
 *
 * `issueOfflineVoucher` also records the voucher in the device's own ledger first, so the
 * phone refuses to sign beyond its offline limit even across several shops. A voucher is an
 * authorization, not a payment: it is only SETTLED after a verified Hedera settlement.
 */

import {
  OFFLINE_PAY_TYPE,
  OFFLINE_PAY_VERSION,
  base64urlEncode,
  customerReferenceFor,
  offlineVoucherSigningText,
  type DecimalString,
  type OfflineLedger,
  type OfflinePaymentVoucher,
} from "@inklink/shared-schemas";
import { publicKeyFor, signMessage } from "./ed25519";

export interface OfflineVoucherFields {
  jobId: string;
  quoteId: string;
  merchantId: string;
  /** The backend-quoted USDC settlement amount, as shown to the customer. */
  amount: DecimalString;
  /** How long a shop may accept it. Default 30 minutes. */
  validForMs?: number;
}

const DEFAULT_VALIDITY_MS = 30 * 60 * 1000;

export function buildOfflineVoucher(
  secretKey: Uint8Array,
  fields: OfflineVoucherFields,
  voucherIdBytes: Uint8Array,
  now: Date = new Date(),
): OfflinePaymentVoucher {
  if (voucherIdBytes.length !== 16) throw new Error("voucherIdBytes must be 16 random bytes");
  const devicePublicKey = publicKeyFor(secretKey);
  const unsigned: Omit<OfflinePaymentVoucher, "signature"> = {
    type: OFFLINE_PAY_TYPE,
    version: OFFLINE_PAY_VERSION,
    voucherId: base64urlEncode(voucherIdBytes),
    jobId: fields.jobId,
    quoteId: fields.quoteId,
    merchantId: fields.merchantId,
    amount: fields.amount,
    asset: "USDC",
    devicePublicKey,
    customerReference: customerReferenceFor(devicePublicKey),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (fields.validForMs ?? DEFAULT_VALIDITY_MS)).toISOString(),
  };
  return { ...unsigned, signature: signMessage(offlineVoucherSigningText(unsigned), secretKey) };
}

/**
 * Sign a voucher only if the device's own ledger accepts it (limits, duplicate job).
 * Throws OfflinePayError and hands nothing out when a limit would be exceeded.
 */
export function issueOfflineVoucher(
  deviceLedger: OfflineLedger,
  secretKey: Uint8Array,
  fields: OfflineVoucherFields,
  voucherIdBytes: Uint8Array,
  now: Date = new Date(),
): OfflinePaymentVoucher {
  const voucher = buildOfflineVoucher(secretKey, fields, voucherIdBytes, now);
  deviceLedger.accept(voucher);
  return voucher;
}
