/**
 * The customer's device key — an Ed25519 keypair generated on first launch.
 *
 * The private key lives in the platform secure store (iOS Keychain / Android
 * Keystore-backed storage), is marked this-device-only, and is never sent
 * anywhere, logged, or exposed to any other component. Only signatures leave the
 * device.
 *
 * WEB (dev preview only): browsers have no secure store, so the key falls back to
 * localStorage. That is NOT secure and exists only so the UI can be previewed.
 */

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  base64urlDecode,
  base64urlEncode,
  customerReferenceFor,
  type AuthorizePaymentRequest,
} from "@inklink/shared-schemas";
import { buildSignedAuthorization, type AuthorizationFields } from "./authorization";
import { publicKeyFor } from "./ed25519";

const STORAGE_KEY = "inklink.device.ed25519";

async function readStored(): Promise<string | null> {
  if (Platform.OS === "web") {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  }
  return SecureStore.getItemAsync(STORAGE_KEY);
}

async function writeStored(value: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(STORAGE_KEY, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

let cached: Uint8Array | null = null;

async function secretKey(): Promise<Uint8Array> {
  if (cached) return cached;
  const stored = await readStored();
  if (stored) {
    cached = base64urlDecode(stored);
    return cached;
  }
  const fresh = Crypto.getRandomBytes(32);
  await writeStored(base64urlEncode(fresh));
  cached = fresh;
  return fresh;
}

export interface DeviceIdentity {
  /** Base64URL raw Ed25519 public key. Safe to share. */
  devicePublicKey: string;
  /** Anonymous per-install id derived from the public key. Contains no PII. */
  customerReference: string;
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const devicePublicKey = publicKeyFor(await secretKey());
  return { devicePublicKey, customerReference: customerReferenceFor(devicePublicKey) };
}

/** Sign a spending policy the customer has just explicitly approved. */
export async function signPaymentAuthorization(
  fields: AuthorizationFields,
): Promise<AuthorizePaymentRequest> {
  return buildSignedAuthorization(await secretKey(), fields, Crypto.getRandomBytes(16));
}

/** Fresh random challenge for the pairing handshake (Base64URL, 32 bytes). */
export function newPairingChallenge(): string {
  return base64urlEncode(Crypto.getRandomBytes(32));
}
