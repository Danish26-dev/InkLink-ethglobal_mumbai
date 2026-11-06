/**
 * DEV/TEST ONLY: a stand-in for the customer's phone. Generates an Ed25519 device
 * key and produces correctly signed payment authorizations, exactly the way the
 * mobile app does. Real keys live in the app's secure storage and never exist on
 * the server.
 */

import crypto from "node:crypto";
import {
  OFFLINE_PAY_TYPE,
  OFFLINE_PAY_VERSION,
  authorizationSigningPayload,
  base64urlEncode,
  canonicalJson,
  customerReferenceFor,
  offlineVoucherSigningText,
  utf8,
  type AuthorizePaymentRequest,
  type OfflinePaymentVoucher,
} from "@inklink/shared-schemas";

export interface DevDevice {
  devicePublicKey: string;
  customerReference: string;
  /** Sign an OfflinePay voucher exactly like the app does. */
  signOfflineVoucher(fields: {
    jobId: string;
    quoteId: string;
    merchantId: string;
    amount: string;
    issuedAt?: Date;
    validForMs?: number;
    voucherId?: string;
  }): OfflinePaymentVoucher;
  signAuthorization(
    fields: Omit<
      AuthorizePaymentRequest,
      "customerReference" | "devicePublicKey" | "nonce" | "signature"
    > & { nonce?: string },
  ): AuthorizePaymentRequest;
}

export function createDevDevice(): DevDevice {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const devicePublicKey = publicKey.export({ format: "jwk" }).x as string;
  const customerReference = customerReferenceFor(devicePublicKey);

  return {
    devicePublicKey,
    customerReference,
    signOfflineVoucher(f) {
      const issued = f.issuedAt ?? new Date();
      const unsigned: Omit<OfflinePaymentVoucher, "signature"> = {
        type: OFFLINE_PAY_TYPE,
        version: OFFLINE_PAY_VERSION,
        voucherId: f.voucherId ?? base64urlEncode(crypto.randomBytes(16)),
        jobId: f.jobId,
        quoteId: f.quoteId,
        merchantId: f.merchantId,
        amount: f.amount,
        asset: "USDC",
        devicePublicKey,
        customerReference,
        issuedAt: issued.toISOString(),
        expiresAt: new Date(issued.getTime() + (f.validForMs ?? 30 * 60_000)).toISOString(),
      };
      const signature = base64urlEncode(
        crypto.sign(null, Buffer.from(utf8(offlineVoucherSigningText(unsigned))), privateKey),
      );
      return { ...unsigned, signature };
    },
    signAuthorization(fields) {
      const unsigned = {
        ...fields,
        nonce: fields.nonce ?? base64urlEncode(crypto.randomBytes(16)),
        customerReference,
        devicePublicKey,
      };
      const message = utf8(canonicalJson(authorizationSigningPayload(unsigned)));
      const signature = base64urlEncode(crypto.sign(null, Buffer.from(message), privateKey));
      return { ...unsigned, signature };
    },
  };
}
