// Screen 8 — Payment Authorization (explicit approval, signed by the device key)
import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card, Divider } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { appConfig } from "@/config";
import { signPaymentAuthorization } from "@/crypto/device-key";
import { paymentInProgressFor, quoteExpired } from "@/payment-flow";

/** Smallest whole number of USDC that covers `amount` (display helper for sensible defaults). */
function ceilWhole(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  return (BigInt(whole || "0") + (/[1-9]/.test(frac) ? 1n : 0n)).toString();
}

/**
 * The customer reviews and explicitly approves a spending policy. The app signs it
 * with the device's Ed25519 key; the private key never leaves the device and only
 * the signature is sent. The backend then supplies the authoritative USDC amount,
 * and the payment agent refuses anything outside this policy.
 */
export default function Authorize() {
  const router = useRouter();
  const { session, api, updateSession } = useApp();
  const quote = session.quote;
  const settlement = quote?.settlement;

  const defaultMax = settlement ? `${ceilWhole(settlement.amount)}.00` : "1.00";
  const [maxPerTx, setMaxPerTx] = useState(defaultMax);
  const [total, setTotal] = useState(settlement ? `${BigInt(ceilWhole(settlement.amount)) * 5n}.00` : "5.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merchantId = quote?.merchantId ?? session.shop?.shopId ?? "";
  // Fixed when the screen opens, so the expiry shown is exactly the one signed.
  const [expiresAt] = useState(() => new Date(Date.now() + appConfig.authorizationLifetimeMs));
  // A tap can arrive before React re-renders the button as busy: guard synchronously.
  const inFlight = useRef(false);

  // Already paying this quote (e.g. Android Back from the status screen): show that payment.
  const existingPayment = paymentInProgressFor(session, quote?.quoteId);
  useEffect(() => {
    if (existingPayment) router.replace("/payment-status");
  }, [existingPayment, router]);

  async function approve() {
    if (!quote || !session.job) {
      setError("Missing quote.");
      return;
    }
    if (inFlight.current || paymentInProgressFor(session, quote.quoteId)) return;
    if (quoteExpired(quote)) {
      setError("This quote has expired. Go back and get a new quote before paying.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Contract 5 — device-signed policy (explicit customer approval).
      const signed = await signPaymentAuthorization({
        agentId: appConfig.agentId,
        merchantId,
        maxPerTransaction: maxPerTx.trim(),
        totalSpendingLimit: total.trim(),
        asset: "USDC",
        expiresAt: expiresAt.toISOString(),
      });
      const auth = await api.authorizePayment(signed);
      updateSession({ authorizationId: auth.authorizationId });

      // Contract 6 — the backend determines the USDC amount; the app sends only ids.
      const payment = await api.initiatePayment({
        jobId: session.job.jobId,
        quoteId: quote.quoteId,
        authorizationId: auth.authorizationId,
        paymentMethod: "hedera_x402",
      });
      updateSession({ paymentId: payment.paymentId, paidQuoteId: quote.quoteId });
      // Replace, not push: Back must not return to a live "Approve & sign" button.
      router.replace("/payment-status");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not authorize the payment");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Heading>Approve the payment agent</Heading>
      <Body muted>
        You approve a spending policy once. The agent can then pay this shop within these limits
        without asking again. Your phone signs the approval; your private key never leaves it.
      </Body>

      <Card>
        <Field label="Shop"><Body>{merchantId}</Body></Field>
        <Field label="Asset"><Body>USDC (Hedera Testnet)</Body></Field>
        <Divider />
        <Field label="Max per payment">
          <TextInput value={maxPerTx} onChangeText={setMaxPerTx} keyboardType="decimal-pad" style={styles.input} />
        </Field>
        <Field label="Total limit">
          <TextInput value={total} onChangeText={setTotal} keyboardType="decimal-pad" style={styles.input} />
        </Field>
        <Field label="Expires">
          <Body>{expiresAt.toLocaleTimeString()}</Body>
        </Field>
        {settlement ? (
          <Body muted>This job will cost {settlement.amount} USDC, set by the shop's backend.</Body>
        ) : null}
      </Card>

      {error ? <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text> : null}

      <Button label="Approve & sign" onPress={approve} loading={busy} />
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Body>{label}</Body>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.lightGrey,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    minWidth: 100,
    textAlign: "right",
    color: colors.inkBlack,
  },
});
