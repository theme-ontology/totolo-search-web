import MiniSearch from 'minisearch';
import type { Document, ParsedQuery, ScoredHit } from './types.js';
import { BOOST_TITLE, BOOST_BODY, BOOST_MISC, BOOST_PHRASE, stem, tokenize } from './schema.js';

export function lexicalSearch(
  ms: MiniSearch<Document>,
  parsed: ParsedQuery,
  k: number,
): ScoredHit[] {
  if (!parsed.free_text.trim()) return [];

  const baseOpts = {
    boost: { search_title: BOOST_TITLE, search_body: BOOST_BODY, search_misc: BOOST_MISC },
    fuzzy: (term: string) => (term.length > 3 ? 0.15 : false) as number | false,
    prefix: true,
    combineWith: 'OR' as const,
  };

  const scoreMap = new Map<number, number>();

  const mainResults = ms.search(parsed.free_text, baseOpts);
  for (const r of mainResults) {
    scoreMap.set(r.id as number, (scoreMap.get(r.id as number) ?? 0) + r.score);
  }

  for (const phrase of parsed.phrases) {
    const phraseResults = ms.search(phrase, {
      boost: { search_title: BOOST_TITLE * BOOST_PHRASE, search_body: BOOST_BODY * BOOST_PHRASE },
      fuzzy: false,
      prefix: false,
      combineWith: 'AND' as const,
    });
    for (const r of phraseResults) {
      scoreMap.set(r.id as number, (scoreMap.get(r.id as number) ?? 0) + r.score);
    }
  }

  const hits: ScoredHit[] = Array.from(scoreMap.entries())
    .map(([doc_id, score]) => ({ doc_id, score, source: 'lexical' as const }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return hits;
}

export function applyPoolFilter(
  docIds: number[],
  corpus: Document[],
  required: string[],
  excluded: string[],
): number[] {
  if (required.length === 0 && excluded.length === 0) return docIds;

  const docById = new Map(corpus.map(d => [d.doc_id, d]));

  const stemmedRequired = required.map(r => tokenize(r).map(stem));
  const stemmedExcluded = excluded.map(e => tokenize(e).map(stem));

  return docIds.filter(id => {
    const doc = docById.get(id);
    if (!doc) return false;

    const text = `${doc.search_title} ${doc.search_body} ${doc.search_misc}`;
    const docStems = new Set(tokenize(text).map(stem));

    for (const req of stemmedRequired) {
      if (!req.every(s => docStems.has(s))) return false;
    }
    for (const excl of stemmedExcluded) {
      if (excl.length > 0 && excl.every(s => docStems.has(s))) return false;
    }

    return true;
  });
}
