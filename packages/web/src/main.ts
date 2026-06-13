import MiniSearch from 'minisearch';
import { getMiniSearchOptions } from '@totolo-search/core';
import type { Document, Manifest } from '@totolo-search/core';
import { LATEST_JSON_URL, MODELS_URL, MAX_QUERY_LENGTH } from './config.js';
import {
  getCachedVersionKey,
  setCachedVersionKey,
  getCachedArtifact,
  setCachedArtifact,
  deleteCachedArtifact,
  fetchWithProgress,
} from './cache.js';
import { createSearchEngine } from './search.js';
import type { Timings, ResultsPhase } from './search.js';
import { renderResults, renderPhases, renderProgress, setStatus, setPageLinks } from './ui.js';
import type { WorkerDoc } from './worker-types.js';

let DEBUG = new URLSearchParams(location.search).has('debug');

// Self-hosted models base (root-relative, e.g. "/models/"); resolves against our
// origin on the page and in the worker. Configurable independently of the app base
// so versioned deployments can share one models/ prefix. See config.MODELS_URL.
const MODELS_BASE = MODELS_URL;

const statusEl      = document.getElementById('status') as HTMLElement;
const progressEl    = document.getElementById('progress') as HTMLElement;
const overallFillEl = document.getElementById('overall-fill') as HTMLElement;
const overallProgressEl = document.getElementById('overall-progress') as HTMLElement;
const queryEl       = document.getElementById('query') as HTMLInputElement;
const searchBtn     = document.getElementById('search-btn') as HTMLButtonElement;
const resultsEl     = document.getElementById('results') as HTMLElement;
const resultCountEl = document.getElementById('result-count') as HTMLElement;
const phasesEl      = document.getElementById('search-phases') as HTMLElement;
const regexCheckbox = document.getElementById('regex-mode') as HTMLInputElement;
const debugCheckbox = document.getElementById('debug-mode') as HTMLInputElement;
const typeRadios    = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="doc-type"]'));
const debugEl       = document.getElementById('debug-info') as HTMLElement;
const semLoadingEl  = document.getElementById('semantic-loading') as HTMLElement;
const semLoadingText = document.getElementById('semantic-loading-text') as HTMLElement;

debugCheckbox.checked = DEBUG;

// ── Debug panel ───────────────────────────────────────────────────────────────
// Stats are collected regardless of the Debug flag; the flag only gates display, so
// turning Debug on mid-session immediately shows the already-gathered numbers.
const hasWebGPU = 'gpu' in navigator;
let webGPUActive = false;
let debugEnv = '';
let debugTiming = '';
let debugCorpus: Document[] | null = null;
let debugSizes: Record<string, number> = {};

interface ModelInfo { id: string; files: Record<string, number> }
let debugModels: { embedder?: ModelInfo; reranker?: ModelInfo } | null = null;

// Bytes the client actually downloads for a model: the text/config files plus the one
// ONNX variant its backend uses (WebGPU → fp32 embed / fp16 rerank, else q8).
function modelDownloadBytes(model: ModelInfo, isEmbedder: boolean, usingWebGPU: boolean): number {
  let wanted = isEmbedder
    ? (usingWebGPU ? 'onnx/model.onnx' : 'onnx/model_quantized.onnx')
    : (usingWebGPU ? 'onnx/model_fp16.onnx' : 'onnx/model_quantized.onnx');
  if (model.files[wanted] === undefined) wanted = 'onnx/model_quantized.onnx';
  let bytes = 0;
  for (const [file, size] of Object.entries(model.files)) {
    if (file.startsWith('onnx/')) { if (file === wanted) bytes += size; }
    else bytes += size;
  }
  return bytes;
}

function updateDebug() {
  if (!DEBUG) { debugEl.className = ''; return; }
  debugEl.className = 'visible';
  debugEl.innerHTML = debugEnv + (debugTiming ? `<div class="debug-section">${debugTiming}</div>` : '');
}

// Rebuilds the env section from whatever stats are known so far. Index sizes that
// haven't loaded yet (e.g. the lazily-loaded annotation index) show as "—".
function rebuildDebugEnv() {
  if (!debugCorpus) return;
  const corpus = debugCorpus;
  const gpuClass = webGPUActive ? 'debug-good' : hasWebGPU ? 'debug-warn' : '';
  const gpuLabel = webGPUActive ? 'active' : hasWebGPU ? 'available but not used' : 'not available';
  const stCount = corpus.filter(d => d.doc_type === 'story-theme').length;
  const embCount = corpus.length - stCount;
  const mb = (n: number | undefined) => (n !== undefined ? `${(n / 1024 / 1024).toFixed(1)} MB` : '—');
  const embBytes = debugModels?.embedder
    ? modelDownloadBytes(debugModels.embedder, true, webGPUActive) : undefined;
  const rrBytes = debugModels?.reranker
    ? modelDownloadBytes(debugModels.reranker, false, webGPUActive) : undefined;
  debugEnv = `
    <div class="debug-section">
      <span class="debug-label">WebGPU:</span> <span class="${gpuClass}">${gpuLabel}</span>
    </div>
    <div class="debug-section">
      <span class="debug-label">Corpus:</span>
      ${corpus.length.toLocaleString()} docs
      (${embCount.toLocaleString()} embedded, ${stCount.toLocaleString()} annotations)
    </div>
    <div class="debug-section">
      <span class="debug-label">Index sizes:</span>
      minisearch ${mb(debugSizes['minisearch.json'])} ·
      corpus ${mb(debugSizes['corpus.json'])} ·
      titles ${mb(debugSizes['embeddings.bin'])} ·
      annotations ${mb(debugSizes['embeddings-annotations.bin'])}
    </div>
    <div class="debug-section">
      <span class="debug-label">Models (self-hosted):</span>
      embedder ${mb(embBytes)} ·
      reranker ${mb(rrBytes)}
    </div>
  `.trim();
  updateDebug();
}

function setDebugTiming(phase: string, timings: Timings) {
  const parts: string[] = [`<span class="debug-label">Last ${phase}:</span>`];
  if (timings.embed_ms !== undefined) parts.push(`embed ${timings.embed_ms} ms`);
  if (timings.vector_ms !== undefined) parts.push(`vector ${timings.vector_ms} ms`);
  if (timings.rerank_ms !== undefined) parts.push(`rerank ${timings.rerank_ms} ms`);
  if (timings.total_ms !== undefined) parts.push(`<b>total ${timings.total_ms} ms</b>`);
  debugTiming = parts.join(' · ');
  updateDebug();
}

// ── Status / progress ─────────────────────────────────────────────────────────
let readyTimer: ReturnType<typeof setTimeout> | null = null;

function status(msg: string, kind: 'info' | 'error' | '' = '') {
  if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
  setStatus(statusEl, msg, kind);
}

function setOverallProgress(pct: number) {
  if (pct >= 100) {
    overallProgressEl.style.display = 'none';
  } else {
    overallProgressEl.style.display = '';
    overallFillEl.style.width = `${pct}%`;
  }
}

// Subtle background indicator. Two things can load in the background: the title
// semantic index + models, and (lazily) the annotation index. The indicator stays
// visible while either is in flight; title progress aggregates its embeddings + all
// model files into one smooth percentage.
const semFiles = new Map<string, { loaded: number; total: number }>();
let annProgress = { loaded: 0, total: 0 };
let titleLoading = false;
let annLoading = false;

function pct(loaded: number, total: number): number {
  return total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0; // 100% reserved for ready
}

function renderSemanticIndicator() {
  semLoadingEl.classList.toggle('visible', titleLoading || annLoading);
  if (titleLoading) {
    let l = 0;
    let t = 0;
    for (const v of semFiles.values()) { l += v.loaded; t += v.total; }
    const p = pct(l, t);
    semLoadingText.textContent = p > 0 ? `Loading semantic search… ${p}%` : 'Loading semantic search…';
  } else if (annLoading) {
    const p = pct(annProgress.loaded, annProgress.total);
    semLoadingText.textContent = p > 0 ? `Loading annotation search… ${p}%` : 'Loading annotation search…';
  }
}

function updateSemanticProgress(file: string, loaded: number, total: number) {
  if (total > 0) semFiles.set(file, { loaded, total });
  renderSemanticIndicator();
}

// Shows the error and resolves when the user clicks Retry.
function waitForRetry(message: string): Promise<void> {
  status(message, 'error');
  return new Promise(resolve => {
    const btn = document.createElement('button');
    btn.id = 'retry-btn';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      progressEl.innerHTML = '';
      resolve();
    });
    progressEl.replaceChildren(btn);
  });
}

// ── Artifact loading ──────────────────────────────────────────────────────────
// Artifact URLs resolve relative to the manifest's own URL, so index_prefix "."
// works on any host or subpath (dev /test-data/, GitHub Pages, S3 absolute URLs).
function artifactUrl(manifest: Manifest, name: string): string {
  const base = new URL(LATEST_JSON_URL, location.href);
  return new URL(`${manifest.index_prefix}/${name}`, base).toString();
}

async function loadManifest(): Promise<Manifest> {
  const resp = await fetch(LATEST_JSON_URL, { cache: 'no-cache', signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json() as Manifest;
}

async function loadArtifact(
  manifest: Manifest,
  name: string,
  isText: boolean,
  useCache: boolean,
  sizes: Record<string, number>,
  onProgress: (loaded: number, total: number) => void,
): Promise<string | ArrayBuffer> {
  if (useCache) {
    const cached = await getCachedArtifact(name);
    if (cached !== undefined) {
      sizes[name] = typeof cached === 'string' ? cached.length : cached.byteLength;
      return cached;
    }
  }
  const url = artifactUrl(manifest, name);
  const buf = await fetchWithProgress(url, p => onProgress(p.loaded, p.total), name);
  const value = isText ? new TextDecoder().decode(buf) : buf;
  await setCachedArtifact(name, value);
  sizes[name] = buf.byteLength;
  return value;
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────
function slimCorpus(corpus: Document[]): WorkerDoc[] {
  return corpus.map(d => ({
    doc_id: d.doc_id,
    doc_type: d.doc_type,
    name: d.name,
    title: d.title,
    search_title: d.search_title,
    search_body: d.search_body,
    search_misc: d.search_misc,
  }));
}

function onWebGPUFallback() {
  webGPUActive = false;
  rebuildDebugEnv();
}

// The embeddings buffer is cloned (not transferred) so the engine can respawn a
// worker the regex watchdog had to terminate.
function spawnWorker(workerDocs: WorkerDoc[], embeddings: ArrayBuffer, docIds: number[]): Promise<Worker> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (ev: MessageEvent) => {
    if (ev.data.type === 'webgpu_fallback') onWebGPUFallback();
  });
  return new Promise<Worker>((resolve, reject) => {
    worker.addEventListener('message', function onMsg(ev: MessageEvent) {
      if (ev.data.type === 'ready') { worker.removeEventListener('message', onMsg); resolve(worker); }
      else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    });
    worker.postMessage({ type: 'init', embeddings, docIds, corpus: workerDocs, useWebGPU: hasWebGPU, modelsBase: MODELS_BASE });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
type Engine = ReturnType<typeof createSearchEngine>;

interface KeywordLoad {
  manifest: Manifest;
  miniSearch: MiniSearch<Document>;
  corpus: Document[];
  useCache: boolean;
  sizes: Record<string, number>;
}

// Loads only what keyword search needs (index + corpus); the big progress bar
// covers this phase since the user can't search until it finishes.
async function loadKeyword(): Promise<KeywordLoad> {
  setOverallProgress(0);
  status('Fetching index manifest…');
  const manifest = await loadManifest();

  const useCache = (await getCachedVersionKey()) === manifest.version_key;
  const sizes: Record<string, number> = {};

  setOverallProgress(8);
  status('Loading search index…');
  const miniSearchJson = await loadArtifact(manifest, 'minisearch.json', true, useCache, sizes, (loaded, total) => {
    renderProgress(progressEl, loaded, total, 'Downloading search index');
    setOverallProgress(8 + Math.round((loaded / Math.max(total, 1)) * 42));
  }) as string;

  setOverallProgress(50);
  status('Loading documents…');
  const corpusJson = await loadArtifact(manifest, 'corpus.json', true, useCache, sizes, (loaded, total) => {
    renderProgress(progressEl, loaded, total, 'Downloading documents');
    setOverallProgress(50 + Math.round((loaded / Math.max(total, 1)) * 42));
  }) as string;

  status('Initializing…');
  const miniSearch = MiniSearch.loadJSON<Document>(miniSearchJson, getMiniSearchOptions());
  const corpus = JSON.parse(corpusJson) as Document[];

  progressEl.innerHTML = '';
  setOverallProgress(100);
  return { manifest, miniSearch, corpus, useCache, sizes };
}

async function main() {
  regexCheckbox.checked = false;
  // Reset filters to a known state (browsers may restore prior radio selection).
  typeRadios.forEach(r => { r.checked = r.value === 'all'; });

  // Ask the browser to keep our IndexedDB artifact cache across sessions, so it isn't
  // evicted under storage pressure (best-effort; combined with the content-addressed
  // version_key this avoids re-downloading the index on repeat visits).
  if (navigator.storage?.persist) void navigator.storage.persist();

  // Point the nav at this deployment's base — '/' normally, '/<tag>/' for a release
  // build — so the top-bar links stay within the deployment.
  {
    const siteBase = (import.meta.env.BASE_URL || '/').replace(/search\/?$/, '');
    document.querySelector('.nav-brand')?.setAttribute('href', siteBase);
    document.querySelector('.nav-search')?.setAttribute('href', `${siteBase}search/`);
    document.querySelector('.nav-versions')?.setAttribute('href', `${siteBase}versions/`);
  }

  // The search field is usable immediately — focus it and let the user type while
  // the index loads. Guards below no-op until keyword search is ready.
  queryEl.focus();

  // Model sizes for the debug box (cache-independent; comes from build-time manifest).
  void fetch(`${MODELS_BASE}models.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(m => { if (m) { debugModels = m; rebuildDebugEnv(); } })
    .catch(() => { /* debug-only; ignore */ });

  let engine: Engine | null = null;
  let keywordReady = false;
  let semanticReady = false;
  let currentQuery = '';
  let typeFilter = 'all';
  let regexMode = false;
  let annotationState: 'idle' | 'loading' | 'loaded' = 'idle';
  // Kept so the regex watchdog can respawn a terminated worker without re-downloading.
  let embeddingsBuffer: ArrayBuffer | null = null;

  function setPhases(phase: ResultsPhase) {
    if (!currentQuery) { renderPhases(phasesEl, 'none'); return; }
    renderPhases(phasesEl, phase);
  }

  function runSearch() {
    if (!engine || !keywordReady) return;
    if (regexMode) {
      engine.searchRegex(currentQuery);
    } else {
      engine.search(currentQuery);
    }
  }

  // Wire input handlers up front so typing during load is captured.
  queryEl.addEventListener('paste', (e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    const selStart = queryEl.selectionStart ?? queryEl.value.length;
    const selEnd = queryEl.selectionEnd ?? queryEl.value.length;
    const resultLen = queryEl.value.slice(0, selStart).length + pasted.length + queryEl.value.slice(selEnd).length;
    if (resultLen > MAX_QUERY_LENGTH) {
      setTimeout(() => status(`Query trimmed to ${MAX_QUERY_LENGTH} characters`), 10);
    }
  });

  queryEl.addEventListener('input', () => {
    currentQuery = queryEl.value;
    runSearch();
  });

  queryEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !regexMode && semanticReady) engine?.triggerRerank(currentQuery);
  });

  searchBtn.addEventListener('click', () => {
    if (!regexMode && semanticReady) engine?.triggerRerank(currentQuery);
  });

  // Copy-to-clipboard buttons on result headers (delegated; results re-render often).
  resultsEl.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.result-copy') as HTMLButtonElement | null;
    if (!btn) return;
    const name = btn.dataset.copy ?? '';
    if (!navigator.clipboard) {
      status('Clipboard not available in this browser', 'error');
      return;
    }
    navigator.clipboard.writeText(name).then(() => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    }).catch(() => status('Could not copy to clipboard', 'error'));
  });

  typeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      typeFilter = radio.value;
      // Annotations have their own semantic index, downloaded only on first use.
      if (typeFilter === 'story-theme') void ensureAnnotationIndex();
      if (!engine || !keywordReady) return;
      // Re-run (not just refilter) so candidates are restricted to the type before
      // the 20-item limit applies.
      runSearch();
    });
  });

  regexCheckbox.addEventListener('change', () => {
    regexMode = regexCheckbox.checked;
    if (regexMode) engine?.cancelSemantic();
    runSearch();
  });

  debugCheckbox.addEventListener('change', () => {
    DEBUG = debugCheckbox.checked;
    updateDebug();
  });

  // ── Keyword phase (blocking, with retry) ──────────────────────────────────
  let kw: KeywordLoad;
  for (;;) {
    try {
      kw = await loadKeyword();
      break;
    } catch (err) {
      setOverallProgress(0);
      await waitForRetry(`Failed to load: ${err}`);
    }
  }
  const { manifest, miniSearch, corpus, useCache, sizes } = kw;

  webGPUActive = hasWebGPU; // optimistic; corrected by webgpu_fallback

  // Debug stats are now collectable — store the inputs and build the env section.
  debugCorpus = corpus;
  debugSizes = sizes;
  rebuildDebugEnv();

  // Result links point at the locally generated detail pages, which live next to the
  // other index artifacts (resolved relative to the manifest URL).
  {
    const pagesBase = new URL(`${manifest.index_prefix}/`, new URL(LATEST_JSON_URL, location.href)).toString();
    const slugs = new Map<string, string>();
    for (const d of corpus) {
      if (d.slug) slugs.set(`${d.doc_type}:${d.name}`, d.slug);
    }
    setPageLinks(pagesBase, slugs);
  }

  engine = createSearchEngine(miniSearch, corpus, {
    onResults: (results, phase, timings) => {
      renderResults(resultsEl, resultCountEl, results, phase, currentQuery);
      setPhases(phase);
      if (timings) setDebugTiming(phase, timings);
    },
    onStatus: (msg, kind) => status(msg, kind ?? ''),
    onModelsReady: () => {
      semanticReady = true;
      titleLoading = false;
      renderSemanticIndicator();
      searchBtn.disabled = false;
      rebuildDebugEnv();
      // Upgrade whatever's currently shown from keyword to semantic.
      if (currentQuery && !regexMode) engine?.search(currentQuery);
    },
    onModelProgress: (file, loaded, total) => updateSemanticProgress(file, loaded, total),
    onAnnotationsReady: () => {
      annLoading = false;
      renderSemanticIndicator();
      // Re-run if still viewing annotations, so semantic results appear.
      if (currentQuery && typeFilter === 'story-theme' && !regexMode) engine?.search(currentQuery);
    },
    getTypeFilter: () => typeFilter,
    respawnWorker: () => {
      titleLoading = true;
      renderSemanticIndicator();
      semanticReady = false;
      searchBtn.disabled = true;
      return spawnWorker(slimCorpus(corpus), embeddingsBuffer!, manifest.doc_ids);
    },
  });

  keywordReady = true;
  queryEl.focus();
  status(`Ready — ${corpus.length.toLocaleString()} documents indexed`);
  readyTimer = setTimeout(() => status(''), 3000);

  // If the user already typed / picked Annotations during load, act on it now.
  if (currentQuery) runSearch();
  if (typeFilter === 'story-theme') void ensureAnnotationIndex();

  // ── Semantic phase (background) ───────────────────────────────────────────
  // Loads embeddings + spawns the worker + lets it load the models, all while
  // keyword search is already usable.
  async function loadSemantic(): Promise<void> {
    titleLoading = true;
    renderSemanticIndicator();
    try {
      embeddingsBuffer = await loadArtifact(manifest, 'embeddings.bin', false, useCache, sizes,
        (loaded, total) => updateSemanticProgress('embeddings.bin', loaded, total)) as ArrayBuffer;
      rebuildDebugEnv(); // title embeddings size now known

      // The three core artifacts are cached; commit the version. The annotation
      // index is lazy, so on a version change drop any stale copy from a prior
      // version rather than serving it under this version's key later.
      if (!useCache) await deleteCachedArtifact('embeddings-annotations.bin');
      await setCachedVersionKey(manifest.version_key);

      const worker = await spawnWorker(slimCorpus(corpus), embeddingsBuffer, manifest.doc_ids);
      engine!.setWorker(worker);
      regexCheckbox.disabled = false; // regex only needs the worker's corpus, not models
    } catch (err) {
      titleLoading = false;
      renderSemanticIndicator();
      console.warn('Semantic search unavailable:', err);
    }
  }

  // ── Annotation index (lazy, on first Annotations selection) ────────────────
  async function ensureAnnotationIndex(): Promise<void> {
    if (annotationState !== 'idle' || !engine) return;
    annotationState = 'loading';
    annLoading = true;
    renderSemanticIndicator();
    try {
      const buf = await loadArtifact(manifest, 'embeddings-annotations.bin', false, useCache, sizes,
        (loaded, total) => { annProgress = { loaded, total }; renderSemanticIndicator(); }) as ArrayBuffer;
      rebuildDebugEnv(); // annotation index size now known
      engine.setAnnotationIndex(buf, manifest.annotation_doc_ids);
      annotationState = 'loaded';
      // annLoading cleared in onAnnotationsReady once the worker has ingested it.
    } catch (err) {
      annotationState = 'idle';
      annLoading = false;
      renderSemanticIndicator();
      console.warn('Annotation search unavailable:', err);
    }
  }

  void loadSemantic();
}

main().catch(err => status(`Unexpected error: ${err}`, 'error'));
