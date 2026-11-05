/**
 * Inklink brand theme — refined paper-and-ink aesthetic.
 * Flat with soft elevation. No loud gradients, no fintech clichés.
 */

export const colors = {
  // Core brand
  inkBlack: "#111111",
  paperWhite: "#FAFAF7",
  signalOrange: "#F15A36",
  graphite: "#777777",
  lightGrey: "#EAEAE7",

  // Extended surfaces (derived, keep the paper feel)
  surface: "#FFFFFF",
  surfaceSunken: "#F4F3EF",
  ink80: "#2A2A2A",
  ink60: "#555555",
  hairline: "#E4E3DE",
  orangeSoft: "#FDEBE6", // orange tint for subtle fills
  orangeDeep: "#D94A28", // pressed state

  // States
  success: "#2E7D4F",
  successSoft: "#E6F2EB",
  danger: "#C0392B",
  dangerSoft: "#F7E7E4",
  warn: "#B7791F",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

/** Soft, low-contrast elevation — gives depth without heaviness. */
export const shadow = {
  card: {
    shadowColor: "#1A1200",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 2,
  },
  floating: {
    shadowColor: "#1A1200",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 6,
  },
} as const;

export const type = {
  display: {
    fontSize: 40,
    lineHeight: 44,
    fontWeight: "800" as const,
    letterSpacing: -1,
    color: colors.inkBlack,
  },
  title: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "700" as const,
    letterSpacing: -0.5,
    color: colors.inkBlack,
  },
  heading: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "700" as const,
    letterSpacing: -0.2,
    color: colors.inkBlack,
  },
  body: {
    fontSize: 15.5,
    lineHeight: 23,
    fontWeight: "400" as const,
    color: colors.ink80,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500" as const,
    color: colors.graphite,
  },
  overline: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700" as const,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    color: colors.graphite,
  },
  button: {
    fontSize: 16,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
    color: colors.paperWhite,
  },
} as const;
