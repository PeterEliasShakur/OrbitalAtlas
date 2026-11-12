# Orbital Atlas — Explore Earth's Orbit

**Live site:** https://petereliasshakur.github.io/OrbitalAtlas/ · **Repository:** https://github.com/PeterEliasShakur/OrbitalAtlas

An interactive 3D Earth with **real satellites** positioned by **SGP4 orbital propagation in your browser**, driven by public orbital-element data from **CelesTrak**, plus the **live ISS position** from the **WhereTheISS.at** REST API.

- Rotate and zoom a realistic Earth (day/night terminator from the computed sub-solar point, night lights, ocean glint, atmosphere).
- ~13 000 real objects from 25 CelesTrak groups (stations, science, GNSS, weather/Earth observation, communications, Starlink, OneWeb, GEO, CubeSats, recent launches).
- Filter by category, approximate orbit class, mean altitude, constellation/group and name/NORAD ID (six-digit IDs supported).
- Click a satellite to see its calculated position, orbital elements, **orbital path in space** and **ground track** (past dashed, future solid), and follow it.
- Timeline: live mode, pause, 1× / 10× / 60× / 600×, ±1 h jumps and a slider over a prediction window around now.
- Statistics calculated from the loaded data, data-source status and freshness, an orbital primer.

> **What is real and what is calculated.** Orbital *elements* are downloaded from CelesTrak and refreshed automatically every ~4 hours. Satellite *positions* are never downloaded — they are **calculated continuously in your browser** from those elements with SGP4 (satellite.js). The ISS additionally shows the position *reported by WhereTheISS.at* (a provider-computed value, not raw telemetry), only in live mode. The app never fabricates positions: if data is unavailable it says so.

---

## Single-file deliverable — just double-click

| File | Use |
|---|---|
| `Standalone/Orbital_Atlas.html` | Double-click in File Explorer → opens in Chrome/Edge via `file://`. No Node, npm, server or browser flags. |
| `GitHub_Pages/index.html` | Byte-identical copy, the only file published to GitHub Pages. |

Each file (~7.3 MB) contains the whole application: HTML, CSS, self-hosted fonts, Globe.gl + Three.js, satellite.js, the SGP4 worker, all Earth/sky textures, and the **complete real CelesTrak snapshot** (13 456 objects, embedded losslessly as gzip + base64, decoded in the browser with `DecompressionStream`). It makes **no requests for local files and no CDN requests**. Its only network traffic is the live ISS API.

- **Offline:** everything works from the embedded snapshot — globe, satellites, selection, trajectories, SGP4 time simulation, search and filters. The UI shows the snapshot's original CelesTrak fetch time and warns when it is old.
- **Online:** the page calls `https://api.wheretheiss.at/v1/satellites/25544` directly every 30 s. The API sends `Access-Control-Allow-Origin: *`, so this works from `file://` pages (origin `null`) as well as from http/https origins. This was verified in Chrome and Edge. If the request fails, the ISS card explains why and the ISS keeps being shown from SGP4.
- **Worker:** the SGP4 worker is embedded as text and started from a Blob URL (works from `file://` in Chrome and Edge). If a browser refuses, the app falls back to main-thread propagation in ≤ 8 ms time slices, keeping the UI responsive. Append `?worker=off` to the URL to force the fallback.

Regenerate both files from the sources (after editing code or refreshing data):

```bash
npm run fetch:orbits        # optional: refresh the snapshot (respects the 2 h minimum)
npm run build:standalone    # → Standalone/Orbital_Atlas.html + GitHub_Pages/index.html
```

`scripts/build-standalone.mjs` builds the worker as a classic IIFE script and the app with Vite in `--mode standalone`. That mode swaps `src/platform/web.js` for `src/platform/standalone.js`, which reads textures, data and worker source from the document, and drops satellite.js's unused WASM runtimes. The script inlines everything, verifies that the output has no local, CDN or dynamic-import references, and writes both files.

---

## Architecture

```
            every ~4 h (GitHub Actions)                     every visitor's browser
 ┌────────────────────────────────────────┐     ┌───────────────────────────────────────────────┐
 │ scripts/fetch-orbits.mjs               │     │ data/orbits.json ──► prepareCatalog            │
 │  CelesTrak GP API (OMM JSON, 25 groups)│     │        │                                       │
 │  → validate → merge by NORAD_CAT_ID    │     │        ▼  Web Worker: json2satrec + SGP4       │
 │  → fallback to last-known-good         │──►  │   lat/lng/alt/speed for the displayed set      │
 │  → public/data/orbits.json             │     │        ▼                                       │
 │ vite build → GitHub Pages              │     │   Globe.gl / Three.js point cloud, paths       │
 └────────────────────────────────────────┘     │                                               │
                                                 │ WhereTheISS.at  (fetch every 30 s, CORS) ──►  │
                                                 │   ISS card + ◇ marker (live mode only)         │
                                                 └───────────────────────────────────────────────┘
```

Why a snapshot instead of calling CelesTrak from the browser? CelesTrak updates GP data about every 2 hours and blocks clients that download the same data repeatedly (HTTP 403/429). Thousands of visitors each downloading ~11 000 Starlink records would violate that policy. One scheduled job per ~4 h fetches each group once and the static site serves the result. The ISS API is designed for direct, frequent client requests and sends `Access-Control-Allow-Origin: *`, so it is called directly from the browser.

### Files

| Path | Purpose |
|---|---|
| `index.html` | App shell: top bar, panels, globe viewport, timeline, dialogs, icon sprite |
| `src/main.js` | Bootstrap, state, main loop, selection, wiring |
| `src/globe.js` | 3D visualisation (Globe.gl): shaders, satellite point cloud, orbit/ground-track lines, picking, labels, camera |
| `src/satellite-api.js` | Snapshot loading (+ Cache Storage offline fallback) and the WhereTheISS.at poller |
| `src/orbital-math.js` | OMM → satrec, SGP4 batch propagation, ECI → geodetic, trajectories, antimeridian splitting, sub-solar point, altitude scaling |
| `src/propagation-worker.js`, `src/propagator.js` | Web Worker that propagates the displayed satellites off the main thread |
| `src/omm.js` | OMM record validation/normalisation (shared with the Node script) and derived orbit class |
| `src/data-processing.js` | Catalog preparation (categories from group membership), breakdowns, safe number formatting |
| `src/satellite-filters.js` | Filters, search, render-limit sub-sampling |
| `src/satellite-details.js` | Right panel: details, ground-track minimap, ISS card, statistics |
| `src/ui-controls.js` | Left panel controls, legend, status chips, data-source dialog, mobile drawers |
| `src/timeline.js` | Simulation clock and timeline controls |
| `src/config.js` | Groups, categories/colours, constants, thresholds |
| `src/styles.css` | All styling |
| `scripts/fetch-orbits.mjs`, `scripts/lib/dataset.mjs` | Orbital-data refresh (fetch, validate, merge, fallback) |
| `public/data/orbits.json` | Committed last-known-good snapshot (real CelesTrak data) |
| `public/assets/textures/` | Earth, night-lights, ocean mask, clouds, star background |
| `src/platform/web.js`, `src/platform/standalone.js` | Platform layer (assets, dataset, worker) for the multi-file and single-file builds |
| `src/fonts.css` | Self-hosted Inter / JetBrains Mono (woff2, from @fontsource) |
| `scripts/build-standalone.mjs` | Builds the single self-contained HTML |
| `Standalone/Orbital_Atlas.html`, `GitHub_Pages/index.html` | Generated single-file deliverables |
| `tests/` | Vitest unit tests + real-data fixtures; `tests/browser/standalone.e2e.mjs` browser suite for the generated HTML |
| `.github/workflows/deploy.yml` | Scheduled refresh + build + GitHub Pages deployment |

---

## Requirements

- **Node.js 20 or newer** (developed with Node 24, CI uses Node 22) and npm.
- A browser with WebGL (current Chrome, Edge, Firefox or Safari).

## Development: install & run the multi-file version

```bash
cd orbital-atlas
npm install          # installs exact pinned versions from package-lock.json (or: npm ci)
npm run dev          # → http://localhost:5173/
```

## Update orbital data locally

```bash
npm run fetch:orbits                 # skips the download if the snapshot is < 120 min old
node scripts/fetch-orbits.mjs --force                      # download now regardless of age
node scripts/fetch-orbits.mjs --groups STATIONS,GPS-OPS --dry-run   # try a subset without writing
```

The script requests each group **once** (no retries) with a 1.5 s pause between requests, stops immediately on HTTP 403/429, treats non-JSON answers as failures, validates every record, merges duplicates by `NORAD_CAT_ID` (keeping the newest epoch and every group membership), keeps last-known-good data for failed groups, and only replaces `public/data/orbits.json` if the merged dataset passes validation (≥ 100 records, no duplicates, no drop of more than 50 % vs. the previous snapshot, at least one group refreshed). Please keep CelesTrak's [usage policy](https://celestrak.org/NORAD/documentation/gp-data-formats.php) in mind: don't run it more often than every 2 hours.

## Build & preview

```bash
npm run build        # → dist/
npm run preview      # → http://localhost:4173/
```

The Vite `base` is `./` (relative URLs), so the multi-file build works under any path. The published site is the single-file build, which has no relative URLs at all and so works at `https://petereliasshakur.github.io/OrbitalAtlas/` or anywhere else.

## Tests

```bash
npm test
```

81 unit tests (Vitest) cover: OMM validation (including six-digit NORAD IDs and malformed records), derived orbit classes, satellite.js 7.x API usage, equivalence of the batch propagator with `propagate()` + `eciToGeodetic()`, physical plausibility of ISS/GEO states, decay handling (no NaN), trajectories through the current position and changing with time, the ground track's westward shift per orbit, antimeridian splitting, the sub-solar point at equinox/solstice, the refresh script's HTTP handling (403/429 stop, 5xx, plain-text answers, network errors), merge/de-duplication/fallback, dataset validation, filters/search/render-limit sampling, the ISS API parser, a full propagation pass over the committed real snapshot, and static checks of the generated single-file HTML (identical files, no local/CDN references, lossless embedded snapshot equal to `public/data/orbits.json`, textures, worker, libraries, ISS API URL).

Browser end-to-end suite for the **generated files** (uses your installed Chrome or Edge through playwright-core; set `CHROME_PATH` to choose):

```bash
npm run test:standalone
```

It opens `Standalone/Orbital_Atlas.html` via `file://`. It checks:

- loading and the embedded snapshot;
- that the worker starts;
- WebGL rendering (texture and pixel checks);
- drag-rotation, wheel and button zoom;
- visible markers and click selection;
- valid details values;
- every quick selection, every category filter, and the orbit-class, constellation and altitude filters;
- search, including six-digit IDs, and the empty state;
- all three altitude modes;
- orbit-path and ground-track toggles and the minimap;
- time simulation (+1 h, 600×, pause, slider, back to live);
- the category chart's Starlink toggle;
- the dialogs;
- the live ISS API;
- no NaN/Infinity, no JS errors, and no requests other than the page and the ISS API;
- fully offline operation;
- ISS API 503 and network-error fallback;
- the `?worker=off` main-thread fallback;
- phone and tablet layouts with no horizontal scroll.

It then serves `GitHub_Pages/index.html` at `http://127.0.0.1:PORT/OrbitalAtlas/` (the exact GitHub Pages project path) and at an HTTPS origin (temporary self-signed certificate via openssl) to simulate GitHub Pages, including the ISS API's CORS from those origins.

---

## Deploy to GitHub Pages

The site is published from **https://github.com/PeterEliasShakur/OrbitalAtlas**. To set up a copy elsewhere:

1. **Create a public repository** (e.g. `OrbitalAtlas`, without a README so the first push is clean).
2. **Push the project** (from inside `orbital-atlas/`):
   ```bash
   git init
   git add .
   git commit -m "Orbital Atlas"
   git branch -M main
   git remote add origin https://github.com/USERNAME/OrbitalAtlas.git
   git push -u origin main
   ```
3. **Enable Pages with Actions:** repository → *Settings* → *Pages* → *Build and deployment* → *Source:* **GitHub Actions**.
4. The push triggers the workflow *Refresh orbital data & deploy* (*Actions* tab). When it finishes, the site is live at **`https://USERNAME.github.io/OrbitalAtlas/`** (the path is the repository name) — a single `index.html` (regenerated by the workflow with the newest valid snapshot embedded). If the first run started before Pages was enabled, re-run it from the *Actions* tab (*Run workflow*).

No secrets, tokens, paid services or servers are needed.

### Scheduled data updates

The workflow (`.github/workflows/deploy.yml`) runs:

- on every push to `main`,
- on a schedule, `17 */4 * * *` (every 4 hours at minute 17, UTC),
- manually via *Actions → Refresh orbital data & deploy → Run workflow* (tick *force_refresh* to bypass the 2-hour minimum age).

Each run restores the previous run's snapshot from the Actions cache, runs `fetch-orbits.mjs` (which uses the newer of the cached and the committed snapshot as the fallback), saves the result to the cache for the next run, regenerates the single-file page (`npm run build:standalone`), runs the unit tests and output checks (blocking) and the browser suite (informational), and deploys a Pages artifact that contains **only `index.html`**. **It never commits to the repository**, so the scheduled refresh works without pushes; the committed `public/data/orbits.json` is only the initial or worst-case fallback. If CelesTrak is unreachable, the site is redeployed with the previous data, and the UI shows the real age of the data. Groups that failed are listed as *cached* in the "Data sources" dialog.

GitHub's scheduled workflows are best-effort: runs can start late (often 5–30 min, sometimes more under load) or occasionally be skipped. GitHub also **disables schedules in repositories with no activity for 60 days**. If that happens, re-enable the workflow on the *Actions* tab (or push any commit).

### Verify the deployed API integration

1. Open the site. The top-right **CelesTrak** chip shows how long ago the orbital elements were fetched. It is green when they're less than 8 h old, amber when older or when some groups fell back to cached data, and red when older than 48 h. Click it to see the per-group status table with the exact CelesTrak URLs and fetch times.
2. The **ISS API** chip should turn green within a few seconds, showing the age of the last WhereTheISS.at response. Open DevTools → *Network*, filter on `wheretheiss`: a request to `https://api.wheretheiss.at/v1/satellites/25544` appears every 30 s with status 200.
3. Select the **ISS**. The *Live API position* card shows the API's coordinates and timestamp, plus **Δ vs. our SGP4** — the distance between the API's position and our own SGP4 calculation at the same instant, typically ~1 km.
4. The page is one document: DevTools → *Network* shows only `index.html` and the periodic ISS API requests. The orbital snapshot is embedded in it; its CelesTrak fetch time (top-right chip and *Data sources* dialog) should be at most ~4–5 hours old if the schedule is running. See the workflow log step *Show snapshot freshness*.
5. Move the timeline away from *now*: the banner switches to **Simulated**, positions are re-propagated, and the ISS API marker disappears, because API coordinates are only valid for the present.

---

## How it works (science notes)

- **Propagation.** Each OMM record is converted with `satellite.json2satrec()`. For each frame the worker computes the Julian date and GMST once, calls `sgp4(satrec, minutesSinceEpoch)` for each displayed satellite, rejects failures and decayed objects (`checkForDecay`, altitude < 80 km, non-finite values), and converts TEME/ECI to geodetic coordinates with `eciToGeodetic`. Speed is the inertial velocity magnitude.
- **Orbital path vs. ground track.** The *orbital path* is one revolution of propagated ECI positions, all rotated into the Earth-fixed frame using the sidereal time of the displayed instant — the shape of the orbit in space, which the satellite lies on. The *ground track* uses each sample's own sidereal time, so Earth's rotation makes it shift west by about 23° per ISS orbit. Sampling is 180 points per orbit (~31 s for the ISS, ~8 min for GEO). Ground tracks run from −½ to +1½ orbits.
- **Antimeridian.** In 3D, consecutive samples are joined by short chords, so nothing crosses the globe. The 2D minimap splits polylines at ±180° with interpolated edge points.
- **Altitude rendering.** *Compressed* (default) uses `0.5·√(h/R⊕)` Earth radii: LEO is ~2× enlarged and GEO pulled in to ~1.2 R⊕ so the whole population fits on screen. *True scale* is proportional. *Ground projection* puts every satellite on its sub-satellite point. Real altitudes are always shown numerically, and the on-screen badge states the mode.
- **Orbit classes** (approximate, from mean elements): GEO = period within ±3 % of a sidereal day and e < 0.05; then e > 0.25 → Other (HEO); LEO = apogee < 2 000 km; MEO = perigee ≥ 2 000 km and apogee < 35 586 km; otherwise Other.
- **Categories** come only from CelesTrak group membership (priority: stations › science › navigation › weather/EO › communications › Starlink › OneWeb › other GEO › CubeSats/recent). Operator, launch date and status are not in the dataset and are not shown.
- **Prediction window.** The timeline window is ±24 h around now (±12 h if the data is older than 2 days, ±6 h if older than 7 days). Elements more than 14 days from the displayed time are flagged in the details panel.
- **Render limit.** Records loaded, records matching the filters, and markers drawn are counted separately. When the limit is reached, small categories are drawn in full and large ones (Starlink) are evenly sub-sampled. The default limit is 5 000 (2 500 on ≤ 4-core or touch devices) and can be raised to 20 000.

## Data sources & credits

- Orbital elements: [CelesTrak](https://celestrak.org/) GP data (OMM JSON) — T.S. Kelso.
- Live ISS position: [WhereTheISS.at API](https://wheretheiss.at/w/developer).
- Earth imagery: NASA Blue Marble / Black Marble (public domain), via the MIT-licensed [three-globe](https://github.com/vasturiano/three-globe) examples; the cloud layer is a static illustrative texture, not live weather.
- Fonts: Inter and JetBrains Mono (SIL Open Font License), self-hosted via @fontsource.
- Libraries: [Globe.gl](https://globe.gl/) / [Three.js](https://threejs.org/), [satellite.js](https://github.com/shashwatak/satellite-js) 7.2, [Vite](https://vite.dev/), [Vitest](https://vitest.dev/).

Keyboard: `/` search · `Space` pause/resume · `F` follow selected · `Esc` deselect.
