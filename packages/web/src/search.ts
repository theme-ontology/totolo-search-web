import MiniSearch from 'minisearch';
import { parseOperators, lexicalSearch, applyPoolFilter, sortByRrf } from '@totolo-search/core';
import type { Document, SearchResult, ScoredHit } from '@totolo-search/core';
import { CANDIDATE_K, FINAL_K, DEBOUNCE_MS, AUTO_SEARCH_MAX_CHARS } from './config.js';
import type { RegexHit } from './worker-types.js';

export type ResultsPhase = 'keyword' | 'semantic' | 'reranked' | 'regex' | 'searching';
export type Timings = { embed_ms?: number; vector_ms?: number; rerank_ms?: number; total_ms?: number };
export type ResultsCallback = (results: SearchResult[], phase: ResultsPhase, timings?: Timings) => void;

const REGEX_WATCHDOG_MS = 5000;

export function matchesType(docType: string, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'story') return docType === 'story' || docType === 'collection';
  return docType === filter;
}

// Extracts ±context chars around the first match of any term in body. Returns null if no match.
function findExcerpt(body: string, terms: string[], context = 150): string | null {
  if (!body || terms.length === 0) return null;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = new RegExp(escaped.join('|'), 'i').exec(body);
  if (!m) return null;
  const s = Math.max(0, m.index - context);
  const e = Math.min(body.length, m.index + m[0].length + context);
  return (s > 0 ? '…' : '') + body.slice(s, e) + (e < body.length ? '…' : '');
}

function parseTerms(query: string): string[] {
  return [...new Set(
    query.split(/\s+/)
      .map(t => t.replace(/^["'+\-]+|["']+$/g, ''))
      .filter(t => t.length >= 3)
      .map(t => t.toLowerCase()),
  )];
}

function hydrateResults(
  rankedIds: Array<{ doc_id: number; score: number }>,
  docById: Map<number, Document>,
  snippets: Map<number, string>,
  semanticScores: Map<number, number>,
  lexicalScores: Map<number, number>,
  query = '',
): SearchResult[] {
  const terms = parseTerms(query);
  return rankedIds.slice(0, FINAL_K).flatMap(({ doc_id, score }) => {
    const doc = docById.get(doc_id);
    if (!doc) return [];
    const snippet = snippets.get(doc_id) ?? '';
    const excerpt = snippet
      ? snippet.replace(/^[^.]+\.\s*/, '').slice(0, 200)
      : (findExcerpt(doc.search_body, terms) ?? doc.description.slice(0, 120) + (doc.description.length > 120 ? '…' : ''));
    return [{
      doc_id,
      score,
      name: doc.name,
      doc_type: doc.doc_type,
      title: doc.title,
      date: doc.date,
      description: excerpt,
      snippet,
      lexical_score: lexicalScores.get(doc_id) ?? 0,
      semantic_score: semanticScores.get(doc_id) ?? 0,
      theme_level: doc.theme_level,
      parents: doc.parents,
    } satisfies SearchResult];
  });
}

export interface EngineCallbacks {
  onResults: ResultsCallback;
  onStatus: (msg: string, kind?: 'error') => void;
  onModelsReady?: () => void;
  onModelProgress?: (file: string, loaded: number, total: number) => void;
  onAnnotationsReady?: () => void;
  getTypeFilter?: () => string;
  // Called when the regex watchdog kills a hung worker; must return a freshly
  // initialized worker (re-posting 'init'). Without it the watchdog only reports.
  respawnWorker?: () => Promise<Worker>;
}

interface RankedCache {
  ranked: Array<{ doc_id: number; score: number }>;
  snippets: Map<number, string>;
  semScores: Map<number, number>;
  lexScores: Map<number, number>;
  phase: 'keyword' | 'semantic' | 'reranked';
}

export function createSearchEngine(
  miniSearch: MiniSearch<Document>,
  corpus: Document[],
  callbacks: EngineCallbacks,
) {
  const { onResults, onStatus, onModelsReady, onModelProgress, onAnnotationsReady, respawnWorker } = callbacks;
  const getTypeFilter = callbacks.getTypeFilter ?? (() => 'all');

  // The worker (semantic search + reranking + regex) is attached after the keyword
  // index is already usable, so these start null/false and flip as it loads.
  let worker: Worker | null = null;
  let modelsReady = false;
  // The annotation embedding index is loaded lazily; remembered so a respawned worker
  // can be re-seeded with it.
  let annotationIndex: { embeddings: ArrayBuffer; docIds: number[] } | null = null;
  let annotationsReady = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchGeneration = 0;
  let lastQuery = '';
  let cache: RankedCache | null = null;
  let regexTimer: ReturnType<typeof setTimeout> | null = null;
  let regexT0 = 0;

  const docById = new Map(corpus.map(d => [d.doc_id, d]));

  // Render from the untruncated ranked cache: type filter first, then FINAL_K
  // truncation inside hydrateResults — so filtering never starves the result list.
  function render(timings?: Timings) {
    if (!cache) {
      onResults([], 'searching');
      return;
    }
    const filter = getTypeFilter();
    const visible = filter === 'all'
      ? cache.ranked
      : cache.ranked.filter(r => {
          const doc = docById.get(r.doc_id);
          return doc ? matchesType(doc.doc_type, filter) : false;
        });
    onResults(
      hydrateResults(visible, docById, cache.snippets, cache.semScores, cache.lexScores, lastQuery),
      cache.phase,
      timings,
    );
  }

  function clearRegexWatchdog() {
    if (regexTimer !== null) {
      clearTimeout(regexTimer);
      regexTimer = null;
    }
  }

  function hydrateRegexHits(raw: RegexHit[]): SearchResult[] {
    return raw.flatMap(h => {
      const doc = docById.get(h.doc_id);
      if (!doc) return [];
      const description = h.excerpt
        || doc.description.slice(0, 200) + (doc.description.length > 200 ? '…' : '');
      return [{
        doc_id: h.doc_id,
        score: 0,
        name: doc.name,
        doc_type: doc.doc_type,
        title: doc.title,
        date: doc.date,
        description,
        snippet: h.snippet,
        lexical_score: 0,
        semantic_score: 0,
        theme_level: doc.theme_level,
        parents: doc.parents,
      } satisfies SearchResult];
    });
  }

  function onWorkerMessage(ev: MessageEvent) {
    const msg = ev.data as { type: string } & Record<string, unknown>;
    if (msg.type === 'results') {
      if ((msg.generation as number) !== searchGeneration) return;
      const raw = msg.results as Array<{ doc_id: number; score: number; snippet: string }>;
      cache = {
        ranked: raw.map(r => ({ doc_id: r.doc_id, score: r.score })),
        snippets: new Map(raw.map(r => [r.doc_id, r.snippet])),
        semScores: new Map(raw.map(r => [r.doc_id, r.score])),
        lexScores: new Map(),
        phase: (msg.reranked as boolean) ? 'reranked' : 'semantic',
      };
      render(msg.timings as Timings | undefined);
      onStatus('');
    } else if (msg.type === 'regex_results') {
      // Any regex reply proves the worker is alive — disarm the watchdog even if stale.
      clearRegexWatchdog();
      if ((msg.generation as number) !== searchGeneration) return;
      if (msg.invalid as boolean) {
        onResults([], 'searching');
        onStatus('Invalid regex', 'error');
        return;
      }
      const results = hydrateRegexHits(msg.results as RegexHit[]);
      onResults(results, 'regex', { total_ms: Math.round(performance.now() - regexT0) });
      onStatus('');
    } else if (msg.type === 'models_ready') {
      modelsReady = true;
      onModelsReady?.();
    } else if (msg.type === 'annotations_ready') {
      annotationsReady = true;
      onAnnotationsReady?.();
    } else if (msg.type === 'model_progress') {
      onModelProgress?.(msg.file as string, msg.loaded as number, msg.total as number);
    } else if (msg.type === 'error') {
      onStatus(`Search error: ${msg.message}`, 'error');
    }
    // 'progress' (model-load labels) and 'webgpu_fallback' are handled by main.ts.
  }

  function attachWorker(w: Worker) {
    worker = w;
    w.addEventListener('message', onWorkerMessage);
    // Re-seed a previously-loaded annotation index into the fresh worker.
    if (annotationIndex) {
      annotationsReady = false;
      w.postMessage({ type: 'init_annotations', embeddings: annotationIndex.embeddings, docIds: annotationIndex.docIds });
    }
  }

  // Attach the worker once it has spawned and initialized. Regex works immediately
  // (it only needs the worker's corpus); semantic waits for modelsReady.
  function setWorker(w: Worker) {
    attachWorker(w);
  }

  // Hand the worker the lazily-downloaded annotation embedding index.
  function setAnnotationIndex(embeddings: ArrayBuffer, docIds: number[]) {
    annotationIndex = { embeddings, docIds };
    annotationsReady = false;
    worker?.postMessage({ type: 'init_annotations', embeddings, docIds });
  }

  function hasWorker(): boolean {
    return worker !== null;
  }

  function isModelsReady(): boolean {
    return modelsReady;
  }

  function hasAnnotationIndex(): boolean {
    return annotationIndex !== null;
  }

  function isAnnotationsReady(): boolean {
    return annotationsReady;
  }

  // Semantic search is usable when the models are ready — and, for the Annotations
  // filter specifically, only once the annotation index has been ingested.
  function semanticAvailable(): boolean {
    if (!modelsReady) return false;
    if (getTypeFilter() === 'story-theme') return annotationsReady;
    return true;
  }

  function doKeywordSearch(query: string): {
    ranked: Array<{ doc_id: number; score: number }>;
    lexScores: Map<number, number>;
  } {
    const parsed = parseOperators(query);
    if (!parsed.free_text.trim()) return { ranked: [], lexScores: new Map() };
    // Restrict to the selected type before truncating to CANDIDATE_K.
    const filter = getTypeFilter();
    const typePred = filter === 'all'
      ? undefined
      : (id: number) => matchesType(docById.get(id)?.doc_type ?? '', filter);
    const lexHits = lexicalSearch(miniSearch, parsed, CANDIDATE_K, typePred);
    const hasOperators = parsed.required.length > 0 || parsed.excluded.length > 0;
    const filtered = hasOperators
      ? applyPoolFilter(lexHits.map(h => h.doc_id), corpus, parsed.required, parsed.excluded)
      : lexHits.map(h => h.doc_id);
    const lexScores = new Map(lexHits.map(h => [h.doc_id, h.score]));
    const lexList: ScoredHit[] = filtered.map(id => ({ doc_id: id, score: lexScores.get(id) ?? 0, source: 'lexical' as const }));
    return { ranked: sortByRrf(filtered, [lexList]), lexScores };
  }

  // Synchronous keyword search; rendered instantly on every keystroke.
  function showKeyword(query: string) {
    lastQuery = query;
    const t0 = performance.now();
    const { ranked, lexScores } = doKeywordSearch(query);
    cache = { ranked, snippets: new Map(), semScores: new Map(), lexScores, phase: 'keyword' };
    render({ total_ms: Math.round(performance.now() - t0) });
  }

  function dispatchSemantic(query: string, rerank: boolean) {
    if (!worker) return;
    lastQuery = query;
    const parsed = parseOperators(query);
    const { ranked } = doKeywordSearch(query);
    const gen = ++searchGeneration;
    onStatus(rerank ? 'Running semantic re-ranking…' : 'Running semantic search…');
    worker.postMessage({ type: 'cancel_warmup', phase: 'embed' });
    if (rerank) worker.postMessage({ type: 'cancel_warmup', phase: 'rerank' });
    worker.postMessage({
      type: 'search',
      query,
      generation: gen,
      keywordHits: ranked.map(r => r.doc_id),
      topK: CANDIDATE_K,
      rerank,
      required: parsed.required,
      excluded: parsed.excluded,
      typeFilter: getTypeFilter(),
    });
  }

  // Instant keyword results, then (if the model is ready and the query is short
  // enough for auto-search) a debounced semantic pass. Long queries show keyword
  // only and wait for Enter/Search.
  function search(rawQuery: string) {
    const query = rawQuery.trim();
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    ++searchGeneration; // invalidate any in-flight semantic reply
    if (!query) {
      cache = null;
      onResults([], 'searching');
      onStatus('');
      return;
    }
    showKeyword(query);
    if (!semanticAvailable()) return; // semantic (or annotation index) still loading
    if (query.length <= AUTO_SEARCH_MAX_CHARS) {
      onStatus('');
      debounceTimer = setTimeout(() => dispatchSemantic(query, false), DEBOUNCE_MS);
    } else {
      onStatus('Press Enter or Search for semantic results');
    }
  }

  // Full re-ranking, triggered explicitly (Enter / button). No-op for semantic if
  // the model isn't ready yet — keyword results already stand.
  function triggerRerank(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query) return;
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (!semanticAvailable()) { showKeyword(query); return; }
    dispatchSemantic(query, true);
  }

  // Regex search runs in the worker (user-supplied patterns can backtrack
  // catastrophically); a watchdog terminates and respawns a hung worker.
  function searchRegex(rawQuery: string) {
    const query = rawQuery.trim();
    cancelSemantic();
    if (!query) {
      cache = null;
      onResults([], 'searching');
      onStatus('');
      return;
    }
    if (!worker) {
      onStatus('Regex search is still loading…');
      return;
    }
    lastQuery = query;
    const gen = ++searchGeneration;
    regexT0 = performance.now();
    clearRegexWatchdog();
    regexTimer = setTimeout(() => {
      regexTimer = null;
      ++searchGeneration;
      modelsReady = false; // the killed worker must reload before semantic works again
      onResults([], 'searching');
      onStatus('Regex search timed out — pattern too complex', 'error');
      if (respawnWorker && worker) {
        worker.terminate();
        worker = null;
        void respawnWorker().then(w => attachWorker(w));
      }
    }, REGEX_WATCHDOG_MS);
    worker.postMessage({ type: 'regex_search', pattern: query, typeFilter: getTypeFilter(), generation: gen });
  }

  function refilter() {
    render();
  }

  function cancelSemantic() {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    ++searchGeneration;
  }

  return {
    search,
    triggerRerank,
    searchRegex,
    refilter,
    cancelSemantic,
    setWorker,
    setAnnotationIndex,
    hasWorker,
    isModelsReady,
    hasAnnotationIndex,
    isAnnotationsReady,
  };
}
