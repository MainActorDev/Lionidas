import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// CRUCIBLE_API_TARGET (default 9230): point the dev proxy at a test
// instance (e.g. 9231) without touching the real server — see
// docs/testing-setup-wizard.md.
const apiTarget = process.env.CRUCIBLE_API_TARGET ?? 'http://127.0.0.1:9230';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5230,
    proxy: {
      '/api': { target: apiTarget, ws: true },
      // simdeck gated proxy (authed device surface) lives on the API server;
      // /simulators is the wrapped surface's runtime root — our canvas
      // client, chrome fetches, and stream WS all ride it
      '/simdeck': { target: apiTarget, ws: true },
      '/simulators': { target: apiTarget, ws: true },
    },
  },
});
