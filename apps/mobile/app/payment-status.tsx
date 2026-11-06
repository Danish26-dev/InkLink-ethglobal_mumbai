// Screen 9 — Payment Status (polls Contract 7 until settled/failed)
import { useEffect, useState } from "react";
import { View, Text, Linking, Pressable } from "react-native";
import { useRouter } from "expo-router";
import type { PaymentStatusResponse } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card, Pill } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { db } from "@/db/database";
import { hashscanTransactionUrl, paymentPollDelayMs } from "@/payment-flow";

export default function PaymentStatusScreen() {
  const router = useRouter();
  const { session, api, updateSession } = useApp();
  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const paymentId = session.paymentId;
    if (!paymentId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;

    const poll = async () => {
      let s: PaymentStatusResponse;
      try {
        s = await api.getPaymentStatus(paymentId);
      } catch (e) {
        // A Wi-Fi blip must not freeze the screen: the payment may still settle. Keep asking.
        if (!active) return;
        errors++;
        setError(`Connection problem (${e instanceof Error ? e.message : "network error"}). Still checking…`);
        timer = setTimeout(poll, paymentPollDelayMs(errors));
        return;
      }
      if (!active) return;
      errors = 0;
      setError(null);
      setStatus(s);
      if (s.status === "settled") {
        // Record the payment facts only. Job status is authoritative on the backend
        // and is picked up from GET /jobs/{id}/status on the tracking screen.
        // A local storage failure must not look like a payment failure.
        await db
          .updateJob(s.jobId, { paymentStatus: "settled", paymentId: s.paymentId, transactionId: s.transactionId })
          .catch((e: unknown) => console.warn("[inklink] could not save the payment locally", e));
        return; // stop polling
      }
      if (s.status === "failed" || s.status === "expired") return;
      timer = setTimeout(poll, paymentPollDelayMs(0));
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
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
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="View the transaction on HashScan"
            onPress={() => Linking.openURL(hashscanTransactionUrl(status.transactionId!))}
          >
            <Text style={[type.caption, { color: colors.signalOrange, marginTop: spacing.sm }]}>
              View on HashScan ↗  {status.transactionId}
            </Text>
          </Pressable>
        ) : null}
      </Card>

      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}

      {settled ? <Button label="Track print job" onPress={() => router.push("/tracking")} /> : null}
      {terminalFail ? (
        <Button
          label="Back to payment"
          variant="secondary"
          onPress={() => {
            // This payment ended without settling: allow a fresh approval for a new attempt.
            updateSession({ paymentId: undefined, paidQuoteId: undefined });
            router.replace("/payment");
          }}
        />
      ) : null}
    </Screen>
  );
}
