// Locked INKLINK brand identity. Do not change these values.
export const BRAND = {
  name: 'INKLINK',
  tagline: 'Your Document. Your Agent. Your Control.',
  colors: {
    ink: '#111111',
    paper: '#FAFAF7',
    signal: '#F15A36',
    graphite: '#777777',
    lightGrey: '#EAEAE7',
  },
} as const;

// Three.js color constants (linear-ish values used directly as sRGB hex).
export const C = BRAND.colors;

export const SECTIONS = [
  { id: 'hero', label: 'Platform' },
  { id: 'workshop', label: 'How It Works' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'local', label: 'Infrastructure' },
  { id: 'offlinepay', label: 'OfflinePay' },
  { id: 'technology', label: 'Technology' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'developers', label: 'Developers' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];
