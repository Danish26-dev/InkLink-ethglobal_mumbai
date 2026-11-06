// Screen 7 — Payment Selection (the backend decides the amount; the app only displays it)
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card, MockBanner, Pill } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { DEFAULT_OFFLINE_PAY_POLICY } from "@inklink/shared-schemas";

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Payment() {
  const router = useRouter();
  const { session, api, updateSession } = useApp();
  const quote = session.quote;
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = quote ? Date.parse(quote.expiresAt) - now : 0;
  const expired = !!quote && remaining <= 0;
  const settlement = quote?.settlement;
  const hederaOffered = !!quote?.paymentMethods.includes("hedera_x402") && !!settlement;
  // One payment method per quote: once one has started, the other is not offered again.
  const offlineStarted = !!quote && session.offlineVoucher?.quoteId === quote.quoteId;
  const x402Started = !!quote && session.paidQuoteId === quote.quoteId;
  const canPayWithHedera = hederaOffered && !expired && !offlineStarted;
  const canPayLater = hederaOffered && !expired && !x402Started && !offlineStarted;

  async function refreshQuote() {
    if (!session.job) return;
    setRefreshing(true);
    setError(null);
    try {
      updateSession({ quote: await api.generateQuote(session.job.jobId) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get a new quote");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen>
      <Heading>Choose how to pay</Heading>
      {quote ? (
        <Card>
          <Text style={type.display}>₹{quote.amount}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.xs }}>
            <Pill text={expired ? "quote expired" : `valid ${formatRemaining(remaining)}`} tone={expired ? "bad" : "neutral"} />
          </View>
        </Card>
      ) : null}

      {expired ? (
        <Card>
          <Body>This quote has expired. Get a new quote to see the current price.</Body>
          <Button label="Get a new quote" onPress={refreshQuote} loading={refreshing} />
        </Card>
      ) : null}
      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}

      <Card>
        <Heading>Autonomous Hedera payment</Heading>
        {settlement ? (
          <>
            <Text style={type.title}>{settlement.amount} USDC</Text>
            <Body muted>
              Rate {settlement.rate} · captured {new Date(settlement.capturedAt).toLocaleTimeString()}
            </Body>
          </>
        ) : null}
        <Body muted>
          Approve a spending limit once. A payment agent then pays this shop via x402, settled in
          USDC on Hedera Testnet. The amount is set by the shop's backend, not by this app.
        </Body>
        <Button label="Use Hedera x402" disabled={!canPayWithHedera} onPress={() => router.push("/authorize")} />
      </Card>

      <Card>
        <Heading>Pay later (OfflinePay)</Heading>
        <Body muted>
          Sign a promise for exactly this amount. The shop accepts it now and settles it in USDC on
          Hedera when it is online. Limited to {DEFAULT_OFFLINE_PAY_POLICY.maxPerVoucher} USDC per promise
          and {DEFAULT_OFFLINE_PAY_POLICY.maxOutstanding} USDC unsettled.
        </Body>
        {offlineStarted ? (
          <Button label="View OfflinePay status" variant="secondary" onPress={() => router.push("/offline-pay")} />
        ) : (
          <Button label="Pay later with OfflinePay" variant="secondary" disabled={!canPayLater} onPress={() => router.push("/offline-pay")} />
        )}
      </Card>

      <Card>
        <Heading>UPI / traditional</Heading>
        <Body muted>Pay the INR amount directly. No crypto wallet required.</Body>
        <MockBanner text="UPI path is out of scope for this module; owned by the main backend." />
        <Button label="Pay with UPI" variant="secondary" disabled onPress={() => {}} />
      </Card>
    </Screen>
  );
}
