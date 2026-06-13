#!/usr/bin/env node
/**
 * Local UAT: build and serve the *production* bundle exactly as it deploys to GitHub
 * Pages, so you can acceptance-test the real artifact (minified build, the
 * /totolo-search-web/ base path, artifacts + pages + models laid out as deployed,
 * served as plain static files — no HMR, no dev-server transforms).
 *
 * Mirrors the deploy workflow: build indexes -> dist-data, fetch models, vite build
 * with the prod base, copy artifacts into dist, then `vite preview`.
 *
 * Usage:
 *   node scripts/uat.mjs                  # full: corpus, models, indexes, build, serve
 *   node scripts/uat.mjs --skip-corpus    # reuse existing corpus.json
 *   node scripts/uat.mjs --skip-index     # reuse existing dist-data (skip corpus+indexer)
 *   node scripts/uat.mjs v2025.10         # pin an ontology version
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER  = resolve(ROOT, 'packages/indexer');
const WEB       = resolve(ROOT, 'packages/web');
const CORPUS    = resolve(ROOT, 'corpus.json');
const DATA_DIR  = resolve(ROOT, 'dist-data');      // same staging dir CI uses
const DIST      = resolve(WEB, 'dist');

// Must match the GitHub Pages base (repo name). Keep in sync with deploy.yml.
const BASE = '/totolo-search-web/';

const NODE          = process.execPath;
const TSX           = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const TSC           = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const VITE_BIN      = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const FETCH_MODELS  = resolve(ROOT, 'scripts/fetch-models.mjs');

const args = process.argv.slice(2);
const skipCorpus = args.includes('--skip-corpus') || args.includes('--skip-index');
const skipIndex  = args.includes('--skip-index');
const version    = args.find(a => /^v\d{4}\.\d{2}$/.test(a)) ?? '';

// Env baked into the build: prod base + manifest URL under that base.
const buildEnv = {
  ...process.env,
  APP_BASE: BASE,
  VITE_LATEST_JSON_URL: `${BASE}latest.json`,
};

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

const totalSteps = 5;
let currentStep = 0;

// ── Step 1: Generate corpus.json via Python ────────────────────────────────
if (!skipIndex && !skipCorpus) {
  step(++currentStep, totalSteps, `Generating corpus${version ? ` (${version})` : ' (latest)'}…`);
  const pyArgs = ['-m', 'totolo.util.makejson', '-tsc'];
  if (version) pyArgs.push(version);
  const result = spawnSync('python', pyArgs, { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('\x1b[31mCorpus generation failed.\x1b[0m');
    process.exit(result.status ?? 1);
  }
  writeFileSync(CORPUS, result.stdout);
  console.log(`\x1b[2mWrote ${(result.stdout.length / 1024).toFixed(0)} KB → corpus.json\x1b[0m`);
} else {
  step(++currentStep, totalSteps, 'Skipping corpus generation');
}

// ── Step 2: Download self-hosted models (idempotent) ────────────────────────
step(++currentStep, totalSteps, 'Ensuring models are downloaded…');
runSync(NODE, [FETCH_MODELS]);

// ── Step 3: Build index artifacts + pages into dist-data ────────────────────
if (!skipIndex) {
  step(++currentStep, totalSteps, 'Building indexes + pages…');
  if (!existsSync(CORPUS)) {
    console.error('\x1b[31mcorpus.json not found — cannot build indexes.\x1b[0m');
    process.exit(1);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  // index_prefix defaults to "." — artifacts resolve relative to latest.json's URL.
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, DATA_DIR], { cwd: INDEXER });
} else {
  step(++currentStep, totalSteps, 'Skipping index build (reusing dist-data)');
  if (!existsSync(DATA_DIR)) {
    console.error('\x1b[31mdist-data not found — cannot skip index build.\x1b[0m');
    process.exit(1);
  }
}

// ── Step 4: Production web build, then assemble dist like CI ────────────────
step(++currentStep, totalSteps, 'Building web app (production)…');
runSync(NODE, [TSC, '--noEmit', '-p', WEB]);
runSync(NODE, [VITE_BIN, 'build'], { cwd: WEB, env: buildEnv });

// vite build copies all of public/ into dist, including the dev-only test-data dump.
// Drop it so the UAT build matches production (which never has it).
rmSync(resolve(DIST, 'test-data'), { recursive: true, force: true });
// Layer the index artifacts + pages on top, exactly as deploy.yml's `cp -r` does.
cpSync(DATA_DIR, DIST, { recursive: true });

// ── Step 5: Serve the built site ────────────────────────────────────────────
step(++currentStep, totalSteps, 'Serving production build…');
console.log(`\x1b[2mUAT build served at the production base path — open http://localhost:4173${BASE}\x1b[0m\n`);

const server = spawn(NODE, [VITE_BIN, 'preview', '--port', '4173'], { cwd: WEB, env: buildEnv, stdio: 'inherit' });
server.on('exit', code => process.exit(code ?? 0));
