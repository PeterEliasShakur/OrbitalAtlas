/**
 * Orbital Atlas — shared configuration.
 *
 * This module is pure data so it can be imported both by the browser
 * application and by the Node.js data-refresh script (scripts/fetch-orbits.mjs).
 */

/** CelesTrak GP (General Perturbations) API. */
export const CELESTRAK = {
  name: 'CelesTrak',
  // CELESTRAK_BASE_URL may be set (Node only) to point the refresh script at a test server.
  baseUrl: globalThis.process?.env?.CELESTRAK_BASE_URL || 'https://celestrak.org/NORAD/elements/gp.php',
  docsUrl: 'https://celestrak.org/NORAD/documentation/gp-data-formats.php',
  /** CelesTrak typically updates GP data every ~2 h; never fetch the same group more often. */
  minRefreshMinutes: 120,
};

export function celestrakGroupUrl(group) {
  return `${CELESTRAK.baseUrl}?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`;
}

/** WhereTheISS.at live position API (browser-side, CORS-enabled). */
export const ISS_API = {
  name: 'WhereTheISS.at',
  url: 'https://api.wheretheiss.at/v1/satellites/25544',
  docsUrl: 'https://wheretheiss.at/w/developer',
  pollMs: 30_000,
  noradId: 25544,
};

/**
 * Display categories. A satellite's *primary* category is derived only from
 * the CelesTrak groups it was downloaded from (never from its name), using
 * the `priority` order below (lower number wins).
 */
export const CATEGORIES = {
  // Colours: validated categorical palette (dark steps), assigned in its
  // CVD-safe slot order. Starlink uses a neutral slate so the ~11 000-object
  // mega-constellation does not visually drown the other categories.
  comms:    { label: 'Communications',         color: '#3987e5', priority: 4, order: 0 },
  geo:      { label: 'Geosynchronous (other)', color: '#d95926', priority: 7, order: 1 },
  weather:  { label: 'Weather & Earth obs.',   color: '#199e70', priority: 3, order: 2 },
  nav:      { label: 'Navigation (GNSS)',      color: '#c98500', priority: 2, order: 3 },
  oneweb:   { label: 'OneWeb',                 color: '#d55181', priority: 6, order: 4 },
  other:    { label: 'CubeSats & recent',      color: '#008300', priority: 8, order: 5 },
  science:  { label: 'Science & geodesy',      color: '#9085e9', priority: 1, order: 6 },
  station:  { label: 'Space stations',         color: '#e66767', priority: 0, order: 7 },
  starlink: { label: 'Starlink',               color: '#8793a8', priority: 5, order: 8 },
};

/**
 * CelesTrak groups that are downloaded. `id` is the exact CelesTrak GROUP name
 * (verified against the live API). `constellation` marks groups that make sense
 * as a constellation filter.
 */
export const GROUPS = [
  { id: 'STATIONS',     label: 'Space stations',         category: 'station' },
  { id: 'SCIENCE',      label: 'Space & Earth science',  category: 'science' },
  { id: 'GEODETIC',     label: 'Geodetic',               category: 'science' },
  { id: 'GPS-OPS',      label: 'GPS (operational)',      category: 'nav', constellation: 'GPS' },
  { id: 'GLO-OPS',      label: 'GLONASS (operational)',  category: 'nav', constellation: 'GLONASS' },
  { id: 'GALILEO',      label: 'Galileo',                category: 'nav', constellation: 'Galileo' },
  { id: 'BEIDOU',       label: 'BeiDou',                 category: 'nav', constellation: 'BeiDou' },
  { id: 'SBAS',         label: 'SBAS augmentation',      category: 'nav' },
  { id: 'WEATHER',      label: 'Weather',                category: 'weather' },
  { id: 'GOES',         label: 'GOES',                   category: 'weather' },
  { id: 'RESOURCE',     label: 'Earth resources',        category: 'weather' },
  { id: 'SARSAT',       label: 'Search & rescue',        category: 'weather' },
  { id: 'PLANET',       label: 'Planet',                 category: 'weather', constellation: 'Planet' },
  { id: 'SPIRE',        label: 'Spire',                  category: 'weather', constellation: 'Spire' },
  { id: 'IRIDIUM-NEXT', label: 'Iridium NEXT',           category: 'comms', constellation: 'Iridium NEXT' },
  { id: 'GLOBALSTAR',   label: 'Globalstar',             category: 'comms', constellation: 'Globalstar' },
  { id: 'ORBCOMM',      label: 'ORBCOMM',                category: 'comms', constellation: 'ORBCOMM' },
  { id: 'INTELSAT',     label: 'Intelsat',               category: 'comms', constellation: 'Intelsat' },
  { id: 'SES',          label: 'SES',                    category: 'comms', constellation: 'SES' },
  { id: 'AMATEUR',      label: 'Amateur radio',          category: 'comms' },
  { id: 'STARLINK',     label: 'Starlink',               category: 'starlink', constellation: 'Starlink' },
  { id: 'ONEWEB',       label: 'OneWeb',                 category: 'oneweb', constellation: 'OneWeb' },
  { id: 'CUBESAT',      label: 'CubeSats',               category: 'other', constellation: 'CubeSats' },
  { id: 'GEO',          label: 'Active geosynchronous',  category: 'geo' },
  { id: 'LAST-30-DAYS', label: 'Launched in last 30 days', category: 'other', constellation: 'Last 30 days' },
];

export const GROUP_BY_ID = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

/** Physical constants (WGS-72 values used by SGP4 where relevant). */
export const EARTH_RADIUS_KM = 6371.0; // mean radius, used for display scaling
export const EARTH_EQ_RADIUS_KM = 6378.135; // WGS-72 equatorial radius (SGP4)
export const MU_EARTH = 398600.8; // km^3/s^2 (WGS-72)
export const SIDEREAL_DAY_MIN = 1436.0682;

/** Approximate orbit-class thresholds (km). */
export const ORBIT_CLASS = {
  LEO: { label: 'LEO', name: 'Low Earth orbit', desc: 'apogee below 2 000 km' },
  MEO: { label: 'MEO', name: 'Medium Earth orbit', desc: 'perigee ≥ 2 000 km, apogee below 35 586 km, e ≤ 0.25' },
  GEO: { label: 'GEO', name: 'Geosynchronous', desc: 'period within ±3% of a sidereal day, e < 0.05' },
  OTHER: { label: 'Other', name: 'Other / highly elliptical', desc: 'eccentricity > 0.25, or between/beyond the other classes' },
};

/** Rendering / performance defaults. */
export const RENDER = {
  defaultLimit: 4000,
  maxLimit: 20000,
  globeRadius: 100, // three-globe's internal globe radius (scene units)
  trajectorySamplesPerOrbit: 180,
  groundTrackOrbits: 1.5, // future, in orbital periods (past uses 0.5)
  labelCount: 24,
};

/** Simulation window: how far from "now" the timeline can go. */
export const TIMELINE = {
  windowHours: 24,
  speeds: [1, 10, 60, 600],
  /** Element sets older than this (relative to the simulated time) are flagged as stale. */
  staleElementDays: 14,
  /** Dataset older than this triggers a global stale-data warning. */
  staleDatasetHours: 48,
};

export const ALTITUDE_MODES = {
  compressed: {
    label: 'Compressed',
    note: 'Logarithmic altitude compression — LEO enlarged, GEO pulled inwards. Not to scale.',
  },
  true: {
    label: 'True scale',
    note: 'Rendered altitude is proportional to real altitude (1 : 1 with Earth’s radius).',
  },
  ground: {
    label: 'Ground projection',
    note: 'All satellites projected onto their sub-satellite points on the surface.',
  },
};
