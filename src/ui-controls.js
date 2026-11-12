/**
 * Left panel (filters, search, display options), legend, top bar status,
 * data-source dialog and mobile drawers.
 */
import { CATEGORIES, ORBIT_CLASS, GROUP_BY_ID, ALTITUDE_MODES, RENDER, CELESTRAK, ISS_API } from './config.js';
import { sliderToKm, kmToSlider, searchSuggestions, ALT_SLIDER_MAX_KM } from './satellite-filters.js';
import { fmtInt, fmtUtc, formatAge } from './data-processing.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Controls {
  /**
   * @param {object} p
   * @param {object} p.filters  mutable filter state (see satellite-filters.defaultFilterState)
   * @param {Function} p.onFilters called after any filter change
   * @param {Function} p.onOption (key, value)
   * @param {Function} p.onAltMode (mode)
   * @param {Function} p.onLimit (n)
   * @param {Function} p.onSelect (sat)
   * @param {Function} p.onQuick (name)
   */
  constructor(p) {
    Object.assign(this, p);
    this.sats = [];
    this._searchTimer = null;
  }

  build(catalog, breakdownAll, initial) {
    this.sats = catalog.sats;
    this._buildCategories(breakdownAll);
    this._buildClasses(breakdownAll);
    this._buildConstellations(breakdownAll);
    this._bindAltitude();
    this._bindSearch();
    this._bindDisplay(initial);
    this._bindQuick();
    this._buildLegend();
    this._bindDrawers();
    this.syncFromState();
  }

  /* ---------------------------------------------------------- filters */

  _buildCategories(bd) {
    const root = $('#f-categories');
    root.innerHTML = Object.entries(CATEGORIES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(
        ([k, c]) => `<label class="check" data-k="${k}">
          <input type="checkbox" value="${k}" checked />
          <span class="swatch" style="--c:${c.color}"></span>
          <span class="check-label">${esc(c.label)}</span>
          <span class="check-count mono" data-count="${k}">${fmtInt(bd.byCategory[k])}</span>
        </label>`,
      )
      .join('');
    root.addEventListener('change', (e) => {
      const cb = e.target;
      if (cb.checked) this.filters.categories.add(cb.value);
      else this.filters.categories.delete(cb.value);
      this.onFilters();
    });
    document.querySelectorAll('[data-all="categories"]').forEach((b) =>
      b.addEventListener('click', () => {
        this.filters.categories = new Set(Object.keys(CATEGORIES));
        this.syncFromState();
        this.onFilters();
      }),
    );
    document.querySelectorAll('[data-none="categories"]').forEach((b) =>
      b.addEventListener('click', () => {
        this.filters.categories = new Set();
        this.syncFromState();
        this.onFilters();
      }),
    );
  }

  _buildClasses(bd) {
    const root = $('#f-classes');
    root.innerHTML = Object.entries(ORBIT_CLASS)
      .map(
        ([k, c]) => `<button type="button" class="seg is-active" data-cls="${k}" aria-pressed="true" title="${esc(c.name)} — ${esc(c.desc)}">
          <span>${c.label}</span><small class="mono" data-cls-count="${k}">${fmtInt(bd.byClass[k])}</small></button>`,
      )
      .join('');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cls]');
      if (!b) return;
      const k = b.dataset.cls;
      if (this.filters.classes.has(k)) this.filters.classes.delete(k);
      else this.filters.classes.add(k);
      this.syncFromState();
      this.onFilters();
    });
  }

  _buildConstellations(bd) {
    const root = $('#f-constellations');
    const names = [...new Set(Object.values(GROUP_BY_ID).map((g) => g.constellation).filter(Boolean))]
      .filter((c) => bd.byConstellation[c] > 0); // only groups actually present in loaded data
    root.innerHTML = names
      .map((c) => `<button type="button" class="chip" data-con="${esc(c)}" aria-pressed="false">${esc(c)} <small class="mono">${fmtInt(bd.byConstellation[c])}</small></button>`)
      .join('');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-con]');
      if (!b) return;
      const c = b.dataset.con;
      if (this.filters.constellations.has(c)) this.filters.constellations.delete(c);
      else this.filters.constellations.add(c);
      this.syncFromState();
      this.onFilters();
    });
    document.querySelectorAll('[data-none="constellations"]').forEach((b) =>
      b.addEventListener('click', () => {
        this.filters.constellations.clear();
        this.syncFromState();
        this.onFilters();
      }),
    );
  }

  _bindAltitude() {
    const lo = $('#alt-min');
    const hi = $('#alt-max');
    const apply = (which) => {
      let a = Number(lo.value);
      let b = Number(hi.value);
      if (a > b) {
        if (which === 'lo') hi.value = String((b = a));
        else lo.value = String((a = b));
      }
      this.filters.altMin = sliderToKm(a);
      this.filters.altMax = b >= 1000 ? Infinity : sliderToKm(b);
      this._renderAlt();
      this.onFilters();
    };
    lo.addEventListener('input', () => apply('lo'));
    hi.addEventListener('input', () => apply('hi'));
    document.querySelectorAll('[data-alt]').forEach((b) =>
      b.addEventListener('click', () => {
        const [x, y] = b.dataset.alt.split(',');
        this.filters.altMin = Number(x);
        this.filters.altMax = y === 'inf' ? Infinity : Number(y);
        this.syncFromState();
        this.onFilters();
      }),
    );
  }

  _renderAlt() {
    const lo = $('#alt-min');
    const hi = $('#alt-max');
    const f = this.filters;
    lo.value = String(kmToSlider(f.altMin));
    hi.value = String(Number.isFinite(f.altMax) ? kmToSlider(f.altMax) : 1000);
    $('#alt-min-v').textContent = `${fmtInt(f.altMin)} km`;
    $('#alt-max-v').textContent = Number.isFinite(f.altMax) ? `${fmtInt(f.altMax)} km` : `${fmtInt(ALT_SLIDER_MAX_KM)}+ km`;
    const fill = $('#alt-fill');
    fill.style.left = `${Number(lo.value) / 10}%`;
    fill.style.right = `${100 - Number(hi.value) / 10}%`;
  }

  _bindSearch() {
    const input = $('#search');
    const list = $('#search-results');
    this.searchActive = -1;
    const render = () => {
      const q = input.value;
      const res = searchSuggestions(this.sats, q, 8);
      this.searchResults = res;
      this.searchActive = -1;
      if (!q.trim()) {
        list.hidden = true;
        list.innerHTML = '';
        return;
      }
      list.hidden = false;
      list.innerHTML = res.length
        ? res
            .map(
              (s, i) => `<li role="option" id="sr-${i}" data-i="${i}" aria-selected="false">
                <span class="swatch" style="--c:${CATEGORIES[s.category].color}"></span>
                <span class="sr-name">${esc(s.name)}</span><span class="sr-id mono">${s.id}</span></li>`,
            )
            .join('')
        : `<li class="sr-empty">No satellite named “${esc(q.trim())}” in the loaded data.</li>`;
    };
    input.addEventListener('input', () => {
      render();
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.filters.query = input.value;
        this.onFilters();
      }, 160);
    });
    input.addEventListener('keydown', (e) => {
      const n = this.searchResults?.length ?? 0;
      if (e.key === 'ArrowDown' && n) {
        e.preventDefault();
        this._activate(Math.min(n - 1, this.searchActive + 1));
      } else if (e.key === 'ArrowUp' && n) {
        e.preventDefault();
        this._activate(Math.max(0, this.searchActive - 1));
      } else if (e.key === 'Enter' && n) {
        e.preventDefault();
        this.onSelect(this.searchResults[Math.max(0, this.searchActive)]);
        list.hidden = true;
      } else if (e.key === 'Escape') {
        list.hidden = true;
      }
    });
    input.addEventListener('focus', () => input.value.trim() && render());
    input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('[data-i]');
      if (!li) return;
      e.preventDefault();
      this.onSelect(this.searchResults[Number(li.dataset.i)]);
      list.hidden = true;
    });
  }

  _activate(i) {
    this.searchActive = i;
    const list = $('#search-results');
    list.querySelectorAll('[data-i]').forEach((li) => {
      const on = Number(li.dataset.i) === i;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', String(on));
    });
    $('#search').setAttribute('aria-activedescendant', `sr-${i}`);
  }

  setQuery(q) {
    $('#search').value = q;
    this.filters.query = q;
  }

  _bindDisplay(initial) {
    document.querySelectorAll('#f-display [data-opt]').forEach((cb) => {
      cb.checked = initial.options[cb.dataset.opt] ?? cb.checked;
      cb.addEventListener('change', () => this.onOption(cb.dataset.opt, cb.checked));
    });
    const mode = $('#alt-mode');
    mode.value = initial.altMode;
    const note = () => ($('#alt-mode-note').textContent = ALTITUDE_MODES[mode.value].note);
    note();
    mode.addEventListener('change', () => {
      note();
      this.onAltMode(mode.value);
    });
    const lim = $('#render-limit');
    lim.max = String(Math.min(RENDER.maxLimit, Math.ceil(this.sats.length / 250) * 250));
    lim.value = String(initial.limit);
    const showLim = () => ($('#render-limit-v').textContent = fmtInt(Number(lim.value)));
    showLim();
    lim.addEventListener('input', showLim);
    lim.addEventListener('change', () => this.onLimit(Number(lim.value)));
  }

  setOptionChecked(key, value) {
    const cb = document.querySelector(`#f-display [data-opt="${key}"]`);
    if (cb) cb.checked = value;
  }

  _bindQuick() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-quick]');
      if (!b || b.closest('#pane-details, #pane-overview')) return; // handled by details panel
      this.onQuick(b.dataset.quick);
    });
  }

  /** Reflect the filter state in all controls. */
  syncFromState() {
    const f = this.filters;
    document.querySelectorAll('#f-categories input').forEach((cb) => (cb.checked = f.categories.has(cb.value)));
    document.querySelectorAll('#f-classes [data-cls]').forEach((b) => {
      const on = f.classes.has(b.dataset.cls);
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('#f-constellations [data-con]').forEach((b) => {
      const on = f.constellations.has(b.dataset.con);
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#search').value = f.query;
    this._renderAlt();
  }

  /* ------------------------------------------------------------ counts */

  setCounts({ matching, displayed, loaded, limitHit, limit, breakdownMatching }) {
    $('#cnt-matching').textContent = fmtInt(matching);
    $('#cnt-displayed').textContent = fmtInt(displayed);
    $('#cnt-loaded').textContent = fmtInt(loaded);
    $('#ts-loaded').textContent = fmtInt(loaded);
    $('#ts-displayed').textContent = fmtInt(displayed);
    const note = $('#cnt-note');
    note.hidden = !limitHit;
    if (limitHit) note.textContent = `Render limit ${fmtInt(limit)} reached — large categories are evenly sub-sampled. Raise it under Display options.`;
    if (breakdownMatching) {
      for (const [k, n] of Object.entries(breakdownMatching.byClass)) {
        const el = document.querySelector(`[data-cls-count="${k}"]`);
        if (el) el.textContent = fmtInt(n);
      }
    }
  }

  /* ------------------------------------------------------------ legend */

  _buildLegend() {
    const cats = Object.entries(CATEGORIES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([, c]) => `<span class="lg"><i class="lg-dot" style="--c:${c.color}"></i>${esc(c.label)}</span>`)
      .join('');
    $('#legend').innerHTML = `
      <div class="lg-cats">${cats}</div>
      <div class="lg-sym">
        <span class="lg"><i class="lg-ring"></i>Selected</span>
        <span class="lg"><i class="lg-line lg-fut"></i>Orbit (future)</span>
        <span class="lg"><i class="lg-line lg-past"></i>Past</span>
        <span class="lg"><i class="lg-line lg-gt"></i>Ground track</span>
        <span class="lg"><i class="lg-diamond"></i>ISS API position</span>
      </div>`;
  }

  /* ----------------------------------------------------------- drawers */

  _bindDrawers() {
    const btns = document.querySelectorAll('[data-drawer]');
    const left = $('#panel-left');
    const right = $('#panel-right');
    btns.forEach((b) =>
      b.addEventListener('click', () => this.openDrawer(b.dataset.drawer)),
    );
    this._drawerBtns = btns;
    this._left = left;
    this._right = right;
  }

  openDrawer(which) {
    this._left.classList.toggle('is-open', which === 'left');
    this._right.classList.toggle('is-open', which === 'right');
    this._drawerBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.drawer === which));
  }
}

/* ======================================================= status / top bar */

export function renderDataStatus(meta, origin, nowMs = Date.now()) {
  const el = $('#status-data');
  const val = $('#status-data-val');
  const last = Date.parse(meta?.lastSuccessfulFetch ?? '');
  const ageH = (nowMs - last) / 3_600_000;
  let level = 'ok';
  if (!Number.isFinite(ageH) || ageH > 48) level = 'bad';
  else if (ageH > 8 || origin === 'browser-cache' || (meta?.freshGroups ?? 0) < (meta?.totalGroups ?? 0)) level = 'warn';
  const how = origin === 'embedded' ? 'snapshot embedded in this page' : origin === 'browser-cache' ? 'offline: browser-cached copy' : 'site snapshot';
  el.dataset.level = level;
  val.textContent = Number.isFinite(last) ? `${formatAge(nowMs - last)} ago` : 'unknown';
  el.title = `Orbital elements downloaded from ${CELESTRAK.name} at ${fmtUtc(last)} (${how}). Positions are calculated from these elements and become less accurate as they age. Click for details.`;
  return { level, ageH };
}

export function renderIssStatus(state, live) {
  const el = $('#status-iss');
  const val = $('#status-iss-val');
  if (!state || state.status === 'connecting') {
    el.dataset.level = 'idle';
    val.textContent = '…';
  } else if (state.status === 'live' && state.data) {
    el.dataset.level = live ? 'ok' : 'idle';
    val.textContent = `${formatAge(Date.now() - state.data.timestampMs)} ago`;
  } else {
    el.dataset.level = 'warn';
    val.textContent = 'offline · SGP4';
  }
  el.title = state?.status === 'error'
    ? `${ISS_API.name} unavailable (${state.error}). The ISS is shown from SGP4 propagation of cached elements.`
    : `${ISS_API.name} live position API — polled every ${ISS_API.pollMs / 1000} s.`;
}

export function renderDataDialog(meta, origin, catalog) {
  const groups = (meta?.groups ?? [])
    .map((g) => {
      const label = GROUP_BY_ID[g.id]?.label ?? g.id;
      const st = g.status === 'fresh' ? 'ok' : g.status === 'cached' ? 'warn' : 'bad';
      return `<tr>
        <td><span class="st st-${st}">${g.status}</span></td>
        <td>${esc(label)}<br /><a class="mono small" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">GROUP=${esc(g.id)}</a></td>
        <td class="mono num">${fmtInt(g.count)}</td>
        <td class="mono small">${g.fetchedAt ? fmtUtc(Date.parse(g.fetchedAt), false) : '—'}${g.error ? `<br /><span class="err">${esc(g.error)}</span>` : ''}</td>
      </tr>`;
    })
    .join('');
  $('#data-body').innerHTML = `
    <div class="ds-grid">
      <section class="card">
        <h3 class="card-h">Orbital elements — ${CELESTRAK.name} GP API</h3>
        <p>Format: OMM JSON. A GitHub Actions job runs <code>scripts/fetch-orbits.mjs</code> about every 4 hours, validates the records, merges them by NORAD catalog number and ${origin === 'embedded' ? 'embeds the snapshot into this single HTML page' : 'publishes <code>data/orbits.json</code> with the site'}. Failed groups keep their last-known-good data. This page does not download CelesTrak data itself: positions are calculated from the last downloaded elements (time below), so they become less accurate as the snapshot ages.</p>
        <dl class="kvs">
          <div class="kv"><dt>Last successful fetch</dt><dd class="mono">${fmtUtc(Date.parse(meta?.lastSuccessfulFetch ?? ''))}</dd></div>
          <div class="kv"><dt>Snapshot generated</dt><dd class="mono">${fmtUtc(Date.parse(meta?.generatedAt ?? ''))}</dd></div>
          <div class="kv"><dt>Unique objects</dt><dd class="mono">${fmtInt(catalog.sats.length)}</dd></div>
          <div class="kv"><dt>Loaded from</dt><dd>${origin === 'browser-cache' ? 'Browser cache (network unavailable)' : origin === 'embedded' ? 'Embedded in this HTML file' : 'Site snapshot (network)'}</dd></div>
          <div class="kv"><dt>Snapshot age</dt><dd class="mono">${formatAge(Date.now() - Date.parse(meta?.lastSuccessfulFetch ?? ''))}</dd></div>
        </dl>
        <p><a href="${CELESTRAK.docsUrl}" target="_blank" rel="noopener noreferrer">CelesTrak GP data formats documentation</a></p>
      </section>
      <section class="card">
        <h3 class="card-h">Live ISS position — ${ISS_API.name}</h3>
        <p>Requested directly by your browser from <code>${ISS_API.url}</code> every ${ISS_API.pollMs / 1000} s. Used only for the ISS card and the ◇ marker in live mode — never for simulated times.</p>
        <p><a href="${ISS_API.docsUrl}" target="_blank" rel="noopener noreferrer">API documentation</a></p>
      </section>
      <section class="card">
        <h3 class="card-h">Calculated positions</h3>
        <p>Every satellite position is propagated in your browser with SGP4 (satellite.js) from the elements above, in a Web Worker, for the displayed simulation time. Positions are predictions, not observations.</p>
      </section>
    </div>
    <h3 class="card-h">CelesTrak groups</h3>
    <div class="table-wrap"><table class="gtable">
      <thead><tr><th>Status</th><th>Group</th><th class="num">Objects</th><th>Fetched (UTC)</th></tr></thead>
      <tbody>${groups}</tbody>
    </table></div>
    <p class="note">Credits: orbital data © CelesTrak (T.S. Kelso); live ISS data from WhereTheISS.at; Earth imagery NASA Blue Marble / Black Marble (public domain) via three-globe examples; rendering by Globe.gl &amp; Three.js; SGP4 by satellite.js.</p>`;
}
