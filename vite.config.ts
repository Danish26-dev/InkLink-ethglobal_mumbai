import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import type { ServerResponse } from 'node:http';

// Single local origin for the whole product (http://localhost:5173):
//   /                   this landing page (unchanged)
//   /portal, /app, /shop, /jury, /demo  the Inklink PWA (apps/web dev server, port 5174)
//   /pwa/*              PWA assets
//   /api/*              Inklink backend (FastAPI, port 8000)
const PWA = process.env.INKLINK_PWA_URL ?? 'http://127.0.0.1:5174';
const BACKEND = process.env.INKLINK_BACKEND_URL ?? 'http://127.0.0.1:8000';

function unavailable(name: string, start: string) {
  return (proxy: { on: (e: 'error', cb: (err: Error, req: unknown, res: unknown) => void) => void }) => {
    proxy.on('error', (_err, _req, res) => {
      const r = res as ServerResponse;
      if (!r || r.headersSent || typeof r.writeHead !== 'function') return;
      r.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      r.end(
        `<!doctype html><meta charset="utf-8"><title>Inklink</title><body style="font-family:system-ui;padding:40px;max-width:640px">` +
          `<h1>${name} is not running</h1><p>Start it with:</p><pre style="background:#111;color:#fafaf7;padding:12px;border-radius:8px">${start}</pre>` +
          `<p>Or start everything with <code>.\\scripts\\dev-stack.ps1</code>.</p></body>`,
      );
    });
  };
}

const pwaPage: ProxyOptions = {
  target: PWA,
  changeOrigin: false,
  // Every PWA route is the same single-page app.
  rewrite: () => '/pwa/',
  configure: unavailable('The Inklink app (apps/web)', 'cd apps/web; npm run dev'),
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false, xfwd: true },
      '/pwa': { target: PWA, changeOrigin: false, configure: unavailable('The Inklink app (apps/web)', 'cd apps/web; npm run dev') },
      '^/(app|shop|demo|portal|jury)(/.*)?$': pwaPage,
    },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // three / r3f / drei are only reached through the lazily loaded 3D
        // experience, so these chunks stay off the critical path.
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei'],
          gsap: ['gsap'],
        },
      },
    },
  },
});
