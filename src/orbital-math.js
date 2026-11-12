/**
 * Orbital mechanics: OMM → SGP4 satrec → ECI → geodetic.
 *
 * Built on satellite.js 7.x (SGP4/SDP4). Units throughout:
 *   - positions: km, velocities: km/s (ECI, TEME frame from SGP4)
 *   - angles: radians internally, degrees for display
 *   - times: JavaScript epoch milliseconds (UTC)
 */
import {
  json2satrec,
  sgp4,
  gstime,
  eciToGeodetic,
  jday,
  sunPos,
  checkForDecay,
} from 'satellite.js';
import { EARTH_RADIUS_KM } from './config.js';

const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** Lowest/highest altitude we accept as a physically meaningful propagated state. */
export const MIN_VALID_ALT_KM = 80;
export const MAX_VALID_ALT_KM = 400_000;

/** Julian date (UT1≈UTC) from epoch milliseconds. Equivalent to satellite.js `jday(date)`. */
export function julianDate(ms) {
  return ms / 86_400_000 + 2_440_587.5;
}

/** Greenwich mean sidereal time (rad) for epoch milliseconds. */
export function gmstAt(ms) {
  return gstime(julianDate(ms));
}

/**
 * Create a satrec from an OMM JSON record. Returns null when the elements
 * cannot be initialised (satellite.js sets `satrec.error`).
 */
export function createSatrec(omm) {
  try {
    const satrec = json2satrec(omm);
    if (!satrec || satrec.error) return null;
    return satrec;
  } catch {
    return null;
  }
}

/** Normalise a longitude to [-180, 180). */
export function wrapLng(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * SGP4 state at a Julian date. Returns `{ r, v }` (ECI km, km/s) or null on
 * propagation failure / decay / non-finite output.
 */
export function eciState(satrec, jd) {
  const tsince = (jd - satrec.jdsatepoch) * 1440;
  let pv;
  try {
    pv = sgp4(satrec, tsince);
  } catch {
    return null;
  }
  if (!pv || !pv.position || !pv.velocity) return null;
  if (checkForDecay(satrec)) return null;
  const r = pv.position;
  const v = pv.velocity;
  if (!Number.isFinite(r.x + r.y + r.z + v.x + v.y + v.z)) return null;
  return { r, v };
}

/**
 * Geodetic state from an ECI state. Returns null when the result is not
 * physically meaningful (e.g. below 80 km — the object has decayed).
 */
export function geodeticFromEci(r, gmst) {
  const g = eciToGeodetic(r, gmst);
  const lat = g.latitude * RAD2DEG;
  const lng = wrapLng(g.longitude * RAD2DEG);
  const alt = g.height;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(alt)) return null;
  if (alt < MIN_VALID_ALT_KM || alt > MAX_VALID_ALT_KM) return null;
  return { lat, lng, alt };
}

/**
 * Full calculated state of a satellite at a UTC time.
 * @returns {{lat:number,lng:number,alt:number,speed:number,r:object,v:object}|null}
 */
export function stateAt(satrec, ms) {
  const jd = julianDate(ms);
  const s = eciState(satrec, jd);
  if (!s) return null;
  const g = geodeticFromEci(s.r, gstime(jd));
  if (!g) return null;
  const speed = Math.hypot(s.v.x, s.v.y, s.v.z);
  if (!(speed > 0 && speed < 12)) return null;
  return { ...g, speed, r: s.r, v: s.v };
}

/**
 * Propagate many satellites at once (used by the Web Worker).
 * Writes [lat, lng, alt, speed] per satellite into `out` (NaN on failure).
 * @returns number of valid states
 */
export function propagateBatch(satrecs, indices, ms, out) {
  const jd = julianDate(ms);
  const gmst = gstime(jd);
  let valid = 0;
  for (let k = 0; k < indices.length; k++) {
    const satrec = satrecs[indices[k]];
    const o = k * 4;
    let ok = false;
    if (satrec) {
      const s = eciState(satrec, jd);
      if (s) {
        const g = geodeticFromEci(s.r, gmst);
        const speed = Math.hypot(s.v.x, s.v.y, s.v.z);
        if (g && speed > 0 && speed < 12) {
          out[o] = g.lat;
          out[o + 1] = g.lng;
          out[o + 2] = g.alt;
          out[o + 3] = speed;
          ok = true;
          valid++;
        }
      }
    }
    if (!ok) out[o] = out[o + 1] = out[o + 2] = out[o + 3] = NaN;
  }
  return valid;
}

/** Orbital period (minutes) from SGP4's Kozai mean motion `no` (rad/min). */
export function periodMinutes(satrec) {
  return TWO_PI / satrec.no;
}

/**
 * Compute the trajectory of one satellite around time `centerMs`.
 *
 *  - `orbit`: the orbital path in space — one full revolution of propagated
 *    ECI positions (half before, half after `centerMs`), expressed in the
 *    Earth-fixed frame *at* `centerMs`. This is how the orbit looks in space at
 *    that instant (the satellite sits on it; Earth rotates underneath).
 *  - `ground`: the ground track — sub-satellite points, each one using the
 *    sidereal time of its own sample time, so Earth's rotation is included.
 *
 * Every point carries `dt` (minutes relative to centerMs); negative = past.
 */
export function computeTrajectory(satrec, centerMs, {
  samplesPerOrbit = 180,
  groundPastOrbits = 0.5,
  groundFutureOrbits = 1.5,
} = {}) {
  const P = periodMinutes(satrec);
  if (!Number.isFinite(P) || P <= 0) return null;
  const step = P / samplesPerOrbit; // minutes
  const gmstCenter = gmstAt(centerMs);

  const orbit = [];
  for (let i = -samplesPerOrbit / 2; i <= samplesPerOrbit / 2; i++) {
    const dt = i * step;
    const s = eciState(satrec, julianDate(centerMs + dt * 60_000));
    if (!s) continue;
    const g = geodeticFromEci(s.r, gmstCenter);
    if (g) orbit.push({ ...g, dt });
  }

  const ground = [];
  const n0 = Math.round(-groundPastOrbits * samplesPerOrbit);
  const n1 = Math.round(groundFutureOrbits * samplesPerOrbit);
  for (let i = n0; i <= n1; i++) {
    const dt = i * step;
    const ms = centerMs + dt * 60_000;
    const jd = julianDate(ms);
    const s = eciState(satrec, jd);
    if (!s) continue;
    const g = geodeticFromEci(s.r, gstime(jd));
    if (g) ground.push({ ...g, dt });
  }

  return { periodMin: P, stepMin: step, centerMs, orbit, ground };
}

/**
 * Split a lat/lng polyline into segments wherever it crosses the
 * antimeridian (±180°), inserting interpolated edge points so that 2D map
 * renderings never draw a line across the whole map.
 */
export function splitAtAntimeridian(points) {
  const segments = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const d = p.lng - prev.lng;
      if (Math.abs(d) > 180) {
        // crossing: unwrap, find latitude at ±180
        const sign = d > 0 ? -1 : 1; // prev near +180 → crossing at +180 when d<0
        const lngUnwrapped = p.lng + sign * 360;
        const edge = sign > 0 ? 180 : -180;
        const f = (edge - prev.lng) / (lngUnwrapped - prev.lng);
        const lat = prev.lat + f * (p.lat - prev.lat);
        const dt = prev.dt + f * (p.dt - prev.dt);
        cur.push({ ...prev, lat, lng: edge, dt, edge: true });
        segments.push(cur);
        cur = [{ ...p, lat, lng: -edge, dt, edge: true }];
      }
    }
    cur.push(p);
  }
  if (cur.length) segments.push(cur);
  return segments;
}

/**
 * Sub-solar point (lat/lng degrees) at a UTC time, from satellite.js's
 * solar ephemeris (right ascension / declination) and GMST.
 */
export function subsolarPoint(ms) {
  const jd = julianDate(ms);
  const { rtasc, decl } = sunPos(jd);
  const lng = wrapLng((rtasc - gstime(jd)) * RAD2DEG);
  return { lat: decl * RAD2DEG, lng };
}

/**
 * Rendering altitude (fraction of Earth radius) for a real altitude in km.
 * `compressed` uses a square-root law so LEO shells stay distinguishable
 * while GEO remains within view. Real altitudes are always displayed
 * separately in the UI.
 */
export function renderAltitude(altKm, mode) {
  if (!(altKm >= 0)) return 0;
  if (mode === 'ground') return 0.0035;
  const ratio = altKm / EARTH_RADIUS_KM;
  if (mode === 'true') return ratio;
  return 0.5 * Math.sqrt(ratio);
}

/** Same mapping as three-globe's polar2Cartesian (lat/lng degrees, alt in radii). */
export function toCartesian(lat, lng, alt, radius = 100, out = {}) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = radius * (1 + alt);
  const sp = Math.sin(phi);
  out.x = r * sp * Math.cos(theta);
  out.y = r * Math.cos(phi);
  out.z = r * sp * Math.sin(theta);
  return out;
}

/** Epoch age in days of an element set relative to `ms`. */
export function elementAgeDays(epochMs, ms) {
  return (ms - epochMs) / 86_400_000;
}

export { jday };
