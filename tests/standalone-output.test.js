/**
 * Static checks of the generated single-file deliverables
 * (Standalone/Orbital_Atlas.html and GitHub_Pages/index.html).
 * Run `npm run build:standalone` first; skipped if the files do not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const STANDALONE = new URL('../Standalone/Orbital_Atlas.html', import.meta.url);
const PAGES = new URL('../GitHub_Pages/index.html', import.meta.url);
const SNAPSHOT = new URL('../public/data/orbits.json', import.meta.url);

describe.skipIf(!existsSync(STANDALONE) || !existsSync(PAGES))('standalone HTML deliverables', () => {
  const html = readFileSync(STANDALONE, 'utf8');
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');

  it('both deliverables are byte-identical; GitHub_Pages contains only index.html', () => {
    expect(readFileSync(PAGES).equals(readFileSync(STANDALONE))).toBe(true);
    expect(readdirSync(new URL('../GitHub_Pages/', import.meta.url))).toEqual(['index.html']);
  });

  it('references no separate local files and no CDNs', () => {
    const refs = [...markup.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    const local = refs.filter((u) => !/^(data:|https?:|#|mailto:|blob:)/.test(u));
    expect(local).toEqual([]);
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|unpkg\.com|cdn\.jsdelivr|cdnjs/);
    expect(markup).not.toMatch(/<script[^>]+src=/);
    expect(markup).not.toMatch(/<link[^>]+rel="stylesheet"/);
    // CSS: only data: URLs (fonts are inlined)
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('data:font/woff2'))).toBe(true);
  });

  it('embeds the complete real CelesTrak snapshot losslessly', () => {
    const m = html.match(/<script type="application\/x-gzip-base64" id="oa-data" data-records="(\d+)" data-fetched="([^"]+)">([^<]+)<\/script>/);
    expect(m).toBeTruthy();
    const embedded = JSON.parse(gunzipSync(Buffer.from(m[3], 'base64')).toString('utf8'));
    expect(embedded.records.length).toBe(Number(m[1]));
    expect(embedded.meta.lastSuccessfulFetch).toBe(m[2]);
    expect(embedded.records.some((r) => r.NORAD_CAT_ID > 99_999)).toBe(true);
    expect(embedded.records.find((r) => r.NORAD_CAT_ID === 25544).OBJECT_NAME).toBe('ISS (ZARYA)');
    if (existsSync(SNAPSHOT)) {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
      // If this fails after `npm run fetch:orbits`, regenerate with `npm run build:standalone`.
      expect(embedded).toEqual(snap);
    }
  });

  it('embeds all textures as JPEG data URIs', () => {
    for (const t of ['earth-blue-marble', 'earth-night', 'earth-water', 'clouds-alpha', 'night-sky']) {
      const m = html.match(new RegExp(`<script type="text/plain" data-asset="textures/${t}\\.jpg">data:image/jpeg;base64,([^<]+)</script>`));
      expect(m, t).toBeTruthy();
      const bytes = Buffer.from(m[1], 'base64');
      expect(bytes[0]).toBe(0xff); // JPEG SOI marker
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.length).toBeGreaterThan(50_000);
    }
  });

  it('embeds the worker, Globe.gl / Three.js, satellite.js and the app as inline scripts', () => {
    const worker = html.match(/<script type="text\/plain" id="oa-worker-src">([\s\S]*?)<\/script>/)[1];
    expect(worker).toMatch(/jdsatepoch/); // satellite.js SGP4 state
    expect(worker).toMatch(/onmessage/);
    const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    expect(mod.length).toBeGreaterThan(1_000_000);
    expect(mod).toMatch(/globeMaterial/); // Globe.gl API
    expect(mod).toMatch(/WebGLRenderer/); // Three.js
    expect(mod).toMatch(/jdsatepoch/); // satellite.js on the main thread (trajectories)
    expect(mod).toContain('https://api.wheretheiss.at/v1/satellites/25544'); // direct ISS API kept
    expect(mod).not.toMatch(/\bimport\s*\(\s*["'`]\.{0,2}\//); // no runtime local module imports
    expect(mod).not.toMatch(/from\s*["']\.{0,2}\//);
  });
});
