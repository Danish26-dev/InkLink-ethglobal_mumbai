/**
 * DEV/TEST ONLY: a stand-in for the customer's phone. Generates an Ed25519 device
 * key and produces correctly signed payment authorizations, exactly the way the
 * mobile app does. Real keys live in the app's secure storage and never exist on
 * the server.
 */

import crypto from "node:crypto";
import {
  authorizationSigningPayload,
  base64urlEncode,
  canonicalJson,
  customerReferenceFor,
  utf8,
  type AuthorizePaymentRequest,
} from "@inklink/shared-schemas";

export interface DevDevice {
  devicePublicKey: string;
  customerReference: string;
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
