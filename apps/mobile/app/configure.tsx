// Screen 5 — Print Configuration (copies, page range, colour, paper)
import { useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import type { PrintConfig } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";

export default function Configure() {
  const router = useRouter();
  const { session, updateSession } = useApp();
  const [cfg, setCfg] = useState<PrintConfig>(session.printConfig);

  function set<K extends keyof PrintConfig>(key: K, value: PrintConfig[K]) {
    setCfg((c) => ({ ...c, [key]: value }));
  }

  function next() {
    updateSession({ printConfig: cfg });
    router.push("/preview");
  }

  return (
    <Screen>
      <Heading>Print settings</Heading>

      <Card>
        <Stepper label="Copies" value={cfg.copies} onChange={(v) => set("copies", Math.max(1, v))} />
        <Field label="Page range">
          <TextInput value={cfg.pageRange} onChangeText={(t) => set("pageRange", t)} style={styles.inlineInput} />
        </Field>
        <Choice
          label="Colour"
          options={["grayscale", "colour"]}
          value={cfg.colourMode}
          onChange={(v) => set("colourMode", v as PrintConfig["colourMode"])}
        />
        <Choice
          label="Paper"
          options={["A4", "A3", "Letter", "Legal"]}
          value={cfg.paperSize}
          onChange={(v) => set("paperSize", v as PrintConfig["paperSize"])}
        />
      </Card>

      <Button label="Review job" onPress={next} />
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

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <View style={styles.row}>
      <Body>{label}</Body>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable onPress={() => onChange(value - 1)} style={styles.stepBtn}>
          <Text style={type.heading}>−</Text>
        </Pressable>
        <Text style={[type.heading, { marginHorizontal: spacing.md }]}>{value}</Text>
        <Pressable onPress={() => onChange(value + 1)} style={styles.stepBtn}>
          <Text style={type.heading}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={[styles.row, { flexWrap: "wrap" }]}>
      <Body>{label}</Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {options.map((o) => (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={[styles.chip, value === o && styles.chipActive]}
          >
            <Text style={{ color: value === o ? colors.paperWhite : colors.inkBlack }}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: colors.lightGrey,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginVertical: spacing.sm,
    color: colors.inkBlack,
  },
  inlineInput: {
    borderWidth: 1,
    borderColor: colors.lightGrey,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    minWidth: 80,
    textAlign: "right",
    color: colors.inkBlack,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.inkBlack,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.inkBlack,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginLeft: spacing.xs,
    marginTop: spacing.xs,
  },
  chipActive: { backgroundColor: colors.inkBlack },
});
