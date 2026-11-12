/**
 * Turns the normalised dataset (public/data/orbits.json) into the in-memory
 * satellite catalog used by the UI. Category and constellation come *only*
 * from CelesTrak group membership recorded by the refresh script.
 */
import { CATEGORIES, GROUP_BY_ID, ORBIT_CLASS } from './config.js';
import { normalizeOmm, deriveOrbit, classifyOrbit, parseEpoch } from './omm.js';

/** Primary display category from group membership (lowest priority number wins). */
export function primaryCategory(groups) {
  let best = null;
  for (const g of groups) {
    const cat = GROUP_BY_ID[g]?.category;
    if (!cat) continue;
    if (best === null || CATEGORIES[cat].priority < CATEGORIES[best].priority) best = cat;
  }
  return best;
}

export function constellationsOf(groups) {
  const out = [];
  for (const g of groups) {
    const c = GROUP_BY_ID[g]?.constellation;
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * @param {object} dataset parsed orbits.json
 * @returns {{ sats: object[], byId: Map<number, object>, rejected: number, meta: object }}
 */
export function prepareCatalog(dataset, { nowMs = Date.now() } = {}) {
  if (!dataset || !Array.isArray(dataset.records)) throw new Error('Dataset has no records array');
  const sats = [];
  const byId = new Map();
  let rejected = 0;

  for (const raw of dataset.records) {
    const res = normalizeOmm(raw, { nowMs });
    if (!res.ok) {
      rejected++;
      continue;
    }
    const omm = res.record;
    if (byId.has(omm.NORAD_CAT_ID)) {
      rejected++; // duplicates should never occur — the refresh script de-duplicates
      continue;
    }
    const groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => GROUP_BY_ID[g]) : [];
    const category = primaryCategory(groups);
    if (!category) {
      rejected++;
      continue;
    }
    const d = deriveOrbit(omm);
    if (!Number.isFinite(d.periodMin) || !Number.isFinite(d.perigeeKm)) {
      rejected++;
      continue;
    }
    const sat = {
      idx: sats.length,
      id: omm.NORAD_CAT_ID,
      name: omm.OBJECT_NAME,
      nameLc: omm.OBJECT_NAME.toLowerCase(),
      intlDes: omm.OBJECT_ID || null,
      groups,
      category,
      constellations: constellationsOf(groups),
      epochMs: parseEpoch(omm.EPOCH),
      periodMin: d.periodMin,
      perigeeKm: d.perigeeKm,
      apogeeKm: d.apogeeKm,
      meanAltKm: d.meanAltKm,
      orbitClass: classifyOrbit(d, omm.ECCENTRICITY),
      omm,
    };
    sats.push(sat);
    byId.set(sat.id, sat);
  }
  return { sats, byId, rejected, meta: dataset.meta ?? {} };
}

/** Counts per category / orbit class / constellation over a list of satellites. */
export function breakdown(sats) {
  const byCategory = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  const byClass = Object.fromEntries(Object.keys(ORBIT_CLASS).map((k) => [k, 0]));
  const byConstellation = {};
  for (const s of sats) {
    byCategory[s.category]++;
    byClass[s.orbitClass]++;
    for (const c of s.constellations) byConstellation[c] = (byConstellation[c] ?? 0) + 1;
  }
  return { byCategory, byClass, byConstellation };
}

/** Human-friendly duration ("3 h 12 min", "4.2 d"). */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  const a = Math.abs(ms);
  const min = a / 60_000;
  let s;
  if (min < 1) s = `${Math.round(a / 1000)} s`;
  else if (min < 60) s = `${Math.round(min)} min`;
  else if (min < 48 * 60) s = `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
  else s = `${(min / 1440).toFixed(1)} d`;
  return neg ? `in ${s}` : s;
}

/** Format a number safely — never prints NaN/Infinity. */
export function fmt(v, digits = 2, unit = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (Number(v.toFixed(digits)) === 0) v = 0; // no "-0.0"
  const s = v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return unit ? `${s} ${unit}` : s;
}

export function fmtInt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtLat(lat) {
  if (!Number.isFinite(lat)) return '—';
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}`;
}

export function fmtLng(lng) {
  if (!Number.isFinite(lng)) return '—';
  return `${Math.abs(lng).toFixed(3)}° ${lng >= 0 ? 'E' : 'W'}`;
}

export function fmtUtc(ms, withSeconds = true) {
  if (!Number.isFinite(ms)) return '—';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)} UTC`;
}
