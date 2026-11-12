import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchGroup, buildDataset, validateDataset, snapshotAgeMinutes } from '../scripts/lib/dataset.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/omm-sample.json', import.meta.url)));
const raw = (id) => {
  const { groups, ...omm } = fixture.records.find((r) => r.NORAD_CAT_ID === id);
  return omm;
};
const NOW = Date.parse('2026-11-12T06:00:00Z');
const GROUPS = [{ id: 'STATIONS' }, { id: 'AMATEUR' }, { id: 'STARLINK' }];

const ok = (records, fetchedAt = '2026-11-12T05:00:00.000Z') => ({ ok: true, httpStatus: 200, records, rejected: [], fetchedAt });
const fail = (httpStatus, error = `HTTP ${httpStatus}`) => ({ ok: false, httpStatus, error });

const mockFetch = (status, body, contentType = 'application/json') => async () => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: new Map([['content-type', contentType]]),
});

describe('fetchGroup (mocked HTTP)', () => {
  it('parses and validates a JSON array, rejecting malformed records', async () => {
    const r = await fetchGroup('STATIONS', {
      fetchImpl: mockFetch(200, [raw(25544), { OBJECT_NAME: 'BROKEN', NORAD_CAT_ID: 'x' }, raw(100001)]),
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.records.map((x) => x.NORAD_CAT_ID)).toEqual([25544, 100001]);
    expect(r.rejected.length).toBe(1);
    expect(r.url).toContain('GROUP=STATIONS&FORMAT=JSON');
  });

  it.each([
    [403, true],
    [429, true],
    [500, false],
    [503, false],
    [404, false],
  ])('HTTP %i → failure, stopAll=%s (no retries)', async (status, stop) => {
    let calls = 0;
    const r = await fetchGroup('STARLINK', {
      fetchImpl: async () => {
        calls++;
        return { status, text: async () => 'error' };
      },
    });
    expect(r.ok).toBe(false);
    expect(!!r.stopAll).toBe(stop);
    expect(calls).toBe(1);
  });

  it('treats CelesTrak plain-text answers (HTTP 200) as failures', async () => {
    const r = await fetchGroup('NOAA', { fetchImpl: mockFetch(200, 'Invalid query: "GROUP=NOAA&FORMAT=JSON" (GROUP=noaa not found)') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-JSON/);
  });

  it('reports network errors without throwing', async () => {
    const r = await fetchGroup('GPS-OPS', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOTFOUND');
  });
});

describe('buildDataset — merge, de-duplication and last-known-good fallback', () => {
  it('de-duplicates by NORAD id and keeps every group membership', () => {
    const ds = buildDataset({
      results: { STATIONS: ok([raw(25544)]), AMATEUR: ok([raw(25544), raw(27844)]), STARLINK: ok([raw(100001)]) },
      groups: GROUPS,
      now: NOW,
    });
    expect(ds.records.length).toBe(3);
    const issRec = ds.records.find((r) => r.NORAD_CAT_ID === 25544);
    expect(issRec.groups.sort()).toEqual(['AMATEUR', 'STATIONS']);
    expect(ds.meta.freshGroups).toBe(3);
    expect(ds.meta.recordCount).toBe(3);
    expect(ds.records.some((r) => r.NORAD_CAT_ID === 100001)).toBe(true);
    expect(ds.meta.lastSuccessfulFetch).toBe('2026-11-12T05:00:00.000Z');
  });

  it('keeps the newest element set when the same object appears twice', () => {
    const older = { ...raw(25544), EPOCH: '2026-11-10T00:00:00.000000', MEAN_ANOMALY: 1 };
    const newer = { ...raw(25544), EPOCH: '2026-11-11T00:00:00.000000', MEAN_ANOMALY: 2 };
    const ds = buildDataset({ results: { STATIONS: ok([older]), AMATEUR: ok([newer]) }, groups: GROUPS.slice(0, 2), now: NOW });
    expect(ds.records[0].MEAN_ANOMALY).toBe(2);
  });

  it('falls back to the previous snapshot for groups that failed', () => {
    const previous = buildDataset({
      results: { STATIONS: ok([raw(25544)], '2026-11-11T20:00:00.000Z'), AMATEUR: ok([raw(27844)]), STARLINK: ok([raw(100001)], '2026-11-11T20:00:00.000Z') },
      groups: GROUPS,
      now: NOW - 3600_000,
    });
    const ds = buildDataset({
      results: { STATIONS: ok([raw(25544)]), AMATEUR: ok([raw(27844)]), STARLINK: fail(429) },
      previous,
      groups: GROUPS,
      now: NOW,
    });
    const star = ds.meta.groups.find((g) => g.id === 'STARLINK');
    expect(star.status).toBe('cached');
    expect(star.fetchedAt).toBe('2026-11-11T20:00:00.000Z'); // true age preserved
    expect(star.error).toBe('HTTP 429');
    expect(ds.records.some((r) => r.NORAD_CAT_ID === 100001)).toBe(true);
    expect(ds.meta.oldestGroupFetch).toBe('2026-11-11T20:00:00.000Z');
  });

  it('marks a failed group without previous data as missing', () => {
    const ds = buildDataset({ results: { STATIONS: ok([raw(25544)]), AMATEUR: fail(500), STARLINK: fail(503) }, groups: GROUPS, now: NOW });
    expect(ds.meta.groups.map((g) => g.status)).toEqual(['fresh', 'missing', 'missing']);
  });
});

describe('validateDataset', () => {
  const ds = buildDataset({ results: { STATIONS: ok([raw(25544)]), AMATEUR: ok([raw(27844)]), STARLINK: ok([raw(100001)]) }, groups: GROUPS, now: NOW });

  it('accepts a sane dataset', () => {
    expect(validateDataset(ds, null, { minRecords: 1 }).ok).toBe(true);
  });

  it('rejects too few records, duplicates, or a suspicious drop vs. previous', () => {
    expect(validateDataset(ds, null, { minRecords: 100 }).ok).toBe(false);
    const dup = { ...ds, records: [...ds.records, ds.records[0]] };
    expect(validateDataset(dup, null, { minRecords: 1 }).reasons.join()).toMatch(/duplicate/);
    const prev = { records: Array.from({ length: 10 }, () => ds.records[0]) };
    expect(validateDataset(ds, prev, { minRecords: 1 }).reasons.join()).toMatch(/dropped/);
  });

  it('rejects a run where no group was refreshed', () => {
    const none = { ...ds, meta: { ...ds.meta, freshGroups: 0 } };
    expect(validateDataset(none, null, { minRecords: 1 }).ok).toBe(false);
  });

  it('computes snapshot age', () => {
    expect(snapshotAgeMinutes(ds, NOW)).toBeCloseTo(60, 6);
    expect(snapshotAgeMinutes(null, NOW)).toBe(Infinity);
  });
});
