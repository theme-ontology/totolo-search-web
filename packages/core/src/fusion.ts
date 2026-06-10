import type { ScoredHit } from './types.js';

const RRF_K = 60;

export function unionDedup(hitLists: ScoredHit[][]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];

  const maxLen = Math.max(...hitLists.map(l => l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of hitLists) {
      if (i < list.length) {
        const id = list[i].doc_id;
        if (!seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }
    }
  }
  return result;
}

export function rrfScores(hitLists: ScoredHit[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of hitLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank].doc_id;
      const prev = scores.get(id) ?? 0;
      scores.set(id, prev + 1 / (RRF_K + rank + 1));
    }
  }
  return scores;
}

export function sortByRrf(docIds: number[], hitLists: ScoredHit[][]): Array<{ doc_id: number; score: number }> {
  const scores = rrfScores(hitLists);
  return docIds
    .map(id => ({ doc_id: id, score: scores.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
