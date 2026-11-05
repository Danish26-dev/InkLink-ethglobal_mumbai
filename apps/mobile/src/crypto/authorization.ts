/**
 * Builds the device-signed payment authorization (Contract 5).
 *
 * Pure: the caller supplies the secret key and the random nonce bytes, so the
 * exact same bytes can be reproduced and verified by the payment agent's Node
 * implementation. The private key never leaves the device.
 */

import {
  authorizationSigningPayload,
  base64urlEncode,
  canonicalJson,
  customerReferenceFor,
  type AuthorizePaymentRequest,
} from "@inklink/shared-schemas";
import { publicKeyFor, signMessage } from "./ed25519";

export type AuthorizationFields = Omit<
  AuthorizePaymentRequest,
  "customerReference" | "devicePublicKey" | "nonce" | "signature"
>;

export function buildSignedAuthorization(
  secretKey: Uint8Array,
  fields: AuthorizationFields,
  nonceBytes: Uint8Array,
): AuthorizePaymentRequest {
  const devicePublicKey = publicKeyFor(secretKey);
  const unsigned = {
    ...fields,
    customerReference: customerReferenceFor(devicePublicKey),
    devicePublicKey,
    nonce: base64urlEncode(nonceBytes),
  };
  const signature = signMessage(
    canonicalJson(authorizationSigningPayload(unsigned)),
    secretKey,
  );
  return { ...unsigned, signature };
}
