// OfflinePay — sign a promise to pay this job's quoted USDC; the shop settles it on Hedera later.
import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Linking, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { OfflinePayError, type OfflinePaymentVoucher } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card, Divider, Pill } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { db } from "@/db/database";
import { getDeviceIdentity, signOfflineVoucher } from "@/crypto/device-key";
import { verifySignature } from "@/crypto/ed25519";
import { deviceOfflineLedger } from "@/offline/device-ledger";
import {
  assertDeviceCanIssue,
  classifySubmitError,
  describeOfflineState,
  offlinePollDelayMs,
  syncDeviceLedger,
  type OfflineVoucherView,
} from "@/offline/offline-pay-flow";
import { hashscanTransactionUrl, quoteExpired } from "@/payment-flow";

export default function OfflinePay() {
  const router = useRouter();
  const { session, api, updateSession } = useApp();
  const quote = session.quote;
  const settlement = quote?.settlement;
  // A voucher already signed for THIS quote: show it, never sign a second one.
  const voucher = session.offlineVoucher && session.offlineVoucher.quoteId === quote?.quoteId ? session.offlineVoucher : undefined;

  const [view, setView] = useState<OfflineVoucherView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    void getDeviceIdentity()
      .then((id) => setDeviceKey(id.devicePublicKey))
      .catch(() => setDeviceKey(null));
  }, []);

  // The phone's own record: limits and what it has promised and not yet seen settled.
  let outstanding = "0.00";
  let limits = { maxPerVoucher: "2.00", maxOutstanding: "5.00" };
  let ledgerError: string | null = null;
  try {
    const ledger = deviceOfflineLedger();
    limits = ledger.limits;
    if (deviceKey) outstanding = ledger.outstanding(deviceKey);
  } catch (e) {
    ledgerError = e instanceof Error ? e.message : "The OfflinePay record on this phone could not be read.";
  }

  /** Send (or resend, unchanged) the signed voucher to the shop's backend. */
  const submit = useCallback(
    async (v: OfflinePaymentVoucher) => {
      setError(null);
      setNoAnswer(false);
      try {
        const res = await api.submitOfflineVoucher(v);
        deviceOfflineLedger().accept(v); // recorded on the phone only once the shop has it
        setView(res);
        if (session.job) {
          await db.updateJob(session.job.jobId, { paymentStatus: "processing" }).catch(() => undefined);
        }
      } catch (e) {
        if (classifySubmitError(e) === "unknown") {
          // The shop may have received it: count it against the limit and allow an identical resend.
          try {
            deviceOfflineLedger().accept(v);
          } catch {
            /* already recorded */
          }
          setNoAnswer(true);
          setError("No answer from the shop. Your promise was kept on this phone; send it again when connected.");
        } else {
          // A definite refusal: nothing is recorded and nothing is owed. Another payment method can be used.
          updateSession({ offlineVoucher: undefined });
          setError(e instanceof Error ? e.message : "The shop refused this promise.");
        }
      }
    },
    [api, session.job, updateSession],
  );

  async function signAndSend() {
    if (inFlight.current || voucher) return;
    if (!quote || !settlement || !session.job) {
      setError("This job has no USDC quote to promise.");
      return;
    }
    if (quoteExpired(quote)) {
      setError("This quote has expired. Go back and get a new quote first.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const v = await signOfflineVoucher({
        jobId: session.job.jobId,
        quoteId: quote.quoteId,
        merchantId: quote.merchantId,
        amount: settlement.amount, // exactly the backend's quoted amount
      });
      // The phone's own limits (per voucher, unsettled total across shops, one per job).
      assertDeviceCanIssue(deviceOfflineLedger(), v, verifySignature);
      updateSession({ offlineVoucher: v });
      await submit(v);
    } catch (e) {
      setError(e instanceof OfflinePayError ? e.message : e instanceof Error ? e.message : "Could not sign the promise");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (!voucher || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await submit(voucher);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Follow the voucher until it is verified on Hedera (or a final state).
  const voucherId = voucher?.voucherId;
  useEffect(() => {
    if (!voucherId || noAnswer) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;

    const poll = async () => {
      let v: OfflineVoucherView;
      try {
        v = await api.getOfflineVoucher(voucherId);
      } catch {
        if (!active) return;
        errors++;
        timer = setTimeout(poll, offlinePollDelayMs(errors));
        return;
      }
      if (!active) return;
      errors = 0;
      setView(v);
      try {
        syncDeviceLedger(deviceOfflineLedger(), v);
      } catch (e) {
        console.warn("[inklink] OfflinePay: could not update the phone's record", e);
      }
      if (v.state === "SETTLED") {
        await db
          .updateJob(v.voucher.jobId, { paymentStatus: "settled", paymentId: v.paymentId ?? null, transactionId: v.transactionId ?? null })
          .catch(() => undefined);
      }
      if (!describeOfflineState(v).final) timer = setTimeout(poll, offlinePollDelayMs(0));
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [voucherId, noAnswer, api]);

  const state = view ? describeOfflineState(view) : null;

  return (
    <Screen>
      <Heading>Pay later with OfflinePay</Heading>

      {!voucher ? (
        <>
          <Body muted>
            Sign a promise to pay this exact amount. The shop accepts it now and settles it in USDC on
            Hedera through the payment agent when it is online. It is not a payment until then.
          </Body>
          <Card>
            <Row k="Amount" v={settlement ? `${settlement.amount} USDC` : "—"} />
            <Row k="Shop" v={quote?.merchantId ?? "—"} />
            <Row k="Job" v={session.job?.jobId ?? "—"} />
            <Divider />
            <Row k="Limit per promise" v={`${limits.maxPerVoucher} USDC`} />
            <Row k="Unsettled limit (all shops)" v={`${limits.maxOutstanding} USDC`} />
            <Row k="Unsettled on this phone" v={`${outstanding} USDC`} />
          </Card>
          {ledgerError ? <Text style={[type.caption, { color: colors.danger }]}>{ledgerError}</Text> : null}
          {error ? <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text> : null}
          <Button label="Sign promise" onPress={signAndSend} loading={busy} disabled={!!ledgerError || !settlement} />
          <Button label="Back to payment" variant="secondary" onPress={() => router.back()} />
        </>
      ) : (
        <>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={type.heading}>{state?.title ?? (noAnswer ? "Not sent yet" : "Sending…")}</Text>
              <Pill text={view?.state.toLowerCase().replace(/_/g, " ") ?? "pending"} tone={state?.tone ?? "neutral"} />
            </View>
            <Body muted>{state?.detail ?? "Handing your signed promise to the shop."}</Body>
            <Divider />
            <Row k="Amount" v={`${voucher.amount} USDC`} />
            <Row k="Valid until" v={new Date(voucher.expiresAt).toLocaleTimeString()} />
            {view?.paymentId ? <Row k="Payment" v={view.paymentId} /> : null}
            {view?.transactionId ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="View the settlement on HashScan"
                onPress={() => Linking.openURL(hashscanTransactionUrl(view.transactionId!))}
              >
                <Text style={[type.caption, { color: colors.signalOrange, marginTop: spacing.sm }]}>
                  View on HashScan ↗  {view.transactionId}
                </Text>
              </Pressable>
            ) : null}
          </Card>
          {error ? <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text> : null}
          {noAnswer ? <Button label="Send promise again" onPress={resend} loading={busy} /> : null}
          {view?.state === "SETTLED" ? <Button label="Track print job" onPress={() => router.push("/tracking")} /> : null}
        </>
      )}
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: spacing.xs }}>
      <Body muted>{k}</Body>
      <Body>{v}</Body>
    </View>
  );
}
