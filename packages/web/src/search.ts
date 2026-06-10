import MiniSearch from 'minisearch';
import { parseOperators, lexicalSearch, applyPoolFilter, sortByRrf } from '@totolo-search/core';
import type { Document, SearchResult, ScoredHit } from '@totolo-search/core';
import { CANDIDATE_K, FINAL_K, DEBOUNCE_MS } from './config.js';

export type ResultsPhase = 'keyword' | 'semantic' | 'reranked' | 'regex' | 'searching';
export type Timings = { embed_ms?: number; vector_ms?: number; rerank_ms?: number; total_ms?: number };
export type ResultsCallback = (results: SearchResult[], phase: ResultsPhase, timings?: Timings) => void;

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
  corpus: Document[],
  snippets: Map<number, string>,
  semanticScores: Map<number, number>,
  lexicalScores: Map<number, number>,
  query = '',
): SearchResult[] {
  const byId = new Map(corpus.map(d => [d.doc_id, d]));
  const terms = parseTerms(query);
  return rankedIds.slice(0, FINAL_K).map(({ doc_id, score }) => {
    const doc = byId.get(doc_id);
    if (!doc) return null;
    const snippet = snippets.get(doc_id) ?? '';
    const excerpt = snippet
      ? snippet.replace(/^[^.]+\.\s*/, '').slice(0, 200)
      : (findExcerpt(doc.search_body, terms) ?? doc.description.slice(0, 120) + (doc.description.length > 120 ? '…' : ''));
    return {
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
    } satisfies SearchResult;
  }).filter((r): r is SearchResult => r !== null);
}

// Returns null if pattern is invalid regex, otherwise up to 200 matching docs.
export function regexSearch(
  corpus: Document[],
  pattern: string,
  typeFilter = 'all',
): SearchResult[] | null {
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  const results: SearchResult[] = [];
  for (const doc of corpus) {
    if (typeFilter !== 'all') {
      const match = typeFilter === 'story'
        ? (doc.doc_type === 'story' || doc.doc_type === 'collection')
        : doc.doc_type === typeFilter;
      if (!match) continue;
    }
    const text = doc.search_title + '\n' + doc.search_body + '\n' + doc.search_misc;
    if (!re.test(text)) continue;
    const bodyMatch = re.exec(doc.search_body);
    let description: string;
    if (bodyMatch) {
      const ctx = 150;
      const s = Math.max(0, bodyMatch.index - ctx);
      const e = Math.min(doc.search_body.length, bodyMatch.index + bodyMatch[0].length + ctx);
      description = (s > 0 ? '…' : '') + doc.search_body.slice(s, e) + (e < doc.search_body.length ? '…' : '');
    } else {
      description = doc.description.slice(0, 200) + (doc.description.length > 200 ? '…' : '');
    }
    results.push({
      doc_id: doc.doc_id,
      score: 0,
      name: doc.name,
      doc_type: doc.doc_type,
      title: doc.title,
      date: doc.date,
      description,
      snippet: bodyMatch ? doc.search_body.slice(bodyMatch.index, bodyMatch.index + bodyMatch[0].length) : '',
      lexical_score: 0,
      semantic_score: 0,
      theme_level: doc.theme_level,
      parents: doc.parents,
    });
    if (results.length >= 200) break;
  }
  return results;
}

export function createSearchEngine(
  miniSearch: MiniSearch<Document>,
  corpus: Document[],
  worker: Worker,
  onResults: ResultsCallback,
  onStatus: (msg: string) => void,
  onModelsReady?: () => void,
  getTypeFilter: () => string = () => 'all',
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchGeneration = 0;
  let lastResults: SearchResult[] = [];
  let lastPhase: 'keyword' | 'semantic' | 'reranked' = 'keyword';
  let lastQuery = '';

  function applyFilter(results: SearchResult[]): SearchResult[] {
    const filter = getTypeFilter();
    if (filter === 'all') return results;
    if (filter === 'story') return results.filter(r => r.doc_type === 'story' || r.doc_type === 'collection');
    return results.filter(r => r.doc_type === filter);
  }

  function show(results: SearchResult[], phase: 'keyword' | 'semantic' | 'reranked', timings?: Timings) {
    lastResults = results;
    lastPhase = phase;
    onResults(applyFilter(results), phase, timings);
  }

  worker.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type: string } & Record<string, unknown>;
    if (msg.type === 'results') {
      if ((msg.generation as number) !== searchGeneration) return;
      const raw = msg.results as Array<{ doc_id: number; score: number; snippet: string }>;
      const snippets = new Map(raw.map(r => [r.doc_id, r.snippet]));
      const scores = new Map(raw.map(r => [r.doc_id, r.score]));
      const ranked = raw.map(r => ({ doc_id: r.doc_id, score: r.score }));
      const results = hydrateResults(ranked, corpus, snippets, scores, new Map(), lastQuery);
      const timings = msg.timings as Timings | undefined;
      show(results, (msg.reranked as boolean) ? 'reranked' : 'semantic', timings);
      onStatus('');
    } else if (msg.type === 'models_ready') {
      onModelsReady?.();
    } else if (msg.type === 'webgpu_fallback') {
      onStatus('WebGPU unavailable, using WASM fallback');
    } else if (msg.type === 'progress') {
      onStatus(msg.label as string);
    } else if (msg.type === 'error') {
      onStatus(`Search error: ${msg.message}`);
    }
  });

  function doKeywordSearch(query: string): SearchResult[] {
    const parsed = parseOperators(query);
    if (!parsed.free_text.trim()) return [];
    const lexHits = lexicalSearch(miniSearch, parsed, CANDIDATE_K);
    const hasOperators = parsed.required.length > 0 || parsed.excluded.length > 0;
    const filtered = hasOperators
      ? applyPoolFilter(lexHits.map(h => h.doc_id), corpus, parsed.required, parsed.excluded)
      : lexHits.map(h => h.doc_id);
    const lexScores = new Map(lexHits.map(h => [h.doc_id, h.score]));
    const lexList: ScoredHit[] = filtered.map(id => ({ doc_id: id, score: lexScores.get(id) ?? 0, source: 'lexical' as const }));
    return hydrateResults(sortByRrf(filtered, [lexList]), corpus, new Map(), new Map(), lexScores, query);
  }

  function dispatchSearch(query: string, rerank: boolean) {
    lastQuery = query;
    const keywordHits = doKeywordSearch(query).map(r => r.doc_id);
    const gen = ++searchGeneration;
    onStatus(rerank ? 'Running semantic re-ranking…' : 'Running semantic search…');
    worker.postMessage({ type: 'cancel_warmup', phase: 'embed' });
    if (rerank) worker.postMessage({ type: 'cancel_warmup', phase: 'rerank' });
    worker.postMessage({ type: 'search', query, generation: gen, keywordHits, topK: CANDIDATE_K, rerank });
  }

  // Clear results immediately, then run keyword+semantic after debounce
  function search(rawQuery: string) {
    const query = rawQuery.trim();
    onResults([], 'searching');
    onStatus('');
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (!query) { lastResults = []; return; }
    debounceTimer = setTimeout(() => dispatchSearch(query, false), DEBOUNCE_MS);
  }

  // Full re-ranking, triggered explicitly (Enter / button)
  function triggerRerank(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query) return;
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    dispatchSearch(query, true);
  }

  function refilter() {
    onResults(applyFilter(lastResults), lastPhase, undefined);
  }

  function cancelSemantic() {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    ++searchGeneration;
  }

  return { search, triggerRerank, refilter, cancelSemantic };
}
