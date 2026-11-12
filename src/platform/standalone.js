/**
 * Platform layer — standalone single-HTML build (scripts/build-standalone.mjs).
 *
 * Everything lives inside the HTML document:
 *  - textures:  <script type="text/plain" data-asset="textures/…">data:image/jpeg;base64,…</script>
 *  - dataset:   <script type="application/x-gzip-base64" id="oa-data">…</script>
 *               (the CelesTrak snapshot JSON, gzip-compressed — lossless)
 *  - worker:    <script type="text/plain" id="oa-worker-src">…classic worker JS…</script>
 * Nothing is fetched from the file system, so it works from file://.
 */
export const PLATFORM = 'standalone';

const assetCache = new Map();

export function assetUrl(path) {
  if (assetCache.has(path)) return assetCache.get(path);
  const el = document.querySelector(`script[data-asset="${path}"]`);
  if (!el) throw new Error(`Embedded asset missing: ${path}`);
  const url = el.textContent.trim();
  assetCache.set(path, url);
  return url;
}

/**
 * Classic worker created from a Blob URL of the embedded worker source.
 * May throw (or fail asynchronously) under restrictive file:// policies —
 * the caller falls back to main-thread propagation.
 */
export function createPropagationWorker() {
  const src = document.getElementById('oa-worker-src')?.textContent;
  if (!src) throw new Error('embedded worker source missing');
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'orbital-atlas-sgp4' });
  // the worker has fetched its script once it reports ready; revoke later
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return worker;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode the embedded gzip+base64 CelesTrak snapshot. */
export async function loadEmbeddedDataset() {
  const el = document.getElementById('oa-data');
  if (!el) return null;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser lacks DecompressionStream (needed to unpack the embedded orbital data). Please use a current Chrome, Edge, Firefox or Safari.');
  }
  const bytes = base64ToBytes(el.textContent.replace(/\s+/g, ''));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const dataset = JSON.parse(text);
  if (!Array.isArray(dataset?.records)) throw new Error('embedded snapshot has no records');
  return dataset;
}
