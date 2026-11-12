#!/usr/bin/env node
/**
 * Orbital Atlas — standalone single-file build.
 *
 * Bundles the modular source (src/), Globe.gl / Three.js, satellite.js, the
 * SGP4 worker, fonts, textures and the current real CelesTrak snapshot
 * (public/data/orbits.json) into ONE self-contained HTML document:
 *
 *   Standalone/Orbital_Atlas.html   — double-click to open (file://)
 *   GitHub_Pages/index.html         — identical content, for GitHub Pages
 *
 * The generated HTML makes no requests for local files. Its only network
 * access at runtime is the live ISS API (https://api.wheretheiss.at), plus the
 * external links a user may click.
 *
 * Usage: node scripts/build-standalone.mjs [--data public/data/orbits.json]
 */
import { build } from 'vite';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOmm } from '../src/omm.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataPath = resolve(args.includes('--data') ? args[args.indexOf('--data') + 1] : join(ROOT, 'public/data/orbits.json'));
const OUTPUTS = [join(ROOT, 'Standalone/Orbital_Atlas.html'), join(ROOT, 'GitHub_Pages/index.html')];
const TEXTURES = ['earth-blue-marble.jpg', 'earth-night.jpg', 'earth-water.jpg', 'clouds-alpha.jpg', 'night-sky.jpg'];

const log = (...a) => console.log('[standalone]', ...a);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/**
 * Make text safe inside an HTML <script> element. Inside script data the HTML
 * tokenizer reacts to "</script", "<!--" and "<script"; in a JS module those
 * sequences can only occur inside string/regex/template literals or comments,
 * where "\x3C" is an equivalent spelling of "<".
 */
function escapeScript(code) {
  return code.replace(/<\/(script)/gi, '\\x3C/$1').replace(/<!--/g, '\\x3C!--').replace(/<(script)/gi, '\\x3C$1');
}

function outputs(result) {
  const r = Array.isArray(result) ? result[0] : result;
  return r.output;
}

async function buildWorker() {
  // Classic (IIFE) worker so it can run from a Blob URL in every browser.
  const res = await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    resolve: {
      alias: {
        '#wasm-single-thread': join(ROOT, 'src/platform/wasm-stub.js'),
        '#wasm-multi-thread': join(ROOT, 'src/platform/wasm-stub.js'),
      },
    },
    build: {
      write: false,
      target: 'es2020',
      minify: true,
      lib: { entry: join(ROOT, 'src/propagation-worker.js'), formats: ['iife'], name: 'OrbitalAtlasWorker', fileName: () => 'worker.js' },
    },
  });
  const chunks = outputs(res).filter((o) => o.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`worker build produced ${chunks.length} chunks`);
  return chunks[0].code;
}

async function buildApp() {
  const res = await build({
    root: ROOT,
    mode: 'standalone',
    logLevel: 'warn',
    publicDir: false, // textures & data are embedded below, not copied
    build: {
      write: false,
      assetsInlineLimit: () => true, // fonts → data: URIs inside the CSS
      cssCodeSplit: false,
      modulePreload: false,
      chunkSizeWarningLimit: 4000,
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const out = outputs(res);
  const js = out.filter((o) => o.type === 'chunk');
  const css = out.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
  const html = out.find((o) => o.type === 'asset' && o.fileName.endsWith('.html'));
  const others = out.filter((o) => o.type === 'asset' && !o.fileName.endsWith('.css') && !o.fileName.endsWith('.html'));
  if (js.length !== 1) throw new Error(`app build produced ${js.length} JS chunks (${js.map((c) => c.fileName)}) — expected exactly one`);
  if (others.length) throw new Error(`app build emitted separate asset files: ${others.map((o) => o.fileName).join(', ')}`);
  return { js: js[0], css: css.map((c) => String(c.source)).join('\n'), html: String(html.source) };
}

async function main() {
  const t0 = Date.now();

  // 1. Dataset: validate, then gzip losslessly.
  const dataText = await readFile(dataPath, 'utf8');
  const dataset = JSON.parse(dataText);
  if (!Array.isArray(dataset.records) || !dataset.meta) throw new Error(`${dataPath} is not an Orbital Atlas snapshot`);
  const bad = dataset.records.filter((r) => !normalizeOmm(r).ok).length;
  if (bad) throw new Error(`${bad} invalid records in snapshot`);
  const compact = JSON.stringify(dataset);
  const gz = gzipSync(Buffer.from(compact), { level: 9 });
  const dataB64 = gz.toString('base64');
  log(`dataset: ${dataset.records.length} records, last CelesTrak fetch ${dataset.meta.lastSuccessfulFetch} — ${kb(compact.length)} JSON → ${kb(gz.length)} gzip → ${kb(dataB64.length)} base64`);

  // 2. Code.
  const [workerCode, app] = await Promise.all([buildWorker(), buildApp()]);
  log(`app JS ${kb(app.js.code.length)}, CSS ${kb(app.css.length)}, worker ${kb(workerCode.length)}`);

  // 3. Textures and favicon as data: URIs.
  const textures = [];
  for (const t of TEXTURES) {
    const b = await readFile(join(ROOT, 'public/assets/textures', t));
    textures.push({ key: `textures/${t}`, uri: `data:image/jpeg;base64,${b.toString('base64')}` });
  }
  const favicon = `data:image/svg+xml;base64,${(await readFile(join(ROOT, 'public/favicon.svg'))).toString('base64')}`;
  log(`textures ${kb(textures.reduce((a, t) => a + t.uri.length, 0))} (base64)`);

  // 4. Assemble.
  let html = app.html;
  html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>\s*/g, '');
  html = html.replace(/<link rel="stylesheet"[^>]*href="[^"]+"[^>]*>\s*/g, '');
  html = html.replace(/<link rel="modulepreload"[^>]*>\s*/g, '');
  html = html.replace(/href="\.\/favicon\.svg"/, `href="${favicon}"`);
  const buildInfo = `Orbital Atlas standalone build ${new Date().toISOString()} · ${dataset.records.length} CelesTrak records fetched ${dataset.meta.lastSuccessfulFetch}`;
  html = html.replace('<head>', `<head>\n    <!-- ${buildInfo} -->\n    <meta name="generator" content="Orbital Atlas build-standalone" />`);
  html = html.replace('</head>', () => `    <style>\n${app.css.replace(/<\/style/gi, '<\\/style')}\n    </style>\n  </head>`);

  const payload = [
    '<!-- ===== Embedded real data: CelesTrak GP snapshot (OMM JSON, gzip + base64, lossless) ===== -->',
    `<script type="application/x-gzip-base64" id="oa-data" data-records="${dataset.records.length}" data-fetched="${dataset.meta.lastSuccessfulFetch}">${dataB64}</script>`,
    '<!-- ===== Embedded textures (NASA Blue Marble / Black Marble etc.) ===== -->',
    ...textures.map((t) => `<script type="text/plain" data-asset="${t.key}">${t.uri}</script>`),
    '<!-- ===== SGP4 propagation worker (started from a Blob URL; main-thread fallback if blocked) ===== -->',
    `<script type="text/plain" id="oa-worker-src">${escapeScript(workerCode)}</script>`,
    '<!-- ===== Application (Globe.gl, Three.js, satellite.js and Orbital Atlas source) ===== -->',
    `<script type="module">\n${escapeScript(app.js.code)}\n</script>`,
  ].join('\n');
  html = html.replace('</body>', () => `${payload}\n  </body>`);

  // 5. Verify: no references to separate local files.
  // scan the markup only (script bodies contain template-literal links built at runtime)
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  const refs = [...markup.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  const localRefs = refs.filter((u) => !/^(data:|https?:|#|mailto:|blob:)/.test(u) && u !== '');
  const cssUrls = [...app.css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
  const dynImports = (app.js.code.match(/\bimport\(\s*["'`]\.{0,2}\//g) || []).length;
  const scriptTags = (html.match(/<script\b/gi) || []).length;
  const scriptEnds = (html.match(/<\/script>/gi) || []).length;
  const problems = [];
  if (localRefs.length) problems.push(`local file references: ${localRefs.join(', ')}`);
  if (cssUrls.length) problems.push(`CSS url() to files: ${cssUrls.join(', ')}`);
  if (dynImports) problems.push(`${dynImports} dynamic import(s) of local modules`);
  if (scriptTags !== scriptEnds) problems.push(`unbalanced <script> tags (${scriptTags} vs ${scriptEnds})`);
  if (/fonts\.googleapis|fonts\.gstatic|unpkg\.com|jsdelivr/.test(html)) problems.push('CDN reference found');
  if (problems.length) throw new Error(`standalone verification failed:\n  - ${problems.join('\n  - ')}`);

  // 6. Write both deliverables atomically.
  for (const out of OUTPUTS) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(`${out}.tmp`, html);
    await rename(`${out}.tmp`, out);
    log(`wrote ${out} (${Buffer.byteLength(html).toLocaleString('en-US')} bytes)`);
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error('[standalone] FAILED:', err.message || err);
  process.exit(1);
});
