#!/usr/bin/env node
/**
 * End-to-end browser tests for the GENERATED single-file deliverables:
 *
 *   A. Standalone/Orbital_Atlas.html opened directly via file://   (full suite)
 *   B. GitHub_Pages/index.html served at http://127.0.0.1:PORT/OrbitalAtlas/   (GitHub Pages simulation)
 *   C. GitHub_Pages/index.html served at https://127.0.0.1:PORT/OrbitalAtlas/ (self-signed cert, if openssl exists)
 *
 * Or test a deployed site:  node tests/browser/standalone.e2e.mjs --url https://petereliasshakur.github.io/OrbitalAtlas/
 *
 * Uses an installed Chrome or Edge through playwright-core (no browser download).
 * Set CHROME_PATH to choose the executable. Run: npm run test:standalone
 *
 * Network-dependent checks (live ISS API) report SKIP instead of FAIL when the
 * machine itself is offline; everything else must pass.
 */
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STANDALONE = join(ROOT, 'Standalone/Orbital_Atlas.html');
const PAGES = join(ROOT, 'GitHub_Pages/index.html');
const ISS_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
const PAGES_PATH = '/OrbitalAtlas/'; // GitHub Pages project path of the PeterEliasShakur/OrbitalAtlas repository
const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : null;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
// SwiftShader = software WebGL, so the tests also run on machines/CI without a GPU.
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/* ------------------------------------------------------------- reporting */

const results = [];
let currentGroup = '';
function group(name) {
  currentGroup = name;
  console.log(`\n▶ ${name}`);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.skip) {
      results.push({ group: currentGroup, name, status: 'SKIP', detail: detail.skip });
      console.log(`  ○ SKIP ${name} — ${detail.skip}`);
    } else {
      results.push({ group: currentGroup, name, status: 'PASS', detail });
      console.log(`  ✔ ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''} (${Date.now() - t0} ms)`);
    }
  } catch (err) {
    results.push({ group: currentGroup, name, status: 'FAIL', detail: err.message });
    console.log(`  ✖ FAIL ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* --------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instrument(page) {
  const log = { pageErrors: [], consoleErrors: [], requests: [], failed: [] };
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && log.consoleErrors.push(m.text()));
  page.on('request', (r) => {
    if (!/^(data|blob):/.test(r.url())) log.requests.push(r.url());
  });
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} — ${r.failure()?.errorText}`));
  return log;
}

async function openApp(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#loader') || !document.querySelector('#fatal').hidden, null, { timeout: 120_000 });
  const fatal = await page.evaluate(() => (document.querySelector('#fatal').hidden ? null : document.querySelector('#fatal').innerText));
  if (fatal) throw new Error(`app showed fatal error: ${fatal}`);
  // first positions
  await page.waitForFunction(() => window.__orbitalAtlas?.view?.validCount() > 0, null, { timeout: 60_000 });
}

const app = (page, fn, arg) => page.evaluate(fn, arg);

/** Wait until the worker has delivered positions for the current active set. */
async function settle(page, ms = 700) {
  await sleep(ms);
  await page.waitForFunction(() => {
    const a = window.__orbitalAtlas;
    return a.view.data && a.view.data.length === a.view.indices.length * 4;
  }, null, { timeout: 30_000 });
}

/** Screen position of a visible satellite near the globe centre (or null). */
async function findClickable(page) {
  return app(page, () => {
    const a = window.__orbitalAtlas;
    const v = a.view;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const V = v.camera.position.constructor;
    let best = null;
    for (let k = 0; k < v.indices.length; k++) {
      if (v.sizeAttr.array[k] <= 0) continue;
      const p = new V(v.posAttr.array[k * 3], v.posAttr.array[k * 3 + 1], v.posAttr.array[k * 3 + 2]).project(v.camera);
      const sx = (p.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(sx - (rect.left + rect.width / 2), sy - (rect.top + rect.height / 2));
      if (d > 220) continue;
      const picked = v.pick(sx, sy, 2);
      if (picked != null && picked === v.indices[k] && (!best || d < best.d)) best = { sx, sy, idx: picked, name: a.catalog.sats[picked].name, d };
    }
    return best;
  });
}

async function noNaN(page) {
  const bad = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/.{0,40}\b(NaN|Infinity|undefined)\b.{0,40}/);
    return m ? m[0] : null;
  });
  assert(!bad, `found invalid value in page text: “${bad}”`);
}

/* =================================================== FULL SUITE (file://) */

async function fullSuite(browser, url, label, { remote = false } = {}) {
  group(`${label}: core application`);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const log = instrument(page);
  let loaded = false;

  await check('1. page loads (double-click equivalent) and initialises', async () => {
    const t0 = Date.now();
    await openApp(page, url);
    loaded = true;
    const info = await app(page, () => ({ protocol: location.protocol, origin: window.__orbitalAtlas.datasetOrigin }));
    assert(info.origin === 'embedded', `dataset origin ${info.origin}`);
    return `${info.protocol} · ready in ${Date.now() - t0} ms`;
  });
  if (!loaded) {
    await ctx.close();
    return;
  }

  await check('embedded snapshot: all records, original timestamp shown', async () => {
    const r = await app(page, () => {
      const el = document.getElementById('oa-data');
      const a = window.__orbitalAtlas;
      return { attr: Number(el.dataset.records), fetched: el.dataset.fetched, sats: a.catalog.sats.length, rejected: a.catalog.rejected, meta: a.meta.lastSuccessfulFetch, six: a.catalog.sats.filter((s) => s.id > 99999).length };
    });
    assert(r.sats === r.attr && r.rejected === 0, `loaded ${r.sats}/${r.attr}, rejected ${r.rejected}`);
    assert(r.six > 0, 'no six-digit NORAD IDs');
    await page.click('#tab-overview');
    const ov = await page.locator('#pane-overview').innerText();
    await page.click('#tab-details');
    const shown = r.meta.slice(0, 10) + ' ' + r.meta.slice(11, 19);
    assert(ov.includes(shown), `overview does not show snapshot time ${shown}`);
    assert(/embedded in page/.test(ov), 'overview does not say the snapshot is embedded');
    assert(/less accurate/.test(ov), 'no data-age accuracy explanation');
    return `${r.sats} records (${r.six} six-digit IDs), CelesTrak fetch ${r.meta}`;
  });

  await check('24. Web Worker starts from the embedded Blob source', async () => {
    const m = await app(page, () => ({ mode: window.__orbitalAtlas.propagator.mode, reason: window.__orbitalAtlas.propagator.fallbackReason }));
    assert(m.mode === 'worker', `propagator mode ${m.mode} (${m.reason})`);
    return 'mode=worker';
  });

  await check('2. 3D Earth renders (textures loaded, globe pixels lit)', async () => {
    const r = await app(page, () => {
      const v = window.__orbitalAtlas.view;
      const u = v.earthMat.uniforms;
      const tex = [u.dayTex, u.nightTex, u.waterTex].map((t) => t.value.image?.width ?? 0);
      v.renderer.render(v.scene, v.camera);
      const gl = v.renderer.getContext();
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      const sample = (x, y) => {
        const px = new Uint8Array(4 * 24 * 24);
        gl.readPixels(x - 12, y - 12, 24, 24, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0;
        for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
        return s / (px.length / 4) / 3;
      };
      return { tex, centre: sample(W / 2, H / 2), corner: sample(30, 30), clouds: v.cloudMat.uniforms.cloudTex.value.image?.width ?? 0 };
    });
    assert(r.tex.every((w) => w >= 1600), `texture widths ${r.tex}`);
    assert(r.clouds > 0, 'cloud texture missing');
    assert(r.centre > 18, `globe centre too dark (${r.centre.toFixed(1)})`);
    assert(r.centre > r.corner + 8, `globe not brighter than space (${r.centre.toFixed(1)} vs ${r.corner.toFixed(1)})`);
    return `centre brightness ${r.centre.toFixed(0)} vs space ${r.corner.toFixed(0)}; textures ${r.tex.join('/')} px`;
  });

  await check('3. globe rotation by mouse drag', async () => {
    await page.click('#f-display label:has([data-opt="rotate"])');
    assert(!(await page.isChecked('#f-display [data-opt="rotate"]')), 'auto-rotate toggle did not switch off');
    await sleep(300);
    const before = await app(page, () => window.__orbitalAtlas.view.camera.position.toArray());
    const box = await page.locator('#globe canvas').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 25, cy + i * 4);
    await page.mouse.up();
    await sleep(800);
    const after = await app(page, () => window.__orbitalAtlas.view.camera.position.toArray());
    const ang = Math.acos(Math.min(1, (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (Math.hypot(...before) * Math.hypot(...after)))) * 180 / Math.PI;
    assert(ang > 5, `camera rotated only ${ang.toFixed(1)}°`);
    return `camera orbited ${ang.toFixed(1)}°`;
  });

  await check('4. zoom with mouse wheel and buttons', async () => {
    const dist = () => app(page, () => window.__orbitalAtlas.view.camera.position.length());
    const d0 = await dist();
    const box = await page.locator('#globe canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -240);
      await sleep(60);
    }
    await sleep(900);
    const d1 = await dist();
    assert(d1 < d0 * 0.95, `wheel zoom-in did not reduce distance (${d0.toFixed(0)} → ${d1.toFixed(0)})`);
    await page.click('#cam-out');
    await sleep(900);
    const d2 = await dist();
    assert(d2 > d1 * 1.1, `zoom-out button did not increase distance (${d1.toFixed(0)} → ${d2.toFixed(0)})`);
    await page.click('#cam-reset');
    await sleep(1600);
    return `distance ${d0.toFixed(0)} → ${d1.toFixed(0)} (wheel) → ${d2.toFixed(0)} (button)`;
  });

  await check('5. satellites visible on the globe', async () => {
    await settle(page);
    const r = await app(page, () => {
      const a = window.__orbitalAtlas;
      const v = a.view;
      const rect = v.renderer.domElement.getBoundingClientRect();
      const V = v.camera.position.constructor;
      let onScreen = 0;
      for (let k = 0; k < v.indices.length; k++) {
        if (v.sizeAttr.array[k] <= 0) continue;
        const p = new V(v.posAttr.array[k * 3], v.posAttr.array[k * 3 + 1], v.posAttr.array[k * 3 + 2]).project(v.camera);
        if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) onScreen++;
      }
      return { drawn: v.points.geometry.drawRange.count, valid: v.validCount(), shown: a.shown.length, onScreen, labels: document.querySelectorAll('.sat-label[style*="block"]').length, limit: a.limit };
    });
    assert(r.drawn === r.shown && r.valid > 0.98 * r.shown, `drawn ${r.drawn}, valid ${r.valid}, shown ${r.shown}`);
    assert(r.onScreen > 500, `only ${r.onScreen} markers on screen`);
    return r;
  });

  await check('6. satellite selection by clicking a marker', async () => {
    const t = await findClickable(page);
    assert(t, 'no clickable satellite near the centre');
    await page.mouse.click(t.sx, t.sy);
    await sleep(1500);
    const sel = await app(page, () => window.__orbitalAtlas.selected?.name);
    assert(sel === t.name, `clicked ${t.name}, selected ${sel}`);
    const ring = await app(page, () => window.__orbitalAtlas.view.selSprite.visible);
    assert(ring, 'selection ring not shown');
    return `selected ${sel}`;
  });

  await check('10. quick selections (ISS, Hubble, GPS, Starlink, Weather, Reset)', async () => {
    const out = {};
    await page.click('.qbtn[data-quick="iss"]');
    await sleep(1500);
    out.iss = await app(page, () => window.__orbitalAtlas.selected?.id);
    assert(out.iss === 25544, `ISS quick → ${out.iss}`);
    await page.click('.qbtn[data-quick="hubble"]');
    await sleep(1200);
    out.hubble = await app(page, () => window.__orbitalAtlas.selected?.name);
    assert(out.hubble === 'HST', `Hubble quick → ${out.hubble}`);
    for (const [q, test] of [
      ['gps', (a) => a.matching.length > 20 && a.matching.every((s) => s.constellations.includes('GPS'))],
      ['starlink', (a) => a.matching.length > 1000 && a.matching.every((s) => s.constellations.includes('Starlink'))],
      ['weather', (a) => a.matching.length > 50 && a.matching.every((s) => s.category === 'weather')],
      ['reset', (a) => a.matching.length === a.catalog.sats.length],
    ]) {
      await page.click(`.qbtn[data-quick="${q}"]`);
      await sleep(500);
      const ok = await page.evaluate(`(${test.toString()})(window.__orbitalAtlas)`);
      out[q] = await app(page, () => window.__orbitalAtlas.matching.length);
      assert(ok, `quick "${q}" produced an unexpected set (${out[q]} matching)`);
    }
    return out;
  });

  await check('7. details panel shows valid calculated values (ISS)', async () => {
    await page.click('.qbtn[data-quick="iss"]');
    await sleep(2000);
    const r = await app(page, () => {
      const q = (id) => document.querySelector(`#${id}`)?.textContent ?? '';
      return { lat: q('det-lat'), lng: q('det-lng'), alt: q('det-alt'), speed: q('det-speed'), text: document.querySelector('#pane-details').innerText };
    });
    const num = (s) => parseFloat(s.replace(/,/g, ''));
    assert(/[NS]$/.test(r.lat) && num(r.lat) <= 52, `latitude ${r.lat}`);
    assert(/[EW]$/.test(r.lng) && num(r.lng) <= 180, `longitude ${r.lng}`);
    assert(num(r.alt) > 380 && num(r.alt) < 450, `altitude ${r.alt}`);
    assert(num(r.speed) > 7.5 && num(r.speed) < 7.8, `speed ${r.speed}`);
    for (const k of ['NORAD 25544', '1998-067A', 'Inclination', '51.6', 'Eccentricity', 'Period', 'Element epoch', 'SGP4']) assert(r.text.includes(k), `details missing "${k}"`);
    return `${r.lat}, ${r.lng}, ${r.alt}, ${r.speed}`;
  });

  await check('12. orbital trajectory (orbit path) shown and toggleable', async () => {
    const vis = () => app(page, () => ({ f: window.__orbitalAtlas.view.orbitFuture.visible, p: window.__orbitalAtlas.view.orbitPast.visible, n: window.__orbitalAtlas.trajectory?.orbit.length }));
    const a = await vis();
    assert(a.f && a.p && a.n > 150, `orbit path not drawn ${JSON.stringify(a)}`);
    await page.click('#f-display label:has([data-opt="orbit"])');
    await sleep(300);
    const b = await vis();
    assert(!b.f && !b.p, 'orbit path still visible after toggling off');
    await page.click('#f-display label:has([data-opt="orbit"])');
    await sleep(300);
    assert((await vis()).f, 'orbit path not restored');
    return `${a.n} propagated points, past + future segments`;
  });

  await check('13. ground track shown (3D + minimap) and toggleable', async () => {
    const vis = () => app(page, () => ({ f: window.__orbitalAtlas.view.groundFuture.visible, p: window.__orbitalAtlas.view.groundPast.visible, n: window.__orbitalAtlas.trajectory?.ground.length }));
    const a = await vis();
    assert(a.f && a.p && a.n > 300, `ground track not drawn ${JSON.stringify(a)}`);
    const amber = await app(page, () => {
      const cv = document.querySelector('#det-map');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 150 && d[i + 1] < 215 && d[i + 2] < 120) n++;
      return n;
    });
    assert(amber > 300, `minimap ground track pixels: ${amber}`);
    await page.click('#pane-details label:has([data-traj="ground"])');
    await sleep(300);
    assert(!(await vis()).f, 'ground track still visible after toggle');
    await page.click('#pane-details label:has([data-traj="ground"])');
    await sleep(300);
    assert((await vis()).f, 'ground track not restored');
    return `${a.n} sub-satellite points; ${amber} track pixels on minimap`;
  });

  await check('11. altitude rendering modes (compressed / true / ground)', async () => {
    const out = {};
    for (const mode of ['true', 'ground', 'compressed']) {
      await page.selectOption('#alt-mode', mode);
      await sleep(700);
      out[mode] = await app(page, () => {
        const a = window.__orbitalAtlas;
        const st = a.view.stateOf(a.selected.idx);
        const r = a.view.selSprite.position.length() / 100 - 1;
        return { rendered: +r.toFixed(4), alt: st.alt, badge: document.querySelector('#alt-badge').textContent };
      });
    }
    const R = 6371;
    assert(Math.abs(out.true.rendered - out.true.alt / R) < 0.003, `true-scale ${JSON.stringify(out.true)}`);
    assert(Math.abs(out.ground.rendered - 0.0035) < 0.002, `ground ${JSON.stringify(out.ground)}`);
    assert(Math.abs(out.compressed.rendered - 0.5 * Math.sqrt(out.compressed.alt / R)) < 0.004, `compressed ${JSON.stringify(out.compressed)}`);
    assert(/TRUE SCALE/.test(out.true.badge) && /GROUND/.test(out.ground.badge) && /COMPRESSED/.test(out.compressed.badge), 'altitude badge text');
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.rendered]));
  });

  await check('14. simulation time re-propagates positions (+1 h, 600×, pause, live)', async () => {
    const st = () => app(page, () => window.__orbitalAtlas.view.stateOf(window.__orbitalAtlas.selected.idx));
    const s0 = await st();
    const t0 = await app(page, () => window.__orbitalAtlas.trajectory.centerMs);
    await page.click('#tl-fwd');
    await settle(page, 1200);
    const s1 = await st();
    const r = await app(page, () => ({ off: Math.round(window.__orbitalAtlas.clock.offsetMs() / 60000), banner: !document.querySelector('#sim-banner').hidden, mode: document.querySelector('#clock-mode').textContent, iss: window.__orbitalAtlas.view.issSprite.visible, tc: window.__orbitalAtlas.trajectory.centerMs }));
    const moved = Math.hypot(s1.lat - s0.lat, s1.lng - s0.lng);
    assert(r.off === 60 && r.banner && r.mode === 'SIM', `after +1h: ${JSON.stringify(r)}`);
    assert(moved > 5, `ISS moved only ${moved.toFixed(2)}° after +1 h`);
    assert(Math.abs(r.tc - t0 - 3_600_000) < 120_000, 'trajectory not recomputed for the new time');
    assert(!r.iss, 'live ISS API marker shown in simulated time');
    await page.click('.tl-speed[data-speed="600"]');
    await sleep(2500);
    const off2 = await app(page, () => window.__orbitalAtlas.clock.offsetMs() / 60000);
    assert(off2 > 75, `600× did not advance the clock (offset ${off2.toFixed(1)} min)`);
    await page.click('#tl-play'); // pause
    const p1 = await app(page, () => window.__orbitalAtlas.clock.now());
    await sleep(800);
    const p2 = await app(page, () => window.__orbitalAtlas.clock.now());
    assert(p1 === p2, 'clock advanced while paused');
    await page.click('#tl-live');
    await sleep(800);
    const live = await app(page, () => window.__orbitalAtlas.clock.isLive());
    assert(live, 'Now button did not return to live');
    // slider: drag to −12 h
    await page.evaluate(() => {
      const s = document.querySelector('#tl-slider');
      s.value = String(-720);
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(500);
    const offS = await app(page, () => Math.round(window.__orbitalAtlas.clock.offsetMs() / 60000));
    assert(Math.abs(offS + 720) <= 1, `slider set offset ${offS} min`);
    await page.click('#tl-live');
    await settle(page);
    return `ISS moved ${moved.toFixed(1)}° in +1 h; 600× → +${off2.toFixed(0)} min; pause/live/slider OK`;
  });

  await check('8. search by name, NORAD ID and six-digit ID; empty state', async () => {
    await page.fill('#search', 'HST');
    await sleep(400);
    const first = await page.locator('#search-results li').first().innerText();
    assert(/HST/.test(first), `first suggestion: ${first}`);
    await page.press('#search', 'Enter');
    await sleep(1200);
    assert((await app(page, () => window.__orbitalAtlas.selected?.id)) === 20580, 'Enter did not select HST');
    const six = await app(page, () => window.__orbitalAtlas.catalog.sats.find((s) => s.id > 99999).id);
    await page.fill('#search', String(six));
    await sleep(500);
    const sixTxt = await page.locator('#search-results li').first().innerText();
    assert(sixTxt.includes(String(six)), `six-digit search: ${sixTxt}`);
    await page.fill('#search', '25544');
    await sleep(500);
    assert((await page.locator('#search-results li').first().innerText()).includes('ISS'), 'NORAD 25544 search');
    await page.fill('#search', 'zz-no-such-satellite');
    await sleep(600);
    const empty = await app(page, () => ({ m: window.__orbitalAtlas.matching.length, e: !document.querySelector('#empty-state').hidden }));
    assert(empty.m === 0 && empty.e, 'empty state not shown');
    await page.fill('#search', '');
    await sleep(600);
    return `HST, ${six}, 25544 found; empty state OK`;
  });

  await check('9. every category filter (and orbit class / constellation filters)', async () => {
    const cats = await app(page, () => [...document.querySelectorAll('#f-categories input')].map((i) => i.value));
    const out = {};
    for (const c of cats) {
      await page.click('[data-none="categories"]');
      await page.click(`#f-categories label[data-k="${c}"]`);
      await sleep(350);
      const r = await app(page, (cat) => {
        const a = window.__orbitalAtlas;
        const expected = a.catalog.sats.filter((s) => s.category === cat).length;
        const wrong = a.shown.filter((s) => s.category !== cat && s !== a.selected).length;
        return { n: a.matching.length, expected, wrong, label: document.querySelector(`[data-count="${cat}"]`).textContent };
      }, c);
      assert(r.n === r.expected && r.n > 0 && r.wrong === 0, `category ${c}: ${JSON.stringify(r)}`);
      out[c] = r.n;
    }
    await page.click('[data-all="categories"]');
    await sleep(300);
    // orbit class
    await page.click('#f-classes [data-cls="LEO"]');
    await sleep(350);
    const noLeo = await app(page, () => window.__orbitalAtlas.matching.every((s) => s.orbitClass !== 'LEO') && window.__orbitalAtlas.matching.length);
    assert(noLeo > 0, 'LEO toggle');
    await page.click('#f-classes [data-cls="LEO"]');
    // constellation
    await page.click('#f-constellations [data-con="Galileo"]');
    await sleep(350);
    const gal = await app(page, () => window.__orbitalAtlas.matching.every((s) => s.constellations.includes('Galileo')) && window.__orbitalAtlas.matching.length);
    assert(gal > 10, 'Galileo constellation filter');
    await page.click('[data-none="constellations"]');
    // altitude preset GEO
    await page.click('[data-alt="35000,37000"]');
    await sleep(350);
    const geo = await app(page, () => window.__orbitalAtlas.matching.every((s) => s.meanAltKm >= 35000 && s.meanAltKm <= 37000) && window.__orbitalAtlas.matching.length);
    assert(geo > 100, 'altitude preset');
    await page.click('[data-alt="0,inf"]');
    await sleep(350);
    const all = await app(page, () => window.__orbitalAtlas.matching.length === window.__orbitalAtlas.catalog.sats.length);
    assert(all, 'filters did not reset');
    return { ...out, notLEO: noLeo, galileo: gal, geoAlt: geo };
  });

  await check('15. category chart and its "without Starlink" scale toggle', async () => {
    await page.click('#tab-overview');
    await sleep(300);
    const widths = () => app(page, () => Object.fromEntries([...document.querySelectorAll('#pane-overview .bar-row')].map((r) => [r.querySelector('.bar-label').textContent, parseFloat(r.querySelector('.bar').style.width)])));
    const w0 = await widths();
    await page.click('#pane-overview [data-v="nostar"]');
    await sleep(300);
    const w1 = await widths();
    const off = await app(page, () => !!document.querySelector('#pane-overview .bar-row.is-off'));
    assert(w0.Starlink === 100 && w1.Starlink === 0 && off, `Starlink bar ${w0.Starlink} → ${w1.Starlink}`);
    assert(w1.OneWeb === 100 && w1.OneWeb > w0.OneWeb * 5, `OneWeb bar ${w0.OneWeb} → ${w1.OneWeb}`);
    await page.click('#pane-overview [data-v="all"]');
    await sleep(300);
    assert((await widths()).Starlink === 100, 'toggle back to "all"');
    const stats = await page.locator('#pane-overview').innerText();
    for (const k of ['records loaded', 'displayed', 'valid positions', 'average calculated altitude', 'LEO', 'MEO', 'GEO']) assert(stats.includes(k), `statistics missing "${k}"`);
    await page.click('#tab-details');
    return `OneWeb bar ${w0.OneWeb.toFixed(1)}% → ${w1.OneWeb.toFixed(1)}%`;
  });

  await check('dialogs (data sources, orbital primer)', async () => {
    await page.click('#status-data');
    await sleep(300);
    const t = await page.locator('#dlg-data').innerText();
    assert(/Embedded in this HTML file/.test(t) && /GROUP=STARLINK/.test(t) && /fresh/.test(t), 'data dialog content');
    await page.keyboard.press('Escape');
    await page.click('#btn-edu');
    await sleep(300);
    assert(/SGP4 propagation/.test(await page.locator('#dlg-edu').innerText()), 'primer content');
    await page.keyboard.press('Escape');
    return 'OK';
  });

  await check('17. live ISS API request from this origin (CORS)', async () => {
    await page.click('.qbtn[data-quick="iss"]');
    await sleep(1200);
    const r = await page.waitForFunction(() => {
      const s = window.__orbitalAtlas.issState;
      return s && s.status !== 'connecting' ? s : null;
    }, null, { timeout: 20_000 }).then((h) => h.jsonValue());
    const requested = log.requests.filter((u) => u.startsWith(ISS_URL)).length;
    if (r.status !== 'live') {
      if (!(await internetReachable())) return { skip: `machine offline (${r.error})` };
      throw new Error(`ISS API status ${r.status}: ${r.error}`);
    }
    const card = await page.locator('#det-iss').innerText();
    assert(/API online/.test(card) && /API timestamp/.test(card) && /WhereTheISS/.test(card), 'ISS card content');
    return `status=live, ${requested} request(s), lat ${r.data.lat.toFixed(2)}, ${r.data.speedKms.toFixed(3)} km/s, ts ${new Date(r.data.timestampMs).toISOString()}`;
  });

  await check('21. no NaN / Infinity / undefined in the UI', async () => {
    await noNaN(page);
    await page.click('#tab-overview');
    await noNaN(page);
    await page.click('#tab-details');
    return 'OK';
  });

  await check('19/20/25. no JS errors, no missing assets, no local or dev-server requests', async () => {
    const isFile = url.startsWith('file:');
    const pageUrl = url.split('?')[0];
    const foreign = log.requests.filter((u) => u.split('?')[0] !== pageUrl && !u.startsWith(ISS_URL) && !(!isFile && u.split('?')[0] === pageUrl + 'index.html'));
    assert(log.pageErrors.length === 0, `page errors: ${log.pageErrors.join(' | ')}`);
    assert(log.consoleErrors.length === 0, `console errors: ${log.consoleErrors.join(' | ')}`);
    assert(log.failed.length === 0, `failed requests: ${log.failed.join(' | ')}`);
    assert(foreign.length === 0, `unexpected requests: ${foreign.join(', ')}`);
    assert(!log.requests.some((u) => /localhost|127\.0\.0\.1/.test(u)) || !isFile, 'file:// page contacted a local server');
    return `${log.requests.length} requests total: the page itself + ${log.requests.filter((u) => u.startsWith(ISS_URL)).length} × ISS API`;
  });
  await ctx.close();

  /* ---------------------------------------------- offline & API failure */
  group(`${label}: offline & API failure`);

  await check('16. fully offline: snapshot loads, satellites, selection, trajectory, search work', async () => {
    if (remote) return { skip: 'remote URL — a web page cannot be loaded without network (offline mode is verified on the local file)' };
    const c = await browser.newContext({ viewport: { width: 1400, height: 860 }, offline: true });
    const p = await c.newPage();
    const l = instrument(p);
    try {
      await openApp(p, url);
      await p.click('.qbtn[data-quick="iss"]');
      await sleep(2500);
      const r = await app(p, () => {
        const a = window.__orbitalAtlas;
        return { sats: a.catalog.sats.length, valid: a.view.validCount(), sel: a.selected?.id, traj: a.trajectory?.ground.length, orbit: a.view.orbitFuture.visible, iss: a.issState?.status, issErr: a.issState?.error, chip: document.querySelector('#status-iss').innerText.replace(/\s+/g, ' '), online: navigator.onLine };
      });
      assert(r.sats > 13000 && r.valid > 1000 && r.sel === 25544 && r.traj > 300 && r.orbit, `offline app state ${JSON.stringify(r)}`);
      assert(r.iss === 'error' && /offline/.test(r.issErr) && /offline/.test(r.chip), `ISS status offline: ${JSON.stringify(r)}`);
      await p.fill('#search', 'STARLINK');
      await sleep(600);
      assert((await app(p, () => window.__orbitalAtlas.matching.length)) > 1000, 'offline search');
      await p.click('#tl-fwd');
      await sleep(1000);
      assert((await app(p, () => window.__orbitalAtlas.view.validCount())) > 0, 'offline simulation');
      const errs = l.pageErrors;
      assert(errs.length === 0, `page errors ${errs}`);
      return `${r.sats} sats, ${r.valid} positions, ISS chip “${r.chip}”, error “${r.issErr}”`;
    } finally {
      await c.close();
    }
  });

  await check('18. ISS API failure (HTTP 503 and network error) falls back gracefully', async () => {
    const out = {};
    for (const [kind, handler] of [
      ['503', (r) => r.fulfill({ status: 503, body: 'Service Unavailable', headers: { 'Access-Control-Allow-Origin': '*' } })],
      ['abort', (r) => r.abort('connectionrefused')],
    ]) {
      const c = await browser.newContext({ viewport: { width: 1400, height: 860 } });
      const p = await c.newPage();
      const l = instrument(p);
      await p.route('**/api.wheretheiss.at/**', handler);
      try {
        await openApp(p, url);
        await p.waitForFunction(() => window.__orbitalAtlas.issState?.status === 'error', null, { timeout: 15_000 });
        await p.click('.qbtn[data-quick="iss"]');
        await sleep(1500);
        const r = await app(p, () => ({ err: window.__orbitalAtlas.issState.error, card: document.querySelector('#det-iss').innerText, pos: window.__orbitalAtlas.view.stateOf(window.__orbitalAtlas.selected.idx), marker: window.__orbitalAtlas.view.issSprite.visible }));
        assert(/API unavailable/.test(r.card) && /SGP4/.test(r.card) && r.pos && !r.marker, `fallback state ${JSON.stringify(r).slice(0, 300)}`);
        assert(l.pageErrors.length === 0, `page errors ${l.pageErrors}`);
        out[kind] = r.err;
      } finally {
        await c.close();
      }
    }
    return out;
  });

  await check('24b. main-thread fallback (?worker=off) propagates and stays responsive', async () => {
    const c = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const p = await c.newPage();
    const l = instrument(p);
    try {
      await openApp(p, `${url}?worker=off`);
      const r1 = await app(p, () => ({ mode: window.__orbitalAtlas.propagator.mode, reason: window.__orbitalAtlas.propagator.fallbackReason, valid: window.__orbitalAtlas.view.validCount(), t: window.__orbitalAtlas.view.dataTime }));
      assert(r1.mode === 'main-thread' && r1.valid > 1000, `fallback state ${JSON.stringify(r1)}`);
      // event-loop responsiveness probe while propagating
      const probe = await p.evaluate(async () => {
        const lat = [];
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          await new Promise((r) => setTimeout(r, 0));
          lat.push(performance.now() - t);
          await new Promise((r) => setTimeout(r, 50));
        }
        lat.sort((a, b) => a - b);
        return { median: lat[10], max: lat[19], slice: window.__orbitalAtlas.propagator.sliceMs };
      });
      await sleep(1500);
      const t2 = await app(p, () => window.__orbitalAtlas.view.dataTime);
      assert(t2 > r1.t, 'positions not updating in main-thread mode');
      await p.click('.qbtn[data-quick="iss"]');
      await sleep(1500);
      assert((await app(p, () => window.__orbitalAtlas.selected?.id)) === 25544, 'selection in fallback mode');
      assert(l.pageErrors.length === 0, `page errors ${l.pageErrors}`);
      return `mode=main-thread, SGP4 slices ≤ ${probe.slice} ms; setTimeout latency median ${probe.median.toFixed(0)} ms / max ${probe.max.toFixed(0)} ms (software WebGL)`;
    } finally {
      await c.close();
    }
  });

  /* ----------------------------------------------------- responsive */
  group(`${label}: responsive layouts`);
  for (const [name, vp, touch] of [
    ['22. phone 390×844', { width: 390, height: 844 }, true],
    ['22. tablet portrait 820×1180', { width: 820, height: 1180 }, true],
    ['22. tablet landscape 1180×820', { width: 1180, height: 820 }, true],
  ]) {
    await check(`${name} — usable, 23. no horizontal scroll`, async () => {
      const c = await browser.newContext({ viewport: vp, isMobile: touch && vp.width < 900, hasTouch: touch, deviceScaleFactor: 2 });
      const p = await c.newPage();
      const l = instrument(p);
      try {
        await openApp(p, url);
        const mobile = vp.width <= 900;
        const overflow = () => app(p, () => {
          const w = document.documentElement.clientWidth;
          const offenders = [...document.querySelectorAll('header, aside, footer, nav, .panel, .bottombar, .topbar')].filter((e) => {
            const r = e.getBoundingClientRect();
            return getComputedStyle(e).display !== 'none' && (r.right > w + 1 || r.left < -1);
          }).map((e) => e.className);
          return { hscroll: document.documentElement.scrollWidth > w || document.body.scrollWidth > w, offenders };
        });
        let o = await overflow();
        assert(!o.hscroll && o.offenders.length === 0, `overflow ${JSON.stringify(o)}`);
        if (mobile) {
          await p.tap('[data-drawer="left"]');
          await sleep(500);
          assert(await app(p, () => document.querySelector('#panel-left').classList.contains('is-open')), 'filters drawer did not open');
          await p.tap('#panel-left .qbtn[data-quick="iss"]');
          await sleep(1800);
          const r = await app(p, () => ({ right: document.querySelector('#panel-right').classList.contains('is-open'), sel: window.__orbitalAtlas.selected?.id }));
          assert(r.right && r.sel === 25544, `details drawer ${JSON.stringify(r)}`);
          await p.tap('[data-drawer="none"]');
          await sleep(400);
        } else {
          await p.click('.qbtn[data-quick="iss"]');
          await sleep(1500);
          assert(await p.locator('#pane-details').isVisible(), 'details panel hidden');
        }
        o = await overflow();
        assert(!o.hscroll && o.offenders.length === 0, `overflow after interaction ${JSON.stringify(o)}`);
        await p.screenshot({ path: join(SHOTS, `${label.replace(/\W+/g, '_')}-${vp.width}x${vp.height}.png`) });
        assert(l.pageErrors.length === 0, `page errors ${l.pageErrors}`);
        return `${mobile ? 'drawers' : 'side panels'} OK, limit ${await app(p, () => window.__orbitalAtlas.limit)}`;
      } finally {
        await c.close();
      }
    });
  }
}

/* ======================================= SERVED SUITE (http / https) */

async function servedSuite(browser, url, label, ctxOpts = {}) {
  group(label);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 880 }, ...ctxOpts });
  const page = await ctx.newPage();
  const log = instrument(page);
  try {
    await check(`loads at ${new URL(url).pathname} with embedded data and worker`, async () => {
      await openApp(page, url);
      const r = await app(page, () => ({ o: window.__orbitalAtlas.datasetOrigin, m: window.__orbitalAtlas.propagator.mode, n: window.__orbitalAtlas.catalog.sats.length, v: window.__orbitalAtlas.view.validCount(), proto: location.protocol }));
      assert(r.o === 'embedded' && r.m === 'worker' && r.n > 13000 && r.v > 1000, JSON.stringify(r));
      return r;
    });
    await check('select ISS, trajectory, search, filter, time', async () => {
      await page.click('.qbtn[data-quick="iss"]');
      await sleep(1500);
      const t = await app(page, () => ({ sel: window.__orbitalAtlas.selected?.id, g: window.__orbitalAtlas.view.groundFuture.visible, o: window.__orbitalAtlas.view.orbitFuture.visible }));
      assert(t.sel === 25544 && t.g && t.o, JSON.stringify(t));
      await page.fill('#search', 'HST');
      await sleep(400);
      await page.press('#search', 'Enter');
      await sleep(800);
      assert((await app(page, () => window.__orbitalAtlas.selected?.id)) === 20580, 'search');
      await page.fill('#search', '');
      await page.click('.qbtn[data-quick="gps"]');
      await sleep(500);
      assert((await app(page, () => window.__orbitalAtlas.matching.length)) > 20, 'gps filter');
      await page.click('#tl-fwd');
      await sleep(800);
      assert((await app(page, () => Math.round(window.__orbitalAtlas.clock.offsetMs() / 60000))) === 60, 'time');
      await page.click('#tl-live');
      return 'OK';
    });
    await check('live ISS API from this origin (CORS)', async () => {
      const r = await page.waitForFunction(() => {
        const s = window.__orbitalAtlas.issState;
        return s && s.status !== 'connecting' ? s : null;
      }, null, { timeout: 20_000 }).then((h) => h.jsonValue());
      if (r.status !== 'live') {
        if (!(await internetReachable())) return { skip: 'machine offline' };
        throw new Error(`ISS API ${r.status}: ${r.error}`);
      }
      return `status=live (origin ${new URL(url).origin}), lat ${r.data.lat.toFixed(2)}`;
    });
    await check('only index.html + ISS API requested; no errors', async () => {
      await noNaN(page);
      const foreign = log.requests.filter((u) => !u.startsWith(ISS_URL) && !new RegExp(`${PAGES_PATH}(index\\.html)?$`).test(u.split('?')[0]));
      assert(foreign.length === 0, `unexpected requests: ${foreign.join(', ')}`);
      assert(log.pageErrors.length === 0 && log.consoleErrors.length === 0, `errors: ${[...log.pageErrors, ...log.consoleErrors].join(' | ')}`);
      assert(log.failed.length === 0, `failed: ${log.failed.join(' | ')}`);
      return `${log.requests.length} requests`;
    });
  } finally {
    await ctx.close();
  }
}

/** Serves ONLY GitHub_Pages/index.html at PAGES_PATH — any other path is a 404 and is recorded. */
function pagesHandler(hits) {
  return (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(p);
    if (p === PAGES_PATH || p === `${PAGES_PATH}index.html`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(PAGES));
    }
    if (p === PAGES_PATH.slice(0, -1)) {
      res.writeHead(301, { location: PAGES_PATH });
      return res.end();
    }
    res.writeHead(404);
    res.end('not found');
  };
}

async function internetReachable() {
  try {
    const r = await fetch(ISS_URL, { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

function makeCert() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'oa-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return null;
  }
}

/* =================================================================== main */

const SHOTS = process.env.E2E_SHOTS || mkdtempSync(join(tmpdir(), 'oa-e2e-'));

async function main() {
  if (!executablePath) {
    console.error('No Chrome/Edge executable found. Set CHROME_PATH.');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath, headless: process.env.HEADED ? false : true, args: GL_ARGS });
  if (argUrl) {
    // ---- deployed-site mode
    console.log(`Browser: ${executablePath}\nURL: ${argUrl}\nScreenshots: ${SHOTS}`);
    try {
      group(`Deployed site — ${argUrl}`);
      await check('HTTP 200, single self-contained HTML document', async () => {
        const res = await fetch(argUrl, { cache: 'no-store' });
        const html = await res.text();
        assert(res.status === 200, `HTTP ${res.status}`);
        const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
        const local = [...markup.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]).filter((u) => !/^(data:|https?:|#|mailto:|blob:)/.test(u));
        assert(local.length === 0, `local references: ${local.join(', ')}`);
        assert(!/fonts\.googleapis|unpkg\.com|cdn\.jsdelivr|cdnjs/.test(html), 'CDN reference');
        const m = html.match(/id="oa-data" data-records="(\d+)" data-fetched="([^"]+)"/);
        assert(m, 'embedded dataset missing');
        return `${res.headers.get('content-type')}, ${html.length.toLocaleString('en-US')} bytes, ${m[1]} records, CelesTrak fetch ${m[2]}, last-modified ${res.headers.get('last-modified')}`;
      });
      await fullSuite(browser, argUrl, 'Deployed site', { remote: true });
    } finally {
      await browser.close();
    }
    return summary();
  }
  for (const f of [STANDALONE, PAGES]) if (!existsSync(f)) throw new Error(`${f} not found — run npm run build:standalone`);
  console.log(`Browser: ${executablePath}\nStandalone: ${STANDALONE}\nPages:      ${PAGES}\nScreenshots: ${SHOTS}`);
  try {
    await fullSuite(browser, pathToFileURL(STANDALONE).href, 'A. file:// Standalone/Orbital_Atlas.html');

    const httpHits = [];
    const http = createHttp(pagesHandler(httpHits));
    await new Promise((r) => http.listen(0, '127.0.0.1', r));
    const httpUrl = `http://127.0.0.1:${http.address().port}${PAGES_PATH}`;
    await servedSuite(browser, httpUrl, `B. GitHub Pages simulation — ${httpUrl}`);
    await check('server saw only the page itself', async () => {
      const other = httpHits.filter((p) => p !== PAGES_PATH && p !== `${PAGES_PATH}index.html`);
      assert(other.length === 0, `server requests: ${other.join(', ')}`);
      return `${httpHits.length} request(s) to the server`;
    });
    http.close();

    const tls = makeCert();
    if (tls) {
      const httpsHits = [];
      const https = createHttps(tls, pagesHandler(httpsHits));
      await new Promise((r) => https.listen(0, '127.0.0.1', r));
      const httpsUrl = `https://127.0.0.1:${https.address().port}${PAGES_PATH}`;
      // self-signed test certificate: accepted by this test context only
      await servedSuite(browser, httpsUrl, `C. HTTPS origin — ${httpsUrl} (self-signed test cert)`, { ignoreHTTPSErrors: true });
      https.close();
    } else {
      group('C. HTTPS origin');
      results.push({ group: currentGroup, name: 'HTTPS origin', status: 'SKIP', detail: 'openssl not available' });
      console.log('  ○ SKIP openssl not available');
    }
  } finally {
    await browser.close();
  }
  return summary();
}

function summary() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${'='.repeat(70)}\nRESULT: ${pass} passed, ${fail.length} failed, ${skip} skipped`);
  for (const f of fail) console.log(`  ✖ [${f.group}] ${f.name}: ${f.detail}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
