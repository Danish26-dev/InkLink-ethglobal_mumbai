// Screen 4 — Document Selection
import { useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { Screen, Heading, Body, Button, Card } from "@/components/ui";
import { colors, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (Contract limit)

export default function DocumentScreen() {
  const router = useRouter();
  const { session, updateSession } = useApp();
  const [error, setError] = useState<string | null>(null);
  const doc = session.document;

  async function pick() {
    setError(null);
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const isPdf = asset.mimeType === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf");
    const isDocx = asset.name.toLowerCase().endsWith(".docx");
    if (!isPdf && !isDocx) {
      setError("Only PDF and DOCX are supported.");
      return;
    }
    if ((asset.size ?? 0) > MAX_BYTES) {
      setError("File exceeds the 25 MB limit.");
      return;
    }
    updateSession({
      document: {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? (isPdf ? "application/pdf" : "application/octet-stream"),
        size: asset.size ?? 0,
        format: isPdf ? "pdf" : "docx",
      },
    });
  }

  return (
    <Screen>
      <Heading>Choose a document</Heading>
      <Body muted>PDF or DOCX, up to 25 MB. It transfers to the shop's local gateway, not the cloud.</Body>
      <View style={{ height: spacing.md }} />

      {doc ? (
        <Card>
          <Text style={type.heading}>{doc.name}</Text>
          <Body muted>
            {doc.format.toUpperCase()} · {(doc.size / 1024).toFixed(0)} KB
          </Body>
        </Card>
      ) : null}

      {error ? (
        <Text style={[type.caption, { color: colors.danger, marginVertical: spacing.sm }]}>{error}</Text>
      ) : null}

      <Button label={doc ? "Choose a different file" : "Select file"} variant={doc ? "secondary" : "primary"} onPress={pick} />
      {doc ? <Button label="Continue" onPress={() => router.push("/configure")} /> : null}
    </Screen>
  );
}
