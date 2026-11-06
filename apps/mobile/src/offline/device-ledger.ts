/**
 * The phone's own OfflinePay ledger, persisted in the platform secure store, so the device
 * never signs past its offline limits even after a restart or across several shops.
 *
 * The secure store has synchronous get/set, which the shared ledger's storage contract
 * needs (every change is saved before it takes effect). The ledger only holds a handful of
 * small records. WEB (dev preview only) falls back to localStorage.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { OfflineLedger, jsonTextStorage } from "@inklink/shared-schemas";
import { verifySignature } from "../crypto/ed25519";

const KEY = "inklink.offlinepay.ledger.v1";

function read(): string | null {
  if (Platform.OS === "web") return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  return SecureStore.getItem(KEY);
}

function write(text: string): void {
  if (Platform.OS === "web") {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, text);
    return;
  }
  SecureStore.setItem(KEY, text, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

let ledger: OfflineLedger | null = null;

/** Loads on first use. Throws OfflinePayError STORAGE_CORRUPT rather than starting empty. */
export function deviceOfflineLedger(): OfflineLedger {
  if (!ledger) ledger = new OfflineLedger({ verify: verifySignature, storage: jsonTextStorage({ read, write }) });
  return ledger;
}
