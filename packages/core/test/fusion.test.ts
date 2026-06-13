import { describe, it, expect } from 'vitest';
import { unionDedup, rrfScores, sortByRrf } from '../src/fusion';
import type { ScoredHit } from '../src/types';

function hits(source: 'lexical' | 'semantic', ...ids: number[]): ScoredHit[] {
  return ids.map((doc_id, i) => ({ doc_id, score: 1 / (i + 1), source }));
}

describe('unionDedup', () => {
  it('interleaves lists rank by rank', () => {
    const a = hits('lexical', 1, 2, 3);
    const b = hits('semantic', 4, 5, 6);
    expect(unionDedup([a, b])).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it('dedups, keeping the earliest occurrence', () => {
    const a = hits('lexical', 1, 2, 3);
    const b = hits('semantic', 2, 1, 4);
    expect(unionDedup([a, b])).toEqual([1, 2, 3, 4]);
  });

  it('handles lists of different lengths', () => {
    const a = hits('lexical', 1);
    const b = hits('semantic', 2, 3, 4);
    expect(unionDedup([a, b])).toEqual([1, 2, 3, 4]);
  });

  it('handles empty input', () => {
    expect(unionDedup([])).toEqual([]);
    expect(unionDedup([[], []])).toEqual([]);
  });
});

describe('rrfScores', () => {
  it('scores 1/(60+rank+1) per list', () => {
    const a = hits('lexical', 7);
    const scores = rrfScores([a]);
    expect(scores.get(7)).toBeCloseTo(1 / 61, 10);
  });

  it('sums contributions across lists', () => {
    const a = hits('lexical', 7, 8);
    const b = hits('semantic', 8, 7);
    const scores = rrfScores([a, b]);
    // both docs appear at ranks 0 and 1
    expect(scores.get(7)).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(scores.get(8)).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });
});

describe('sortByRrf', () => {
  it('orders docs by descending fused score', () => {
    const a = hits('lexical', 1, 2, 3);
    const b = hits('semantic', 3, 2, 1);
    // docs 1 and 3 get 1/61 + 1/63, doc 2 gets 2/62 — and 1/61 + 1/63 > 2/62,
    // so the rank-0 docs win; 1 before 3 by stable sort on input order
    const sorted = sortByRrf([1, 2, 3], [a, b]);
    expect(sorted.map(s => s.doc_id)).toEqual([1, 3, 2]);
  });

  it('gives unranked docs score 0', () => {
    const sorted = sortByRrf([9], [hits('lexical', 1)]);
    expect(sorted).toEqual([{ doc_id: 9, score: 0 }]);
  });
});
