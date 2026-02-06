import { defineConfig } from 'vite';
import { resolve } from 'path';
import type { Plugin } from 'vite';

// ---------------------------------------------------------------------------
// Content Security Policy definitions
//
// Dev CSP: permissive — Vite HMR needs unsafe-inline, unsafe-eval, localhost
// Prod CSP: locked down — no eval, no inline scripts, explicit domain whitelist
//
// External resource audit (renderer only — main-process API calls bypass CSP):
//   img-src   https://www.google.com  — favicon service (google.com/s2/favicons)
//   font-src  https://fonts.gstatic.com — Press Start 2P arcade font
// All other external communication is via IPC to the main process.
// ---------------------------------------------------------------------------

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' http://localhost:* ws://localhost:*",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
].join('; ');

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob: https://www.google.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspSwapPlugin(): Plugin {
  return {
    name: 'csp-swap',
    transformIndexHtml(html, ctx) {
      const isProd = ctx.bundle !== undefined; // bundle exists only during build
      if (!isProd) return html;
      return html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy"\n    content="${PROD_CSP}">`,
      );
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  plugins: [cspSwapPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
