import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as satellite from 'satellite.js';
import {
  createSatrec,
  stateAt,
  propagateBatch,
  computeTrajectory,
  splitAtAntimeridian,
  subsolarPoint,
  renderAltitude,
  toCartesian,
  wrapLng,
  julianDate,
  periodMinutes,
} from '../src/orbital-math.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/omm-sample.json', import.meta.url)));
const rec = (id) => fixture.records.find((r) => r.NORAD_CAT_ID === id);
const iss = rec(25544);
const issEpoch = Date.parse(`${iss.EPOCH}Z`);
const T = issEpoch + 3 * 3600_000; // 3 h after epoch

const finite = (o) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));

describe('satellite.js integration', () => {
  it('uses satellite.js 7.x with json2satrec / sgp4 / gstime / eciToGeodetic', () => {
    const pkg = JSON.parse(readFileSync(new URL('../node_modules/satellite.js/package.json', import.meta.url)));
    expect(pkg.version.split('.')[0]).toBe('7');
    for (const fn of ['json2satrec', 'sgp4', 'propagate', 'gstime', 'eciToGeodetic', 'sunPos', 'checkForDecay']) {
      expect(typeof satellite[fn]).toBe('function');
    }
  });

  it('builds a satrec from OMM JSON, including a six-digit NORAD id', () => {
    const s = createSatrec(rec(100001));
    expect(s).not.toBeNull();
    expect(s.satnum).toBe('100001');
    expect(s.error).toBe(0);
    const st = stateAt(s, Date.parse(`${rec(100001).EPOCH}Z`));
    expect(st).not.toBeNull();
    expect(finite(st)).toBe(true);
  });

  it('our fast path equals satellite.js propagate() + eciToGeodetic()', () => {
    const s = createSatrec(iss);
    const ours = stateAt(s, T);
    const date = new Date(T);
    const pv = satellite.propagate(createSatrec(iss), date);
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    expect(ours.lat).toBeCloseTo(satellite.degreesLat(g.latitude), 6);
    expect(ours.lng).toBeCloseTo(satellite.degreesLong(g.longitude), 6);
    expect(ours.alt).toBeCloseTo(g.height, 4);
  });

  it('julianDate matches satellite.js jday', () => {
    const d = new Date(T);
    expect(julianDate(T)).toBeCloseTo(satellite.jday(d), 9);
  });
});

describe('Coordinate conversion & physical plausibility', () => {
  it('ISS: valid lat/lng, ~400–440 km, ~7.66 km/s, |lat| ≤ inclination', () => {
    const s = createSatrec(iss);
    for (let k = 0; k < 200; k++) {
      const st = stateAt(s, T + k * 47_000);
      expect(st).not.toBeNull();
      expect(finite(st)).toBe(true);
      expect(Math.abs(st.lat)).toBeLessThanOrEqual(iss.INCLINATION + 0.3);
      expect(st.lng).toBeGreaterThanOrEqual(-180);
      expect(st.lng).toBeLessThan(180);
      expect(st.alt).toBeGreaterThan(390);
      expect(st.alt).toBeLessThan(450);
      expect(st.speed).toBeGreaterThan(7.6);
      expect(st.speed).toBeLessThan(7.75);
      // geocentric radius from ECI agrees with geodetic altitude to within Earth's flattening
      const r = Math.hypot(st.r.x, st.r.y, st.r.z);
      expect(Math.abs(r - 6371 - st.alt)).toBeLessThan(25);
    }
  });

  it('GEO satellite stays near the equator at ~35 786 km and ~3.07 km/s', () => {
    const geo = fixture.records.find((r) => r.groups.includes('GEO'));
    const s = createSatrec(geo);
    const t0 = Date.parse(`${geo.EPOCH}Z`);
    const a = stateAt(s, t0);
    const b = stateAt(s, t0 + 6 * 3600_000);
    expect(Math.abs(a.alt - 35_786)).toBeLessThan(150);
    expect(a.speed).toBeCloseTo(3.07, 1);
    expect(Math.abs(a.lat)).toBeLessThan(5);
    // geosynchronous: sub-satellite longitude nearly constant
    expect(Math.abs(wrapLng(a.lng - b.lng))).toBeLessThan(3);
  });

  it('propagateBatch writes the same values as stateAt and NaN for failures', () => {
    const satrecs = fixture.records.map(createSatrec);
    satrecs.push(null); // invalid entry
    const indices = Int32Array.from(satrecs.map((_, i) => i));
    const out = new Float64Array(indices.length * 4);
    const valid = propagateBatch(satrecs, indices, T, out);
    expect(valid).toBe(fixture.records.length);
    const st = stateAt(satrecs[0], T);
    expect(out[0]).toBeCloseTo(st.lat, 9);
    expect(out[1]).toBeCloseTo(st.lng, 9);
    expect(out[2]).toBeCloseTo(st.alt, 9);
    expect(out[3]).toBeCloseTo(st.speed, 9);
    const last = (indices.length - 1) * 4;
    expect([out[last], out[last + 1], out[last + 2], out[last + 3]].every(Number.isNaN)).toBe(true);
    for (let i = 0; i < last; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('returns null (never NaN) for a decayed / invalid propagation', () => {
    // very low orbit with huge drag propagated far from epoch → decays
    const bad = { ...iss, MEAN_MOTION: 16.4, BSTAR: 0.5, MEAN_MOTION_DOT: 0.05 };
    const s = createSatrec(bad);
    const st = s ? stateAt(s, issEpoch + 60 * 86400_000) : null;
    expect(st).toBeNull();
    expect(createSatrec({ ...iss, ECCENTRICITY: 1.5 })).toBeNull();
  });

  it('toCartesian matches three-globe polar2Cartesian conventions', () => {
    const p0 = toCartesian(0, 0, 0, 100);
    expect(p0.x).toBeCloseTo(0, 9);
    expect(p0.y).toBeCloseTo(0, 9);
    expect(p0.z).toBeCloseTo(100, 9);
    const pN = toCartesian(90, 0, 0, 100);
    expect(pN.y).toBeCloseTo(100, 9);
    const pE = toCartesian(0, 90, 1, 100);
    expect(pE.x).toBeCloseTo(200, 9);
  });

  it('renderAltitude: monotonic, true scale is proportional, ground mode is flat', () => {
    const alts = [200, 420, 550, 1200, 20_200, 35_786];
    for (const mode of ['compressed', 'true']) {
      const v = alts.map((a) => renderAltitude(a, mode));
      for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
    }
    expect(renderAltitude(6371, 'true')).toBeCloseTo(1, 9);
    expect(renderAltitude(420, 'ground')).toBe(renderAltitude(35_786, 'ground'));
    expect(renderAltitude(NaN, 'true')).toBe(0);
  });
});

describe('Trajectory', () => {
  const s = createSatrec(iss);

  it('orbit and ground track pass through the current position', () => {
    const tr = computeTrajectory(s, T, { samplesPerOrbit: 180 });
    const now = stateAt(s, T);
    const o0 = tr.orbit.find((q) => q.dt === 0);
    const g0 = tr.ground.find((q) => q.dt === 0);
    expect(o0.lat).toBeCloseTo(now.lat, 6);
    expect(o0.lng).toBeCloseTo(now.lng, 6);
    expect(g0.lat).toBeCloseTo(now.lat, 6);
    expect(g0.lng).toBeCloseTo(now.lng, 6);
    expect(tr.orbit.length).toBe(181);
    expect(tr.ground.length).toBe(361);
    expect(tr.periodMin).toBeCloseTo(periodMinutes(s), 9);
    expect(tr.ground.every((q) => finite(q))).toBe(true);
  });

  it('ground track shifts westward each orbit by ≈ period/sidereal-day × 360°', () => {
    const tr = computeTrajectory(s, T, { samplesPerOrbit: 180, groundPastOrbits: 0, groundFutureOrbits: 1 });
    const a = tr.ground[0];
    const b = tr.ground[tr.ground.length - 1]; // exactly one period later
    const shift = wrapLng(b.lng - a.lng);
    const expected = -(tr.periodMin / 1436.07) * 360; // ≈ −23.3° (plus small nodal regression)
    expect(Math.abs(b.lat - a.lat)).toBeLessThan(0.6);
    expect(Math.abs(shift - expected)).toBeLessThan(1.0);
  });

  it('changes consistently with simulation time', () => {
    const t1 = computeTrajectory(s, T);
    const t2 = computeTrajectory(s, T + 3600_000);
    const later = stateAt(s, T + 3600_000);
    const g = t2.ground.find((q) => q.dt === 0);
    expect(g.lat).toBeCloseTo(later.lat, 6);
    expect(g.lng).toBeCloseTo(later.lng, 6);
    // the same instant appears in both tracks (t1 at +60 min); allow interpolation-free sample match
    const step = t1.stepMin;
    const k = Math.round(60 / step);
    expect(t1.ground.find((q) => Math.abs(q.dt - k * step) < 1e-9)).toBeTruthy();
    expect(t1.ground[0].lng).not.toBeCloseTo(t2.ground[0].lng, 1);
  });
});

describe('Antimeridian handling', () => {
  it('splits a polyline crossing ±180° and interpolates the edge latitude', () => {
    const pts = [
      { lat: 10, lng: 170, dt: 0 },
      { lat: 12, lng: 178, dt: 1 },
      { lat: 14, lng: -174, dt: 2 },
      { lat: 16, lng: -166, dt: 3 },
    ];
    const segs = splitAtAntimeridian(pts);
    expect(segs.length).toBe(2);
    const endA = segs[0][segs[0].length - 1];
    const startB = segs[1][0];
    expect(endA.lng).toBe(180);
    expect(startB.lng).toBe(-180);
    expect(endA.lat).toBeCloseTo(12.5, 6); // 178° → 186° (unwrapped): edge is 2/8 of the way, 12 → 14
    expect(startB.lat).toBeCloseTo(endA.lat, 9);
    for (const seg of segs) for (let i = 1; i < seg.length; i++) expect(Math.abs(seg[i].lng - seg[i - 1].lng)).toBeLessThan(180);
  });

  it('handles eastward-to-westward crossing and real ground tracks', () => {
    const segs = splitAtAntimeridian([
      { lat: 0, lng: -179, dt: 0 },
      { lat: 1, lng: 179, dt: 1 },
    ]);
    expect(segs.length).toBe(2);
    expect(segs[0][1].lng).toBe(-180);
    const tr = computeTrajectory(createSatrec(iss), T);
    for (const seg of splitAtAntimeridian(tr.ground)) {
      for (let i = 1; i < seg.length; i++) expect(Math.abs(seg[i].lng - seg[i - 1].lng)).toBeLessThan(30);
    }
  });
});

describe('Sub-solar point', () => {
  it('declination ≈ 0° at the March 2024 equinox and ≈ +23.44° at the June solstice', () => {
    expect(Math.abs(subsolarPoint(Date.parse('2024-03-20T03:06:00Z')).lat)).toBeLessThan(0.1);
    expect(subsolarPoint(Date.parse('2024-06-20T20:51:00Z')).lat).toBeCloseTo(23.44, 1);
  });

  it('longitude follows UTC and the equation of time', () => {
    // 3 Nov: equation of time ≈ +16.4 min → solar noon at Greenwich ≈ 11:43.6 UTC,
    // so at 12:00 UTC the sub-solar point is ≈ 4.1° west.
    const p = subsolarPoint(Date.parse('2026-11-03T12:00:00Z'));
    expect(p.lng).toBeCloseTo(-4.1, 0);
    const q = subsolarPoint(Date.parse('2026-11-03T18:00:00Z'));
    expect(wrapLng(q.lng - p.lng)).toBeCloseTo(-90, 0);
  });
});
