import { stemmer } from 'stemmer';
import type { Options as MiniSearchOptions } from 'minisearch';
import type { Document } from './types.js';

export const FIELD_TITLE = 'search_title';
export const FIELD_BODY = 'search_body';
export const FIELD_MISC = 'search_misc';

export const BOOST_TITLE = 2.5;
export const BOOST_BODY = 1.0;
export const BOOST_MISC = 0.4;
export const BOOST_PHRASE = 2.0;

export function stem(word: string): string {
  return stemmer(word.toLowerCase());
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function getMiniSearchOptions(): MiniSearchOptions<Document> {
  return {
    fields: [FIELD_TITLE, FIELD_BODY, FIELD_MISC],
    idField: 'doc_id',
    tokenize: (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [],
    processTerm: (term: string) => {
      const s = stemmer(term);
      return s.length > 0 ? s : null;
    },
  };
}
