/**
 * Checks on the committed real-data snapshot (public/data/orbits.json) and
 * on the WhereTheISS.at response parser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { prepareCatalog } from '../src/data-processing.js';
import { createSatrec, propagateBatch } from '../src/orbital-math.js';
import { parseIssResponse } from '../src/satellite-api.js';
import { validateDataset } from '../scripts/lib/dataset.mjs';
import { GROUP_BY_ID } from '../src/config.js';

const SNAP = new URL('../public/data/orbits.json', import.meta.url);

describe.skipIf(!existsSync(SNAP))('committed orbital snapshot', () => {
  const ds = JSON.parse(readFileSync(SNAP));
  const fetched = Date.parse(ds.meta.lastSuccessfulFetch);

  it('has metadata with real CelesTrak source URLs and a fetch timestamp', () => {
    expect(Number.isFinite(fetched)).toBe(true);
    expect(ds.meta.source.api).toBe('https://celestrak.org/NORAD/elements/gp.php');
    for (const g of ds.meta.groups) {
      expect(g.url).toMatch(/^https:\/\/celestrak\.org\/NORAD\/elements\/gp\.php\?GROUP=.+&FORMAT=JSON$/);
      expect(GROUP_BY_ID[g.id]).toBeTruthy();
    }
  });

  it('passes the same validation the refresh script applies', () => {
    const v = validateDataset(ds, null);
    expect(v.reasons).toEqual([]);
  });

  it('contains the ISS, Hubble and six-digit catalog numbers', () => {
    const ids = new Set(ds.records.map((r) => r.NORAD_CAT_ID));
    expect(ids.has(25544)).toBe(true);
    expect(ids.has(20580)).toBe(true);
    expect(ds.records.some((r) => r.NORAD_CAT_ID > 99_999)).toBe(true);
  });

  it('every record propagates to finite values or a clean failure (no NaN leaks)', () => {
    const cat = prepareCatalog(ds, { nowMs: fetched });
    expect(cat.rejected).toBe(0);
    const satrecs = cat.sats.map((s) => createSatrec(s.omm));
    const idx = Int32Array.from(satrecs.map((_, i) => i));
    const out = new Float64Array(idx.length * 4);
    const valid = propagateBatch(satrecs, idx, fetched, out);
    expect(valid / idx.length).toBeGreaterThan(0.98);
    for (let k = 0; k < idx.length; k++) {
      const q = out.subarray(k * 4, k * 4 + 4);
      const allNaN = q.every(Number.isNaN);
      const allFinite = q.every(Number.isFinite);
      expect(allNaN || allFinite).toBe(true);
      if (allFinite) {
        expect(Math.abs(q[0])).toBeLessThanOrEqual(90);
        expect(q[2]).toBeGreaterThan(80);
        expect(q[3]).toBeGreaterThan(0);
        expect(q[3]).toBeLessThan(12);
      }
    }
  });
});

describe('WhereTheISS.at response parsing', () => {
  // shape captured from a real request to https://api.wheretheiss.at/v1/satellites/25544
  const real = {
    name: 'iss', id: 25544, latitude: -27.936152175302, longitude: 127.70768090296, altitude: 423.86696651443,
    velocity: 27571.302927581, visibility: 'daylight', footprint: 4527.0847593891, timestamp: 1794461694,
    daynum: 2461356.7325694, solar_lat: -17.696675024239, solar_lon: 92.298347996588, units: 'kilometers',
  };

  it('normalises units (velocity km/h → km/s, timestamp s → ms)', () => {
    const p = parseIssResponse(real);
    expect(p.lat).toBeCloseTo(-27.936, 3);
    expect(p.altKm).toBeCloseTo(423.87, 2);
    expect(p.speedKms).toBeCloseTo(7.6587, 3);
    expect(p.timestampMs).toBe(1794461694000);
    expect(p.visibility).toBe('daylight');
  });

  it('handles miles and rejects malformed payloads', () => {
    expect(parseIssResponse({ ...real, units: 'miles', altitude: 263, velocity: 17130 }).altKm).toBeCloseTo(423.3, 0);
    expect(parseIssResponse(null)).toBeNull();
    expect(parseIssResponse({ ...real, latitude: 'x' })).toBeNull();
    expect(parseIssResponse({ ...real, latitude: 123 })).toBeNull();
    expect(parseIssResponse({ ...real, altitude: 5 })).toBeNull();
    expect(parseIssResponse({ error: 'rate limited' })).toBeNull();
  });
});
