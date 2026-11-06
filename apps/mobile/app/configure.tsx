// Screen 5 — Print Configuration (copies, page range, colour, paper, orientation, sides)
import { useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import type { PrintConfig } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card } from "@/components/ui";
import { colors, radius, spacing, type } from "@/theme";
import { useApp } from "@/state/app-context";
import {
  COLOUR_OPTIONS,
  ORIENTATION_OPTIONS,
  PAPER_OPTIONS,
  SIDES_OPTIONS,
  type Option,
} from "@/print-options";

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
        <Choice label="Colour" options={COLOUR_OPTIONS} value={cfg.colourMode} onChange={(v) => set("colourMode", v)} />
        <Choice label="Paper" options={PAPER_OPTIONS} value={cfg.paperSize} onChange={(v) => set("paperSize", v)} />
        <Choice
          label="Orientation"
          options={ORIENTATION_OPTIONS}
          value={cfg.orientation ?? "portrait"}
          onChange={(v) => set("orientation", v)}
        />
        <Choice label="Sides" options={SIDES_OPTIONS} value={cfg.sides ?? "one-sided"} onChange={(v) => set("sides", v)} />
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

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={[styles.row, { flexWrap: "wrap" }]}>
      <Body>{label}</Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 1 }}>
        {options.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === o.value }}
            accessibilityLabel={`${label}: ${o.label}`}
            style={[styles.chip, value === o.value && styles.chipActive]}
          >
            <Text style={{ color: value === o.value ? colors.paperWhite : colors.inkBlack }}>{o.label}</Text>
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
