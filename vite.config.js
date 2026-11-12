import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const platform = (name) => fileURLToPath(new URL(`./src/platform/${name}.js`, import.meta.url));

// `base: './'` emits relative asset URLs, so the multi-file build works under
// any path (e.g. https://petereliasshakur.github.io/OrbitalAtlas/) — no repo
// name hard-coded. Override with VITE_BASE=/OrbitalAtlas/ for absolute URLs.
// `--mode standalone` (used by scripts/build-standalone.mjs) swaps the platform
// layer so assets, data and the worker are read from the HTML document itself.
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE || './',
  resolve: {
    alias: {
      '@platform': platform(mode === 'standalone' ? 'standalone' : 'web'),
      // standalone: drop satellite.js's unused optional WASM runtimes (see src/platform/wasm-stub.js)
      ...(mode === 'standalone' ? { '#wasm-single-thread': platform('wasm-stub'), '#wasm-multi-thread': platform('wasm-stub') } : {}),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2600,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
}));
