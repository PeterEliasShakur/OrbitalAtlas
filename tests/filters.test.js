import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { prepareCatalog, primaryCategory, constellationsOf, breakdown, fmt, fmtLat, fmtLng } from '../src/data-processing.js';
import {
  applyFilters,
  defaultFilterState,
  selectForRender,
  searchSuggestions,
  sliderToKm,
  kmToSlider,
} from '../src/satellite-filters.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/omm-sample.json', import.meta.url)));
const NOW = Date.parse('2026-11-12T06:00:00Z');
const catalog = prepareCatalog({ meta: {}, records: fixture.records }, { nowMs: NOW });
const sat = (id) => catalog.byId.get(id);

describe('catalog preparation (categories from CelesTrak groups only)', () => {
  it('loads every valid fixture record', () => {
    expect(catalog.sats.length).toBe(fixture.records.length);
    expect(catalog.rejected).toBe(0);
  });

  it('assigns primary categories by group priority', () => {
    expect(sat(25544).category).toBe('station'); // STATIONS + AMATEUR
    expect(sat(20580).category).toBe('science'); // HST in SCIENCE
    expect(sat(37846).category).toBe('nav'); // GALILEO + SARSAT
    expect(sat(26900).category).toBe('comms'); // INTELSAT + GEO
    expect(sat(100001).category).toBe('starlink');
    expect(sat(27844).category).toBe('comms'); // AMATEUR + CUBESAT → comms wins
    expect(primaryCategory(['UNKNOWN'])).toBeNull();
    expect(constellationsOf(['GALILEO', 'SARSAT'])).toEqual(['Galileo']);
  });

  it('skips malformed and duplicate records', () => {
    const c = prepareCatalog({ records: [fixture.records[0], fixture.records[0], { OBJECT_NAME: 'X' }, { ...fixture.records[1], groups: [] }] }, { nowMs: NOW });
    expect(c.sats.length).toBe(1);
    expect(c.rejected).toBe(3);
  });
});

describe('applyFilters', () => {
  const run = (patch) => applyFilters(catalog.sats, { ...defaultFilterState(), ...patch }).map((s) => s.id);

  it('default state matches everything', () => {
    expect(run({}).length).toBe(catalog.sats.length);
  });

  it('category filter', () => {
    expect(run({ categories: new Set(['station']) })).toEqual([25544]);
    expect(run({ categories: new Set() })).toEqual([]);
  });

  it('orbit-class filter', () => {
    const meo = run({ classes: new Set(['MEO']) });
    expect(meo).toContain(26407); // GPS
    expect(meo).toContain(37846); // Galileo
    expect(meo).not.toContain(25544);
    expect(run({ classes: new Set(['GEO']) })).toEqual([26900]);
  });

  it('altitude-range filter (mean altitude)', () => {
    const low = run({ altMin: 0, altMax: 600 });
    expect(low).toContain(25544);
    expect(low).not.toContain(26407);
    expect(run({ altMin: 30_000, altMax: Infinity })).toContain(26900);
  });

  it('constellation filter', () => {
    expect(run({ constellations: new Set(['GPS']) })).toEqual([26407]);
    expect(run({ constellations: new Set(['Starlink', 'OneWeb']) }).sort()).toEqual([44057, 100001].sort());
  });

  it('search by name, designator, NORAD id and six-digit id', () => {
    expect(run({ query: 'iss' })).toContain(25544);
    expect(run({ query: 'HST' })).toEqual([20580]);
    expect(run({ query: '1998-067' })).toEqual([25544]);
    expect(run({ query: '25544' })).toEqual([25544]);
    expect(run({ query: '100001' })).toEqual([100001]);
    expect(run({ query: 'gps prn' })).toEqual([26407]);
    expect(run({ query: 'definitely-not-a-satellite' })).toEqual([]);
  });

  it('filters combine with AND', () => {
    expect(run({ categories: new Set(['nav']), query: 'galileo' })).toEqual([37846]);
    expect(run({ categories: new Set(['station']), query: 'gps' })).toEqual([]);
  });
});

describe('selectForRender (render limit)', () => {
  // synthetic population: 1 big category + several small ones
  const mk = (n, category, start) => Array.from({ length: n }, (_, i) => ({ idx: start + i, category }));
  const big = mk(10_000, 'starlink', 0);
  const small = [...mk(30, 'nav', 10_000), ...mk(19, 'station', 10_030), ...mk(400, 'comms', 10_049)];
  const all = [...big, ...small];

  it('returns everything below the limit', () => {
    expect(selectForRender(small, 1000).length).toBe(small.length);
  });

  it('respects the limit, keeps small categories complete and sub-samples the large one evenly', () => {
    const out = selectForRender(all, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.length).toBeGreaterThan(1990);
    const count = (c) => out.filter((s) => s.category === c).length;
    expect(count('nav')).toBe(30);
    expect(count('station')).toBe(19);
    expect(count('comms')).toBe(400);
    const star = out.filter((s) => s.category === 'starlink').map((s) => s.idx);
    expect(star[0]).toBe(0);
    expect(star[star.length - 1]).toBeGreaterThan(9000); // spread over the whole list
  });

  it('always includes must-include satellites (e.g. the selection)', () => {
    const chosen = big[1234];
    const out = selectForRender(all, 500, [chosen]);
    expect(out.includes(chosen)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('search suggestions & helpers', () => {
  it('ranks exact NORAD id first', () => {
    expect(searchSuggestions(catalog.sats, '25544')[0].id).toBe(25544);
    expect(searchSuggestions(catalog.sats, 'hst')[0].id).toBe(20580);
    expect(searchSuggestions(catalog.sats, '')).toEqual([]);
  });

  it('altitude slider mapping round-trips', () => {
    for (const km of [0, 400, 2000, 20_200, 35_786]) expect(Math.abs(sliderToKm(kmToSlider(km)) - km)).toBeLessThan(200);
    expect(kmToSlider(Infinity)).toBe(1000);
  });

  it('breakdown counts and formatters never print NaN', () => {
    const b = breakdown(catalog.sats);
    expect(Object.values(b.byCategory).reduce((a, c) => a + c, 0)).toBe(catalog.sats.length);
    expect(fmt(NaN)).toBe('—');
    expect(fmt(Infinity)).toBe('—');
    expect(fmtLat(-12.3456)).toBe('12.346° S');
    expect(fmtLng(NaN)).toBe('—');
  });
});
