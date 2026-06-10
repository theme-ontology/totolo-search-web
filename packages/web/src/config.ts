export const LATEST_JSON_URL: string =
  import.meta.env['VITE_LATEST_JSON_URL'] ?? '/latest.json';

export const CANDIDATE_K = 50;
export const FINAL_K = 20;
export const RERANK_TOP = 20;
export const DEBOUNCE_MS = 250;
export const MAX_QUERY_LENGTH = 300;
export const AUTO_SEARCH_MAX_CHARS = 20;
