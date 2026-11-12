/**
 * OMM (Orbit Mean-Elements Message) record validation & normalisation.
 *
 * Shared by the browser and by scripts/fetch-orbits.mjs. Works on CelesTrak's
 * OMM JSON format (https://celestrak.org/NORAD/documentation/gp-data-formats.php).
 *
 * NORAD catalog numbers are treated as plain integers of arbitrary width, so
 * six-digit (and larger) identifiers — which no longer fit the classic
 * five-column TLE field — are handled without any Alpha-5 conversion.
 */

const NUMERIC_FIELDS = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
];

/** Fields carried into the normalised dataset (all are real OMM fields). */
export const OMM_FIELDS = [
  'OBJECT_NAME',
  'OBJECT_ID',
  'NORAD_CAT_ID',
  'EPOCH',
  ...NUMERIC_FIELDS,
  'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE',
  'ELEMENT_SET_NO',
  'REV_AT_EPOCH',
];

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Parse an OMM EPOCH (UTC, usually without a trailing Z) into epoch milliseconds. */
export function parseEpoch(epoch) {
  if (typeof epoch !== 'string' || epoch.length < 10) return NaN;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(epoch) ? epoch : `${epoch}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Validate a raw OMM object. Returns `{ ok: true, record }` with a normalised
 * copy, or `{ ok: false, reason }`.
 */
export function normalizeOmm(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not an object' };
  }
  const name = typeof raw.OBJECT_NAME === 'string' ? raw.OBJECT_NAME.trim() : '';
  if (!name) return { ok: false, reason: 'missing OBJECT_NAME' };

  const id = toNumber(raw.NORAD_CAT_ID);
  if (!Number.isInteger(id) || id <= 0 || id > 999_999_999) {
    return { ok: false, reason: `invalid NORAD_CAT_ID (${raw.NORAD_CAT_ID})` };
  }

  const epochMs = parseEpoch(raw.EPOCH);
  if (!Number.isFinite(epochMs)) return { ok: false, reason: 'invalid EPOCH' };
  const minEpoch = Date.UTC(1957, 9, 4);
  if (epochMs < minEpoch || epochMs > nowMs + 3 * 86400_000) {
    return { ok: false, reason: 'EPOCH out of range' };
  }

  const rec = {
    OBJECT_NAME: name,
    OBJECT_ID: typeof raw.OBJECT_ID === 'string' ? raw.OBJECT_ID.trim() : '',
    NORAD_CAT_ID: id,
    EPOCH: String(raw.EPOCH),
  };

  for (const f of NUMERIC_FIELDS) {
    let v = toNumber(raw[f]);
    if ((f === 'MEAN_MOTION_DOT' || f === 'MEAN_MOTION_DDOT') && raw[f] == null) v = 0;
    if (!Number.isFinite(v)) return { ok: false, reason: `non-numeric ${f}` };
    rec[f] = v;
  }

  if (!(rec.MEAN_MOTION > 0.05 && rec.MEAN_MOTION < 20)) return { ok: false, reason: 'MEAN_MOTION out of range' };
  if (!(rec.ECCENTRICITY >= 0 && rec.ECCENTRICITY < 1)) return { ok: false, reason: 'ECCENTRICITY out of range' };
  if (!(rec.INCLINATION >= 0 && rec.INCLINATION <= 180)) return { ok: false, reason: 'INCLINATION out of range' };
  for (const f of ['RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY']) {
    if (!(rec[f] >= 0 && rec[f] <= 360)) return { ok: false, reason: `${f} out of range` };
  }

  // Optional integer / string fields: copy only when valid.
  for (const f of ['EPHEMERIS_TYPE', 'ELEMENT_SET_NO', 'REV_AT_EPOCH']) {
    const v = toNumber(raw[f]);
    if (Number.isFinite(v)) rec[f] = v;
  }
  if (typeof raw.CLASSIFICATION_TYPE === 'string') rec.CLASSIFICATION_TYPE = raw.CLASSIFICATION_TYPE;

  return { ok: true, record: rec };
}

/**
 * Derived orbital quantities from mean elements (Kepler, two-body). These are
 * *approximate* and only used for classification / filtering, never in place
 * of the SGP4-propagated state.
 */
export function deriveOrbit(rec, mu = 398600.8, earthRadius = 6378.135) {
  const n = rec.MEAN_MOTION; // rev/day
  const periodMin = 1440 / n;
  const nRad = (n * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(mu / (nRad * nRad)); // km
  const e = rec.ECCENTRICITY;
  const perigeeKm = a * (1 - e) - earthRadius;
  const apogeeKm = a * (1 + e) - earthRadius;
  return { periodMin, semiMajorKm: a, perigeeKm, apogeeKm, meanAltKm: a - earthRadius };
}

/** Approximate orbit class from mean elements. */
export function classifyOrbit({ periodMin, perigeeKm, apogeeKm }, ecc) {
  if (Math.abs(periodMin - 1436.07) / 1436.07 < 0.03 && ecc < 0.05) return 'GEO';
  if (ecc > 0.25) return 'OTHER'; // highly elliptical (Molniya, GTO, HEO…)
  if (apogeeKm < 2000) return 'LEO';
  if (perigeeKm >= 2000 && apogeeKm < 35586) return 'MEO';
  return 'OTHER';
}
