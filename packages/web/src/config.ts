export const LATEST_JSON_URL: string =
  import.meta.env['VITE_LATEST_JSON_URL'] ?? '/latest.json';

// Where the self-hosted models live. Decoupled from the app base on purpose: prod
// serves the app under a per-version path (/<branch>/<month>/) but shares one models/
// prefix across versions, so this must be settable independently. Defaults to
// "<base>/models/" for setups (dev, GitHub Pages) where models sit beside the app.
export const MODELS_URL: string =
  import.meta.env['VITE_MODELS_URL'] ?? `${import.meta.env.BASE_URL}models/`;

export const CANDIDATE_K = 50;
export const FINAL_K = 20;
export const RERANK_TOP = 20;
export const DEBOUNCE_MS = 250;
export const MAX_QUERY_LENGTH = 300;
export const AUTO_SEARCH_MAX_CHARS = 20;
