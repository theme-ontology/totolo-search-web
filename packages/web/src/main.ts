import MiniSearch from 'minisearch';
import { getMiniSearchOptions } from '@totolo-search/core';
import type { Document, Manifest } from '@totolo-search/core';
import { LATEST_JSON_URL, MAX_QUERY_LENGTH, AUTO_SEARCH_MAX_CHARS } from './config.js';
import {
  getCachedVersionKey,
  setCachedVersionKey,
  getCachedArtifact,
  setCachedArtifact,
  fetchWithProgress,
} from './cache.js';
import { createSearchEngine, regexSearch } from './search.js';
import type { Timings } from './search.js';
import { renderResults, renderProgress, setStatus } from './ui.js';

let DEBUG = new URLSearchParams(location.search).has('debug');

const statusEl      = document.getElementById('status') as HTMLElement;
const progressEl    = document.getElementById('progress') as HTMLElement;
const overallFillEl = document.getElementById('overall-fill') as HTMLElement;
const overallProgressEl = document.getElementById('overall-progress') as HTMLElement;
const queryEl       = document.getElementById('query') as HTMLInputElement;
const searchBtn     = document.getElementById('search-btn') as HTMLButtonElement;
const resultsEl     = document.getElementById('results') as HTMLElement;
const regexCheckbox = document.getElementById('regex-mode') as HTMLInputElement;
const debugCheckbox = document.getElementById('debug-mode') as HTMLInputElement;
const typeRadios    = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="doc-type"]'));
const debugEl       = document.getElementById('debug-info') as HTMLElement;

debugCheckbox.checked = DEBUG;

// ── Debug panel ───────────────────────────────────────────────────────────────
const hasWebGPU = 'gpu' in navigator;
let webGPUActive = false;
let debugEnv = '';
let debugTiming = '';

function updateDebug() {
  if (!DEBUG) { debugEl.className = ''; return; }
  debugEl.className = 'visible';
  debugEl.innerHTML = debugEnv + (debugTiming ? `<div class="debug-section">${debugTiming}</div>` : '');
}

function setDebugEnv(corpus: Document[], sizes: Record<string, number>, usingWebGPU: boolean) {
  if (!DEBUG) return;
  webGPUActive = usingWebGPU;
  const gpuClass = usingWebGPU ? 'debug-good' : hasWebGPU ? 'debug-warn' : '';
  const gpuLabel = usingWebGPU ? 'active' : hasWebGPU ? 'available but not used' : 'not available';
  const stCount = corpus.filter(d => d.doc_type === 'story-theme').length;
  const embCount = corpus.length - stCount;
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
      minisearch ${(sizes['minisearch.json'] / 1024 / 1024).toFixed(1)} MB ·
      corpus ${(sizes['corpus.json'] / 1024 / 1024).toFixed(1)} MB ·
      embeddings ${(sizes['embeddings.bin'] / 1024 / 1024).toFixed(1)} MB
    </div>
  `.trim();
  updateDebug();
}

function setDebugTiming(phase: string, timings: Timings) {
  if (!DEBUG) return;
  const parts: string[] = [`<span class="debug-label">Last ${phase}:</span>`];
  if (timings.embed_ms !== undefined) parts.push(`embed ${timings.embed_ms} ms`);
  if (timings.vector_ms !== undefined) parts.push(`vector ${timings.vector_ms} ms`);
  if (timings.rerank_ms !== undefined) parts.push(`rerank ${timings.rerank_ms} ms`);
  if (timings.total_ms !== undefined) parts.push(`<b>total ${timings.total_ms} ms</b>`);
  debugTiming = parts.join(' · ');
  updateDebug();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
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

// ── Artifact loading ──────────────────────────────────────────────────────────
async function loadArtifacts(manifest: Manifest): Promise<{
  miniSearchJson: string;
  corpusJson: string;
  embeddingsBuffer: ArrayBuffer;
  sizes: Record<string, number>;
}> {
  const cachedKey = await getCachedVersionKey();
  const useCache = cachedKey === manifest.version_key;

  const ARTIFACTS = [
    { name: 'minisearch.json', isText: true },
    { name: 'corpus.json', isText: true },
    { name: 'embeddings.bin', isText: false },
  ] as const;

  const results: Record<string, ArrayBuffer | string> = {};
  const sizes: Record<string, number> = {};

  for (let i = 0; i < ARTIFACTS.length; i++) {
    const art = ARTIFACTS[i];
    if (useCache) {
      const cached = await getCachedArtifact(art.name);
      if (cached !== undefined) {
        results[art.name] = cached;
        sizes[art.name] = typeof cached === 'string' ? cached.length : cached.byteLength;
        setOverallProgress(10 + Math.round(((i + 1) / ARTIFACTS.length) * 80));
        continue;
      }
    }

    const url = `${manifest.index_prefix}/${art.name}`;
    status(`Downloading ${art.name}…`);
    const buf = await fetchWithProgress(url, p => {
      renderProgress(progressEl, p.loaded, p.total, `Downloading ${art.name}`);
    }, art.name);

    const value = art.isText ? new TextDecoder().decode(buf) : buf;
    await setCachedArtifact(art.name, value);
    results[art.name] = value;
    sizes[art.name] = buf.byteLength;
    setOverallProgress(10 + Math.round(((i + 1) / ARTIFACTS.length) * 80));
  }

  if (!useCache) await setCachedVersionKey(manifest.version_key);

  progressEl.innerHTML = '';
  return {
    miniSearchJson: results['minisearch.json'] as string,
    corpusJson:     results['corpus.json'] as string,
    embeddingsBuffer: results['embeddings.bin'] as ArrayBuffer,
    sizes,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  regexCheckbox.checked = false;
  setOverallProgress(0);
  status('Fetching index manifest…');

  let manifest: Manifest;
  try {
    const resp = await fetch(LATEST_JSON_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    manifest = await resp.json() as Manifest;
  } catch (err) {
    status(`Failed to load manifest: ${err}`, 'error');
    return;
  }

  setOverallProgress(10);
  status('Loading indexes…');
  let miniSearchJson: string, corpusJson: string, embeddingsBuffer: ArrayBuffer;
  let sizes: Record<string, number>;
  try {
    ({ miniSearchJson, corpusJson, embeddingsBuffer, sizes } = await loadArtifacts(manifest));
  } catch (err) {
    status(`Failed to load indexes: ${err}`, 'error');
    return;
  }

  setOverallProgress(92);
  status('Initializing…');

  let miniSearch: MiniSearch<Document>;
  try {
    miniSearch = MiniSearch.loadJSON(miniSearchJson, getMiniSearchOptions());
  } catch (err) {
    status(`Failed to parse minisearch.json (first 120 chars: ${miniSearchJson.slice(0, 120)}): ${err}`, 'error');
    return;
  }

  let corpus: Document[];
  try {
    corpus = JSON.parse(corpusJson) as Document[];
  } catch (err) {
    status(`Failed to parse corpus.json (first 120 chars: ${corpusJson.slice(0, 120)}): ${err}`, 'error');
    return;
  }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  await new Promise<void>((resolve, reject) => {
    worker.addEventListener('message', function onMsg(ev: MessageEvent) {
      if (ev.data.type === 'ready') { worker.removeEventListener('message', onMsg); resolve(); }
      else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    });
    worker.postMessage(
      { type: 'init', embeddings: embeddingsBuffer, docIds: manifest.doc_ids, corpus, useWebGPU: hasWebGPU },
      [embeddingsBuffer],
    );
  });

  setOverallProgress(96);

  // ── Search state ────────────────────────────────────────────────────────────
  let currentQuery = '';
  let typeFilter = 'all';
  let regexMode = false;

  const engine = createSearchEngine(
    miniSearch, corpus, worker,
    (results, phase, timings) => {
      renderResults(resultsEl, results, phase, currentQuery);
      if (timings) setDebugTiming(phase, timings);
    },
    msg => status(msg),
    () => {
      setOverallProgress(100);
      setDebugEnv(corpus, sizes, webGPUActive);
      status('Ready!');
      readyTimer = setTimeout(() => status(''), 3000);
    },
    () => typeFilter,
  );

  // Track whether WebGPU actually worked (worker reports fallback if not)
  worker.addEventListener('message', (ev: MessageEvent) => {
    if (ev.data.type === 'webgpu_fallback') webGPUActive = false;
  });
  webGPUActive = hasWebGPU; // optimistic; corrected above if fallback occurs

  function runSearch() {
    if (!currentQuery) {
      renderResults(resultsEl, [], 'searching');
      status('');
      return;
    }
    if (regexMode) {
      const t0 = performance.now();
      const results = regexSearch(corpus, currentQuery, typeFilter);
      const total_ms = Math.round(performance.now() - t0);
      if (results === null) {
        renderResults(resultsEl, [], 'searching');
        status('Invalid regex', 'error');
      } else {
        renderResults(resultsEl, results, 'regex', currentQuery);
        setDebugTiming('regex', { total_ms });
        status('');
      }
    } else if (currentQuery.length > AUTO_SEARCH_MAX_CHARS) {
      engine.cancelSemantic();
      status('Press Enter or Search to run');
    } else {
      engine.search(currentQuery);
    }
  }

  queryEl.addEventListener('paste', (e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    const selStart = queryEl.selectionStart ?? queryEl.value.length;
    const selEnd = queryEl.selectionEnd ?? queryEl.value.length;
    const resultLen = queryEl.value.slice(0, selStart).length + pasted.length + queryEl.value.slice(selEnd).length;
    if (resultLen > MAX_QUERY_LENGTH) {
      // setTimeout so this fires after the input event's status('') clears
      setTimeout(() => status(`Query trimmed to ${MAX_QUERY_LENGTH} characters`), 10);
    }
  });

  queryEl.addEventListener('input', () => {
    currentQuery = queryEl.value;
    runSearch();
  });

  queryEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !regexMode) engine.triggerRerank(currentQuery);
  });

  searchBtn.addEventListener('click', () => {
    if (!regexMode) engine.triggerRerank(currentQuery);
  });

  typeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      typeFilter = radio.value;
      if (regexMode) runSearch();
      else engine.refilter();
    });
  });

  regexCheckbox.addEventListener('change', () => {
    regexMode = regexCheckbox.checked;
    if (regexMode) engine.cancelSemantic();
    runSearch();
  });

  debugCheckbox.addEventListener('change', () => {
    DEBUG = debugCheckbox.checked;
    updateDebug();
  });

  queryEl.disabled = false;
  searchBtn.disabled = false;
  queryEl.focus();
  status(`Ready — ${corpus.length.toLocaleString()} documents indexed`);
}

main().catch(err => status(`Unexpected error: ${err}`, 'error'));
