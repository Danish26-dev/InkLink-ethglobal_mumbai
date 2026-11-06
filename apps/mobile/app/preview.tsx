// Screen 6 — Job Preview: create job -> upload -> quote
import { useRef, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Heading, Body, Button, Card, ProgressBar } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import type { CreateJobResponse } from "@inklink/shared-schemas";
import { getDeviceIdentity } from "@/crypto/device-key";
import { db } from "@/db/database";
import { COLOUR_OPTIONS, ORIENTATION_OPTIONS, SIDES_OPTIONS, labelFor } from "@/print-options";

export default function Preview() {
  const router = useRouter();
  const { session, updateSession, api, customerReference: backendCustomerRef } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string>("");
  const [progress, setProgress] = useState<number | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  // A retry after a failed transfer must reuse the job already created, not make an orphan.
  const jobRef = useRef<CreateJobResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      const job = jobRef.current ?? (await api.createJob({ shopId: shop.shopId, printConfig }));
      jobRef.current = job;
      updateSession({ job });

      // Contract 2 — upload the document against that jobId (idempotent).
      setStep("Transferring document…");
      // Anonymous per-install id: the backend's stable identity once pairing proved the device
      // key, else the one derived locally from the same key. No personal data either way.
      const customerReference = backendCustomerRef ?? (await getDeviceIdentity()).customerReference;
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress(0);
      setRetryNote(null);
      const upload = await api.uploadDocument({
        fileUri: document.uri,
        fileName: document.name,
        mimeType: document.mimeType,
        shopId: shop.shopId,
        customerId: customerReference,
        jobId: job.jobId,
        idempotencyKey: `${job.jobId}:${document.name}`,
        signal: controller.signal,
        onProgress: (p) => {
          setRetryNote(p.attempt > 1 ? `Retrying (${p.attempt}/${p.maxAttempts})�` : null);
          if (p.total > 0) setProgress(p.sent / p.total);
        },
        onRetry: (_n, reason) => {
          setProgress(0);
          setRetryNote(`${reason}. Retrying�`);
        },
      });
      setProgress(null);
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
      setProgress(null);
      setRetryNote(null);
      abortRef.current = null;
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
        <Row k="Colour" v={labelFor(COLOUR_OPTIONS, printConfig.colourMode)} />
        <Row k="Paper" v={printConfig.paperSize} />
        <Row k="Orientation" v={labelFor(ORIENTATION_OPTIONS, printConfig.orientation)} />
        <Row k="Sides" v={labelFor(SIDES_OPTIONS, printConfig.sides)} />
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
      {progress !== null ? <ProgressBar fraction={progress} /> : null}
      {retryNote ? <Body muted>{retryNote}</Body> : null}
      {error ? (
        <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text>
      ) : null}

      <Button label={error ? "Try again" : "Submit & get quote"} onPress={submit} loading={busy} />
      {busy && progress !== null ? (
        <Button label="Cancel upload" variant="secondary" onPress={() => abortRef.current?.abort()} />
      ) : null}
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
