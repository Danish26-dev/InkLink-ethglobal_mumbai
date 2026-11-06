/** @type {import('tailwindcss').Config} */
// Same locked palette and type system as the landing page.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#111111',
        paper: '#FAFAF7',
        signal: '#F15A36',
        graphite: '#777777',
        'light-grey': '#EAEAE7',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      letterSpacing: { tightest: '-0.045em' },
      transitionTimingFunction: { cinema: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    },
  },
  plugins: [],
};
