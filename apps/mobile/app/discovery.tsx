// Screen 2 — Shop Discovery (QR or BLE)
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card, MockBanner } from "@/components/ui";
import { spacing } from "@/theme";

export default function Discovery() {
  const router = useRouter();
  return (
    <Screen>
      <Heading>Connect to a shop</Heading>
      <Body muted>
        You are visiting the shop in person. Connect to its local gateway — no central
        marketplace required.
      </Body>
      <View style={{ height: spacing.lg }} />

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
