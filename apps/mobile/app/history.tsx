// Screen 11 — Job History (from SQLite, works offline)
import { useEffect, useState } from "react";
import { FlatList, View, Text, Linking, Pressable } from "react-native";
import { Screen, Heading, Body, Card, Pill } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { db, type JobRow } from "@/db/database";

const HASHSCAN = "https://hashscan.io/testnet/transaction/";

export default function History() {
  const [jobs, setJobs] = useState<JobRow[]>([]);

  useEffect(() => {
    void db.listJobs().then(setJobs);
  }, []);

  return (
    <Screen>
      <Heading>Your jobs</Heading>
      <Body muted>Stored locally on this device — available offline.</Body>
      <FlatList
        style={{ marginTop: spacing.md }}
        data={jobs}
        keyExtractor={(j) => j.jobId}
        ListEmptyComponent={<Body muted>No jobs yet.</Body>}
        renderItem={({ item }) => (
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={type.heading}>{item.documentName ?? item.jobId}</Text>
              <Pill
                text={item.status}
                tone={item.status === "completed" ? "good" : item.status === "failed" ? "bad" : "neutral"}
              />
            </View>
            <Body muted>
              {item.copies} copies · {item.colourMode} · {item.paperSize}
              {item.quoteAmountInr ? ` · ₹${item.quoteAmountInr}` : ""}
            </Body>
            <Body muted>Payment: {item.paymentStatus}</Body>
            {item.transactionId ? (
              <Pressable onPress={() => Linking.openURL(`${HASHSCAN}${item.transactionId}`)}>
                <Text style={[type.caption, { color: colors.signalOrange }]}>
                  Tx on HashScan ↗
                </Text>
              </Pressable>
            ) : null}
          </Card>
        )}
      />
    </Screen>
  );
}
