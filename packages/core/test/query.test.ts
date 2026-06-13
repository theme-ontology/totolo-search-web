import { describe, it, expect } from 'vitest';
import { applyPoolFilter } from '../src/query';
import type { Document } from '../src/types';

function doc(doc_id: number, body: string, title = '', misc = ''): Document {
  return {
    doc_id,
    name: `doc-${doc_id}`,
    doc_type: 'story',
    aliases: [],
    title: '',
    date: '',
    authors: [],
    description: '',
    search_title: title,
    search_body: body,
    search_misc: misc,
  };
}

const corpus: Document[] = [
  doc(1, 'a wolf runs through the dark forest at night'),
  doc(2, 'a dragon breathes fire over the castle'),
  doc(3, 'the forest is bright and full of song'),
  doc(4, 'dark castles loom', 'dragon keep'),
];

const ids = corpus.map(d => d.doc_id);

describe('applyPoolFilter', () => {
  it('returns input unchanged when no operators', () => {
    expect(applyPoolFilter(ids, corpus, [], [])).toEqual(ids);
  });

  it('keeps only docs containing a required term', () => {
    expect(applyPoolFilter(ids, corpus, ['dragon'], [])).toEqual([2, 4]);
  });

  it('finds required terms in any search field', () => {
    // 'keep' only appears in doc 4's search_title
    expect(applyPoolFilter(ids, corpus, ['keep'], [])).toEqual([4]);
  });

  it('drops docs containing an excluded term', () => {
    expect(applyPoolFilter(ids, corpus, [], ['dark'])).toEqual([2, 3]);
  });

  it('multi-word exclusion drops docs containing all the words (not the phrase)', () => {
    // doc 1 has both 'dark' and 'forest'; doc 3 has only 'forest'; doc 4 only 'dark'
    expect(applyPoolFilter(ids, corpus, [], ['dark forest'])).toEqual([2, 3, 4]);
  });

  it('matches via stemming ("running" matches docs with "runs")', () => {
    expect(applyPoolFilter(ids, corpus, ['running'], [])).toEqual([1]);
  });

  it('combines required and excluded', () => {
    expect(applyPoolFilter(ids, corpus, ['forest'], ['dark'])).toEqual([3]);
  });

  it('drops unknown doc ids', () => {
    expect(applyPoolFilter([1, 999], corpus, ['wolf'], [])).toEqual([1]);
  });
});
