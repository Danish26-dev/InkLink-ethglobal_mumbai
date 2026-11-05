/**
 * Reusable Inklink UI primitives — refined paper-and-ink style with soft
 * elevation and tactile press states. Same exported API as before.
 */

import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { colors, radius, shadow, spacing, type } from "@/theme";

/** Scrollable, comfortably padded screen container. */
export function Screen({
  children,
  scroll = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
}) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screenContent}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={type.title}>{children}</Text>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={[type.heading, { marginBottom: spacing.xs }]}>{children}</Text>;
}

export function Overline({ children }: { children: React.ReactNode }) {
  return <Text style={[type.overline, { marginBottom: spacing.xs }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={muted ? type.caption : type.body}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  loading?: boolean;
}) {
  const isPrimary = variant === "primary";
  const fg = isPrimary ? colors.paperWhite : colors.inkBlack;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
        isPrimary && !disabled && shadow.card,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[type.button, { color: disabled ? colors.paperWhite : fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
  elevated = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  elevated?: boolean;
}) {
  return (
    <View style={[styles.card, elevated && shadow.card, style]}>{children}</View>
  );
}

export function Pill({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "good" | "bad" | "accent";
}) {
  const map = {
    neutral: { bg: colors.surfaceSunken, fg: colors.ink60 },
    good: { bg: colors.successSoft, fg: colors.success },
    bad: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.orangeSoft, fg: colors.orangeDeep },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: map.bg }]}>
      <Text style={[styles.pillText, { color: map.fg }]}>{text}</Text>
    </View>
  );
}

/** Subtle note used to flag mocked/dev behaviour (honesty rule). */
export function MockBanner({ text }: { text: string }) {
  return (
    <View style={styles.mockBanner}>
      <View style={styles.mockDot} />
      <Text style={styles.mockText}>{text}</Text>
    </View>
  );
}

/** Determinate progress bar; `fraction` is 0..1. */
export function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ height: 6, borderRadius: 3, backgroundColor: colors.lightGrey, overflow: "hidden", marginVertical: spacing.sm }}
    >
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.ink80 }} />
    </View>
  );
}

/** A thin divider for separating rows. */
export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paperWhite, padding: spacing.lg },
  screenScroll: { flex: 1, backgroundColor: colors.paperWhite },
  screenContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  button: {
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: spacing.sm,
    minHeight: 54,
  },
  buttonPrimary: { backgroundColor: colors.signalOrange },
  buttonSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: colors.inkBlack,
  },
  buttonDisabled: { backgroundColor: colors.lightGrey, borderColor: colors.lightGrey },
  buttonPressed: { transform: [{ scale: 0.98 }], opacity: 0.92 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    marginVertical: spacing.sm,
  },
  pill: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
  },
  pillText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  mockBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  mockDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.warn,
    marginRight: spacing.sm,
  },
  mockText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.ink60, fontWeight: "500" },
  divider: { height: 1, backgroundColor: colors.hairline, marginVertical: spacing.sm },
});
