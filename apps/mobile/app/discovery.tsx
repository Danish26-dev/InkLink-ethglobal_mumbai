// Screen 2 — Shop Discovery (QR or BLE)
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card, MockBanner } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { db, type PairedShopRow } from "@/db/database";

export default function Discovery() {
  const router = useRouter();
  const { reconnect } = useApp();
  const [shops, setShops] = useState<PairedShopRow[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    db.listShops().then(setShops).catch(() => setShops([]));
  }, []);

  async function reconnectTo(shopId: string) {
    setConnecting(shopId);
    setError(null);
    try {
      await reconnect(shopId);
      router.replace("/connection");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(null);
    }
  }

  return (
    <Screen>
      <Heading>Connect to a shop</Heading>
      <Body muted>
        You are visiting the shop in person. Connect to its local gateway — no central
        marketplace required.
      </Body>
      <View style={{ height: spacing.lg }} />

      {shops.length > 0 ? (
        <Card>
          <Heading>Paired shops</Heading>
          <Body muted>Reconnect without scanning. The shop must still prove it holds the key you paired with.</Body>
          {shops.map((s) => (
            <View key={s.shopId} style={{ marginTop: spacing.sm }}>
              <Body>{s.name}</Body>
              <Body muted>Key {s.publicKeyFingerprint}</Body>
              <Button
                label="Reconnect"
                variant="secondary"
                onPress={() => reconnectTo(s.shopId)}
                loading={connecting === s.shopId}
                disabled={connecting !== null && connecting !== s.shopId}
              />
            </View>
          ))}
          {error ? <Text style={[type.caption, { color: colors.danger, marginTop: spacing.sm }]}>{error}</Text> : null}
        </Card>
      ) : null}

      <Card>
        <Heading>Scan QR</Heading>
        <Body muted>Scan the shop's Inklink QR code. The app verifies the shop's signature before connecting.</Body>
        <Button label="Open scanner" onPress={() => router.push("/scan")} />
      </Card>

      <Card>
        <Heading>Bluetooth</Heading>
        <Body muted>
          Discover nearby Inklink gateways over BLE and pair. Document transfer then happens
          over local Wi-Fi.
        </Body>
        <MockBanner text="BLE scan is scaffolded; pairing handshake pending gateway BLE service. Use QR for the demo." />
        <Button label="Scan Bluetooth" variant="secondary" onPress={() => router.push("/scan?mode=ble")} />
      </Card>
    </Screen>
  );
}
