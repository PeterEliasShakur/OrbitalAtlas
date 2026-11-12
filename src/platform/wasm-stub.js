/**
 * Stand-in for satellite.js's optional WebAssembly SGP4 runtimes in the
 * standalone build. Orbital Atlas uses satellite.js's pure-JavaScript SGP4
 * only; the WASM runtimes (reached solely through dynamic import) would add
 * ~400 KB plus a nested pthread worker that cannot be inlined.
 */
export default function createWasmModule() {
  throw new Error('satellite.js WASM runtime is not included in the standalone build');
}
