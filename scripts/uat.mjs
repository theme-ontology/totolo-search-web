#!/usr/bin/env node
/**
 * Local UAT: build the production artifacts and serve the whole site the way it deploys
 * — front page at /, search SPA at /search/, detail pages + data + versions at the root,
 * shared models at /models/. A tiny static server mirrors the CloudFront/S3 behavior
 * (directory-index + path=key), so this is a faithful preview without HMR.
 *
 * Usage:
 *   node scripts/uat.mjs                  # full: corpus, models, indexes+pages, build, serve
 *   node scripts/uat.mjs --skip-corpus    # reuse corpus.json
 *   node scripts/uat.mjs --skip-index     # reuse dist-data artifacts; only regenerate pages
 *   node scripts/uat.mjs v2025.10         # pin an ontology version
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFile, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT      = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER   = resolve(ROOT, 'packages/indexer');
const WEB       = resolve(ROOT, 'packages/web');
const CORPUS    = resolve(ROOT, 'corpus.json');
const DATA_DIR  = resolve(ROOT, 'dist-data');           // index artifacts + generated pages
const WEB_DIST  = resolve(WEB, 'dist');                 // built search SPA (base /search/)
const MODELS    = resolve(WEB, 'public/models');        // shared model files
const PORT = 4173;

const NODE         = process.execPath;
const TSX          = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const VITE_BIN     = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const FETCH_MODELS = resolve(ROOT, 'scripts/fetch-models.mjs');

const args = process.argv.slice(2);
const skipCorpus = args.includes('--skip-corpus') || args.includes('--skip-index');
const skipIndex  = args.includes('--skip-index');
// Corpus source: a release tag (v2026.04, v0.3.3), a local theming path (--source), or latest.
const srcFlag = args.indexOf('--source');
const source  = srcFlag >= 0 ? (args[srcFlag + 1] ?? '') : (args.find(a => /^v[\d.]+$/.test(a)) ?? '');

// The SPA serves at /search/; data + models are referenced at the shared root.
const buildEnv = { ...process.env, APP_BASE: '/search/', VITE_LATEST_JSON_URL: '/latest.json', VITE_MODELS_URL: '/models/' };

function step(label) { console.log(`\n\x1b[1m${label}\x1b[0m`); }
function runSync(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) { console.error(`\x1b[31mExited with status ${r.status}\x1b[0m`); process.exit(r.status ?? 1); }
}

// ── Step 1: corpus ──────────────────────────────────────────────────────────
if (!skipCorpus) {
  step(`Generating corpus${source ? ` (${source})` : ' (latest)'}…`);
  const pyArgs = ['-m', 'totolo.util.makejson', '-tsc'];
  if (source) pyArgs.push(source);
  const r = spawnSync('python', pyArgs, { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) { console.error('\x1b[31mCorpus generation failed.\x1b[0m'); process.exit(r.status ?? 1); }
  writeFileSync(CORPUS, r.stdout);
} else if (!existsSync(CORPUS)) {
  console.error('\x1b[31mcorpus.json not found — cannot skip corpus.\x1b[0m'); process.exit(1);
}

// ── Step 2: models ──────────────────────────────────────────────────────────
step('Ensuring models are downloaded…');
runSync(NODE, [FETCH_MODELS]);

// ── Step 3: index artifacts + pages → dist-data ─────────────────────────────
if (skipIndex) {
  if (!existsSync(DATA_DIR)) { console.error('\x1b[31mdist-data missing — run a full build first.\x1b[0m'); process.exit(1); }
  step('Regenerating pages only (reusing dist-data artifacts)…');
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, DATA_DIR, '--pages-only'], { cwd: INDEXER });
} else {
  step('Building indexes + pages…');
  runSync(NODE, [TSX, 'src/build.ts', CORPUS, DATA_DIR], { cwd: INDEXER });
}

// ── Step 4: build the search SPA (base /search/) ────────────────────────────
step('Building search app (production, base /search/)…');
runSync(NODE, [VITE_BIN, 'build'], { cwd: WEB, env: buildEnv });

// Sample version list so the /versions page renders locally (the deploy maintains the
// real one in S3). "current" points at the live root.
const month = new Date().toISOString().slice(0, 7);
writeFileSync(join(DATA_DIR, 'versions.json'), JSON.stringify({
  versions: [{ branch: 'main', date: month, path: '/', current: true, built: new Date().toISOString() }],
}, null, 2));

// ── Step 5: serve (routing mirrors CloudFront: /search→SPA, /models→models, else data)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.txt': 'text/plain',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function routeToFile(urlPath) {
  let base, rel;
  if (urlPath === '/search' || urlPath.startsWith('/search/')) {
    base = WEB_DIST; rel = urlPath.replace(/^\/search\/?/, '');
  } else if (urlPath.startsWith('/models/')) {
    base = MODELS; rel = urlPath.slice('/models/'.length);
  } else {
    base = DATA_DIR; rel = urlPath.replace(/^\//, '');
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  else if (!extname(rel)) rel += '/index.html';
  const file = normalize(join(base, rel));
  return file.startsWith(base) ? file : null; // guard path traversal
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = routeToFile(urlPath);
  if (!file) { res.writeHead(403); res.end('Forbidden'); return; }
  readFile(file, (err, data) => {
    if (err || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n\x1b[1mUAT site serving at \x1b[36mhttp://localhost:${PORT}/\x1b[0m`);
  console.log('\x1b[2m  front page /   ·   search /search/   ·   versions /versions/   ·   Ctrl+C to stop\x1b[0m\n');
});
