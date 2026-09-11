import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // feature flags (read via `typeof __X__ !== 'undefined'` in src)
  define: {
    __SIMDECK_EMBED__: JSON.stringify(process.env['VITE_SIMDECK_EMBED'] ?? '0'),
  },
  server: {
    port: 5230,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9230', ws: true },
      // simdeck gated proxy (authed device surface) lives on the API server;
      // /simulators + /devices are the wrapped surface's RUNTIME-built roots
      // (its client JS composes them from location.host) - same proxy target
      '/simdeck': { target: 'http://127.0.0.1:9230', ws: true },
      '/simulators': { target: 'http://127.0.0.1:9230', ws: true },
      '/baguette': { target: 'http://127.0.0.1:9230', ws: true },
      '/capture': { target: 'http://127.0.0.1:9230', ws: true },
      '/capture-gallery.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/carplay-frames': { target: 'http://127.0.0.1:9230', ws: true },
      '/farm': { target: 'http://127.0.0.1:9230', ws: true },
      '/frame-decoder.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/network': { target: 'http://127.0.0.1:9230', ws: true },
      '/plugin-control.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/plugin-prompt.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/plugin-row-action.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/recorder.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/screens': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-3d.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-ax-inspector.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-camera.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-file-drop.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-list': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-location.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-logs.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-native.html': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-native.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-network.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-plugins.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-screens.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-status-bar.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-stream.html': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim-stream.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/sim.html': { target: 'http://127.0.0.1:9230', ws: true },
      '/stream-format.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/stream-session.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/target.js': { target: 'http://127.0.0.1:9230', ws: true },
      '/toolbar': { target: 'http://127.0.0.1:9230', ws: true },
      '/vendor': { target: 'http://127.0.0.1:9230', ws: true },
      // crucible-screenstream (our first-party engine): same-origin WS via the
      // vite proxy. The engine is loopback-only; the browser connects through
      // the app origin, so no allow-list flags or trust hatches are needed.
      '/screenstream': { target: 'http://127.0.0.1:8440', ws: true, rewrite: (path) => path.replace(/^\/screenstream/, '') },
    },
  },
});
