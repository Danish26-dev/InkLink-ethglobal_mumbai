import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app talks to the Inklink backend through the dev-server proxy, so the
// browser stays same-origin (no CORS, and SSE works through the proxy).
const backend = process.env.INKLINK_BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
  preview: {
    port: 5174,
    proxy: { '/api': { target: backend, changeOrigin: false } },
  },
  build: { target: 'es2020' },
});
