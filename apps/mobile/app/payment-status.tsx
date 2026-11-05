// Screen 9 — Payment Status (polls Contract 7 until settled/failed)
import { useEffect, useState } from "react";
import { View, Text, Linking, Pressable } from "react-native";
import { useRouter } from "expo-router";
import type { PaymentStatusResponse } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card, Pill } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { db } from "@/db/database";

const HASHSCAN = "https://hashscan.io/testnet/transaction/";

export default function PaymentStatusScreen() {
  const router = useRouter();
  const { session, api } = useApp();
  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const paymentId = session.paymentId;
    if (!paymentId) return;
    let active = true;

    const poll = async () => {
      try {
        const s = await api.getPaymentStatus(paymentId);
        if (!active) return;
        setStatus(s);
        if (s.status === "settled") {
          // Record the payment facts only. Job status is authoritative on the backend
          // and is picked up from GET /jobs/{id}/status on the tracking screen.
          await db.updateJob(s.jobId, {
            paymentStatus: "settled",
            paymentId: s.paymentId,
            transactionId: s.transactionId,
          });
          return; // stop polling
        }
        if (s.status === "failed" || s.status === "expired") return;
        setTimeout(poll, 2500);
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void poll();
    return () => {
      active = false;
    };
  }, [session.paymentId, api]);

  const settled = status?.status === "settled";
  const terminalFail = status?.status === "failed" || status?.status === "expired";

  return (
    <Screen>
      <Heading>Payment</Heading>
      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={type.heading}>{status?.status ?? "starting…"}</Text>
          <Pill
            text={status?.status ?? "…"}
            tone={settled ? "good" : terminalFail ? "bad" : "neutral"}
          />
        </View>
        {status ? (
          <>
            <Body muted>Amount {status.amount} {status.asset}</Body>
            <Body muted>Network {status.network}</Body>
          </>
        ) : null}
        {status?.transactionId ? (
          <Pressable onPress={() => Linking.openURL(`${HASHSCAN}${status.transactionId}`)}>
            <Text style={[type.caption, { color: colors.signalOrange, marginTop: spacing.sm }]}>
              View on HashScan ↗  {status.transactionId}
            </Text>
          </Pressable>
        ) : null}
      </Card>

      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}

      {settled ? <Button label="Track print job" onPress={() => router.push("/tracking")} /> : null}
      {terminalFail ? (
        <Button label="Back to payment" variant="secondary" onPress={() => router.replace("/payment")} />
      ) : null}
    </Screen>
  );
}
