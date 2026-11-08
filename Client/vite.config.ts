import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => {
  // Non-VITE_ variables (DEV_PROXY_TARGET) are only visible here, never in the browser bundle.
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.DEV_PROXY_TARGET || 'http://localhost:3000';

  const proxy = (ws = false): ProxyOptions => ({
    target,
    changeOrigin: true,
    secure: true,
    ws,
    configure: (p) => {
      // The dev server makes the API look same-origin; drop the browser Origin so the
      // backend's CORS list does not need to include http://localhost:5173.
      p.on('proxyReq', (req) => {
        req.removeHeader('origin');
      });
      p.on('proxyReqWs', (req) => {
        req.removeHeader('origin');
      });
    },
  });

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': proxy(),
        '/socket.io': proxy(true),
        '/health': proxy(),
        '/ready': proxy(),
      },
    },
    // `vite preview` of a production build against the same backend (local QA of the real bundle).
    preview: {
      proxy: {
        '/api': proxy(),
        '/socket.io': proxy(true),
        '/health': proxy(),
        '/ready': proxy(),
      },
    },
    // Bundled worklets (RNNoise) are ES modules: AudioWorklet.addModule loads modules, and the
    // emscripten code needs import.meta.
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
  };
});
