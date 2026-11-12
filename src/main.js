/**
 * Orbital Atlas — application bootstrap and main loop.
 */
import './fonts.css';
import './styles.css';
import { ISS_API, RENDER, TIMELINE, CATEGORIES } from './config.js';
import { loadOrbitDataset, IssLiveFeed } from './satellite-api.js';
import { prepareCatalog, breakdown, fmt, fmtInt, fmtUtc, formatAge } from './data-processing.js';
import { applyFilters, selectForRender, defaultFilterState } from './satellite-filters.js';
import { createSatrec, stateAt, computeTrajectory } from './orbital-math.js';
import { createPropagator } from './propagator.js';
import { GlobeView } from './globe.js';
import { SimClock, TimelineControls, formatOffset } from './timeline.js';
import { DetailsPanel } from './satellite-details.js';
import { Controls, renderDataStatus, renderIssStatus, renderDataDialog } from './ui-controls.js';

const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------ loader UI */

function setLoader(msg, frac) {
  $('#loader-msg').textContent = msg;
  if (frac != null) $('#loader-progress').style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
}

function hideLoader() {
  const l = $('#loader');
  l.classList.add('is-done');
  setTimeout(() => l.remove(), 700);
}

function fatal(title, msg) {
  $('#loader')?.remove();
  $('#fatal-title').textContent = title;
  $('#fatal-msg').textContent = msg;
  $('#fatal').hidden = false;
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

/* ================================================================== app */

class App {
  async start() {
    if (!webglAvailable()) {
      fatal(
        'WebGL is not available',
        'Orbital Atlas renders the 3D Earth with WebGL, which this browser or device does not provide (it may be disabled, blocked by a policy, or unsupported by the graphics driver). Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.',
      );
      return;
    }

    setLoader('Loading orbital elements (CelesTrak snapshot)…', 0.05);
    let loaded;
    try {
      loaded = await loadOrbitDataset({
        onProgress: (r, t) => setLoader(`Loading orbital elements… ${(r / 1e6).toFixed(1)} MB`, t ? 0.05 + 0.45 * (r / t) : null),
      });
    } catch (err) {
      fatal('Orbital data unavailable', `${err.message} Orbital Atlas never substitutes invented positions, so nothing can be displayed until the data can be downloaded.`);
      return;
    }
    this.datasetOrigin = loaded.origin;
    this.catalog = prepareCatalog(loaded.dataset);
    this.meta = this.catalog.meta;
    if (this.catalog.sats.length === 0) {
      fatal('Orbital data invalid', 'The orbital-element snapshot contains no valid records.');
      return;
    }

    setLoader(`Initialising SGP4 for ${fmtInt(this.catalog.sats.length)} objects…`, 0.55);
    const propagatorReady = createPropagator(this.catalog.sats.map((s) => s.omm), {
      preferWorker: !/[?&]worker=off\b/.test(location.search),
    });

    setLoader('Loading Earth textures…', 0.65);
    this.view = new GlobeView($('#globe'), $('#labels'), {
      onPick: (idx) => (idx != null ? this.select(this.catalog.sats[idx]) : null),
      onHover: (idx, x, y) => this.showTooltip(idx, x, y),
      onUserInteract: () => {
        if (this.view.following) this.setFollowing(false);
      },
    });
    try {
      [this.propagator] = await Promise.all([propagatorReady, this.view.init()]);
      this.propagator.onPositions = (msg) => this.onPositions(msg);
    } catch (err) {
      console.error(err);
      fatal('Initialisation failed', `The 3D view or the propagation worker could not start (${err?.message || err}).`);
      return;
    }
    this.view.setCatalog(this.catalog);
    this.view.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      fatal('Graphics context lost', 'The browser reset the WebGL context (often caused by GPU memory pressure). Reload the page to continue.');
    });

    setLoader('Preparing interface…', 0.9);
    this.setupState();
    this.setupUi();
    this.applyFilters();
    this.view.resetCamera(0);
    this.startLoops();
    this.issFeed.start();
    this.restoreFromHash();
    setLoader('Ready', 1);
    hideLoader();
  }

  /* ---------------------------------------------------------- state */

  setupState() {
    const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || matchMedia('(pointer: coarse)').matches;
    this.limit = Math.min(lowEnd ? 2500 : 5000, RENDER.maxLimit);
    this.filters = defaultFilterState();
    // Prediction window shrinks as the orbital elements age (SGP4 errors grow by km/day).
    const ageH = (Date.now() - Date.parse(this.meta?.lastSuccessfulFetch ?? '')) / 3_600_000;
    this.windowHours = !Number.isFinite(ageH) || ageH > 7 * 24 ? 6 : ageH > TIMELINE.staleDatasetHours ? 12 : TIMELINE.windowHours;
    this.clock = new SimClock({ windowHours: this.windowHours });
    this.selected = null;
    this.satrec = null;
    this.trajectory = null;
    this.trajComputedAt = 0;
    this.dirty = true;
    this.lastReq = 0;
    this.fps = 0;
    this.issState = null;
    const issSat = this.catalog.byId.get(ISS_API.noradId);
    this.issSatrec = issSat ? createSatrec(issSat.omm) : null;
    this.clock.on((type) => {
      this.dirty = true;
      if (type === 'jump' || type === 'limit') this.trajComputedAt = 0;
      if (type === 'limit') this.toast(`Reached the edge of the ±${this.windowHours} h prediction window — simulation paused.`);
    });
    this.issFeed = new IssLiveFeed({
      onUpdate: (st) => {
        this.issState = st;
        this.refreshIss();
      },
    });
  }

  setupUi() {
    this.details = new DetailsPanel({
      paneDetails: $('#pane-details'),
      paneOverview: $('#pane-overview'),
      tabDetails: $('#tab-details'),
      tabOverview: $('#tab-overview'),
      onAction: (action, data) => this.onDetailsAction(action, data),
    });
    this.details.issSatrec = this.issSatrec;
    this.details.setTrajectoryOptions(this.view.options);

    this.controls = new Controls({
      filters: this.filters,
      onFilters: () => this.applyFilters(),
      onOption: (k, v) => this.setOption(k, v),
      onAltMode: (m) => {
        this.view.setAltitudeMode(m);
        this.updateAltBadge();
      },
      onLimit: (n) => {
        this.limit = n;
        this.applyFilters();
      },
      onSelect: (sat) => sat && this.select(sat),
      onQuick: (q) => this.quick(q),
    });
    this.controls.build(this.catalog, breakdown(this.catalog.sats), {
      options: this.view.options,
      altMode: this.view.altMode,
      limit: this.limit,
    });
    this.timeline = new TimelineControls(this.clock);

    $('#cam-in').addEventListener('click', () => this.view.zoom(0.7));
    $('#cam-out').addEventListener('click', () => this.view.zoom(1.4));
    $('#cam-reset').addEventListener('click', () => {
      this.setFollowing(false);
      this.view.resetCamera();
    });
    $('#sim-banner-live').addEventListener('click', () => this.clock.goLive());
    $('#btn-edu').addEventListener('click', () => $('#dlg-edu').showModal());
    $('#status-data').addEventListener('click', () => this.openDataDialog());
    $('#status-iss').addEventListener('click', () => this.quick('iss'));
    document.querySelectorAll('dialog').forEach((d) => {
      d.addEventListener('click', (e) => {
        if (e.target === d || e.target.closest('[data-close]')) d.close();
      });
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('hashchange', () => this.restoreFromHash());

    renderDataStatus(this.meta, this.datasetOrigin);
    this.renderStaleBanner();
    this.updateAltBadge();
  }

  /* -------------------------------------------------------- filters */

  applyFilters() {
    const matching = applyFilters(this.catalog.sats, this.filters);
    const shown = selectForRender(matching, this.limit, this.selected ? [this.selected] : []);
    // the selected satellite stays visible even when filtered out
    if (this.selected && !shown.includes(this.selected)) {
      shown.push(this.selected);
      shown.sort((a, b) => a.idx - b.idx);
    }
    this.matching = matching;
    this.shown = shown;
    const indices = this.view.setActive(shown);
    this.view.activeVersion = this.propagator.setActive(indices);
    this.dirty = true;

    const bdMatching = breakdown(matching);
    this.bdMatching = bdMatching;
    this.controls.setCounts({
      matching: matching.length,
      displayed: shown.length,
      loaded: this.catalog.sats.length,
      limitHit: matching.length > this.limit,
      limit: this.limit,
      breakdownMatching: bdMatching,
    });
    const empty = $('#empty-state');
    empty.hidden = matching.length > 0;
    if (!empty.hidden) {
      $('#empty-detail').textContent = this.filters.query.trim()
        ? `Nothing matches “${this.filters.query.trim()}” with the active category, class, altitude and constellation filters.`
        : 'Try enabling more categories, orbit classes or widening the altitude range.';
    }
    this.renderOverview();
  }

  renderOverview() {
    const live = this.liveStats ?? {};
    this.details.renderOverview({
      loaded: this.catalog.sats.length,
      matching: this.matching.length,
      displayed: this.shown.length,
      valid: live.valid ?? 0,
      avgAlt: live.avgAlt ?? null,
      breakdown: this.bdMatching,
      datasetMeta: this.meta,
      origin: this.datasetOrigin,
      catalogRejected: this.catalog.rejected,
    });
  }

  quick(name) {
    const f = this.filters;
    const resetFilters = () => {
      Object.assign(f, defaultFilterState());
      this.controls.syncFromState();
    };
    switch (name) {
      case 'iss': {
        const s = this.catalog.byId.get(ISS_API.noradId);
        if (s) this.select(s);
        else this.toast('The ISS is not in the loaded dataset.');
        break;
      }
      case 'hubble': {
        // Hubble's catalog name in CelesTrak is "HST" (NORAD 20580)
        const s = this.catalog.byId.get(20580) ?? this.catalog.sats.find((x) => x.name === 'HST');
        if (s) this.select(s);
        else this.toast('Hubble (HST) is not in the loaded dataset.');
        break;
      }
      case 'gps':
        resetFilters();
        f.constellations = new Set(['GPS']);
        this.controls.syncFromState();
        this.applyFilters();
        this.view.globe.pointOfView({ altitude: this.view.altMode === 'true' ? 9 : 3.6 }, 1200);
        this.toast('Showing the GPS constellation (CelesTrak GPS-OPS group).');
        break;
      case 'starlink':
        resetFilters();
        f.constellations = new Set(['Starlink']);
        this.controls.syncFromState();
        this.applyFilters();
        this.toast(`Showing Starlink — ${fmtInt(this.matching.length)} objects matched${this.matching.length > this.limit ? `, ${fmtInt(this.shown.length)} rendered (render limit)` : ''}.`);
        break;
      case 'weather':
        resetFilters();
        f.categories = new Set(['weather']);
        this.controls.syncFromState();
        this.applyFilters();
        this.toast('Showing weather & Earth-observation satellites.');
        break;
      case 'reset':
        resetFilters();
        this.applyFilters();
        break;
      default:
        break;
    }
  }

  setOption(key, value) {
    this.view.setOption(key, value);
    if (key === 'orbit' || key === 'ground') {
      this.details.setTrajectoryOptions(this.view.options);
      this.controls.setOptionChecked(key, value);
    }
  }

  /* ------------------------------------------------------ selection */

  select(sat, { fly = true } = {}) {
    if (!sat) return;
    this.selected = sat;
    this.satrec = createSatrec(sat.omm);
    if (!this.shown.includes(sat)) this.applyFilters();
    this.view.setSelected(sat.idx);
    this.details.select(sat, this.satrec, { datasetMeta: this.meta });
    this.details.setTrajectoryOptions(this.view.options);
    this.trajComputedAt = 0;
    this.updateTrajectory(true);
    const st = this.satrec ? stateAt(this.satrec, this.clock.now()) : null;
    if (fly && st) this.view.flyTo(st.lat, st.lng, st.alt);
    if (!st) this.toast(`${sat.name}: SGP4 propagation failed at the displayed time — no position available.`);
    this.view.lastInteraction = performance.now(); // pause auto-rotation
    if (matchMedia('(max-width: 900px)').matches) this.controls.openDrawer('right');
    const h = `#sat=${sat.id}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  deselect() {
    this.selected = null;
    this.satrec = null;
    this.trajectory = null;
    this.view.setSelected(null);
    this.details.renderEmpty();
    this.details.setIssState(this.issState, this.clock.isLive());
    this.setFollowing(false);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    this.applyFilters();
  }

  restoreFromHash() {
    const m = /sat=(\d+)/.exec(location.hash);
    if (!m) return;
    const s = this.catalog.byId.get(Number(m[1]));
    if (s && s !== this.selected) this.select(s);
  }

  setFollowing(on) {
    this.view.following = on && !!this.selected;
    this.details.setFollowing(this.view.following);
    if (this.view.following) {
      const st = this.view.stateOf(this.selected.idx);
      if (st) this.view.flyTo(st.lat, st.lng, st.alt, 800);
    }
  }

  onDetailsAction(action, data) {
    if (action === 'deselect') this.deselect();
    else if (action === 'follow') this.setFollowing(!this.view.following);
    else if (action === 'flyto' && this.selected) {
      const st = this.view.stateOf(this.selected.idx);
      if (st) this.view.flyTo(st.lat, st.lng, st.alt);
    } else if (action === 'traj') this.setOption(data.key, data.value);
    else if (action === 'quick') this.quick(data.quick);
    else if (action === 'datasources') this.openDataDialog();
  }

  updateTrajectory(force = false) {
    if (!this.selected || !this.satrec) return;
    const sim = this.clock.now();
    const now = performance.now();
    const t = this.trajectory;
    const stepMs = t ? t.stepMin * 60_000 : 0;
    const due = force || !t || this.trajComputedAt === 0 || (Math.abs(sim - t.centerMs) > stepMs / 3 && now - this.trajComputedAt > 100);
    if (!due) return;
    this.trajectory = computeTrajectory(this.satrec, sim, { samplesPerOrbit: RENDER.trajectorySamplesPerOrbit });
    this.trajComputedAt = now;
    this.view.setTrajectory(this.trajectory);
  }

  /* -------------------------------------------------------- positions */

  onPositions(msg) {
    const ok = this.view.applyPositions(msg);
    if (!ok) this.dirty = true;
    this.workerMs = msg.ms;
  }

  requestPositions(now) {
    const c = this.clock;
    const interval = c.paused ? Infinity : c.speed >= 60 ? 0 : c.speed >= 10 ? 40 : 120;
    if (this.dirty || now - this.lastReq >= interval) {
      if (this.propagator.request(c.now())) {
        this.lastReq = now;
        this.dirty = false;
      }
    }
  }

  /* -------------------------------------------------------- loops */

  startLoops() {
    let last = performance.now();
    let frames = 0;
    let fpsT = last;
    let slowT = 0;
    let secT = 0;
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      frames++;
      if (now - fpsT > 1000) {
        this.fps = (frames * 1000) / (now - fpsT);
        frames = 0;
        fpsT = now;
      }
      const sim = this.clock.now();
      this.requestPositions(now);
      this.updateTrajectory();
      this.view.frame(sim, now);
      this.timeline.tick();
      this.renderClock(sim);
      if (now - slowT > 250) {
        slowT = now;
        this.slowUpdate(sim);
      }
      if (now - secT > 1000) {
        secT = now;
        this.secondUpdate();
      }
      last = now;
    };
    this.raf = requestAnimationFrame(loop);
  }

  renderClock(sim) {
    const iso = new Date(sim).toISOString();
    const time = iso.slice(11, 19);
    if (this._lastClock !== time) {
      this._lastClock = time;
      $('#clock-time').textContent = time;
      $('#clock-date').textContent = iso.slice(0, 10);
    }
    const live = this.clock.isLive();
    const mode = live ? 'LIVE' : this.clock.paused ? 'PAUSED' : 'SIM';
    if (this._lastMode !== mode) {
      this._lastMode = mode;
      const pill = $('#clock-mode');
      pill.textContent = mode;
      pill.className = `mode-pill ${live ? 'is-live' : 'is-sim'}`;
      document.body.classList.toggle('is-sim', !live);
      this.refreshIss();
    }
  }

  slowUpdate(sim) {
    const live = this.clock.isLive();
    // simulated-time banner
    const banner = $('#sim-banner');
    const off = this.clock.offsetMs();
    banner.hidden = live;
    if (!live) {
      $('#sim-banner-title').textContent = this.clock.paused && Math.abs(off) < 2000 ? 'Paused' : off >= 0 ? 'Simulated future' : 'Simulated past';
      $('#sim-banner-text').textContent = `${formatOffset(off)} from now · ${this.clock.paused ? 'paused' : `${this.clock.speed}×`} · positions are SGP4 predictions${Math.abs(off) > 6 * 3_600_000 ? ', accuracy decreases further from the element epoch' : ''}.`;
    }
    // ISS API marker only for the current time
    const d = this.issState?.data;
    this.view.setIssApi(live && d && Date.now() - d.timestampMs < 120_000 ? d : null);

    if (this.selected) {
      this.details.update({
        state: this.view.stateOf(this.selected.idx),
        simMs: sim,
        live,
        altMode: this.view.altMode,
        trajectory: this.trajectory,
      });
    }
    const p = this.propagator;
    const where = p.mode === 'worker' ? 'worker' : 'main thread';
    $('#perf').textContent = `${Math.round(this.fps)} fps · SGP4 (${where}) ${fmt(this.workerMs ?? NaN, 1)} ms / ${fmtInt(this.shown.length)}`;
    $('#perf').title = `Rendering ${Math.round(this.fps)} frames/s. SGP4 runs in ${p.mode === 'worker' ? 'a Web Worker' : `the main thread in ≤ 8 ms slices (worker unavailable: ${p.fallbackReason})`} and needs ${fmt(this.workerMs ?? NaN, 1)} ms to propagate ${fmtInt(this.shown.length)} satellites; updates are throttled automatically on slower devices.${p.pending ? '' : ''}`;
  }

  secondUpdate() {
    // live statistics from calculated positions of displayed satellites
    const data = this.view.data;
    let valid = 0;
    let sum = 0;
    if (data) {
      for (let k = 0; k < this.view.indices.length; k++) {
        const alt = data[k * 4 + 2];
        if (!Number.isNaN(alt)) {
          valid++;
          sum += alt;
        }
      }
    }
    this.liveStats = { valid, avgAlt: valid ? sum / valid : null };
    $('#ts-alt').textContent = valid ? `${fmtInt(sum / valid)} km` : '—';
    this.details.updateOverviewLive(this.liveStats);
    renderDataStatus(this.meta, this.datasetOrigin);
    renderIssStatus(this.issState, this.clock.isLive());
    if (!this.selected) this.details.setIssState(this.issState, this.clock.isLive());
  }

  refreshIss() {
    const live = this.clock.isLive();
    this.details.setIssState(this.issState, live);
    renderIssStatus(this.issState, live);
  }

  /* --------------------------------------------------------- misc UI */

  updateAltBadge() {
    const m = this.view.altMode;
    $('#alt-badge').textContent = m === 'true' ? 'ALTITUDE · TRUE SCALE' : m === 'ground' ? 'GROUND PROJECTION' : 'ALTITUDE · √ COMPRESSED (NOT TO SCALE)';
  }

  renderStaleBanner() {
    const el = $('#stale-banner');
    const last = Date.parse(this.meta?.lastSuccessfulFetch ?? '');
    const ageH = (Date.now() - last) / 3_600_000;
    const msgs = [];
    if (this.datasetOrigin === 'browser-cache') msgs.push(`Offline — using the orbital data cached in this browser (refreshed ${fmtUtc(last)}).`);
    if (!Number.isFinite(ageH) || ageH > TIMELINE.staleDatasetHours) {
      msgs.push(`Orbital elements are ${Number.isFinite(ageH) ? formatAge(Date.now() - last) : 'of unknown age'} old — predicted positions may be off by tens of kilometres or more.`);
    }
    el.hidden = msgs.length === 0;
    el.textContent = msgs.join(' ');
  }

  openDataDialog() {
    renderDataDialog(this.meta, this.datasetOrigin, this.catalog);
    $('#dlg-data').showModal();
  }

  showTooltip(idx, x, y) {
    const tip = $('#tooltip');
    if (idx == null) {
      tip.hidden = true;
      return;
    }
    const s = this.catalog.sats[idx];
    const st = this.view.stateOf(idx);
    const vp = $('#viewport').getBoundingClientRect();
    tip.innerHTML = `<div class="tt-name"><i style="--c:${CATEGORIES[s.category].color}"></i>${s.name.replace(/</g, '&lt;')}</div>
      <div class="tt-meta mono">NORAD ${s.id} · ${CATEGORIES[s.category].label}</div>
      <div class="tt-meta mono">${st ? `${fmt(st.alt, 0)} km · ${fmt(st.speed, 2)} km/s` : 'no valid position'}</div>`;
    tip.hidden = false;
    const tx = Math.min(x - vp.left + 14, vp.width - 230);
    const ty = Math.max(8, y - vp.top - 10);
    tip.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      $('#viewport').appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('is-on'), 3800);
  }

  onKey(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && this.selected) this.deselect();
    else if (e.key === ' ') {
      e.preventDefault();
      this.clock.setPaused(!this.clock.paused);
    } else if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key.toLowerCase() === 'f' && this.selected) this.setFollowing(!this.view.following);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.issFeed?.stop();
    this.propagator?.dispose();
    this.timeline?.dispose();
    this.view?.dispose();
  }
}

const app = new App();
window.__orbitalAtlas = app; // handy for debugging / automated checks
app.start().catch((err) => {
  console.error(err);
  fatal('Unexpected error', String(err?.message || err));
});
window.addEventListener('pagehide', () => app.dispose());
