import { readFile } from 'node:fs/promises';
import { slugify } from '@totolo-search/core';
import type { Document } from '@totolo-search/core';

interface RawTheme {
  name: string;
  description?: string;
  aliases?: string[];
  examples?: string;
  notes?: string;
  parents?: string[];
}

interface RawStoryTheme {
  name: string;
  motivation?: string;
  level?: string;
  capacity?: string;
}

interface RawStory {
  name: string;
  title?: string;
  date?: string;
  authors?: string | string[];
  description?: string;
  aliases?: string[];
  examples?: string;
  notes?: string;
  themes?: RawStoryTheme[];
}

interface RawCorpus {
  themes?: RawTheme[];
  stories?: RawStory[];
  collections?: RawStory[];
}

function buildSearchTitle(
  name: string,
  aliases: string[],
  docType: Document['doc_type'],
  extra: { title?: string; date?: string; authors?: string | string[] },
): string {
  const parts = [name, ...aliases];
  if (docType !== 'theme') {
    if (extra.title) parts.push(extra.title);
    if (extra.date) parts.push(extra.date);
    const authors = typeof extra.authors === 'string' ? [extra.authors] : (extra.authors ?? []);
    if (authors.length) parts.push(authors.join(', '));
  }
  return parts.join('. ');
}

export async function loadCorpus(corpusPath: string): Promise<Document[]> {
  const raw = JSON.parse(await readFile(corpusPath, 'utf-8')) as RawCorpus;
  const docs: Document[] = [];
  let doc_id = 0;

  for (const t of raw.themes ?? []) {
    docs.push({
      doc_id: doc_id++,
      name: t.name,
      doc_type: 'theme',
      aliases: t.aliases ?? [],
      title: '',
      date: '',
      authors: [],
      description: t.description ?? '',
      search_title: buildSearchTitle(t.name, t.aliases ?? [], 'theme', {}),
      search_body: t.description ?? '',
      search_misc: [t.examples, t.notes].filter(Boolean).join(' '),
      parents: t.parents ?? [],
    });
  }

  for (const s of raw.stories ?? []) {
    docs.push({
      doc_id: doc_id++,
      name: s.name,
      doc_type: 'story',
      aliases: s.aliases ?? [],
      title: s.title ?? '',
      date: s.date ?? '',
      authors: typeof s.authors === 'string' ? [s.authors] : (s.authors ?? []),
      description: s.description ?? '',
      search_title: buildSearchTitle(s.name, s.aliases ?? [], 'story', s),
      search_body: s.description ?? '',
      search_misc: [s.examples, s.notes].filter(Boolean).join(' '),
    });
  }

  for (const c of raw.collections ?? []) {
    docs.push({
      doc_id: doc_id++,
      name: c.name,
      doc_type: 'collection',
      aliases: c.aliases ?? [],
      title: c.title ?? '',
      date: c.date ?? '',
      authors: typeof c.authors === 'string' ? [c.authors] : (c.authors ?? []),
      description: c.description ?? '',
      search_title: buildSearchTitle(c.name, c.aliases ?? [], 'collection', c),
      search_body: c.description ?? '',
      search_misc: [c.examples, c.notes].filter(Boolean).join(' '),
    });
  }

  // Assign page slugs to themes/stories/collections (annotations have no own page).
  // Globally unique across all types: collisions get a deterministic -2, -3… suffix.
  const usedSlugs = new Map<string, number>();
  for (const d of docs) {
    const base = slugify(d.name);
    const n = (usedSlugs.get(base) ?? 0) + 1;
    usedSlugs.set(base, n);
    d.slug = n === 1 ? base : `${base}-${n}`;
  }

  for (const s of [...(raw.stories ?? []), ...(raw.collections ?? [])]) {
    for (const th of s.themes ?? []) {
      if (!th.motivation) continue;
      docs.push({
        doc_id: doc_id++,
        name: s.name,
        doc_type: 'story-theme',
        aliases: [],
        title: th.name,
        date: '',
        authors: [],
        description: th.motivation,
        search_title: th.name + '. ' + s.name,
        search_body: th.motivation,
        search_misc: th.level ?? '',
        theme_level: th.level ?? '',
      });
    }
  }

  return docs;
}
