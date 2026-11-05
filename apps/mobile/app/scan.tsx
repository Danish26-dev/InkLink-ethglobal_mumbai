// Screen 3a — Scan the shop's QR, verify its signature, and pair with the gateway
import { useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { QrValidationError } from "@/discovery/qr";
import { PairingError } from "@/discovery/pairing";

function explain(e: unknown): string {
  if (e instanceof QrValidationError || e instanceof PairingError) return e.message;
  return "Could not connect to the shop. Please try again.";
}

export default function Scan() {
  const router = useRouter();
  const { pair } = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  // A camera fires many scan events per second; only process one at a time.
  const handling = useRef(false);

  async function connect(raw: string) {
    if (handling.current) return;
    handling.current = true;
    setBusy(true);
    setError(null);
    try {
      await pair(raw);
      router.replace("/connection");
    } catch (e) {
      setError(explain(e));
      handling.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Heading>Scan the shop's QR code</Heading>
      <Body muted>
        The app checks the shop's cryptographic signature and makes the gateway prove it holds
        the shop's key before anything is sent to it.
      </Body>

      <View style={styles.cameraWrap}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => void connect(data)}
          />
        ) : (
          <View style={styles.cameraPlaceholder}>
            <Body muted>
              {permission === null
                ? "Checking camera permission…"
                : "Camera access is needed to scan the shop's QR code."}
            </Body>
            {permission && !permission.granted ? (
              <Button label="Allow camera" onPress={() => void requestPermission()} />
            ) : null}
          </View>
        )}
      </View>

      {busy ? <Body muted>Verifying shop and connecting…</Body> : null}
      {error ? <Text style={[type.caption, styles.error]}>{error}</Text> : null}

      <Button
        label={showManual ? "Hide manual entry" : "Enter code manually"}
        variant="secondary"
        onPress={() => setShowManual((v) => !v)}
      />
      {showManual ? (
        <Card>
          <Text style={type.caption}>Paste the shop's QR text</Text>
          <TextInput
            multiline
            value={manual}
            onChangeText={setManual}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder='{"type":"inklink_shop", …}'
          />
          <Button label="Verify & connect" onPress={() => void connect(manual)} loading={busy} disabled={!manual.trim()} />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cameraWrap: {
    height: 300,
    marginVertical: spacing.md,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.inkBlack,
  },
  cameraPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, backgroundColor: colors.surfaceSunken },
  error: { color: colors.danger, marginVertical: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.lightGrey,
    borderRadius: radius.sm,
    padding: spacing.sm,
    minHeight: 120,
    marginVertical: spacing.sm,
    fontSize: 12,
    color: colors.inkBlack,
  },
});
