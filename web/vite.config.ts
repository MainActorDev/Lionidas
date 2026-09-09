import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5230,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9230', ws: true },
      // crucible-screenstream (our first-party engine): same-origin WS via the
      // vite proxy. The engine is loopback-only; the browser connects through
      // the app origin, so no allow-list flags or trust hatches are needed.
      '/screenstream': { target: 'http://127.0.0.1:8440', ws: true, rewrite: (path) => path.replace(/^\/screenstream/, '') },
    },
  },
});
