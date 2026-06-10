import { pipeline } from '@huggingface/transformers';
import { makePassages, unionDedup } from '@totolo-search/core';
import type { Document, ScoredHit } from '@totolo-search/core';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

type Pipe = Awaited<ReturnType<typeof pipeline>>;

let embedder: Pipe | null = null;
let reranker: Pipe | null = null;
let embedMatrix: Float32Array | null = null;
let docIds: number[] = [];
let nDocs = 0;
let dims = 0;
let corpus: Document[] = [];
let useWebGPU = false;
const cancelWarmup = { embed: false, rerank: false };

function pipelineOpts(task: 'embed' | 'rerank'): Record<string, unknown> {
  if (useWebGPU) return { device: 'webgpu', dtype: task === 'embed' ? 'fp32' : 'fp16' };
  return { dtype: 'q8' };
}

async function loadEmbedder() {
  if (!embedder) {
    self.postMessage({ type: 'progress', label: 'Loading embedding model…' });
    try {
      embedder = await pipeline('feature-extraction', EMBED_MODEL, pipelineOpts('embed'));
    } catch (err) {
      if (useWebGPU) {
        useWebGPU = false;
        self.postMessage({ type: 'webgpu_fallback' });
        embedder = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
      } else throw err;
    }
  }
}

async function loadReranker() {
  if (!reranker) {
    self.postMessage({ type: 'progress', label: 'Loading re-ranker…' });
    try {
      reranker = await pipeline('text-classification', RERANK_MODEL, pipelineOpts('rerank'));
    } catch (err) {
      if (useWebGPU) {
        useWebGPU = false;
        reranker = await pipeline('text-classification', RERANK_MODEL, { dtype: 'q8' });
      } else throw err;
    }
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array, bOffset: number): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[bOffset + i];
  return dot;
}

function vectorSearch(queryVec: Float32Array, topK: number): ScoredHit[] {
  if (!embedMatrix || nDocs === 0) return [];
  const sims: Array<[number, number]> = [];
  for (let i = 0; i < nDocs; i++) {
    const sim = cosineSimilarity(queryVec, embedMatrix, i * dims);
    sims.push([docIds[i], sim]);
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
  // @ts-expect-error transformers overloads
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

self.addEventListener('message', async (ev: MessageEvent) => {
  const msg = ev.data as { type: string } & Record<string, unknown>;

  switch (msg.type) {
    case 'init': {
      const buf = msg.embeddings as ArrayBuffer;
      const view = new DataView(buf);
      nDocs = view.getUint32(0, true);
      dims = view.getUint32(4, true);
      embedMatrix = new Float32Array(buf, 8, nDocs * dims);
      docIds = msg.docIds as number[];
      corpus = msg.corpus as Document[];
      useWebGPU = (msg.useWebGPU as boolean) ?? false;
      self.postMessage({ type: 'ready' });

      loadEmbedder()
        .then(async () => {
          if (cancelWarmup.embed) return;
          // @ts-expect-error overloads
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
          // @ts-expect-error overloads
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

      try {
        const t0 = performance.now();

        await loadEmbedder();
        const t1 = performance.now();

        // @ts-expect-error overloads
        const out = await embedder(query, { pooling: 'mean', normalize: true });
        const queryVec = out.data as Float32Array;
        const t2 = performance.now();

        const semanticHits = vectorSearch(queryVec, topK);
        const lexicalHits: ScoredHit[] = keywordHits.map((id, rank) => ({
          doc_id: id, score: 1 / (rank + 1), source: 'lexical' as const,
        }));
        const candidateIds = unionDedup([lexicalHits, semanticHits]);
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

    case 'cancel_warmup': {
      const phase = msg.phase as string;
      if (phase === 'embed') cancelWarmup.embed = true;
      if (phase === 'rerank') cancelWarmup.rerank = true;
      break;
    }
  }
});
