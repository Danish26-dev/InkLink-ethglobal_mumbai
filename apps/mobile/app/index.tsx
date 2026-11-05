// Screen 1 — Welcome / Onboarding (mirrors the Inklink website: paper, ink, one orange signal)
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Button, Logo, Eyebrow, Callout } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";

export default function Welcome() {
  const router = useRouter();
  return (
    <Screen>
      <View style={styles.nav}>
        <View style={styles.brand}>
          <Logo size={36} />
          <Text style={styles.wordmark}>INKLINK</Text>
        </View>
        <Pressable onPress={() => router.push("/history")} style={styles.navPill} accessibilityRole="button">
          <Text style={styles.navPillText}>Past jobs</Text>
        </Pressable>
      </View>

      <View style={styles.hero}>
        <Eyebrow>DECENTRALIZED · AGENT-DRIVEN · LOCAL-FIRST</Eyebrow>
        <Text style={styles.headline}>
          Printing,{"\n"}reimagined{"\n"}for an{"\n"}autonomous{"\n"}world
          <Text style={{ color: colors.signalOrange }}>.</Text>
        </Text>
        <Text style={[type.body, styles.lead]}>
          Pick a nearby print shop, send your document over its local Wi-Fi, and pay with an
          autonomous agent you stay in control of. No account needed to print.
        </Text>
      </View>

      <Callout label="LOCAL-FIRST" title="Your file never leaves the shop's network">
        It goes straight to the shop's gateway, not to a cloud server.
      </Callout>

      <View style={styles.chips}>
        {["Private", "Agent payments", "Hedera USDC"].map((c) => (
          <View key={c} style={styles.chip}>
            <Text style={styles.chipText}>{c}</Text>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Button label="Find a print shop  →" onPress={() => router.push("/discovery")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  brand: { flexDirection: "row", alignItems: "center" },
  wordmark: { fontSize: 18, fontWeight: "800", letterSpacing: 2, color: colors.inkBlack, marginLeft: spacing.sm },
  navPill: {
    borderWidth: 1,
    borderColor: colors.lightGrey,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  navPillText: { color: colors.inkBlack, fontWeight: "600", fontSize: 13 },
  hero: { marginBottom: spacing.md },
  headline: {
    fontSize: 44,
    lineHeight: 46,
    fontWeight: "800",
    letterSpacing: -1.6,
    color: colors.inkBlack,
  },
  lead: { marginTop: spacing.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    backgroundColor: colors.orangeSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipText: { color: colors.orangeDeep, fontWeight: "700", fontSize: 13 },
  footer: { marginTop: spacing.md },
});
