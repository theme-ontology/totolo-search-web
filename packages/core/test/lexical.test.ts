import { describe, it, expect } from 'vitest';
import MiniSearch from 'minisearch';
import { lexicalSearch } from '../src/query';
import { getMiniSearchOptions } from '../src/schema';
import { parseOperators } from '../src/parse';
import type { Document } from '../src/types';

function doc(doc_id: number, doc_type: Document['doc_type'], title: string, body: string): Document {
  return {
    doc_id,
    name: `doc-${doc_id}`,
    doc_type,
    aliases: [],
    title: '',
    date: '',
    authors: [],
    description: '',
    search_title: title,
    search_body: body,
    search_misc: '',
  };
}

const docs: Document[] = [
  doc(1, 'theme', 'dragon', 'a theme about dragons and fire'),
  doc(2, 'story', 'dragon tale', 'a story where a dragon hoards gold'),
  doc(3, 'theme', 'wyrm', 'an old word for dragon'),
  doc(4, 'story', 'knight', 'a knight slays the dragon'),
  doc(5, 'story-theme', 'dragon', 'the dragon represents greed in this story'),
];

function buildIndex(): MiniSearch<Document> {
  const ms = new MiniSearch<Document>(getMiniSearchOptions());
  ms.addAll(docs);
  return ms;
}

describe('lexicalSearch with type filter', () => {
  it('returns all matching types when no filter is given', () => {
    const ms = buildIndex();
    const hits = lexicalSearch(ms, parseOperators('dragon'), 50);
    const ids = new Set(hits.map(h => h.doc_id));
    expect(ids).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('restricts to a single type before truncation', () => {
    const ms = buildIndex();
    const themes = lexicalSearch(ms, parseOperators('dragon'), 50, id =>
      docs.find(d => d.doc_id === id)?.doc_type === 'theme');
    expect(new Set(themes.map(h => h.doc_id))).toEqual(new Set([1, 3]));
  });

  it('applies the filter before the k limit, so a rare type still fills up', () => {
    const ms = buildIndex();
    // With k=1 and no filter the single annotation might not survive; with the filter
    // applied first, the top annotation is returned.
    const anns = lexicalSearch(ms, parseOperators('dragon'), 1, id =>
      docs.find(d => d.doc_id === id)?.doc_type === 'story-theme');
    expect(anns).toHaveLength(1);
    expect(anns[0].doc_id).toBe(5);
  });
});
