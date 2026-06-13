import type { Document } from '@totolo-search/core';

// Subset of Document shipped to the worker. The worker needs the search_* fields
// for +/- operator filtering (applyPoolFilter) and regex search, doc_type for the
// regex type filter, and name/title/search_body for rerank passages. Everything
// else (aliases, authors, date, description, theme_level, parents) stays on the
// main thread and is hydrated there by doc_id.
export type WorkerDoc = Pick<
  Document,
  'doc_id' | 'doc_type' | 'name' | 'title' | 'search_title' | 'search_body' | 'search_misc'
>;

export interface RegexHit {
  doc_id: number;
  // ±150-char window around the first body match, '' if the match was in title/misc only
  excerpt: string;
  // the matched text itself, '' if no body match
  snippet: string;
}
