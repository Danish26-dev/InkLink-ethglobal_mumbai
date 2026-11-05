// Screen 12 — Settings
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { Screen, Heading, Body, Card, Pill } from "@/components/ui";
import { spacing, type } from "@/theme";
import { appConfig } from "@/config";
import { getDeviceIdentity, type DeviceIdentity } from "@/crypto/device-key";
import { publicKeyFingerprint } from "@/crypto/ed25519";
import { db, type PairedShopRow } from "@/db/database";
import { useApp } from "@/state/app-context";

export default function Settings() {
  const { api } = useApp();
  const [shops, setShops] = useState<PairedShopRow[]>([]);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);

  useEffect(() => {
    void db.listShops().then(setShops);
    void getDeviceIdentity().then(setIdentity);
  }, []);

  return (
    <Screen>
      <Heading>Settings</Heading>

      <Card>
        <Text style={type.heading}>This device</Text>
        <Row k="Customer ref" v={identity?.customerReference ?? "…"} />
        <Row k="Device key" v={identity ? publicKeyFingerprint(identity.devicePublicKey) : "…"} />
        <Row k="Agent ID" v={appConfig.agentId} />
        <Row k="Gateway" v={api.isConfigured ? api.origin : "not connected"} />
        <Body muted>
          Your device key signs payment approvals and never leaves this phone. The customer
          reference is derived from it and contains no personal information.
        </Body>
      </Card>

      <Card>
        <Text style={type.heading}>Paired shops</Text>
        {shops.length === 0 ? (
          <Body muted>No shops paired yet.</Body>
        ) : (
          shops.map((s) => (
            <View key={s.shopId} style={{ paddingVertical: spacing.xs }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Body>{s.shopId}</Body>
                <Pill text={s.publicKeyFingerprint} />
              </View>
              <Body muted>{s.gatewayIp ?? s.gatewayMdns}:{s.gatewayPort}</Body>
            </View>
          ))
        )}
      </Card>

      <Card>
        <Text style={type.heading}>Privacy</Text>
        <Body muted>
          Documents are sent to the shop's local gateway, not the cloud, and never put on-chain.
          No third-party trackers are used in this app. Payment keys never live on this device.
        </Body>
      </Card>
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: spacing.xs }}>
      <Body muted>{k}</Body>
      <Text style={[type.caption, { flexShrink: 1, textAlign: "right" }]}>{v}</Text>
    </View>
  );
}
