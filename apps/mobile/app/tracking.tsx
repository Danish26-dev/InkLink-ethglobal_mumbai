// Screen 10 — Print Job Tracking (polls Contract 8)
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import type { JobStatusResponse } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card, Pill } from "@/components/ui";
import { spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import { db } from "@/db/database";

const TERMINAL: JobStatusResponse["status"][] = ["completed", "cancelled", "failed"];

export default function Tracking() {
  const router = useRouter();
  const { session, api, resetSession } = useApp();
  const [job, setJob] = useState<JobStatusResponse | null>(null);

  useEffect(() => {
    const jobId = session.job?.jobId;
    if (!jobId) return;
    let active = true;

    const poll = async () => {
      try {
        const s = await api.getJobStatus(jobId);
        if (!active) return;
        setJob(s);
        await db.updateJob(jobId, { status: s.status, paymentStatus: s.paymentStatus });
        if (!TERMINAL.includes(s.status)) setTimeout(poll, 2500);
      } catch {
        if (active) setTimeout(poll, 4000);
      }
    };
    void poll();
    return () => {
      active = false;
    };
  }, [session.job?.jobId, api]);

  const done = job?.status === "completed";

  return (
    <Screen>
      <Heading>Print job</Heading>
      <Body muted>
        The shop's local gateway coordinates the ESP32 execution interface. This simulates
        physical paper feeding; it is not a commercial printer.
      </Body>

      <Card>
        <Timeline status={job?.status ?? "created"} />
      </Card>

      <Card>
        <Row k="Job" v={job?.status ?? "—"} />
        <Row k="Payment" v={job?.paymentStatus ?? "—"} />
        <Row k="Device" v={job?.deviceStatus ?? "—"} />
      </Card>

      {done ? (
        <Button
          label="Done"
          onPress={() => {
            // Start the next job clean: no old quote, payment or document carried over.
            resetSession();
            router.replace("/");
          }}
        />
      ) : null}
      <Button label="View history" variant="secondary" onPress={() => router.push("/history")} />
    </Screen>
  );
}

const STAGES: JobStatusResponse["status"][] = [
  "created",
  "awaiting_payment",
  "awaiting_execution",
  "executing",
  "completed",
];

function Timeline({ status }: { status: JobStatusResponse["status"] }) {
  const currentIdx = Math.max(0, STAGES.indexOf(status));
  return (
    <View>
      {STAGES.map((stage, i) => (
        <View key={stage} style={{ flexDirection: "row", alignItems: "center", paddingVertical: spacing.xs }}>
          <Pill text={i <= currentIdx ? "✓" : "·"} tone={i <= currentIdx ? "good" : "neutral"} />
          <Text style={[type.body, { marginLeft: spacing.sm }]}>{stage.replace(/_/g, " ")}</Text>
        </View>
      ))}
    </View>
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
