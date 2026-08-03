import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// The API requires a service key on every route. Read it here, in the Vite
// process, and attach it to proxied requests — so the key never ends up in a
// browser bundle, which is where a VITE_-prefixed variable would put it.
//
// loadEnv reads the workspace-root .env directly, so the documented start
// commands (which set only PORT and BASE_PATH) keep working unchanged.
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const apiServiceKey = loadEnv('development', repoRoot, '').API_SERVICE_KEY;

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // The generated API client calls relative "/api/..." URLs. On Replit the
    // platform router splits "/api" off to the api-server before Vite sees it;
    // running locally there is no such router, so proxy it ourselves. This is
    // dev-server only and has no effect on the production static build.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 8080}`,
        changeOrigin: true,
        // `configure` runs only when the dev server starts one of these, so a
        // production `vite build` — which needs no key — is unaffected.
        configure: (proxy) => {
          if (!apiServiceKey) {
            throw new Error(
              'API_SERVICE_KEY is required in the workspace-root .env so the ' +
                'dev proxy can authenticate to the API. Generate one with: ' +
                'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
            );
          }
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('x-api-key', apiServiceKey);
          });
        },
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
