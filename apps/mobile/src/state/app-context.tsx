/**
 * App-wide context: the API client, connection manager, pairing, and the in-flight
 * job session (shop → document → config → quote → payment). SQLite is the durable
 * store; this is the working session.
 */

import React, { createContext, useContext, useMemo, useRef, useState } from "react";
import type {
  CreateJobResponse,
  PairedShop,
  PrintConfig,
  Quote,
  ShopQrPayload,
} from "@inklink/shared-schemas";
import { InklinkApi } from "@/api/client";
import { ConnectionManager } from "@/connection/connection-state";
import { newPairingChallenge } from "@/crypto/device-key";
import { publicKeyFingerprint } from "@/crypto/ed25519";
import { db } from "@/db/database";
import {
  PairingError,
  type PinnedShopKey,
  pickReachableOrigin,
  runHandshake,
} from "@/discovery/pairing";
import { gatewayCandidates, validateScannedQr } from "@/discovery/qr";

export interface DocumentSelection {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  format: "pdf" | "docx";
}

export interface JobSession {
  shop?: PairedShop;
  document?: DocumentSelection;
  documentId?: string;
  printConfig: PrintConfig;
  job?: CreateJobResponse;
  quote?: Quote;
  authorizationId?: string;
  paymentId?: string;
}

const defaultPrintConfig: PrintConfig = {
  copies: 1,
  pageRange: "all",
  colourMode: "grayscale",
  paperSize: "A4",
};

interface AppContextValue {
  api: InklinkApi;
  connection: ConnectionManager;
  session: JobSession;
  updateSession: (patch: Partial<JobSession>) => void;
  resetSession: () => void;
  /** Validate a scanned QR, find the gateway, prove it holds the shop key, open a session. */
  pair: (qrText: string) => Promise<PairedShop>;
  /** Reconnect to a previously paired shop using its pinned key (no QR needed). */
  reconnect: (shopId: string) => Promise<PairedShop>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const apiRef = useRef<InklinkApi | null>(null);
  const connectionRef = useRef(new ConnectionManager());
  /** The verified shop key + address, kept so an expired session can be renewed. */
  const pairingRef = useRef<{ qr: PinnedShopKey; origin: string } | null>(null);

  if (!apiRef.current) {
    const api = new InklinkApi();
    api.reauthenticate = async () => {
      const p = pairingRef.current;
      if (!p) return false;
      try {
        const s = await runHandshake(p.origin, p.qr, newPairingChallenge());
        api.setSession({ token: s.sessionToken, expiresAt: s.sessionExpiresAt });
        return true;
      } catch {
        return false;
      }
    };
    apiRef.current = api;
  }
  const api = apiRef.current;

  const [session, setSession] = useState<JobSession>({ printConfig: defaultPrintConfig });

  const value = useMemo<AppContextValue>(
    () => ({
      api,
      connection: connectionRef.current,
      session,
      updateSession: (patch) => setSession((s) => ({ ...s, ...patch })),
      resetSession: () => setSession((s) => ({ shop: s.shop, printConfig: defaultPrintConfig })),

      pair: async (qrText) => {
        const qr = validateScannedQr(qrText);

        const origin = await pickReachableOrigin(gatewayCandidates(qr));
        if (!origin) {
          throw new PairingError(
            "GATEWAY_UNREACHABLE",
            "Could not reach the shop gateway. Is your phone on the shop's Wi-Fi?",
          );
        }

        const handshake = await runHandshake(origin, qr, newPairingChallenge());

        api.configure(origin);
        api.setSession({ token: handshake.sessionToken, expiresAt: handshake.sessionExpiresAt });
        pairingRef.current = { qr, origin };

        const paired: PairedShop = {
          shopId: qr.shopId,
          gatewayId: qr.gatewayId,
          publicKey: qr.publicKey,
          publicKeyFingerprint: publicKeyFingerprint(qr.publicKey),
          gateway: qr.gateway,
          pairedAt: new Date().toISOString(),
        };
        await db.upsertShop({
          shopId: paired.shopId,
          gatewayId: paired.gatewayId,
          name: paired.shopId,
          publicKey: paired.publicKey,
          publicKeyFingerprint: paired.publicKeyFingerprint,
          gatewayMdns: qr.gateway.mdns,
          gatewayIp: qr.gateway.ip ?? null,
          gatewayPort: qr.gateway.port,
          pairedAt: paired.pairedAt,
        });

        connectionRef.current.setShopIdentified(true);
        setSession((s) => ({ ...s, shop: paired }));
        return paired;
      },

      reconnect: async (shopId) => {
        const row = (await db.listShops()).find((s) => s.shopId === shopId);
        if (!row) throw new PairingError("PAIRING_FAILED", "This shop is not paired on this phone. Scan its QR code.");
        const pinned: PinnedShopKey = { publicKey: row.publicKey, gatewayId: row.gatewayId };

        const origin = await pickReachableOrigin(
          gatewayCandidates({ gateway: { ip: row.gatewayIp, mdns: row.gatewayMdns, port: row.gatewayPort } }),
        );
        if (!origin) {
          throw new PairingError(
            "GATEWAY_UNREACHABLE",
            "Could not reach the shop gateway. Is your phone on the shop's Wi-Fi?",
          );
        }
        let handshake;
        try {
          handshake = await runHandshake(origin, pinned, newPairingChallenge());
        } catch (e) {
          if (e instanceof PairingError && e.code === "SIGNATURE_INVALID") {
            throw new PairingError(
              "SIGNATURE_INVALID",
              "This gateway no longer matches the key you paired with. If the shop changed its device, scan its QR code again; otherwise do not use it.",
            );
          }
          throw e;
        }

        api.configure(origin);
        api.setSession({ token: handshake.sessionToken, expiresAt: handshake.sessionExpiresAt });
        pairingRef.current = { qr: pinned, origin };

        const paired: PairedShop = {
          shopId: row.shopId,
          gatewayId: row.gatewayId,
          publicKey: row.publicKey,
          publicKeyFingerprint: row.publicKeyFingerprint,
          gateway: { discovery: "local", mdns: row.gatewayMdns, port: row.gatewayPort, ...(row.gatewayIp ? { ip: row.gatewayIp } : {}) },
          pairedAt: row.pairedAt,
        };
        connectionRef.current.setShopIdentified(true);
        setSession((s) => ({ ...s, shop: paired }));
        return paired;
      },
    }),
    [api, session],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
