import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document } from '@totolo-search/core';

// Static detail pages for every theme, story, and collection — the local equivalent
// of themeontology.org's /theme/<name> and /story/<name> pages. Generated at build
// time from the raw corpus (which has full fidelity: references, capacity, component
// stories, …) and served as part of the site. Styling matches the search page.

interface RawAnnotation {
  name: string;
  motivation?: string;
  capacity?: string;
  level?: string;
  notes?: string;
}

interface RawTheme {
  name: string;
  description?: string;
  aliases?: string[];
  examples?: string;
  notes?: string;
  parents?: string[];
  references?: string[];
}

interface RawStory {
  name: string;
  title?: string;
  date?: string;
  authors?: string | string[];
  description?: string;
  references?: string[];
  'related stories'?: string[];
  'component stories'?: string[];
  themes?: RawAnnotation[];
}

interface RawCorpus {
  lto?: { version?: string; timestamp?: string };
  themes?: RawTheme[];
  stories?: RawStory[];
  collections?: RawStory[];
}

const LEVEL_RANK: Record<string, number> = { choice: 0, major: 1, minor: 2 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; font-size: 15px; background: #f8f9fa; color: #212529; min-height: 100vh; }
#app { max-width: 860px; margin: 0 auto; padding: 1.5rem 1rem; }
.site-header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.25rem; }
.site-header a.home { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.5px; color: #111; text-decoration: none; }
.site-header a.home:hover { text-decoration: underline; }
.site-header .ext { margin-left: auto; font-size: .78rem; color: #6c757d; }
.site-header .ext a { color: #6c757d; }
.card { background: #fff; border: 1px solid #dee2e6; border-radius: 6px; padding: 1.1rem 1.25rem; margin-bottom: .8rem; border-left: 3px solid transparent; }
.card.type-theme { border-left-color: #7048e8; }
.card.type-story { border-left-color: #0d6efd; }
.card.type-collection { border-left-color: #198754; }
h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.3px; margin-bottom: .2rem; }
h2 { font-size: .95rem; font-weight: 600; color: #343a40; margin: 1.1rem 0 .45rem; }
.doc-type { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #6c757d; padding: .12em .4em; background: #f1f3f5; border-radius: 3px; vertical-align: middle; }
.meta { font-size: .85rem; color: #6c757d; font-style: italic; margin-bottom: .6rem; }
.desc { font-size: .9rem; line-height: 1.55; color: #343a40; white-space: pre-line; }
a.theme-link { color: #7048e8; text-decoration: none; }
a.story-link { color: #0d6efd; text-decoration: none; }
a.theme-link:hover, a.story-link:hover { text-decoration: underline; }
ul.plain { list-style: none; }
ul.plain li { margin-bottom: .2rem; font-size: .85rem; }
/* table-layout:fixed skips the per-cell measurement pass that makes big tables
   (some theme pages have 1000+ rows) slow; content-visibility lets the browser skip
   layout/paint for offscreen rows so initial paint is fast regardless of row count. */
table { width: 100%; border-collapse: collapse; font-size: .85rem; table-layout: fixed; }
th { text-align: left; font-weight: 600; color: #495057; padding: .4rem .5rem; border-bottom: 2px solid #dee2e6; }
td { padding: .45rem .5rem; border-bottom: 1px solid #e9ecef; vertical-align: top; line-height: 1.45; overflow-wrap: break-word; }
th:first-child, td:first-child { width: 30%; }
th:nth-child(2), td:nth-child(2) { width: 5.5em; }
td.lvl { white-space: nowrap; color: #6c757d; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
tbody tr { content-visibility: auto; contain-intrinsic-size: auto 3.5rem; }
.cap { color: #868e96; font-size: .8rem; }
.refs a { font-size: .85rem; word-break: break-all; }
footer { margin-top: 1.5rem; font-size: .75rem; color: #adb5bd; }
footer a { color: #adb5bd; }
`.trim();

function pageShell(opts: {
  title: string;
  description: string;
  typeClass: string;
  externalUrl: string;
  body: string;
  version: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)} — Totolo</title>
<meta name="description" content="${esc(opts.description.slice(0, 160))}">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="stylesheet" href="../pages.css">
</head>
<body>
<div id="app">
<header class="site-header">
  <a class="home" href="../">Totolo Search</a>
  <span class="ext"><a href="${esc(opts.externalUrl)}" target="_blank" rel="noopener">view on themeontology.org</a></span>
</header>
<main>
<article class="card ${opts.typeClass}">
${opts.body}
</article>
</main>
<footer>Generated from the <a href="https://www.themeontology.org" target="_blank" rel="noopener">Theme Ontology</a>${opts.version ? ` (${esc(opts.version)})` : ''}.</footer>
</div>
</body>
</html>
`;
}

function refSection(references: string[] | undefined): string {
  const refs = (references ?? []).filter(Boolean);
  if (refs.length === 0) return '';
  const items = refs.map(r => `<li><a href="${esc(r)}" target="_blank" rel="noopener">${esc(r)}</a></li>`).join('\n');
  return `<h2>References</h2>\n<ul class="plain refs">\n${items}\n</ul>`;
}

function levelRank(level: string | undefined): number {
  return LEVEL_RANK[(level ?? '').toLowerCase()] ?? 3;
}

export async function writePages(rawPath: string, docs: Document[], outDir: string): Promise<number> {
  const raw = JSON.parse(await readFile(rawPath, 'utf-8')) as RawCorpus;
  const version = [raw.lto?.version, raw.lto?.timestamp?.slice(0, 10)].filter(Boolean).join(', ');

  // name → slug, per page kind. Themes live in theme/, stories AND collections in story/.
  const themeSlug = new Map<string, string>();
  const storySlug = new Map<string, string>();
  for (const d of docs) {
    if (!d.slug) continue;
    if (d.doc_type === 'theme') themeSlug.set(d.name, d.slug);
    else if (d.doc_type === 'story' || d.doc_type === 'collection') storySlug.set(d.name, d.slug);
  }

  const themeLink = (name: string): string => {
    const slug = themeSlug.get(name);
    return slug
      ? `<a class="theme-link" href="../theme/${slug}.html">${esc(name)}</a>`
      : esc(name);
  };
  const storyLink = (name: string): string => {
    const slug = storySlug.get(name);
    return slug
      ? `<a class="story-link" href="../story/${slug}.html">${esc(name)}</a>`
      : esc(name);
  };

  // Reverse maps for theme usage tables, children, and collection membership.
  const usagesByTheme = new Map<string, Array<{ story: string; level: string; motivation: string; capacity: string }>>();
  const allStories = [...(raw.stories ?? []), ...(raw.collections ?? [])];
  for (const s of allStories) {
    for (const a of s.themes ?? []) {
      let list = usagesByTheme.get(a.name);
      if (!list) { list = []; usagesByTheme.set(a.name, list); }
      list.push({ story: s.name, level: a.level ?? '', motivation: a.motivation ?? '', capacity: a.capacity ?? '' });
    }
  }
  const childrenByTheme = new Map<string, string[]>();
  for (const t of raw.themes ?? []) {
    for (const p of t.parents ?? []) {
      let list = childrenByTheme.get(p);
      if (!list) { list = []; childrenByTheme.set(p, list); }
      list.push(t.name);
    }
  }
  const collectionsByStory = new Map<string, string[]>();
  for (const c of raw.collections ?? []) {
    for (const member of c['component stories'] ?? []) {
      let list = collectionsByStory.get(member);
      if (!list) { list = []; collectionsByStory.set(member, list); }
      list.push(c.name);
    }
  }

  const themeOntologyUrl = (kind: 'theme' | 'story', name: string) =>
    `https://www.themeontology.org/${kind}/${encodeURIComponent(name)}`;

  await mkdir(join(outDir, 'theme'), { recursive: true });
  await mkdir(join(outDir, 'story'), { recursive: true });

  // Shared stylesheet: one cacheable object instead of inlining ~2 KB into every page.
  await writeFile(join(outDir, 'pages.css'), PAGE_CSS + '\n', 'utf-8');

  // Copy the app favicon next to the pages so "../favicon.svg" resolves in dev (where
  // pages are nested under /test-data/). In prod the same relative path already hits
  // the app's favicon at the deploy root, so this is just a harmless duplicate there.
  try {
    const faviconSrc = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/public/favicon.svg');
    await writeFile(join(outDir, 'favicon.svg'), await readFile(faviconSrc));
  } catch {
    // Favicon is non-critical; pages render fine without it.
  }

  const writes: Array<{ path: string; html: string }> = [];

  // ── Theme pages ─────────────────────────────────────────────────────────────
  for (const t of raw.themes ?? []) {
    const slug = themeSlug.get(t.name);
    if (!slug) continue;
    const parts: string[] = [];
    parts.push(`<h1>${esc(t.name)} <span class="doc-type">theme</span></h1>`);
    if (t.aliases && t.aliases.length > 0) {
      parts.push(`<p class="meta">also known as: ${t.aliases.map(esc).join(', ')}</p>`);
    }
    if (t.description) parts.push(`<p class="desc">${esc(t.description)}</p>`);
    if (t.notes) parts.push(`<h2>Notes</h2><p class="desc">${esc(t.notes)}</p>`);
    if (t.examples) parts.push(`<h2>Examples</h2><p class="desc">${esc(t.examples)}</p>`);
    parts.push(refSection(t.references));

    const parents = t.parents ?? [];
    if (parents.length > 0) {
      parts.push(`<h2>Parent themes</h2><ul class="plain">${parents.map(p => `<li>${themeLink(p)}</li>`).join('')}</ul>`);
    }
    const children = (childrenByTheme.get(t.name) ?? []).sort();
    if (children.length > 0) {
      parts.push(`<h2>Child themes (${children.length})</h2><ul class="plain">${children.map(c => `<li>${themeLink(c)}</li>`).join('')}</ul>`);
    }

    const usages = (usagesByTheme.get(t.name) ?? []).sort((a, b) =>
      levelRank(a.level) - levelRank(b.level) || a.story.localeCompare(b.story));
    if (usages.length > 0) {
      const rows = usages.map(u => `<tr>
<td>${storyLink(u.story)}</td>
<td class="lvl">${esc(u.level)}</td>
<td>${esc(u.motivation)}${u.capacity ? ` <span class="cap">[${esc(u.capacity)}]</span>` : ''}</td>
</tr>`).join('\n');
      parts.push(`<h2>Stories featuring this theme (${usages.length})</h2>
<table><thead><tr><th>Story</th><th>Level</th><th>Motivation</th></tr></thead><tbody>
${rows}
</tbody></table>`);
    }

    writes.push({
      path: join(outDir, 'theme', `${slug}.html`),
      html: pageShell({
        title: t.name,
        description: t.description ?? '',
        typeClass: 'type-theme',
        externalUrl: themeOntologyUrl('theme', t.name),
        body: parts.filter(Boolean).join('\n'),
        version,
      }),
    });
  }

  // ── Story / collection pages ────────────────────────────────────────────────
  const storyPage = (s: RawStory, isCollection: boolean) => {
    const slug = storySlug.get(s.name);
    if (!slug) return;
    const parts: string[] = [];
    parts.push(`<h1>${esc(s.title || s.name)} <span class="doc-type">${isCollection ? 'collection' : 'story'}</span></h1>`);
    const authors = typeof s.authors === 'string' ? s.authors : (s.authors ?? []).join(', ');
    const metaBits = [s.title && s.title !== s.name ? s.name : '', s.date ?? '', authors].filter(Boolean);
    if (metaBits.length > 0) parts.push(`<p class="meta">${metaBits.map(esc).join(' · ')}</p>`);
    if (s.description) parts.push(`<p class="desc">${esc(s.description)}</p>`);
    parts.push(refSection(s.references));

    const collections = (collectionsByStory.get(s.name) ?? []).sort();
    if (collections.length > 0) {
      parts.push(`<h2>Part of</h2><ul class="plain">${collections.map(c => `<li>${storyLink(c)}</li>`).join('')}</ul>`);
    }
    const components = (s['component stories'] ?? []).slice().sort();
    if (components.length > 0) {
      parts.push(`<h2>Component stories (${components.length})</h2><ul class="plain">${components.map(c => `<li>${storyLink(c)}</li>`).join('')}</ul>`);
    }
    const related = (s['related stories'] ?? []).filter(Boolean);
    if (related.length > 0) {
      parts.push(`<h2>Related stories</h2><ul class="plain">${related.map(r => `<li>${storyLink(r)}</li>`).join('')}</ul>`);
    }

    const annotations = (s.themes ?? []).slice().sort((a, b) =>
      levelRank(a.level) - levelRank(b.level) || a.name.localeCompare(b.name));
    if (annotations.length > 0) {
      const rows = annotations.map(a => `<tr>
<td>${themeLink(a.name)}</td>
<td class="lvl">${esc(a.level ?? '')}</td>
<td>${esc(a.motivation ?? '')}${a.capacity ? ` <span class="cap">[${esc(a.capacity)}]</span>` : ''}</td>
</tr>`).join('\n');
      parts.push(`<h2>Themes (${annotations.length})</h2>
<table><thead><tr><th>Theme</th><th>Level</th><th>Motivation</th></tr></thead><tbody>
${rows}
</tbody></table>`);
    }

    writes.push({
      path: join(outDir, 'story', `${slug}.html`),
      html: pageShell({
        title: s.title || s.name,
        description: s.description ?? '',
        typeClass: isCollection ? 'type-collection' : 'type-story',
        externalUrl: themeOntologyUrl('story', s.name),
        body: parts.filter(Boolean).join('\n'),
        version,
      }),
    });
  };

  for (const s of raw.stories ?? []) storyPage(s, false);
  for (const c of raw.collections ?? []) storyPage(c, true);

  // Write in batches to keep memory and fd usage sane.
  const BATCH = 200;
  for (let i = 0; i < writes.length; i += BATCH) {
    await Promise.all(writes.slice(i, i + BATCH).map(w => writeFile(w.path, w.html, 'utf-8')));
  }

  return writes.length;
}
