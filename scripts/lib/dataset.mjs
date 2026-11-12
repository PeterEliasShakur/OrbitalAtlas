/**
 * Dataset construction helpers for scripts/fetch-orbits.mjs.
 * Pure functions (plus an injectable fetch) so they can be unit-tested.
 */
import { GROUPS, CELESTRAK, celestrakGroupUrl } from '../../src/config.js';
import { normalizeOmm, parseEpoch } from '../../src/omm.js';

export const SCHEMA_VERSION = 1;
const USER_AGENT = 'OrbitalAtlas-DataRefresh/1.0 (static educational satellite visualisation; runs every ~4 h)';

/**
 * Fetch one CelesTrak group exactly once (no retries — CelesTrak asks clients
 * not to hammer the service; failures fall back to the last-known-good data).
 */
export async function fetchGroup(groupId, { fetchImpl = globalThis.fetch, timeoutMs = 60_000, now = () => Date.now() } = {}) {
  const url = celestrakGroupUrl(groupId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const httpStatus = res.status;
    if (httpStatus !== 200) {
      return {
        ok: false,
        url,
        httpStatus,
        error: `HTTP ${httpStatus}`,
        // 403 / 429 mean "you are requesting too often" — stop the whole run.
        stopAll: httpStatus === 403 || httpStatus === 429,
      };
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // CelesTrak answers some conditions (e.g. "no new data since your last
      // download", unknown group) with plain text and HTTP 200.
      return { ok: false, url, httpStatus, error: `non-JSON response: ${text.slice(0, 120).trim()}` };
    }
    if (!Array.isArray(body)) return { ok: false, url, httpStatus, error: 'response is not a JSON array' };

    const fetchedAt = new Date(now()).toISOString();
    const records = [];
    const rejected = [];
    for (const raw of body) {
      const r = normalizeOmm(raw, { nowMs: now() });
      if (r.ok) records.push(r.record);
      else rejected.push({ id: raw?.NORAD_CAT_ID ?? null, reason: r.reason });
    }
    if (records.length === 0) {
      return { ok: false, url, httpStatus, error: `no valid records (${rejected.length} rejected)` };
    }
    return { ok: true, url, httpStatus, records, rejected, fetchedAt };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String(err?.message || err);
    return { ok: false, url, httpStatus: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge fresh group results with the previous snapshot.
 *  - Records are de-duplicated by NORAD_CAT_ID (the newest EPOCH wins).
 *  - Group membership is the union of the groups each object appeared in.
 *  - A group that failed this run keeps its previous members (status "cached").
 */
export function buildDataset({ results, previous, groups = GROUPS, now = Date.now() }) {
  const byId = new Map();
  const prevById = new Map();
  const prevGroupMeta = new Map();
  if (previous?.records) for (const r of previous.records) prevById.set(r.NORAD_CAT_ID, r);
  if (previous?.meta?.groups) for (const g of previous.meta.groups) prevGroupMeta.set(g.id, g);

  const upsert = (rec, groupId) => {
    const cur = byId.get(rec.NORAD_CAT_ID);
    if (!cur) {
      const { groups: _ignored, ...omm } = rec;
      byId.set(rec.NORAD_CAT_ID, { ...omm, groups: [groupId] });
      return;
    }
    if (!cur.groups.includes(groupId)) cur.groups.push(groupId);
    if (parseEpoch(rec.EPOCH) > parseEpoch(cur.EPOCH)) {
      const { groups: _ignored, ...omm } = rec;
      Object.assign(cur, omm);
    }
  };

  const groupMeta = [];
  for (const g of groups) {
    const res = results[g.id];
    const url = celestrakGroupUrl(g.id);
    if (res?.ok) {
      for (const rec of res.records) upsert(rec, g.id);
      groupMeta.push({
        id: g.id,
        url,
        status: 'fresh',
        httpStatus: res.httpStatus,
        count: res.records.length,
        rejected: res.rejected.length,
        fetchedAt: res.fetchedAt,
      });
      continue;
    }
    const prevMeta = prevGroupMeta.get(g.id);
    const prevMembers = previous?.records?.filter((r) => r.groups?.includes(g.id)) ?? [];
    if (prevMeta && prevMembers.length > 0) {
      for (const rec of prevMembers) upsert(rec, g.id);
      groupMeta.push({
        id: g.id,
        url,
        status: 'cached',
        httpStatus: res?.httpStatus ?? null,
        error: res?.error ?? 'not requested',
        count: prevMembers.length,
        fetchedAt: prevMeta.fetchedAt,
      });
    } else {
      groupMeta.push({
        id: g.id,
        url,
        status: 'missing',
        httpStatus: res?.httpStatus ?? null,
        error: res?.error ?? 'not requested',
        count: 0,
        fetchedAt: null,
      });
    }
  }

  const records = [...byId.values()].sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
  const fetchTimes = groupMeta.filter((g) => g.fetchedAt).map((g) => Date.parse(g.fetchedAt));
  const fresh = groupMeta.filter((g) => g.status === 'fresh');

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      lastSuccessfulFetch: fetchTimes.length ? new Date(Math.max(...fetchTimes)).toISOString() : null,
      oldestGroupFetch: fetchTimes.length ? new Date(Math.min(...fetchTimes)).toISOString() : null,
      source: {
        name: CELESTRAK.name,
        api: CELESTRAK.baseUrl,
        documentation: CELESTRAK.docsUrl,
        format: 'OMM JSON (CCSDS Orbit Mean-Elements Message), normalised',
      },
      freshGroups: fresh.length,
      totalGroups: groupMeta.length,
      recordCount: records.length,
      groups: groupMeta,
    },
    records,
  };
}

/** Sanity-check a dataset before it replaces the last-known-good snapshot. */
export function validateDataset(dataset, previous, { minRecords = 100, maxDropRatio = 0.5 } = {}) {
  const reasons = [];
  if (!dataset || !Array.isArray(dataset.records)) reasons.push('no records array');
  const n = dataset?.records?.length ?? 0;
  if (n < minRecords) reasons.push(`only ${n} records (minimum ${minRecords})`);
  const ids = new Set();
  for (const r of dataset?.records ?? []) {
    if (ids.has(r.NORAD_CAT_ID)) reasons.push(`duplicate NORAD_CAT_ID ${r.NORAD_CAT_ID}`);
    ids.add(r.NORAD_CAT_ID);
    if (!normalizeOmm(r).ok) reasons.push(`invalid record ${r.NORAD_CAT_ID}`);
    if (!Array.isArray(r.groups) || r.groups.length === 0) reasons.push(`record ${r.NORAD_CAT_ID} has no group`);
    if (reasons.length > 20) break;
  }
  const prevN = previous?.records?.length ?? 0;
  if (prevN > 0 && n < prevN * maxDropRatio) {
    reasons.push(`record count dropped from ${prevN} to ${n} (more than ${Math.round((1 - maxDropRatio) * 100)}%)`);
  }
  if (dataset?.meta?.freshGroups === 0) reasons.push('no group was refreshed in this run');
  return { ok: reasons.length === 0, reasons };
}

/** Minutes since the newest successful fetch in a snapshot (Infinity if unknown). */
export function snapshotAgeMinutes(snapshot, now = Date.now()) {
  const t = Date.parse(snapshot?.meta?.lastSuccessfulFetch ?? '');
  return Number.isFinite(t) ? (now - t) / 60_000 : Infinity;
}
