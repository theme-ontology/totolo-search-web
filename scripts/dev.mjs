#!/usr/bin/env node
/**
 * Local dev/test entry point.
 *
 * Usage:
 *   node scripts/dev.mjs                  # fetch latest ontology, build indexes, start server
 *   node scripts/dev.mjs v2025.10         # pin to a specific ontology version
 *   node scripts/dev.mjs --skip-corpus    # reuse existing corpus.json (skip Python step)
 *   node scripts/dev.mjs --skip-index     # skip Python + indexer, start server only
 *
 * Index artifacts are written to packages/web/public/test-data/ and served by Vite
 * at /test-data/*, which is where VITE_LATEST_JSON_URL points in .env.development.
 */
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER  = resolve(ROOT, 'packages/indexer');
const WEB      = resolve(ROOT, 'packages/web');
const CORPUS   = resolve(ROOT, 'corpus.json');
const OUT_DIR  = resolve(ROOT, 'packages/web/public/test-data');

// Resolve Node binary + local package entry points (cross-platform, no shell needed)
const NODE     = process.execPath;
const TSX      = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const VITE_BIN = resolve(ROOT, 'node_modules/vite/bin/vite.js');

const args = process.argv.slice(2);
const skipCorpus = args.includes('--skip-corpus') || args.includes('--skip-index');
const skipIndex  = args.includes('--skip-index');
const version    = args.find(a => /^v\d{4}\.\d{2}$/.test(a)) ?? '';

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

const totalSteps = skipIndex ? 1 : skipCorpus ? 2 : 3;
let currentStep = 0;

// ── Step 1: Generate corpus.json via Python ────────────────────────────────
if (!skipCorpus) {
  step(++currentStep, totalSteps, `Generating corpus${version ? ` (${version})` : ' (latest)'}…`);

  const pyArgs = ['-m', 'totolo.util.makejson', '-tsc'];
  if (version) pyArgs.push(version);

  const result = spawnSync('python', pyArgs, {
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('\x1b[31mCorpus generation failed.\x1b[0m');
    process.exit(result.status ?? 1);
  }
  writeFileSync(CORPUS, result.stdout);
  console.log(`\x1b[2mWrote ${(result.stdout.length / 1024).toFixed(0)} KB → corpus.json\x1b[0m`);
} else if (!existsSync(CORPUS)) {
  console.error(`\x1b[31mcorpus.json not found — cannot skip corpus step.\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[2mUsing existing corpus.json\x1b[0m');
}

// ── Step 2: Build keyword index + embeddings ───────────────────────────────
if (!skipIndex) {
  step(++currentStep, totalSteps, 'Building indexes…');
  mkdirSync(OUT_DIR, { recursive: true });
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, OUT_DIR], { cwd: INDEXER });

  // Patch index_prefix so the browser fetches from /test-data/ (where files are actually served)
  const manifestPath = join(OUT_DIR, 'latest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.index_prefix = '/test-data';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// ── Step 3: Start Vite dev server ──────────────────────────────────────────
step(++currentStep, totalSteps, 'Starting dev server…');
console.log('\x1b[2mIndex artifacts served from /test-data/ — press Ctrl+C to stop.\x1b[0m\n');

const server = spawn(NODE, [VITE_BIN, 'dev'], {
  cwd: WEB,
  stdio: 'inherit',
});
server.on('exit', code => process.exit(code ?? 0));
