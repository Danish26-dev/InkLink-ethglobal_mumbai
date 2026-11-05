// Screen 1 — Welcome / Onboarding
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Button } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";

export default function Welcome() {
  const router = useRouter();
  return (
    <Screen scroll={false}>
      <View style={styles.hero}>
        <View style={styles.logoMark}>
          <Text style={styles.logoGlyph}>I</Text>
        </View>
        <Text style={styles.wordmark}>Inklink</Text>
        <Text style={styles.tagline}>Your document. Your agent. Your control.</Text>
      </View>

      <View style={styles.pitch}>
        <Text style={type.title}>Print anywhere,{"\n"}locally.</Text>
        <Text style={[type.body, { marginTop: spacing.sm }]}>
          Connect to a nearby print shop over QR or Bluetooth, send your document across the
          local network, and track the job. No account needed to print.
        </Text>

        <View style={styles.chips}>
          {["Local-first", "Private", "Autonomous pay"].map((c) => (
            <View key={c} style={styles.chip}>
              <Text style={styles.chipText}>{c}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.footer}>
        <Button label="Find a print shop" onPress={() => router.push("/discovery")} />
        <Pressable onPress={() => router.push("/history")} style={styles.link}>
          <Text style={styles.linkText}>View past jobs</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", paddingTop: spacing.xxl, marginTop: spacing.xl },
  logoMark: {
    width: 72,
    height: 72,
    borderRadius: radius.lg,
    backgroundColor: colors.inkBlack,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  logoGlyph: { color: colors.signalOrange, fontSize: 40, fontWeight: "800" },
  wordmark: { ...type.display, fontSize: 44 },
  tagline: { ...type.caption, marginTop: spacing.xs, color: colors.graphite },
  pitch: { flex: 1, justifyContent: "center", paddingVertical: spacing.xl },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: spacing.lg, gap: spacing.sm },
  chip: {
    backgroundColor: colors.orangeSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipText: { color: colors.orangeDeep, fontWeight: "700", fontSize: 13 },
  footer: { paddingBottom: spacing.md },
  link: { alignSelf: "center", paddingVertical: spacing.sm },
  linkText: { color: colors.signalOrange, fontWeight: "700", fontSize: 14 },
});
