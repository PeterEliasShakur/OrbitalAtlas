/**
 * Platform layer — multi-file web build (Vite dev server / `npm run build`).
 *
 * The standalone single-HTML build swaps this module for ./standalone.js via
 * the `@platform` alias in vite.config.js. Both expose the same API.
 */
export const PLATFORM = 'web';

/** URL of a bundled asset under public/assets/. */
export function assetUrl(path) {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}

/** Module worker loaded from its own file (emitted by Vite). */
export function createPropagationWorker() {
  return new Worker(new URL('../propagation-worker.js', import.meta.url), { type: 'module' });
}

/** The web build fetches data/orbits.json instead of embedding it. */
export async function loadEmbeddedDataset() {
  return null;
}
