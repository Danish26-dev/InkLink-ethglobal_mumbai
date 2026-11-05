// Screen 6 — Job Preview: create job -> upload -> quote
import { useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { getDeviceIdentity } from "@/crypto/device-key";
import { db } from "@/db/database";

export default function Preview() {
  const router = useRouter();
  const { session, updateSession, api } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string>("");

  const { document, printConfig, shop } = session;

  async function submit() {
    if (!shop || !document) {
      setError("Missing shop or document.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Contract 3 — create job FIRST (authoritative jobId from gateway).
      setStep("Creating job…");
      const job = await api.createJob({ shopId: shop.shopId, printConfig });
      updateSession({ job });

      // Contract 2 — upload the document against that jobId (idempotent).
      setStep("Transferring document…");
      // Anonymous per-install id derived from the device key: no personal data.
      const { customerReference } = await getDeviceIdentity();
      const upload = await api.uploadDocument({
        fileUri: document.uri,
        fileName: document.name,
        mimeType: document.mimeType,
        shopId: shop.shopId,
        customerId: customerReference,
        jobId: job.jobId,
        idempotencyKey: `${job.jobId}:${document.name}`,
      });
      updateSession({ documentId: upload.documentId });

      // Contract 4 — generate quotation (INR).
      setStep("Getting quotation…");
      const quote = await api.generateQuote(job.jobId);
      updateSession({ quote });

      // Persist to SQLite for offline history/tracking.
      const now = new Date().toISOString();
      await db.insertJob({
        jobId: job.jobId,
        shopId: shop.shopId,
        documentName: document.name,
        copies: printConfig.copies,
        pageRange: printConfig.pageRange,
        colourMode: printConfig.colourMode,
        paperSize: printConfig.paperSize,
        quoteAmountInr: quote.amount,
        status: "awaiting_payment",
        paymentStatus: "created",
        paymentId: null,
        transactionId: null,
        createdAt: now,
        updatedAt: now,
      });

      router.push("/payment");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  return (
    <Screen>
      <Heading>Review your job</Heading>
      <Card>
        <Row k="Shop" v={shop?.shopId ?? "—"} />
        <Row k="Document" v={document?.name ?? "—"} />
        <Row k="Copies" v={String(printConfig.copies)} />
        <Row k="Pages" v={printConfig.pageRange} />
        <Row k="Colour" v={printConfig.colourMode} />
        <Row k="Paper" v={printConfig.paperSize} />
      </Card>

      {session.quote ? (
        <Card>
          <Text style={type.heading}>Quotation</Text>
          <Text style={type.display}>₹{session.quote.amount}</Text>
          {session.quote.settlement ? (
            <Body muted>
              ≈ {session.quote.settlement.amount} USDC if paid with Hedera
            </Body>
          ) : null}
          <Body muted>Quote {session.quote.quoteId}</Body>
        </Card>
      ) : null}

      {step ? <Body muted>{step}</Body> : null}
      {error ? (
        <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text>
      ) : null}

      <Button label="Submit & get quote" onPress={submit} loading={busy} />
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
