export interface Document {
  doc_id: number;
  name: string;
  doc_type: 'theme' | 'story' | 'collection' | 'story-theme';
  aliases: string[];
  title: string;
  date: string;
  authors: string[];
  description: string;
  search_title: string;
  search_body: string;
  search_misc: string;
  theme_level?: string;
  parents?: string[];
}

export interface ScoredHit {
  doc_id: number;
  score: number;
  source: 'lexical' | 'semantic';
}

export interface SearchResult {
  doc_id: number;
  score: number;
  name: string;
  doc_type: 'theme' | 'story' | 'collection' | 'story-theme';
  title: string;
  date: string;
  description: string;
  snippet: string;
  lexical_score: number;
  semantic_score: number;
  theme_level?: string;
  parents?: string[];
}

export interface ParsedQuery {
  free_text: string;
  phrases: string[];
  required: string[];
  excluded: string[];
}

export interface Manifest {
  created: string;
  version_key: string;
  index_prefix: string;
  model_version: string;
  n_docs: number;
  dims: number;
  doc_ids: number[];
  hashes: Record<string, string>;
}
