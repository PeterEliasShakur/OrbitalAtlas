#!/usr/bin/env node
/**
 * Orbital Atlas — orbital-element refresh script.
 *
 * Downloads selected CelesTrak GP groups (OMM JSON), validates and merges them
 * by NORAD catalog number, and writes public/data/orbits.json. On any failure
 * the previous (last-known-good) snapshot is preserved.
 *
 * Usage:
 *   node scripts/fetch-orbits.mjs [--out public/data/orbits.json]
 *                                 [--previous .cache/orbits.json] (repeatable)
 *                                 [--min-age 120] [--groups STATIONS,GPS-OPS]
 *                                 [--force] [--dry-run]
 *
 * Exit code is 0 whenever a usable snapshot exists afterwards (fresh or
 * previous), so a scheduled deployment can still publish the site. It is 1
 * only when no usable data exists at all.
 */
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, CELESTRAK } from '../src/config.js';
import { fetchGroup, buildDataset, validateDataset, snapshotAgeMinutes } from './lib/dataset.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    out: resolve(ROOT, 'public/data/orbits.json'),
    previous: [],
    minAge: CELESTRAK.minRefreshMinutes,
    groups: null,
    force: false,
    dryRun: false,
    delayMs: 1500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') opts.out = resolve(next());
    else if (a === '--previous') opts.previous.push(resolve(next()));
    else if (a === '--min-age') opts.minAge = Number(next());
    else if (a === '--groups') opts.groups = next().split(',').map((s) => s.trim().toUpperCase());
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--delay') opts.delayMs = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log('See header of scripts/fetch-orbits.mjs for usage.');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function readSnapshot(path) {
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(json?.records) || !json?.meta) return null;
    return json;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[fetch-orbits]', ...a);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Choose the newest last-known-good snapshot among the candidates.
  const candidates = [opts.out, ...opts.previous];
  let previous = null;
  let previousPath = null;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const snap = await readSnapshot(p);
    if (!snap) {
      log(`ignoring unreadable snapshot ${p}`);
      continue;
    }
    if (!previous || Date.parse(snap.meta.generatedAt) > Date.parse(previous.meta.generatedAt)) {
      previous = snap;
      previousPath = p;
    }
  }
  if (previous) {
    log(`last-known-good snapshot: ${previousPath} (${previous.records.length} records, last fetch ${previous.meta.lastSuccessfulFetch})`);
  } else {
    log('no previous snapshot found');
  }

  const ensureOutputIsPrevious = async () => {
    if (previous && previousPath !== opts.out && !opts.dryRun) {
      await mkdir(dirname(opts.out), { recursive: true });
      await copyFile(previousPath, opts.out);
      log(`restored last-known-good snapshot into ${opts.out}`);
    }
  };

  // 2. Respect CelesTrak's update cadence: skip if our data is recent enough.
  const age = snapshotAgeMinutes(previous);
  if (!opts.force && previous && age < opts.minAge) {
    log(`snapshot is ${age.toFixed(0)} min old (< ${opts.minAge} min) — skipping download to respect CelesTrak usage policy.`);
    await ensureOutputIsPrevious();
    return 0;
  }

  // 3. Download each group once, sequentially, with a polite delay.
  const groups = opts.groups ? GROUPS.filter((g) => opts.groups.includes(g.id)) : GROUPS;
  const results = {};
  let stopped = null;
  for (const [i, g] of groups.entries()) {
    if (stopped) {
      results[g.id] = { ok: false, httpStatus: null, error: `not requested (stopped after ${stopped})` };
      continue;
    }
    if (i > 0) await sleep(opts.delayMs);
    const r = await fetchGroup(g.id);
    results[g.id] = r;
    if (r.ok) log(`✔ ${g.id.padEnd(13)} ${String(r.records.length).padStart(5)} records${r.rejected.length ? ` (${r.rejected.length} rejected)` : ''}`);
    else log(`✖ ${g.id.padEnd(13)} ${r.error}`);
    if (r.stopAll) {
      stopped = `HTTP ${r.httpStatus} on ${g.id}`;
      log(`CelesTrak returned ${r.httpStatus}; not sending further requests this run.`);
    }
  }

  // 4. Merge with the previous snapshot and validate.
  const dataset = buildDataset({ results, previous, groups });
  const check = validateDataset(dataset, previous);
  const sixDigit = dataset.records.filter((r) => r.NORAD_CAT_ID > 99_999).length;
  log(`merged ${dataset.records.length} unique objects; ${dataset.meta.freshGroups}/${dataset.meta.totalGroups} groups fresh; ${sixDigit} with ≥6-digit NORAD IDs`);

  if (!check.ok) {
    log('validation failed — keeping the previous snapshot:');
    for (const r of check.reasons) log('   -', r);
    await ensureOutputIsPrevious();
    return previous ? 0 : 1;
  }

  if (opts.dryRun) {
    log('dry run — not writing output.');
    return 0;
  }

  // 5. Atomic write.
  await mkdir(dirname(opts.out), { recursive: true });
  const tmp = `${opts.out}.tmp`;
  await writeFile(tmp, JSON.stringify(dataset));
  await rename(tmp, opts.out);
  log(`wrote ${opts.out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[fetch-orbits] fatal:', err);
    process.exit(1);
  },
);
