import { pipeline, env } from '@huggingface/transformers';
import { makePassages, unionDedup, applyPoolFilter } from '@totolo-search/core';
import type { ScoredHit } from '@totolo-search/core';
import type { WorkerDoc, RegexHit } from './worker-types.js';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pipe = any;

let embedder: Pipe | null = null;
let reranker: Pipe | null = null;
let embedMatrix: Float32Array | null = null;
let docIds: number[] = [];
let nDocs = 0;
let dims = 0;
// Annotation (story-theme) embedding index — loaded lazily via 'init_annotations'.
let annMatrix: Float32Array | null = null;
let annDocIds: number[] = [];
let annNDocs = 0;
let corpus: WorkerDoc[] = [];
const typeById = new Map<number, string>();
let useWebGPU = false;
const cancelWarmup = { embed: false, rerank: false };

function pipelineOpts(task: 'embed' | 'rerank'): Record<string, unknown> {
  if (useWebGPU) return { device: 'webgpu', dtype: task === 'embed' ? 'fp32' : 'fp16' };
  return { dtype: 'q8' };
}

// Forward model file download progress to the main thread for the progress bar.
function progressCallback(p: { status?: string; file?: string; loaded?: number; total?: number }) {
  if (p.status === 'progress' && p.total && p.file) {
    self.postMessage({ type: 'model_progress', file: p.file, loaded: p.loaded ?? 0, total: p.total });
  }
}

async function loadEmbedder() {
  if (!embedder) {
    self.postMessage({ type: 'progress', label: 'Loading embedding model…' });
    try {
      embedder = await pipeline('feature-extraction', EMBED_MODEL, {
        ...pipelineOpts('embed'),
        progress_callback: progressCallback,
      });
    } catch (err) {
      if (useWebGPU) {
        useWebGPU = false;
        self.postMessage({ type: 'webgpu_fallback' });
        embedder = await pipeline('feature-extraction', EMBED_MODEL, {
          dtype: 'q8',
          progress_callback: progressCallback,
        });
      } else throw err;
    }
  }
}

async function loadReranker() {
  if (!reranker) {
    self.postMessage({ type: 'progress', label: 'Loading re-ranker…' });
    try {
      reranker = await pipeline('text-classification', RERANK_MODEL, {
        ...pipelineOpts('rerank'),
        progress_callback: progressCallback,
      });
    } catch (err) {
      if (useWebGPU) {
        useWebGPU = false;
        reranker = await pipeline('text-classification', RERANK_MODEL, {
          dtype: 'q8',
          progress_callback: progressCallback,
        });
      } else throw err;
    }
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array, bOffset: number): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[bOffset + i];
  return dot;
}

// Annotations use their own matrix; themes/stories use the title matrix and are
// restricted to the selected type so a rare type still fills the candidate list.
function vectorSearch(queryVec: Float32Array, topK: number, typeFilter: string): ScoredHit[] {
  const useAnn = typeFilter === 'story-theme';
  const matrix = useAnn ? annMatrix : embedMatrix;
  const ids = useAnn ? annDocIds : docIds;
  const n = useAnn ? annNDocs : nDocs;
  if (!matrix || n === 0) return [];
  const restrict = typeFilter !== 'all' && !useAnn;
  const sims: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (restrict && !matchesType(typeById.get(id) ?? '', typeFilter)) continue;
    const sim = cosineSimilarity(queryVec, matrix, i * dims);
    sims.push([id, sim]);
  }
  sims.sort((a, b) => b[1] - a[1]);
  return sims.slice(0, topK).map(([doc_id, score]) => ({ doc_id, score, source: 'semantic' as const }));
}

async function scorePassages(query: string, candidates: number[]): Promise<Array<{ doc_id: number; score: number; snippet: string }>> {
  if (!reranker) return candidates.map(id => ({ doc_id: id, score: 0, snippet: '' }));

  const corpusMap = new Map(corpus.map(d => [d.doc_id, d]));
  type Pair = { doc_id: number; passage: string };
  const pairs: Pair[] = [];

  for (const id of candidates) {
    const doc = corpusMap.get(id);
    if (!doc) continue;
    const header = doc.name + (doc.title ? ` — ${doc.title}` : '');
    for (const p of makePassages(header, doc.search_body)) {
      pairs.push({ doc_id: id, passage: p });
    }
  }

  if (pairs.length === 0) return [];

  const inputs = pairs.map(p => [query, p.passage] as [string, string]);
  const rawScores: Array<{ label: string; score: number } | Array<{ label: string; score: number }>> =
    await reranker(inputs, { topk: null });

  const getScore = (r: unknown): number => {
    if (Array.isArray(r)) return Math.max(...(r as Array<{ score: number }>).map(x => x.score));
    return (r as { score: number }).score;
  };

  const docBest = new Map<number, { score: number; snippet: string }>();
  for (let i = 0; i < pairs.length; i++) {
    const { doc_id, passage } = pairs[i];
    const score = getScore(rawScores[i]);
    const prev = docBest.get(doc_id);
    if (!prev || score > prev.score) docBest.set(doc_id, { score, snippet: passage });
  }

  return Array.from(docBest.entries())
    .map(([doc_id, { score, snippet }]) => ({ doc_id, score, snippet }))
    .sort((a, b) => b.score - a.score);
}

function matchesType(docType: string, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'story') return docType === 'story' || docType === 'collection';
  return docType === filter;
}

// Smart-case (like ripgrep / Vim): match case-insensitively when the pattern is all lowercase,
// but case-sensitively the moment it contains a literal uppercase letter. Escape sequences are
// stripped before the test so regex tokens such as \D \W \S \b don't count as "uppercase".
function isCaseSensitive(pattern: string): boolean {
  return /[A-Z]/.test(pattern.replace(/\\./g, ''));
}

function regexSearch(pattern: string, typeFilter: string): RegexHit[] | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern, isCaseSensitive(pattern) ? '' : 'i');
  } catch {
    return null;
  }
  const hits: RegexHit[] = [];
  for (const doc of corpus) {
    if (!matchesType(doc.doc_type, typeFilter)) continue;
    const text = doc.search_title + '\n' + doc.search_body + '\n' + doc.search_misc;
    if (!re.test(text)) continue;
    const bodyMatch = re.exec(doc.search_body);
    let excerpt = '';
    let snippet = '';
    if (bodyMatch) {
      const ctx = 150;
      const s = Math.max(0, bodyMatch.index - ctx);
      const e = Math.min(doc.search_body.length, bodyMatch.index + bodyMatch[0].length + ctx);
      excerpt = (s > 0 ? '…' : '') + doc.search_body.slice(s, e) + (e < doc.search_body.length ? '…' : '');
      snippet = bodyMatch[0];
    }
    hits.push({ doc_id: doc.doc_id, excerpt, snippet });
    if (hits.length >= 200) break;
  }
  return hits;
}

self.addEventListener('message', async (ev: MessageEvent) => {
  const msg = ev.data as { type: string } & Record<string, unknown>;

  switch (msg.type) {
    case 'init': {
      // Serve models from our own origin (downloaded at build time) instead of the
      // Hugging Face CDN, which trips CORS. modelsBase is an absolute URL ending in '/'.
      const modelsBase = msg.modelsBase as string | undefined;
      if (modelsBase) {
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = modelsBase;
      }

      const buf = msg.embeddings as ArrayBuffer;
      const view = new DataView(buf);
      nDocs = view.getUint32(0, true);
      dims = view.getUint32(4, true);
      embedMatrix = new Float32Array(buf, 8, nDocs * dims);
      docIds = msg.docIds as number[];
      corpus = msg.corpus as WorkerDoc[];
      typeById.clear();
      for (const d of corpus) typeById.set(d.doc_id, d.doc_type);
      useWebGPU = (msg.useWebGPU as boolean) ?? false;
      self.postMessage({ type: 'ready' });

      loadEmbedder()
        .then(async () => {
          if (cancelWarmup.embed) return;
          await embedder('something wicked this way comes', { pooling: 'mean', normalize: true });
        })
        .then(() => loadReranker())
        .then(async () => {
          if (cancelWarmup.rerank) return;
          const q = 'something wicked this way comes';
          const p = 'A character encounters something wicked and foreboding this way comes toward them. ' +
                    'The narrative explores themes of darkness, fate, and the supernatural. ' +
                    'Human will is tested against malevolent forces beyond ordinary understanding.';
          const batch = Array.from({ length: 5 }, () => [q, p] as [string, string]);
          await reranker(batch, { topk: null });
        })
        .then(() => self.postMessage({ type: 'models_ready' }))
        .catch(err => self.postMessage({ type: 'error', message: `Model load failed: ${err}` }));
      break;
    }

    case 'search': {
      const query = msg.query as string;
      const generation = msg.generation as number;
      const keywordHits = msg.keywordHits as number[];
      const topK = (msg.topK as number | undefined) ?? 30;
      const rerank = (msg.rerank as boolean | undefined) ?? false;
      const required = (msg.required as string[] | undefined) ?? [];
      const excluded = (msg.excluded as string[] | undefined) ?? [];
      const typeFilter = (msg.typeFilter as string | undefined) ?? 'all';

      try {
        const t0 = performance.now();

        await loadEmbedder();
        const t1 = performance.now();

        const out = await embedder(query, { pooling: 'mean', normalize: true });
        const queryVec = out.data as Float32Array;
        const t2 = performance.now();

        const semanticHits = vectorSearch(queryVec, topK, typeFilter);
        const lexicalHits: ScoredHit[] = keywordHits.map((id, rank) => ({
          doc_id: id, score: 1 / (rank + 1), source: 'lexical' as const,
        }));
        let candidateIds = unionDedup([lexicalHits, semanticHits]);
        // Enforce +required / -excluded on the merged pool so semantic hits respect operators
        if (required.length > 0 || excluded.length > 0) {
          candidateIds = applyPoolFilter(candidateIds, corpus, required, excluded);
        }
        const t3 = performance.now();

        const timings: Record<string, number> = {
          embed_ms: Math.round(t2 - t1),
          vector_ms: Math.round(t3 - t2),
          total_ms: 0,
        };

        if (!rerank) {
          const scoreMap = new Map(semanticHits.map(h => [h.doc_id, h.score]));
          const results = candidateIds.slice(0, topK).map(id => ({
            doc_id: id, score: scoreMap.get(id) ?? 0, snippet: '',
          }));
          timings.total_ms = Math.round(performance.now() - t0);
          self.postMessage({ type: 'results', results, generation, reranked: false, timings });
        } else {
          await loadReranker();
          const t4 = performance.now();
          const reranked = await scorePassages(query, candidateIds.slice(0, 50));
          const t5 = performance.now();
          timings.rerank_ms = Math.round(t5 - t4);
          timings.total_ms = Math.round(t5 - t0);
          self.postMessage({ type: 'results', results: reranked, generation, reranked: true, timings });
        }
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
      }
      break;
    }

    case 'init_annotations': {
      const buf = msg.embeddings as ArrayBuffer;
      const view = new DataView(buf);
      annNDocs = view.getUint32(0, true);
      const annDims = view.getUint32(4, true);
      annMatrix = new Float32Array(buf, 8, annNDocs * annDims);
      annDocIds = msg.docIds as number[];
      self.postMessage({ type: 'annotations_ready' });
      break;
    }

    case 'regex_search': {
      const pattern = msg.pattern as string;
      const typeFilter = (msg.typeFilter as string | undefined) ?? 'all';
      const generation = msg.generation as number;
      const hits = regexSearch(pattern, typeFilter);
      if (hits === null) {
        self.postMessage({ type: 'regex_results', generation, invalid: true, results: [] });
      } else {
        self.postMessage({ type: 'regex_results', generation, invalid: false, results: hits });
      }
      break;
    }

    case 'cancel_warmup': {
      const phase = msg.phase as string;
      if (phase === 'embed') cancelWarmup.embed = true;
      if (phase === 'rerank') cancelWarmup.rerank = true;
      break;
    }
  }
});
