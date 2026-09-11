import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5230,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9230', ws: true },
      // simdeck gated proxy (authed device surface) lives on the API server;
      // /simulators is the wrapped surface's runtime root — our canvas
      // client, chrome fetches, and stream WS all ride it
      '/simdeck': { target: 'http://127.0.0.1:9230', ws: true },
      '/simulators': { target: 'http://127.0.0.1:9230', ws: true },
    },
  },
});
