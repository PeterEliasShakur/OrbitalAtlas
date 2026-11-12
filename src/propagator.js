/**
 * Satellite propagation back-ends with one common interface:
 *
 *   setActive(indices) → version    choose the displayed subset
 *   request(t) → boolean             start computing positions at time t (ignored while busy)
 *   onPositions(msg)                 callback: { seq, t, count, valid, data, version, ms }
 *   mode                             'worker' | 'main-thread'
 *
 * WorkerPropagator runs SGP4 in a Web Worker ("ping-pong" loop, so slow
 * devices automatically get fewer updates instead of a growing queue).
 * MainThreadPropagator is the fallback when a worker cannot start (e.g. a
 * browser policy blocking Blob workers on file:// pages): it time-slices the
 * work into ≤ 8 ms chunks and yields to the event loop between them, so the
 * UI keeps responding.
 */
import { createPropagationWorker } from '@platform';
import { createSatrec, propagateBatch } from './orbital-math.js';

const yieldToEventLoop = () =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

export class WorkerPropagator {
  constructor(records, worker) {
    this.mode = 'worker';
    this.worker = worker;
    this.seq = 0;
    this.pending = false;
    this.activeVersion = 0;
    this.onPositions = null;
    this.lastMs = 0;
    this.ready = new Promise((resolve, reject) => {
      this.worker.addEventListener('message', (e) => {
        if (e.data.type === 'ready') resolve(e.data);
      });
      this.worker.addEventListener('error', (err) => reject(new Error(err?.message || 'worker failed to start')), { once: true });
      this.worker.addEventListener('messageerror', () => reject(new Error('worker message error')), { once: true });
    });
    this.worker.addEventListener('message', (e) => {
      if (e.data.type !== 'positions') return;
      this.pending = false;
      this.lastMs = e.data.ms;
      this.onPositions?.(e.data);
    });
    this.worker.postMessage({ type: 'init', records });
  }

  /** Send the displayed subset; returns the version number echoed back with positions. */
  setActive(indices) {
    this.activeVersion++;
    // copy: the worker keeps its own array; we keep ours for lookups
    this.worker.postMessage({ type: 'active', indices: Int32Array.from(indices), version: this.activeVersion });
    return this.activeVersion;
  }

  /** Request positions at time t (ms). Ignored while a request is in flight. */
  request(t) {
    if (this.pending) return false;
    this.pending = true;
    this.worker.postMessage({ type: 'compute', t, seq: ++this.seq });
    return true;
  }

  dispose() {
    this.worker.terminate();
  }
}

export class MainThreadPropagator {
  constructor(records, { sliceMs = 8 } = {}) {
    this.mode = 'main-thread';
    this.sliceMs = sliceMs;
    this.satrecs = new Array(records.length).fill(null);
    this.active = new Int32Array(0);
    this.activeVersion = 0;
    this.seq = 0;
    this.pending = false;
    this.disposed = false;
    this.onPositions = null;
    this.lastMs = 0;
    this.ready = this._init(records);
  }

  async _init(records) {
    const t0 = performance.now();
    const invalid = [];
    let i = 0;
    while (i < records.length) {
      const end = performance.now() + 12;
      while (i < records.length && performance.now() < end) {
        const s = createSatrec(records[i]);
        if (!s) invalid.push(i);
        this.satrecs[i++] = s;
      }
      await yieldToEventLoop();
    }
    return { type: 'ready', invalid, ms: performance.now() - t0 };
  }

  setActive(indices) {
    this.activeVersion++;
    this.active = Int32Array.from(indices);
    return this.activeVersion;
  }

  request(t) {
    if (this.pending || this.disposed) return false;
    this.pending = true;
    this._run(t, ++this.seq);
    return true;
  }

  async _run(t, seq) {
    const active = this.active;
    const version = this.activeVersion;
    const n = active.length;
    const out = new Float64Array(n * 4);
    let valid = 0;
    let busy = 0;
    let k = 0;
    while (k < n) {
      const start = performance.now();
      while (k < n && performance.now() - start < this.sliceMs) {
        const e = Math.min(n, k + 200);
        valid += propagateBatch(this.satrecs, active.subarray(k, e), t, out.subarray(k * 4, e * 4));
        k = e;
      }
      busy += performance.now() - start;
      if (k < n) await yieldToEventLoop();
      if (this.disposed) return;
    }
    this.pending = false;
    this.lastMs = busy;
    this.onPositions?.({ type: 'positions', seq, t, count: n, valid, data: Float32Array.from(out), version, ms: busy });
  }

  dispose() {
    this.disposed = true;
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not respond within ${ms} ms`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Create the best available propagator: a Web Worker if it starts, otherwise
 * the time-sliced main-thread fallback. `fallbackReason` records why.
 */
export async function createPropagator(records, { preferWorker = true, timeoutMs = 15_000 } = {}) {
  let reason = preferWorker ? null : 'worker disabled (?worker=off)';
  if (preferWorker) {
    let wp = null;
    try {
      wp = new WorkerPropagator(records, createPropagationWorker());
      await withTimeout(wp.ready, timeoutMs, 'propagation worker');
      return wp;
    } catch (err) {
      reason = String(err?.message || err);
      console.warn('[orbital-atlas] Web Worker unavailable — using main-thread propagation:', reason);
      wp?.dispose();
    }
  }
  const mp = new MainThreadPropagator(records);
  await mp.ready;
  mp.fallbackReason = reason;
  return mp;
}
