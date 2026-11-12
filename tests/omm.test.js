import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeOmm, parseEpoch, deriveOrbit, classifyOrbit } from '../src/omm.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/omm-sample.json', import.meta.url)));
const byId = (id) => fixture.records.find((r) => r.NORAD_CAT_ID === id);
const NOW = Date.parse('2026-11-12T06:00:00Z');

describe('OMM normalisation', () => {
  it('accepts a real CelesTrak ISS record', () => {
    const r = normalizeOmm(byId(25544), { nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.record.NORAD_CAT_ID).toBe(25544);
    expect(r.record.OBJECT_ID).toBe('1998-067A');
    expect(r.record.MEAN_MOTION).toBeCloseTo(15.49, 1);
  });

  it('accepts six-digit NORAD catalog numbers (beyond the classic TLE limit)', () => {
    const raw = byId(100001);
    expect(raw).toBeTruthy();
    const r = normalizeOmm(raw, { nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.record.NORAD_CAT_ID).toBe(100001);
    // also numeric strings and larger values
    expect(normalizeOmm({ ...raw, NORAD_CAT_ID: '339999' }, { nowMs: NOW }).record.NORAD_CAT_ID).toBe(339999);
    expect(normalizeOmm({ ...raw, NORAD_CAT_ID: 1234567 }, { nowMs: NOW }).ok).toBe(true);
  });

  it('converts numeric strings and defaults missing derivatives to 0', () => {
    const raw = { ...byId(25544), MEAN_MOTION: '15.5', MEAN_MOTION_DOT: undefined, MEAN_MOTION_DDOT: undefined };
    const r = normalizeOmm(raw, { nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.record.MEAN_MOTION).toBe(15.5);
    expect(r.record.MEAN_MOTION_DOT).toBe(0);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing name', { ...byId(25544), OBJECT_NAME: '  ' }],
    ['bad id', { ...byId(25544), NORAD_CAT_ID: 'A0001' }],
    ['negative id', { ...byId(25544), NORAD_CAT_ID: -5 }],
    ['bad epoch', { ...byId(25544), EPOCH: 'yesterday' }],
    ['future epoch', { ...byId(25544), EPOCH: '2031-01-01T00:00:00' }],
    ['eccentricity ≥ 1', { ...byId(25544), ECCENTRICITY: 1.2 }],
    ['NaN inclination', { ...byId(25544), INCLINATION: 'abc' }],
    ['inclination > 180', { ...byId(25544), INCLINATION: 181 }],
    ['zero mean motion', { ...byId(25544), MEAN_MOTION: 0 }],
    ['RAAN out of range', { ...byId(25544), RA_OF_ASC_NODE: 400 }],
    ['missing BSTAR', { ...byId(25544), BSTAR: null }],
  ])('rejects malformed record: %s', (_n, raw) => {
    expect(normalizeOmm(raw, { nowMs: NOW }).ok).toBe(false);
  });

  it('parses EPOCH without timezone as UTC, keeping sub-second precision', () => {
    expect(parseEpoch('2026-11-11T20:27:01.036512')).toBe(Date.UTC(2026, 10, 11, 20, 27, 1, 36));
    expect(parseEpoch('2026-11-11T20:27:01Z')).toBe(Date.UTC(2026, 10, 11, 20, 27, 1));
    expect(Number.isNaN(parseEpoch(undefined))).toBe(true);
  });
});

describe('Derived orbit & approximate class', () => {
  const cls = (r) => classifyOrbit(deriveOrbit(r), r.ECCENTRICITY);

  it('ISS: ~93 min period, ~420 km, LEO', () => {
    const d = deriveOrbit(byId(25544));
    expect(d.periodMin).toBeGreaterThan(91);
    expect(d.periodMin).toBeLessThan(95);
    expect(d.meanAltKm).toBeGreaterThan(380);
    expect(d.meanAltKm).toBeLessThan(450);
    expect(cls(byId(25544))).toBe('LEO');
  });

  it('GPS: ~12 h period, MEO', () => {
    const gps = fixture.records.find((r) => r.groups.includes('GPS-OPS'));
    const d = deriveOrbit(gps);
    expect(d.periodMin).toBeGreaterThan(710);
    expect(d.periodMin).toBeLessThan(730);
    expect(d.meanAltKm).toBeGreaterThan(19_500);
    expect(d.meanAltKm).toBeLessThan(21_000);
    expect(cls(gps)).toBe('MEO');
  });

  it('Intelsat in GEO group: geosynchronous', () => {
    const geo = fixture.records.find((r) => r.groups.includes('GEO'));
    const d = deriveOrbit(geo);
    expect(Math.abs(d.meanAltKm - 35_786)).toBeLessThan(300);
    expect(cls(geo)).toBe('GEO');
  });

  it('highly elliptical orbit (AO-10, e≈0.6) is "OTHER"', () => {
    const heo = fixture.records.find((r) => r.ECCENTRICITY > 0.5);
    expect(cls(heo)).toBe('OTHER');
  });
});
