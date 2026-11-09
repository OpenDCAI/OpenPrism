import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Shared design system lives at the repo root: /design
const designDir = fileURLToPath(new URL('../../design', import.meta.url));

// One version for the whole app, kept next to the API that reports it too.
const appVersion = readFileSync(fileURLToPath(new URL('../api/VERSION', import.meta.url)), 'utf8').trim();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react()],
  resolve: {
    alias: { '@design': designDir }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The devcontainer's bind-mounted workspace does not deliver file-change events, so Vite would serve stale code.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        target: process.env.OPENPRISM_API_URL || 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
        xfwd: true
      },
      // The Django admin and its static files (#79), so http://localhost:5173/admin/ works in development too.
      '/admin': { target: process.env.OPENPRISM_API_URL || 'http://localhost:8000', changeOrigin: false, xfwd: true },
      '/static': { target: process.env.OPENPRISM_API_URL || 'http://localhost:8000', changeOrigin: false, xfwd: true },
      '/texlive': {
        target: 'https://texlive.swiftlatex.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/texlive/, '')
      }
    }
  }
});
