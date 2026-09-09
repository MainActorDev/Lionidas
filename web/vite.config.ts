import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5230,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9230', ws: true },
      // baguette H.264 stream: same-origin WS (sec-fetch-site: same-origin) so
      // baguette's browser trust passes without allow-list flags
      '/baguette': { target: 'http://127.0.0.1:8430', ws: true, rewrite: (path) => path.replace(/^\/baguette/, '') },
    },
  },
});
