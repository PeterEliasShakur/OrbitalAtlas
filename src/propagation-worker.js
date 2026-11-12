/**
 * Web Worker: holds SGP4 satrecs for the whole catalog and propagates the
 * currently displayed subset on request, off the main (render) thread.
 *
 * Messages in:
 *   { type: 'init', records: OMM[] }
 *   { type: 'active', indices: Int32Array, version }
 *   { type: 'compute', t: epochMs, seq }
 * Messages out:
 *   { type: 'ready', invalid: number[], ms }
 *   { type: 'positions', seq, t, count, valid, data: Float32Array(count*4), ms }
 *     data layout per satellite: [lat°, lng°, alt km, speed km/s] (NaN = failed)
 */
import { createSatrec, propagateBatch } from './orbital-math.js';

let satrecs = [];
let active = new Int32Array(0);
let version = 0;
let scratch = new Float64Array(0);

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const t0 = performance.now();
    const invalid = [];
    satrecs = msg.records.map((r, i) => {
      const s = createSatrec(r);
      if (!s) invalid.push(i);
      return s;
    });
    self.postMessage({ type: 'ready', invalid, ms: performance.now() - t0 });
  } else if (msg.type === 'active') {
    active = msg.indices;
    version = msg.version;
  } else if (msg.type === 'compute') {
    const t0 = performance.now();
    const n = active.length;
    if (scratch.length < n * 4) scratch = new Float64Array(n * 4);
    const valid = propagateBatch(satrecs, active, msg.t, scratch);
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) data[i] = scratch[i];
    self.postMessage(
      { type: 'positions', seq: msg.seq, t: msg.t, count: n, valid, data, version, ms: performance.now() - t0 },
      [data.buffer],
    );
  }
};
