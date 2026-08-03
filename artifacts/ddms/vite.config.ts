import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// The API requires a service key on every route. Read it here, in the Vite
// process, and attach it to proxied requests — so the key never ends up in a
// browser bundle, which is where a VITE_-prefixed variable would put it.
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
  plugins: [react(), tailwindcss(), runtimeErrorOverlay()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
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
    fs: { strict: true },
    // DDMS calls the same API as everything else. On Replit the platform router
    // splits "/api" off before Vite sees it; locally there is no such router,
    // so proxy it ourselves. Dev-server only.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 8080}`,
        changeOrigin: true,
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
