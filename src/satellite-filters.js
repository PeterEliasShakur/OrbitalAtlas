/**
 * Satellite filtering and render-set selection.
 */
import { CATEGORIES, ORBIT_CLASS } from './config.js';

export const ALT_SLIDER_MAX_KM = 40_000;

export function defaultFilterState() {
  return {
    categories: new Set(Object.keys(CATEGORIES)),
    classes: new Set(Object.keys(ORBIT_CLASS)),
    altMin: 0,
    altMax: Infinity,
    constellations: new Set(), // empty → no constellation restriction
    query: '',
  };
}

/** Parse a search query into a matcher function. */
export function makeQueryMatcher(query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    // NORAD catalog number: exact or prefix match (works for 6+ digit IDs)
    return (s) => String(s.id).startsWith(q) || s.nameLc.includes(q);
  }
  const terms = q.split(/\s+/).filter(Boolean);
  return (s) => terms.every((t) => s.nameLc.includes(t) || (s.intlDes && s.intlDes.toLowerCase().includes(t)));
}

/** Apply every filter; returns the matching satellites (catalog order). */
export function applyFilters(sats, state) {
  const match = makeQueryMatcher(state.query);
  const lo = Number.isFinite(state.altMin) ? state.altMin : -Infinity;
  const hi = Number.isFinite(state.altMax) ? state.altMax : Infinity;
  const cons = state.constellations;
  const out = [];
  for (const s of sats) {
    if (!state.categories.has(s.category)) continue;
    if (!state.classes.has(s.orbitClass)) continue;
    if (s.meanAltKm < lo || s.meanAltKm > hi) continue;
    if (cons.size > 0 && !s.constellations.some((c) => cons.has(c))) continue;
    if (match && !match(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * Choose which matching satellites to actually render when there are more
 * than `limit`. Uses "water-filling" so small categories are shown in full
 * and large ones (e.g. Starlink) are evenly sub-sampled with the remainder.
 * Satellites in `mustInclude` (e.g. the selected one) are always kept.
 */
export function selectForRender(matching, limit, mustInclude = []) {
  if (matching.length <= limit) return matching.slice();
  const must = new Set(mustInclude.filter(Boolean).map((s) => s.idx));
  const groups = new Map();
  for (const s of matching) {
    if (must.has(s.idx)) continue;
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  let budget = Math.max(0, limit - must.size);
  const ordered = [...groups.values()].sort((a, b) => a.length - b.length);
  const chosen = matching.filter((s) => must.has(s.idx));
  for (let i = 0; i < ordered.length; i++) {
    const list = ordered[i];
    const share = Math.floor(budget / (ordered.length - i));
    const take = Math.min(list.length, share);
    if (take >= list.length) chosen.push(...list);
    else if (take > 0) {
      const stride = list.length / take;
      for (let k = 0; k < take; k++) chosen.push(list[Math.floor(k * stride)]);
    }
    budget -= take;
  }
  chosen.sort((a, b) => a.idx - b.idx);
  return chosen;
}

/** Mapping between the altitude slider position (0..1000) and km (quadratic, so LEO gets resolution). */
export function sliderToKm(v) {
  const f = Math.min(1, Math.max(0, v / 1000));
  return Math.round(f * f * ALT_SLIDER_MAX_KM);
}
export function kmToSlider(km) {
  if (!Number.isFinite(km)) return 1000;
  return Math.round(Math.sqrt(Math.min(1, Math.max(0, km / ALT_SLIDER_MAX_KM))) * 1000);
}

/** Search suggestions: best matches first (exact id, name prefix, then substring). */
export function searchSuggestions(sats, query, max = 8) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [];
  const match = makeQueryMatcher(q);
  const scored = [];
  for (const s of sats) {
    if (!match(s)) continue;
    let score = 3;
    if (String(s.id) === q) score = 0;
    else if (s.nameLc === q) score = 0.5;
    else if (s.nameLc.startsWith(q)) score = 1;
    else if (s.category === 'station') score = 2;
    scored.push([score, s]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].id - b[1].id);
  return scored.slice(0, max).map((x) => x[1]);
}
