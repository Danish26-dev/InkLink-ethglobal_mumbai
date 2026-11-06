import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The PWA is served under the single Inklink origin next to the landing page:
//   /                 landing page (root Vite app, port 5173)
//   /app, /shop, /demo PWA routes (index.html from this server)
//   /pwa/*            this app's assets (base below), so they never collide
//                     with the landing page's own /src and /assets
// The root dev server proxies those paths here. This server can also be opened
// directly at http://localhost:5174/pwa/ during development.
const backend = process.env.INKLINK_BACKEND_URL ?? 'http://127.0.0.1:8000';
const apiProxy = { '/api': { target: backend, changeOrigin: false, xfwd: true } };

export default defineConfig({
  base: '/pwa/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    // HMR connects straight to this server even when the page comes through 5173.
    hmr: { clientPort: 5174 },
    proxy: apiProxy,
  },
  preview: { port: 5174, proxy: apiProxy },
  build: { target: 'es2020' },
});
