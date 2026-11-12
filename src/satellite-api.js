/**
 * API integration.
 *
 *  1. Orbital elements: the static snapshot `data/orbits.json`, produced from
 *     the real CelesTrak GP API by scripts/fetch-orbits.mjs (run on a schedule
 *     by GitHub Actions). A copy is kept in the browser's Cache Storage so the
 *     app still works offline / when the network request fails.
 *  2. ISS live position: direct browser → WhereTheISS.at REST request
 *     (CORS-enabled), polled every 30 s.
 */
import { ISS_API } from './config.js';
import { loadEmbeddedDataset } from '@platform';

const CACHE_NAME = 'orbital-atlas-data-v1';

function datasetUrl() {
  return new URL(`${import.meta.env.BASE_URL}data/orbits.json`, window.location.href).toString();
}

/**
 * Load the orbital-element snapshot.
 * @returns {Promise<{dataset: object, origin: 'embedded'|'network'|'browser-cache', error?: string}>}
 */
export async function loadOrbitDataset({ onProgress } = {}) {
  // Standalone single-file build: the snapshot is embedded in the HTML itself.
  const embedded = await loadEmbeddedDataset();
  if (embedded) return { dataset: embedded, origin: 'embedded' };
  const url = datasetUrl();
  let networkError = null;
  try {
    // `no-cache` revalidates with the server, so a freshly deployed snapshot is picked up.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await readWithProgress(res, onProgress);
    const dataset = JSON.parse(text);
    if (!Array.isArray(dataset?.records)) throw new Error('snapshot has no records');
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    } catch {
      /* Cache Storage unavailable (private mode, file://) — not fatal */
    }
    return { dataset, origin: 'network' };
  } catch (err) {
    networkError = String(err?.message || err);
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const dataset = await hit.json();
      return { dataset, origin: 'browser-cache', error: networkError };
    }
  } catch {
    /* ignore */
  }
  const e = new Error(`Orbital data could not be loaded (${networkError}). No cached copy is available.`);
  e.code = 'NO_DATA';
  throw e;
}

async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !onProgress) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Validate a WhereTheISS.at response. Returns a normalised object or null.
 * The API reports velocity in km/h; it is converted to km/s here.
 */
export function parseIssResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const lat = Number(json.latitude);
  const lng = Number(json.longitude);
  const alt = Number(json.altitude);
  const vel = Number(json.velocity);
  const ts = Number(json.timestamp);
  if (![lat, lng, alt, vel, ts].every(Number.isFinite)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || alt < 100 || alt > 1000) return null;
  const unitsKm = (json.units ?? 'kilometers') === 'kilometers';
  return {
    lat,
    lng,
    altKm: unitsKm ? alt : alt * 1.609344,
    speedKms: (unitsKm ? vel : vel * 1.609344) / 3600,
    visibility: typeof json.visibility === 'string' ? json.visibility : null,
    footprintKm: Number.isFinite(Number(json.footprint)) ? Number(json.footprint) : null,
    timestampMs: ts * 1000,
  };
}

/**
 * Polls the WhereTheISS.at API. Emits `{status, data, error, lastAttempt}`.
 * status: 'connecting' | 'live' | 'error'
 */
export class IssLiveFeed {
  constructor({ url = ISS_API.url, intervalMs = ISS_API.pollMs, onUpdate } = {}) {
    this.url = url;
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.state = { status: 'connecting', data: null, error: null, lastAttempt: null, lastSuccess: null };
    this.timer = null;
    this.ctrl = null;
    this._visibility = () => {
      if (document.hidden) this.stop(false);
      else this.start();
    };
  }

  start() {
    if (this.timer) return;
    document.addEventListener('visibilitychange', this._visibility);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(removeListener = true) {
    clearInterval(this.timer);
    this.timer = null;
    this.ctrl?.abort();
    if (removeListener) document.removeEventListener('visibilitychange', this._visibility);
  }

  async poll() {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    const t = setTimeout(() => this.ctrl.abort(), 10_000);
    this.state.lastAttempt = Date.now();
    try {
      const res = await fetch(this.url, { signal: this.ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = parseIssResponse(await res.json());
      if (!data) throw new Error('unexpected response format');
      this.state = { ...this.state, status: 'live', data, error: null, lastSuccess: Date.now() };
    } catch (err) {
      let msg = err?.name === 'AbortError' ? 'request timed out' : String(err?.message || err);
      if (msg === 'Failed to fetch' || /NetworkError|Load failed/i.test(msg)) {
        msg = navigator.onLine === false ? 'offline — no network connection' : 'network request failed (offline, blocked, or API unreachable)';
      }
      this.state = { ...this.state, status: 'error', error: msg };
    } finally {
      clearTimeout(t);
    }
    this.onUpdate?.(this.state);
  }
}
