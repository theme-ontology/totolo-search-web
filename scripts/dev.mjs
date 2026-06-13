#!/usr/bin/env node
/**
 * Local dev entry point. Serves the SAME site structure as production / uat:local
 * (front page at /, search SPA at /search/, detail pages + data + versions at the
 * root), but via the Vite dev server so the search app gets hot-reload.
 *
 * The only difference from uat:local is *how* it serves: dev = Vite (HMR, unminified)
 * for fast search-app iteration; uat = the real production build. A dev-only Vite
 * middleware (see vite.config.ts) serves the generated static pages from dist-data.
 *
 * Usage:
 *   node scripts/dev.mjs                          # latest ontology
 *   node scripts/dev.mjs v2025.10                # a release tag
 *   node scripts/dev.mjs --source v0.3.3         # any release tag
 *   node scripts/dev.mjs --source d:\repos\theming\notes   # a local theming files dir
 *   node scripts/dev.mjs --skip-corpus           # reuse corpus.json
 *   node scripts/dev.mjs --skip-index            # reuse dist-data; only regenerate pages
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER  = resolve(ROOT, 'packages/indexer');
const WEB      = resolve(ROOT, 'packages/web');
const CORPUS   = resolve(ROOT, 'corpus.json');
const OUT_DIR  = resolve(ROOT, 'dist-data'); // same artifacts dir uat:local / CI use

const NODE     = process.execPath;
const TSX      = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const VITE_BIN = resolve(ROOT, 'node_modules/vite/bin/vite.js');

const args = process.argv.slice(2);
const skipCorpus = args.includes('--skip-corpus') || args.includes('--skip-index');
const skipIndex  = args.includes('--skip-index');
// Corpus source for `makejson`: a release tag (v2026.04, v0.3.3), a local theming files
// path (via --source), or empty (latest). totolo interprets the trailing argument.
const srcFlag = args.indexOf('--source');
const source  = srcFlag >= 0 ? (args[srcFlag + 1] ?? '') : (args.find(a => /^v[\d.]+$/.test(a)) ?? '');

function step(n, total, label) {
  console.log(`\n\x1b[1m[${n}/${total}] ${label}\x1b[0m`);
}

function runSync(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\x1b[31mProcess exited with status ${result.status}\x1b[0m`);
    process.exit(result.status ?? 1);
  }
}

const totalSteps = 3;
let currentStep = 0;

// Ensure self-hosted models are present (idempotent; downloads on first run only).
console.log('\x1b[2mEnsuring models are downloaded…\x1b[0m');
runSync(NODE, [resolve(ROOT, 'scripts/fetch-models.mjs')]);

// ── Step 1: Generate corpus.json via Python ────────────────────────────────
if (!skipCorpus) {
  step(++currentStep, totalSteps, `Generating corpus${source ? ` (${source})` : ' (latest)'}…`);
  const pyArgs = ['-m', 'totolo.util.makejson', '-tsc'];
  if (source) pyArgs.push(source);
  const result = spawnSync('python', pyArgs, { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('\x1b[31mCorpus generation failed.\x1b[0m');
    process.exit(result.status ?? 1);
  }
  writeFileSync(CORPUS, result.stdout);
  console.log(`\x1b[2mWrote ${(result.stdout.length / 1024).toFixed(0)} KB → corpus.json\x1b[0m`);
} else if (!existsSync(CORPUS)) {
  console.error('\x1b[31mcorpus.json not found — cannot skip corpus step.\x1b[0m');
  process.exit(1);
} else {
  step(++currentStep, totalSteps, 'Skipping corpus generation');
}

// ── Step 2: Build indexes + pages (or just pages on --skip-index) ──────────
mkdirSync(OUT_DIR, { recursive: true });
if (skipIndex) {
  if (!existsSync(join(OUT_DIR, 'minisearch.json'))) {
    console.error('\x1b[31mdist-data not built yet — run without --skip-index first.\x1b[0m');
    process.exit(1);
  }
  step(++currentStep, totalSteps, 'Regenerating pages (reusing indexes)…');
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, OUT_DIR, '--pages-only'], { cwd: INDEXER });
} else {
  step(++currentStep, totalSteps, 'Building indexes + pages…');
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, OUT_DIR], { cwd: INDEXER });
}

// Sample version list so /versions renders locally (the deploy maintains the real one).
const month = new Date().toISOString().slice(0, 7);
writeFileSync(join(OUT_DIR, 'versions.json'), JSON.stringify({
  versions: [{ branch: 'main', date: month, path: '/', current: true, built: new Date().toISOString() }],
}, null, 2));

// ── Step 3: Start Vite dev server ──────────────────────────────────────────
step(++currentStep, totalSteps, 'Starting dev server…');
console.log('\x1b[2mFront page at /, search (HMR) at /search/ — press Ctrl+C to stop.\x1b[0m\n');

// base /search/ namespaces the SPA; the dev middleware serves the rest from dist-data.
const server = spawn(NODE, [VITE_BIN, 'dev'], {
  cwd: WEB,
  stdio: 'inherit',
  env: { ...process.env, APP_BASE: '/search/' },
});
server.on('exit', code => process.exit(code ?? 0));
