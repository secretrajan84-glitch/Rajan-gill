import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This app is 100% client-side (Puter.js talks to api.puter.com directly from the
// browser), so we only need a static dev server that is reachable through the
// sandbox preview proxy.
export default defineConfig({
  base: './',
  plugins: [react()],
  // Pre-bundle the heavy deps at server start. Without this, Vite discovers
  // them on the first request and force-reloads the page, which is exactly the
  // moment a user might already have a batch running.
  optimizeDeps: {
    include: ['react', 'react-dom', 'jszip', '@heyputer/puter.js'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The preview is served from https://<port>-<sandbox>.e2b.app, so the Host
    // header will not be localhost. Allow every host + the proxy's websocket.
    allowedHosts: true,
    cors: true,
    // HMR is deliberately OFF.
    //
    // 1. Under the preview proxy the websocket often cannot be reached, and
    //    Vite's client answers a failed HMR connection by *reloading the page*
    //    once its ping succeeds. A reload mid-run would throw away a
    //    200-image batch.
    // 2. Nothing here needs hot reload during a long generation job.
    hmr: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
