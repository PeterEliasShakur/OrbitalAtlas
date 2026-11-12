/**
 * Right-hand panel: selected-satellite details (with ground-track minimap),
 * the live ISS card, and the "Overview" statistics tab.
 */
import { CATEGORIES, GROUP_BY_ID, ORBIT_CLASS, ISS_API, CELESTRAK, TIMELINE, ALTITUDE_MODES } from './config.js';
import { fmt, fmtInt, fmtLat, fmtLng, fmtUtc, formatAge } from './data-processing.js';
import { splitAtAntimeridian, renderAltitude, stateAt } from './orbital-math.js';
import { assetUrl } from '@platform';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const row = (label, valueId, hint = '') =>
  `<div class="kv"><dt>${label}${hint ? ` <span class="kv-hint">${hint}</span>` : ''}</dt><dd class="mono" id="${valueId}">—</dd></div>`;

const staticRow = (label, value, hint = '') =>
  `<div class="kv"><dt>${label}${hint ? ` <span class="kv-hint">${hint}</span>` : ''}</dt><dd class="mono">${value}</dd></div>`;

/** Great-circle distance between two lat/lng points (km, mean Earth radius). */
export function greatCircleKm(a, b) {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class DetailsPanel {
  constructor({ paneDetails, paneOverview, tabDetails, tabOverview, onAction }) {
    this.paneDetails = paneDetails;
    this.paneOverview = paneOverview;
    this.tabDetails = tabDetails;
    this.tabOverview = tabOverview;
    this.onAction = onAction;
    this.sat = null;
    this.satrec = null;
    this.iss = null; // IssLiveFeed state
    this.mapImg = new Image();
    this.mapImg.src = assetUrl('textures/earth-blue-marble.jpg');
    this.mapImg.onload = () => (this._mapDirty = true);

    tabDetails.addEventListener('click', () => this.showTab('details'));
    tabOverview.addEventListener('click', () => this.showTab('overview'));
    paneDetails.addEventListener('click', (e) => this._onClick(e));
    paneOverview.addEventListener('click', (e) => this._onClick(e));
    this.renderEmpty();
  }

  showTab(which) {
    const d = which === 'details';
    this.tabDetails.classList.toggle('is-active', d);
    this.tabOverview.classList.toggle('is-active', !d);
    this.tabDetails.setAttribute('aria-selected', String(d));
    this.tabOverview.setAttribute('aria-selected', String(!d));
    this.paneDetails.hidden = !d;
    this.paneOverview.hidden = d;
  }

  _onClick(e) {
    const b = e.target.closest('[data-action]');
    if (b?.dataset.action === 'chartscale') {
      this.chartNoStarlink = b.dataset.v === 'nostar';
      if (this._lastOverview) this.renderOverview(this._lastOverview);
      return;
    }
    if (b) this.onAction?.(b.dataset.action, b.dataset);
  }

  /* --------------------------------------------------------- empty */

  renderEmpty() {
    this.sat = null;
    this.paneDetails.innerHTML = `
      <div class="empty-sel">
        <svg class="empty-sel-icon"><use href="#i-target"/></svg>
        <h2>No satellite selected</h2>
        <p>Click any marker on the globe, search by name or NORAD ID, or use a quick selection.</p>
        <div class="quick quick-center">
          <button class="qbtn" type="button" data-action="quick" data-quick="iss">Select ISS</button>
          <button class="qbtn" type="button" data-action="quick" data-quick="hubble">Select Hubble</button>
        </div>
      </div>
      <div id="iss-card-slot"></div>`;
    this._renderIssCard();
  }

  /* ------------------------------------------------------- selected */

  select(sat, satrec, { datasetMeta }) {
    this.sat = sat;
    this.satrec = satrec;
    const cat = CATEGORIES[sat.category];
    const o = sat.omm;
    const groups = sat.groups.filter((g) => (GROUP_BY_ID[g]?.label ?? g) !== cat.label).map((g) => `<span class="tag" title="CelesTrak group ${esc(g)}">${esc(GROUP_BY_ID[g]?.label ?? g)}</span>`).join('');
    const satcat = `https://celestrak.org/satcat/table-satcat.php?CATNR=${encodeURIComponent(sat.id)}`;
    const cls = ORBIT_CLASS[sat.orbitClass];
    const isIss = sat.id === ISS_API.noradId;

    this.paneDetails.innerHTML = `
      <div class="det-head">
        <span class="det-dot" style="--c:${cat.color}"></span>
        <div class="det-title">
          <h2>${esc(sat.name)}</h2>
          <div class="det-sub mono">NORAD ${sat.id}${sat.intlDes ? ` · COSPAR ${esc(sat.intlDes)}` : ''}</div>
        </div>
        <button class="icon-btn" type="button" data-action="deselect" title="Deselect" aria-label="Deselect satellite"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="det-tags"><span class="tag tag-cat" style="--c:${cat.color}">${esc(cat.label)}</span>${groups}</div>
      <div class="det-actions">
        <button class="btn btn-sm" type="button" data-action="follow" id="det-follow" aria-pressed="false"><svg><use href="#i-follow"/></svg>Follow</button>
        <button class="btn btn-sm" type="button" data-action="flyto"><svg><use href="#i-target"/></svg>Fly to</button>
        <a class="btn btn-sm btn-ghost" href="${satcat}" target="_blank" rel="noopener noreferrer" title="CelesTrak SATCAT entry"><svg><use href="#i-ext"/></svg>SATCAT</a>
      </div>

      <section class="card">
        <h3 class="card-h">Calculated position <span class="badge" id="det-pos-badge">SGP4</span></h3>
        <dl class="kvs">
          ${row('Latitude', 'det-lat')}
          ${row('Longitude', 'det-lng')}
          ${row('Altitude', 'det-alt', 'geodetic')}
          ${row('Speed', 'det-speed', 'inertial')}
        </dl>
        <p class="note" id="det-pos-note"></p>
        <p class="warn" id="det-pos-warn" hidden></p>
      </section>

      ${isIss ? '<section class="card card-iss" id="det-iss"></section>' : ''}

      <section class="card">
        <h3 class="card-h">Trajectory <span class="legend-inline"><i class="li li-fut"></i>future <i class="li li-past"></i>past</span></h3>
        <canvas class="minimap" id="det-map" width="640" height="320" aria-label="Ground track map"></canvas>
        <div class="traj-toggles">
          <label class="toggle toggle-sm"><input type="checkbox" data-traj="orbit" ${this._opts?.orbit !== false ? 'checked' : ''} /><span></span>Orbital path</label>
          <label class="toggle toggle-sm"><input type="checkbox" data-traj="ground" ${this._opts?.ground !== false ? 'checked' : ''} /><span></span>Ground track</label>
        </div>
        <p class="note">Ground track: −½ to +1½ orbits of sub-satellite points (Earth rotation included). Orbital path: one revolution in the Earth-fixed frame at the displayed instant. Sampling: <span class="mono" id="det-step">—</span>.</p>
      </section>

      <section class="card">
        <h3 class="card-h">Orbital elements <span class="badge badge-muted">OMM · CelesTrak</span></h3>
        <dl class="kvs">
          ${staticRow('Inclination', fmt(o.INCLINATION, 4, '°'))}
          ${staticRow('Eccentricity', fmt(o.ECCENTRICITY, 7))}
          ${staticRow('Period', fmt(sat.periodMin, 2, 'min'), 'from mean motion')}
          ${staticRow('Mean motion', fmt(o.MEAN_MOTION, 8, 'rev/day'))}
          ${staticRow('Perigee / apogee', `${fmtInt(sat.perigeeKm)} / ${fmtInt(sat.apogeeKm)} km`, 'approx.')}
          ${staticRow('RAAN', fmt(o.RA_OF_ASC_NODE, 4, '°'))}
          ${staticRow('Arg. of perigee', fmt(o.ARG_OF_PERICENTER, 4, '°'))}
          ${staticRow('Mean anomaly', fmt(o.MEAN_ANOMALY, 4, '°'))}
          ${staticRow('B* drag term', Number.isFinite(o.BSTAR) ? o.BSTAR.toExponential(4) : '—', '1/ER')}
          ${staticRow('Orbit class', `${cls.label}`, 'approx.')}
          ${o.REV_AT_EPOCH != null ? staticRow('Rev. at epoch', fmtInt(o.REV_AT_EPOCH)) : ''}
        </dl>
      </section>

      <section class="card">
        <h3 class="card-h">Data freshness</h3>
        <dl class="kvs">
          ${staticRow('Element epoch', fmtUtc(sat.epochMs))}
          ${row('Epoch age', 'det-epoch-age', 'vs. displayed time')}
          ${staticRow('Dataset refreshed', fmtUtc(Date.parse(datasetMeta?.lastSuccessfulFetch ?? '')))}
        </dl>
        <p class="note">Source: <a href="${CELESTRAK.docsUrl}" target="_blank" rel="noopener noreferrer">CelesTrak GP data</a> (OMM JSON). Operator, launch date and status are not part of this dataset and are therefore not shown.</p>
      </section>`;

    this.paneDetails.querySelectorAll('[data-traj]').forEach((cb) =>
      cb.addEventListener('change', () => this.onAction?.('traj', { key: cb.dataset.traj, value: cb.checked })),
    );
    this._mapDirty = true;
    this.showTab('details');
    if (isIss) this._renderIssSection();
  }

  setTrajectoryOptions(opts) {
    this._opts = opts;
    this.paneDetails.querySelectorAll('[data-traj]').forEach((cb) => (cb.checked = !!opts[cb.dataset.traj]));
  }

  setFollowing(on) {
    const b = this.paneDetails.querySelector('#det-follow');
    if (!b) return;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
    b.lastChild.textContent = on ? 'Following' : 'Follow';
  }

  /** Update the live numbers (called a few times per second). */
  update({ state, simMs, live, altMode, trajectory }) {
    if (!this.sat) return;
    const $ = (id) => this.paneDetails.querySelector(`#${id}`);
    const set = (id, v) => {
      const el = $(id);
      if (el && el.textContent !== v) el.textContent = v;
    };
    set('det-lat', state ? fmtLat(state.lat) : '—');
    set('det-lng', state ? fmtLng(state.lng) : '—');
    set('det-alt', state ? fmt(state.alt, 1, 'km') : '—');
    set('det-speed', state ? fmt(state.speed, 3, 'km/s') : '—');
    const badge = $('det-pos-badge');
    if (badge) {
      badge.textContent = live ? 'SGP4 · live' : 'SGP4 · simulated';
      badge.classList.toggle('badge-amber', !live);
    }
    const rendered = state ? renderAltitude(state.alt, altMode) * 6371 : NaN;
    set(
      'det-pos-note',
      state
        ? `Calculated for ${fmtUtc(simMs)} from orbital elements — a prediction, not telemetry. Rendered altitude: ${ALTITUDE_MODES[altMode].label.toLowerCase()} (${fmtInt(rendered)} km equivalent on screen).`
        : 'Propagation failed at this time (decayed, invalid or out-of-range elements). No position is shown.',
    );
    const ageDays = (simMs - this.sat.epochMs) / 86_400_000;
    set('det-epoch-age', `${ageDays >= 0 ? '' : '−'}${formatAge(Math.abs(simMs - this.sat.epochMs))}`);
    const warn = $('det-pos-warn');
    if (warn) {
      const stale = Math.abs(ageDays) > TIMELINE.staleElementDays;
      warn.hidden = !stale;
      if (stale) warn.textContent = `These elements are ${Math.abs(ageDays).toFixed(1)} days from the displayed time; SGP4 errors grow by kilometres per day, so this position is only indicative.`;
    }
    if (trajectory) set('det-step', `${fmt(trajectory.stepMin * 60, 0)} s (${trajectory.orbit.length + trajectory.ground.length} points)`);
    if (trajectory !== this._lastTraj || this._mapDirty) {
      this._lastTraj = trajectory;
      this._mapDirty = false;
      this._drawMap(trajectory, state);
    } else if (state) {
      this._drawMap(trajectory, state, true);
    }
    if (this.sat.id === ISS_API.noradId) this._renderIssSection();
  }

  _drawMap(traj, state, dotOnly = false) {
    const cv = this.paneDetails.querySelector('#det-map');
    if (!cv) return;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const W = cv.width;
    const H = cv.height;
    const X = (lng) => ((lng + 180) / 360) * W;
    const Y = (lat) => ((90 - lat) / 180) * H;
    if (!dotOnly || !this._mapCache) {
      g.clearRect(0, 0, W, H);
      if (this.mapImg.complete && this.mapImg.naturalWidth) {
        g.globalAlpha = 0.85;
        g.drawImage(this.mapImg, 0, 0, W, H);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = '#0b1a33';
        g.fillRect(0, 0, W, H);
      }
      g.fillStyle = 'rgba(2,6,16,0.35)';
      g.fillRect(0, 0, W, H);
      // graticule
      g.strokeStyle = 'rgba(160,200,255,0.14)';
      g.lineWidth = 1;
      for (let lng = -150; lng <= 150; lng += 30) {
        g.beginPath();
        g.moveTo(X(lng), 0);
        g.lineTo(X(lng), H);
        g.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        g.beginPath();
        g.moveTo(0, Y(lat));
        g.lineTo(W, Y(lat));
        g.stroke();
      }
      g.strokeStyle = 'rgba(160,200,255,0.3)';
      g.beginPath();
      g.moveTo(0, Y(0));
      g.lineTo(W, Y(0));
      g.stroke();
      if (traj?.ground?.length) {
        const past = traj.ground.filter((q) => q.dt <= 0);
        const fut = traj.ground.filter((q) => q.dt >= 0);
        const draw = (pts, style, dash, width) => {
          g.strokeStyle = style;
          g.lineWidth = width;
          g.setLineDash(dash);
          for (const seg of splitAtAntimeridian(pts)) {
            g.beginPath();
            seg.forEach((q, i) => (i ? g.lineTo(X(q.lng), Y(q.lat)) : g.moveTo(X(q.lng), Y(q.lat))));
            g.stroke();
          }
          g.setLineDash([]);
        };
        draw(past, 'rgba(255,210,122,0.75)', [6, 5], 2);
        draw(fut, '#ffc14d', [], 3);
      }
      this._mapCache = g.getImageData(0, 0, W, H);
    } else {
      g.putImageData(this._mapCache, 0, 0);
    }
    if (this.iss?.data && this.sat?.id === ISS_API.noradId && this._live) {
      const d = this.iss.data;
      g.strokeStyle = '#ffc14d';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(d.lng), Y(d.lat) - 8);
      g.lineTo(X(d.lng) + 8, Y(d.lat));
      g.lineTo(X(d.lng), Y(d.lat) + 8);
      g.lineTo(X(d.lng) - 8, Y(d.lat));
      g.closePath();
      g.stroke();
    }
    if (state) {
      g.fillStyle = '#7df9ff';
      g.strokeStyle = '#02101c';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(X(state.lng), Y(state.lat), 7, 0, Math.PI * 2);
      g.stroke();
      g.fill();
    }
  }

  /* ---------------------------------------------------------- ISS */

  setIssState(state, live) {
    this.iss = state;
    this._live = live;
    if (!this.sat) this._renderIssCard();
    else if (this.sat.id === ISS_API.noradId) this._renderIssSection();
  }

  setLive(live) {
    this._live = live;
  }

  _issHtml(compact) {
    const st = this.iss;
    const d = st?.data;
    let status;
    if (!st || st.status === 'connecting') status = '<span class="badge">connecting…</span>';
    else if (st.status === 'live' && d) status = '<span class="badge badge-green">API online</span>';
    else status = '<span class="badge badge-amber">API unavailable</span>';

    let body;
    if (d) {
      const age = Date.now() - d.timestampMs;
      let diff = '';
      if (this.issSatrec) {
        const s = stateAt(this.issSatrec, d.timestampMs);
        if (s) {
          const km = greatCircleKm(s, d);
          diff = staticRow('Δ vs. our SGP4', `${fmt(km, 1, 'km')} · Δh ${fmt(d.altKm - s.alt, 1, 'km')}`, 'same instant');
        }
      }
      body = `
        <dl class="kvs">
          ${staticRow('Latitude', fmtLat(d.lat))}
          ${staticRow('Longitude', fmtLng(d.lng))}
          ${staticRow('Altitude', fmt(d.altKm, 1, 'km'))}
          ${staticRow('Speed', fmt(d.speedKms, 3, 'km/s'), `${fmtInt(d.speedKms * 3600)} km/h`)}
          ${d.visibility ? staticRow('Visibility', esc(d.visibility)) : ''}
          ${staticRow('API timestamp', fmtUtc(d.timestampMs))}
          ${staticRow('Received', `${formatAge(age)} ago`)}
          ${diff}
        </dl>`;
    } else {
      body = '<p class="note">No API response yet.</p>';
    }
    const fileHint = location.protocol === 'file:' ? ' This page was opened as a local file: the request needs an internet connection and a browser that permits it from file:// pages.' : '';
    const err = st?.status === 'error'
      ? `<p class="warn">Last request failed (${esc(st.error)}).${fileHint} ${d ? 'Showing the last successful response.' : ''} The ISS on the globe continues to use SGP4 propagation from the CelesTrak elements.</p>`
      : '';
    const simNote = !this._live
      ? '<p class="note note-amber">Viewing simulated time — the API position (current time only) is not used for the globe.</p>'
      : '';
    return `
      <h3 class="card-h">${compact ? 'ISS · ' : ''}Live API position ${status}</h3>
      ${body}${err}${simNote}
      <p class="note">Reported by <a href="${ISS_API.docsUrl}" target="_blank" rel="noopener noreferrer">${ISS_API.name}</a> (direct browser request every ${ISS_API.pollMs / 1000} s). This is a provider-computed position, not raw spacecraft telemetry; shown as <span class="iss-diamond"></span> on the globe in live mode.</p>`;
  }

  _renderIssCard() {
    const slot = this.paneDetails.querySelector('#iss-card-slot');
    if (!slot) return;
    slot.innerHTML = `<section class="card card-iss">${this._issHtml(true)}
      <button class="btn btn-sm" type="button" data-action="quick" data-quick="iss"><svg><use href="#i-target"/></svg>Select ISS</button></section>`;
  }

  _renderIssSection() {
    const el = this.paneDetails.querySelector('#det-iss');
    if (!el) return;
    const now = Date.now();
    if (this._issRenderedAt && now - this._issRenderedAt < 1000) return;
    this._issRenderedAt = now;
    el.innerHTML = this._issHtml(false);
  }

  /* ------------------------------------------------------ overview */

  renderOverview({ loaded, matching, displayed, valid, avgAlt, breakdown, datasetMeta, origin, catalogRejected }) {
    const cats = Object.entries(CATEGORIES).sort((a, b) => a[1].order - b[1].order);
    // Optional: leave Starlink out of the bar scale so the other categories stay readable.
    const scaleCats = this.chartNoStarlink ? cats.filter(([k]) => k !== 'starlink') : cats;
    const max = Math.max(1, ...scaleCats.map(([k]) => breakdown.byCategory[k]));
    this._lastOverview = arguments[0];
    const bars = cats
      .map(([k, c]) => {
        const n = breakdown.byCategory[k];
        const off = this.chartNoStarlink && k === 'starlink';
        const pct = off ? 0 : (n / max) * 100;
        return `<li class="bar-row${off ? ' is-off' : ''}" title="${esc(c.label)}: ${fmtInt(n)} matching satellites${off ? ' (not drawn — excluded from scale)' : ''}">
          <span class="bar-label">${esc(c.label)}</span>
          <span class="bar-track"><span class="bar" style="width:${pct.toFixed(2)}%;--c:${c.color}"></span></span>
          <span class="bar-val mono">${fmtInt(n)}</span></li>`;
      })
      .join('');
    const classes = Object.entries(ORBIT_CLASS)
      .map(([k, c]) => `<div class="cls" title="${esc(c.name)}: ${esc(c.desc)}"><span class="cls-v mono">${fmtInt(breakdown.byClass[k])}</span><span class="cls-l">${c.label}</span></div>`)
      .join('');
    const last = Date.parse(datasetMeta?.lastSuccessfulFetch ?? '');
    this.paneOverview.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><span class="stat-v mono">${fmtInt(loaded)}</span><span class="stat-l">records loaded</span></div>
        <div class="stat"><span class="stat-v mono">${fmtInt(matching)}</span><span class="stat-l">match filters</span></div>
        <div class="stat"><span class="stat-v mono">${fmtInt(displayed)}</span><span class="stat-l">displayed</span></div>
        <div class="stat"><span class="stat-v mono" id="ov-valid">${fmtInt(valid)}</span><span class="stat-l">valid positions</span></div>
        <div class="stat stat-wide"><span class="stat-v mono" id="ov-alt">${avgAlt != null ? fmt(avgAlt, 0, 'km') : '—'}</span><span class="stat-l">average calculated altitude of displayed satellites</span></div>
      </div>
      <p class="note">Counts refer to the CelesTrak groups loaded in this app — a subset of all objects in Earth orbit, not the total.</p>

      <section class="card">
        <h3 class="card-h">Orbit classes <span class="approx">approx., matching</span></h3>
        <div class="cls-row">${classes}</div>
      </section>

      <section class="card">
        <h3 class="card-h">Matching satellites by category
          <span class="seg-mini" role="group" aria-label="Bar scale">
            <button type="button" data-action="chartscale" data-v="all" class="${this.chartNoStarlink ? '' : 'is-active'}" aria-pressed="${!this.chartNoStarlink}">all</button>
            <button type="button" data-action="chartscale" data-v="nostar" class="${this.chartNoStarlink ? 'is-active' : ''}" aria-pressed="${!!this.chartNoStarlink}">without Starlink</button>
          </span></h3>
        <ul class="bars">${bars}</ul>
      </section>

      <section class="card">
        <h3 class="card-h">Orbital data</h3>
        <dl class="kvs">
          ${staticRow('Last CelesTrak refresh', fmtUtc(last))}
          ${staticRow('Age', `${formatAge(Date.now() - last)}`)}
          ${staticRow('Groups fresh', `${datasetMeta?.freshGroups ?? '—'} / ${datasetMeta?.totalGroups ?? '—'}`)}
          ${staticRow('Loaded from', origin === 'browser-cache' ? 'browser cache (offline)' : origin === 'embedded' ? 'snapshot embedded in page' : 'site snapshot')}
          ${catalogRejected ? staticRow('Rejected records', fmtInt(catalogRejected)) : ''}
        </dl>
        <p class="note">Positions are calculated from these last downloaded CelesTrak elements. The older the snapshot, the less accurate the predictions (SGP4 errors grow by roughly 1–3 km per day for LEO).</p>
        <button class="btn btn-sm" type="button" data-action="datasources"><svg><use href="#i-db"/></svg>Sources &amp; group status</button>
      </section>`;
  }

  updateOverviewLive({ valid, avgAlt }) {
    const v = this.paneOverview.querySelector('#ov-valid');
    const a = this.paneOverview.querySelector('#ov-alt');
    if (v) v.textContent = fmtInt(valid);
    if (a) a.textContent = avgAlt != null ? fmt(avgAlt, 0, 'km') : '—';
  }
}
