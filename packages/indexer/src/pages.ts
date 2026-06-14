import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Document } from '@totolo-search/core';

// Static site generated at build time, served alongside the search SPA:
//   /                front page (intro + stats baked from the corpus)
//   /theme/<slug>.html, /story/<slug>.html   detail pages (full-fidelity)
//   /versions/       list of available deployments (links rendered client-side)
//   /robots.txt      keep crawlers out of the versioned archives
// The search SPA lives at /search/. Styling matches the app (framework-free, responsive).

// Nav GitHub link points at the content repo (the ontology itself), not this app's repo.
const REPO_URL = 'https://github.com/theme-ontology/theming';

// The per-doc "view on themeontology.org" link is shown for dev/uat builds but omitted
// in production (where this site IS themeontology.org). Prod builds set HIDE_SOURCE_LINK=1.
const SHOW_SOURCE_LINK = process.env['HIDE_SOURCE_LINK'] !== '1';

// Base path the nav/CTA links resolve against. '' = site root (latest/main deploy and
// local dev). A per-release build sets SITE_BASE=/<tag> so a release's pages link within
// the release (e.g. /v2025.04/search/). Inter-doc links stay relative and need no base.
const SITE_BASE = (process.env['SITE_BASE'] ?? '').replace(/\/$/, '');

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

function words(s: string | undefined): number {
  return (s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; font-size: 15px; background: #f8f9fa; color: #212529; min-height: 100vh; }
a { color: #0d6efd; }

/* ── Top nav (shared, framework-free, responsive) ─────────────────────────── */
.nav { background: #fff; border-bottom: 1px solid #dee2e6; }
.nav-inner { max-width: 1140px; margin: 0 auto; padding: .55rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.nav-brand { display: flex; align-items: center; gap: .5rem; font-weight: 700; font-size: 1.05rem; letter-spacing: -.3px; color: #111; text-decoration: none; }
.nav-brand img { display: block; }
.nav-links { display: flex; align-items: center; gap: 1.25rem; margin-left: auto; }
.nav-links a { color: #495057; text-decoration: none; font-size: .9rem; font-weight: 500; }
.nav-links a:hover { color: #111; }
.nav-links a.active { color: #111; font-weight: 600; }
.nav-links .ext-mark { font-size: .8em; color: #adb5bd; }
/* Non-front nav: links span the bar so Search sits at the left and the rest go right. */
.nav-main { margin-left: 1.5rem; flex: 1; }
.nav-main .nav-versions { margin-left: auto; }
/* Search is the primary action: a prominent outlined pill (black on white). */
.nav-links a.nav-search { color: #212529; background: #fff; border: 1px solid #ced4da; font-weight: 600; padding: .3rem .9rem; border-radius: 6px; }
.nav-links a.nav-search:hover, .nav-links a.nav-search.active { color: #111; background: #f8f9fa; border-color: #868e96; }
.nav-toggle { display: none; }
.nav-burger { display: none; margin-left: auto; cursor: pointer; font-size: 1.4rem; line-height: 1; color: #495057; user-select: none; padding: .1rem .3rem; }
@media (max-width: 640px) {
  .nav-burger { display: inline-flex; }
  .nav-links { display: none; width: 100%; flex-direction: column; align-items: flex-start; gap: .6rem; margin: .4rem 0 .2rem; }
  .nav-toggle:checked ~ .nav-links { display: flex; }
  /* Open burger menu: a plain, full-width, left-aligned column flush under the brand
     (title + icon). Reset every desktop horizontal-bar spacing rule, and drop the Search
     "pill" so all items read as plain left-aligned links. */
  .nav-inner { align-items: flex-start; }
  .nav-main { margin: 0; flex: none; }
  .nav-main .nav-versions { margin-left: 0; }
  .nav-links a { margin: 0; width: 100%; padding: .35rem 0; }
  .nav-links a.nav-search { background: none; border: 0; border-radius: 0; padding: .35rem 0; color: #495057; font-weight: 500; }
  .nav-links a.nav-search.active { color: #111; }
}

.wrap { max-width: 1140px; margin: 0 auto; padding: 1.5rem 1rem; }
footer { margin-top: 1.5rem; font-size: .75rem; color: #adb5bd; }
footer a { color: #adb5bd; }

/* ── Front page ───────────────────────────────────────────────────────────── */
.hero-title { display: flex; align-items: center; gap: .7rem; margin-bottom: .5rem; }
.hero-logo { width: 52px; height: 52px; flex-shrink: 0; }
.hero h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.6px; color: #111; margin-bottom: .5rem; }
.hero-title h1 { margin-bottom: 0; }
.hero .lede { font-size: 1.1rem; line-height: 1.5; color: #495057; margin-bottom: 1.1rem; }
.cta { display: inline-block; background: #495057; color: #fff; text-decoration: none; font-weight: 600; font-size: .95rem; padding: .6rem 1.2rem; border-radius: 6px; }
.cta:hover { background: #343a40; }
/* Main content (hero + about) with the stats in a narrow sidebar floating beside it,
   from the very top. On mobile it stacks (content, then a compact 2x2 of stats). */
.front-grid { display: grid; gap: 1.5rem 1.75rem; grid-template-columns: 1fr; align-items: start; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; }
.stat { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; padding: .8rem .9rem; }
.stat .num { display: block; font-size: 1.5rem; font-weight: 700; color: #111; letter-spacing: -.5px; }
.stat .lbl { font-size: .78rem; color: #6c757d; text-transform: uppercase; letter-spacing: .04em; }
.about { max-width: 680px; margin-top: 1.5rem; }
.about p { line-height: 1.6; color: #343a40; margin-bottom: .9rem; }
.figures { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .4rem .9rem; margin: 0 0 .9rem; }
.figures li { font-size: .9rem; color: #495057; padding-left: 1rem; position: relative; }
.figures li::before { content: "\\00B7"; position: absolute; left: .15rem; color: #adb5bd; }
@media (min-width: 760px) {
  .front-grid { grid-template-columns: minmax(0, 1fr) 190px; }
  .stats { grid-template-columns: 1fr; }
}

/* ── Versions page ────────────────────────────────────────────────────────── */
.versions-list { max-width: 720px; }
.version-branch { font-size: 1rem; font-weight: 600; margin: 1.1rem 0 .5rem; }
.version-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: .75rem; padding: .5rem .25rem; border-bottom: 1px solid #e9ecef; font-size: .9rem; }
.version-row .date { font-weight: 600; min-width: 6em; }
.version-row .badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; padding: .1em .45em; border-radius: 3px; }
.version-row .badge.current { background: #e7f5ff; color: #1971c2; }   /* the version you're viewing */
.version-row .badge.latest { background: #ebfbee; color: #2f9e44; }    /* newest under its heading */
.version-row .muted { color: #868e96; font-size: .82rem; }
/* Per-release dataset downloads (themes/stories/collections JSON on data.themeontology.org). */
.version-row .downloads { margin-left: auto; display: inline-flex; flex-wrap: wrap; gap: .65rem; }
.version-row .dl { font-size: .8rem; color: #1971c2; text-decoration: none; white-space: nowrap; }
.version-row .dl::before { content: "\\2193\\00a0"; color: #adb5bd; }
.version-row .dl:hover { text-decoration: underline; }

/* ── Detail (theme / story / collection) pages ────────────────────────────── */
/* --doc-accent carries the per-type colour so it can be the left accent on wide
   screens and a top bar on narrow ones (see the max-width:640px block). */
.doc { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; --doc-accent: transparent; border-left: 3px solid var(--doc-accent); padding: 1.25rem 1.4rem; }
.doc.type-theme { --doc-accent: #7048e8; }
.doc.type-story { --doc-accent: #0d6efd; }
.doc.type-collection { --doc-accent: #198754; }
/* Secondary metadata floats in a sidebar beside the whole content (head + table),
   from the top. Stacks to a single column on narrow screens. */
.doc-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem 1.75rem; align-items: start; }
.doc-head { padding-bottom: 1rem; border-bottom: 1px solid #eef0f2; }
.doc-head h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.3px; margin-bottom: .25rem; }
.ancestors { font-size: .85rem; line-height: 1.75; color: #495057; }
.ancestors strong { font-weight: 700; }
.lvl-sep { color: #495057; font-weight: 700; }
.doc-type { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #6c757d; padding: .12em .4em; background: #f1f3f5; border-radius: 3px; vertical-align: middle; }
.meta { font-size: .85rem; color: #6c757d; font-style: italic; margin-bottom: .7rem; }
.desc { font-size: .95rem; line-height: 1.6; color: #343a40; white-space: pre-line; max-width: 68ch; }
/* Source link: discreet, outside the card, gray on the gray page background. Pulled up into
   the wrap's top padding so showing it doesn't add a second block of whitespace above. */
.doc-source { text-align: right; margin: -.6rem 0 .15rem; line-height: 1.2; }
.ext-link { font-size: .78rem; color: #adb5bd; text-decoration: none; }
.ext-link:hover { color: #6c757d; text-decoration: underline; }
h2 { font-size: .9rem; font-weight: 600; color: #343a40; margin: 1.1rem 0 .4rem; }
.lvl-summary { font-weight: 400; color: #868e96; font-size: .8rem; margin-left: .25rem; }
/* Stand-alone light-grey summary above a table (the table's column headers already name it,
   so no bold section heading is needed). */
.tbl-summary { color: #868e96; font-size: .8rem; margin: 1.1rem 0 .4rem; }
a.theme-link { color: #7048e8; text-decoration: none; }
a.story-link { color: #0d6efd; text-decoration: none; }
a.theme-link:hover, a.story-link:hover { text-decoration: underline; }
.inline-list { font-size: .85rem; line-height: 1.7; color: #495057; }
ul.plain { list-style: none; }
ul.plain li { margin-bottom: .2rem; font-size: .85rem; }
.refs a { font-size: .85rem; word-break: break-all; }
.cap { color: #868e96; font-size: .8rem; }
.doc-aside h2:first-child { margin-top: 0; }
@media (min-width: 900px) {
  .doc-grid { grid-template-columns: minmax(0, 1fr) 280px; }
  .doc-aside { border-left: 1px solid #eef0f2; padding-left: 1.5rem; }
}
/* Narrow screens (phones): drop the card chrome (border, radius, inner padding,
   white fill) so the content runs nearly edge-to-edge on the page background
   instead of in a boxed, double-padded column. The type is still signalled by the
   .doc-type badge + heading, so the coloured left accent isn't needed here. */
@media (max-width: 640px) {
  .wrap { padding: 1rem .8rem; }
  /* Flat, edge-to-edge — but keep the doc-type cue as a thin coloured bar on top. */
  .doc { background: transparent; border: none; border-radius: 0; border-top: 3px solid var(--doc-accent); padding: .6rem 0 0; }
  .doc-head { padding-bottom: .75rem; }
  .doc-grid { gap: 1rem; }
  th, td { padding-left: .35rem; padding-right: .35rem; }
  th:first-child, td:first-child { width: 34%; }
}

/* table-layout:fixed skips the per-cell measurement pass that makes big tables
   (some theme pages have 1000+ rows) slow; content-visibility lets the browser skip
   layout/paint for offscreen rows so initial paint is fast regardless of row count. */
table { width: 100%; border-collapse: collapse; font-size: .85rem; table-layout: fixed; }
th { text-align: left; font-weight: 600; color: #495057; padding: .4rem .5rem; border-bottom: 2px solid #dee2e6; }
td { padding: .45rem .5rem; border-bottom: 1px solid #e9ecef; vertical-align: top; line-height: 1.45; overflow-wrap: break-word; }
th:first-child, td:first-child { width: 28%; }
th:nth-child(2), td:nth-child(2) { width: 5.5em; }
td.lvl { white-space: nowrap; color: #6c757d; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
tbody tr { content-visibility: auto; contain-intrinsic-size: auto 3.5rem; }
.expand-btn { margin-top: .65rem; font-size: .82rem; font-weight: 600; color: #495057; background: #f1f3f5; border: 1px solid #dee2e6; border-radius: 6px; padding: .35rem .9rem; cursor: pointer; }
.expand-btn:hover:not(:disabled) { background: #e9ecef; }
.expand-btn:disabled { opacity: .6; cursor: wait; }
/* Component-stories table is 2 columns (Story | Date), not the 3-col level tables. */
table.cols2 th:first-child, table.cols2 td:first-child { width: auto; }
table.cols2 th:nth-child(2), table.cols2 td:nth-child(2) { width: 7em; }
`.trim();

// Shared, cacheable script for the doc pages: clicking "Show all" fetches the table's
// overflow rows (pre-rendered HTML) from the sibling <slug>.json and appends them.
const PAGES_JS = `
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('.expand-btn') : null;
  if (!btn) return;
  var tbody = document.getElementById(btn.getAttribute('data-target'));
  if (!tbody) return;
  var key = btn.getAttribute('data-key');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  fetch(btn.getAttribute('data-src'))
    .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
    .then(function (data) {
      tbody.insertAdjacentHTML('beforeend', (data && data[key]) || '');
      if (btn.parentNode) btn.parentNode.removeChild(btn);
    })
    .catch(function () { btn.disabled = false; btn.textContent = 'Failed \\u2014 click to retry'; });
});
`.trim();

function navBar(active: 'search' | 'versions' | '', assetPrefix: string, showBrand = true): string {
  const github = `<a href="${REPO_URL}" target="_blank" rel="noopener">GitHub <span class="ext-mark" aria-hidden="true">&#8599;</span></a>`;
  const burger = `<input type="checkbox" id="nav-toggle" class="nav-toggle">
    <label for="nav-toggle" class="nav-burger" aria-label="Menu">&#9776;</label>`;

  // Front page: no brand (the hero carries it), plain links to the right.
  if (!showBrand) {
    return `<header class="nav">
  <div class="nav-inner">
    ${burger}
    <nav class="nav-links">
      <a href="${SITE_BASE}/search/">Search</a>
      <a href="${SITE_BASE}/versions/">Versions</a>
      ${github}
    </nav>
  </div>
</header>`;
  }

  // Elsewhere: Search is the prominent left item (filled pill); Versions/GitHub right.
  const aS = active === 'search' ? ' active' : '';
  const aV = active === 'versions' ? ' active' : '';
  return `<header class="nav">
  <div class="nav-inner">
    <a class="nav-brand" href="${SITE_BASE}/"><img src="${assetPrefix}favicon.svg" alt="" width="26" height="26"><span>Theme Ontology</span></a>
    ${burger}
    <nav class="nav-links nav-main">
      <a class="nav-search${aS}" href="${SITE_BASE}/search/">Search</a>
      <a class="nav-versions${aV}" href="${SITE_BASE}/versions/">Versions</a>
      ${github}
    </nav>
  </div>
</header>`;
}

function htmlDoc(opts: {
  title: string;
  description: string;
  depth: number; // 0 = root (/index.html), 1 = /theme/, /story/, /versions/
  active: 'search' | 'versions' | '';
  brand?: boolean; // show the logo + name in the nav (false on the front page)
  bodyClass?: string;
  extraHead?: string;
  body: string;
  version: string;
}): string {
  const p = '../'.repeat(opts.depth);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description.slice(0, 160))}">
<link rel="icon" type="image/svg+xml" href="${p}favicon.svg">
<link rel="stylesheet" href="${p}pages.css">
${opts.extraHead ?? ''}</head>
<body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ''}>
${navBar(opts.active, p, opts.brand !== false)}
<div class="wrap">
${opts.body}
<footer>Generated from the <a href="https://www.themeontology.org" target="_blank" rel="noopener">Theme Ontology</a>${opts.version ? ` (${esc(opts.version)})` : ''}.</footer>
</div>
<script src="${p}pages.js" defer></script>
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

// Rows beyond this count are moved out of the HTML into a sibling <slug>.json and
// fetched on demand, so the initial page stays small and paints fast.
const TABLE_LIMIT = 10;

// Builds a table section: first TABLE_LIMIT rows inline + a "Show all N" button when
// there are more. Returns the section HTML and the overflow rows' HTML (for the JSON).
function tableSection(
  id: string,
  headingHtml: string,
  headers: string[],
  rows: string[],
  jsonName: string,
  key: string,
  tableClass = '',
): { html: string; overflow: string | null } {
  const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  const inline = rows.slice(0, TABLE_LIMIT).join('\n');
  const overflow = rows.length > TABLE_LIMIT ? rows.slice(TABLE_LIMIT).join('\n') : null;
  const btn = overflow
    ? `\n<button class="expand-btn" data-src="${jsonName}" data-key="${key}" data-target="${id}">Show all ${rows.length}</button>`
    : '';
  const cls = tableClass ? ` class="${tableClass}"` : '';
  const html = `<section class="doc-main">${headingHtml}
<table${cls}>${thead}<tbody id="${id}">
${inline}
</tbody></table>${btn}</section>`;
  return { html, overflow };
}

// Terse "N total · a choice · b major · c minor" summary (omits zero levels).
function levelSummary(levels: Array<string | undefined>): string {
  let choice = 0;
  let major = 0;
  let minor = 0;
  for (const l of levels) {
    const k = (l ?? '').toLowerCase();
    if (k === 'choice') choice++;
    else if (k === 'major') major++;
    else if (k === 'minor') minor++;
  }
  const parts = [`${levels.length} total`];
  if (choice) parts.push(`${choice} choice`);
  if (major) parts.push(`${major} major`);
  if (minor) parts.push(`${minor} minor`);
  return parts.join(' · ');
}

function nf(n: number): string {
  return n.toLocaleString('en-US');
}

function frontPage(raw: RawCorpus, version: string): string {
  const themes = raw.themes ?? [];
  const stories = raw.stories ?? [];
  const collections = raw.collections ?? [];

  let annotationCount = 0;
  const motivationLengths: number[] = [];
  let storiesWithThemes = 0;
  let storyThemeTotal = 0;
  for (const s of [...stories, ...collections]) {
    const anns = (s.themes ?? []).filter(a => a.motivation);
    annotationCount += anns.length;
    for (const a of anns) motivationLengths.push(words(a.motivation));
  }
  for (const s of stories) {
    const n = (s.themes ?? []).filter(a => a.motivation).length;
    if (n > 0) { storiesWithThemes++; storyThemeTotal += n; }
  }
  const avgThemeWords = themes.length
    ? Math.round(themes.reduce((s, t) => s + words(t.description), 0) / themes.length) : 0;
  const avgThemesPerStory = storiesWithThemes ? Math.round(storyThemeTotal / storiesWithThemes) : 0;
  const avgMotivation = motivationLengths.length
    ? Math.round(motivationLengths.reduce((a, b) => a + b, 0) / motivationLengths.length) : 0;
  const sorted = motivationLengths.slice().sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;

  const lede = `Contains ${nf(themes.length)} well-defined literary themes arranged in a hierarchy, annotated across ${nf(stories.length)} stories.`;
  const body = `<div class="front-grid">
  <div class="front-main">
    <section class="hero">
      <div class="hero-title"><img class="hero-logo" src="favicon.svg" alt="" width="52" height="52"><h1>Theme Ontology</h1></div>
      <p class="lede">${lede}</p>
      <p><a class="cta" href="${SITE_BASE}/search/">Search the ontology &rarr;</a></p>
    </section>
    <div class="about">
      <p>The themes are arranged in a hierarchy: a tree-like graph, a directed acyclic graph, a taxonomy, but with extra features that make it an ontology. Each theme definition establishes the necessary and sufficient conditions for when that theme is present in a story.</p>
      <p>Every story-theme association is weighted as <em>minor</em>, <em>major</em>, or <em>choice</em>, and comes with an explanation, the <em>motivation</em>, describing how the theme manifests in that story.</p>
      <ul class="figures">
        <li>~${avgThemeWords} words per theme definition</li>
        <li>~${avgThemesPerStory} themes per annotated story</li>
        <li>~${avgMotivation} words per motivation</li>
        <li>longest 10% of motivations: ${p90}+ words</li>
      </ul>
      <p>The underlying data is open and maintained on <a href="https://github.com/theme-ontology/theming" target="_blank" rel="noopener">GitHub</a>. A Python package <a href="https://pypi.org/project/totolo/" target="_blank" rel="noopener">totolo</a> or an R package <a href="https://cran.r-project.org/package=stoRy" target="_blank" rel="noopener">stoRy</a> can download and analyse it.</p>
    </div>
  </div>
  <aside class="stats">
    <div class="stat"><span class="num">${nf(themes.length)}</span><span class="lbl">themes</span></div>
    <div class="stat"><span class="num">${nf(stories.length)}</span><span class="lbl">stories</span></div>
    <div class="stat"><span class="num">${nf(collections.length)}</span><span class="lbl">collections</span></div>
    <div class="stat"><span class="num">${nf(annotationCount)}</span><span class="lbl">annotations</span></div>
  </aside>
</div>`;

  return htmlDoc({
    title: 'Theme Ontology',
    description: lede,
    depth: 0,
    active: '',
    brand: false,
    body,
    version,
  });
}

function versionsPage(version: string): string {
  // Links to past versions are rendered client-side from /versions.json so that
  // naive crawlers (which don't execute JS) never follow them into the archives.
  const body = `<h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-.3px;margin-bottom:.4rem;">Versions</h1>
<p style="color:#495057;line-height:1.55;max-width:680px;margin-bottom:.5rem;">The latest build is always served here at the site root. Past monthly snapshots are listed below for reference.</p>
<div id="versions-list" class="versions-list"><p class="muted" style="color:#868e96;">Loading…</p></div>
<script>
(function () {
  var el = document.getElementById('versions-list');
  fetch('/versions.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var versions = (data && data.versions) || [];
      if (!versions.length) { el.innerHTML = '<p class="muted" style="color:#868e96;">No version history available.</p>'; return; }
      // The version this page itself belongs to (root '/', '/vX/', '/<branch>/'): used to mark
      // the row the reader is currently on as "current".
      var pn = location.pathname, vi = pn.lastIndexOf('versions');
      var here = (vi > 0 ? pn.slice(0, vi) : '/') || '/';
      var hasPathMatch = versions.some(function (v) { return v.path === here; });
      var isCurrent = function (v) {
        // Prefer an exact path match; at the root (where releases live under /vX/) fall back to
        // the manifest's current flag (the version mirrored to the site root).
        return hasPathMatch ? v.path === here : (here === '/' && !!v.current);
      };
      // Full build date (YYYY-MM-DD, no time) for every entry.
      var ymd = function (v) { return v.built ? new Date(v.built).toISOString().slice(0, 10) : (v.date || ''); };
      var badges = function (v, latest) {
        return (isCurrent(v) ? '<span class="badge current">current</span>' : '')
          + (latest ? '<span class="badge latest">latest</span>' : '');
      };
      var link = function (href, text) { var a = document.createElement('a'); a.href = href; a.textContent = text; return a.outerHTML; };
      // Each version hosts its own dataset files at <path>{themes,stories,collections}.json;
      // the download attribute names the saved file lto-<version>-<type>.json (as on /data).
      var dl = function (v, type) {
        var b = v.path || '/';
        var id = v.tag || v.branch || 'lto';
        return '<a class="dl" href="' + b + type + '.json" download="lto-' + id + '-' + type + '.json">' + type + '</a>';
      };
      var downloads = function (v) {
        return '<span class="downloads">' + dl(v, 'themes') + dl(v, 'stories') + dl(v, 'collections') + '</span>';
      };
      // Branch rows are labelled by their build date; release rows by tag, with the build date alongside.
      var row = function (v, label, latest, showDate) {
        return '<div class="version-row"><span class="date">' + link(v.path || '#', label) + '</span>'
          + (showDate ? '<span class="muted">' + ymd(v) + '</span>' : '')
          + badges(v, latest) + downloads(v) + '</div>';
      };
      var releases = [], byBranch = {};
      versions.forEach(function (v) { if (v.release) releases.push(v); else (byBranch[v.branch] = byBranch[v.branch] || []).push(v); });
      var html = '';
      Object.keys(byBranch).sort().forEach(function (branch) {
        html += '<div class="version-branch">' + branch + '</div>';
        byBranch[branch].sort(function (a, b) { return (b.built || '').localeCompare(a.built || ''); })
          .forEach(function (v, i) { html += row(v, ymd(v), i === 0, false); });
      });
      if (releases.length) {
        html += '<div class="version-branch">releases</div>';
        releases.sort(function (a, b) { return (b.tag || '').localeCompare(a.tag || ''); })
          .forEach(function (v, i) { html += row(v, v.tag || 'unknown', i === 0, true); });
      }
      el.innerHTML = html;
    })
    .catch(function () { el.innerHTML = '<p class="muted" style="color:#868e96;">Could not load version history.</p>'; });
})();
</script>`;

  return htmlDoc({
    title: 'Versions · Theme Ontology',
    description: 'Available deployment versions.',
    depth: 1,
    active: 'versions',
    extraHead: '<meta name="robots" content="noindex">\n',
    body,
    version,
  });
}

export async function writePages(rawPath: string, docs: Document[], outDir: string): Promise<number> {
  const raw = JSON.parse(await readFile(rawPath, 'utf-8')) as RawCorpus;
  const version = [raw.lto?.version, raw.lto?.timestamp?.slice(0, 10)].filter(Boolean).join(', ');

  const themeSlug = new Map<string, string>();
  const storySlug = new Map<string, string>();
  for (const d of docs) {
    if (!d.slug) continue;
    if (d.doc_type === 'theme') themeSlug.set(d.name, d.slug);
    else if (d.doc_type === 'story' || d.doc_type === 'collection') storySlug.set(d.name, d.slug);
  }

  // Detail pages live in /theme/ and /story/, so links between them are "../theme/…"
  // (relative — portable whether served at the site root or under a snapshot prefix).
  const themeLink = (name: string): string => {
    const slug = themeSlug.get(name);
    return slug ? `<a class="theme-link" href="../theme/${slug}.html">${esc(name)}</a>` : esc(name);
  };
  const storyLink = (name: string): string => {
    const slug = storySlug.get(name);
    return slug ? `<a class="story-link" href="../story/${slug}.html">${esc(name)}</a>` : esc(name);
  };

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
  const parentsByTheme = new Map<string, string[]>();
  for (const t of raw.themes ?? []) {
    parentsByTheme.set(t.name, t.parents ?? []);
    for (const p of t.parents ?? []) {
      let list = childrenByTheme.get(p);
      if (!list) { list = []; childrenByTheme.set(p, list); }
      list.push(t.name);
    }
  }
  // Ancestor themes grouped into topological levels by longest path from the theme
  // (level 1 = direct parents). Longest-path layering keeps the order topological even
  // when a theme has several parents and ancestors are reachable by multiple routes.
  const ancestorLevels = (name: string): string[][] => {
    const level = new Map<string, number>();
    const visit = (n: string, depth: number) => {
      if (depth > 50) return; // guard against cycles / pathological depth
      for (const p of parentsByTheme.get(n) ?? []) {
        const nl = depth + 1;
        if (nl > (level.get(p) ?? 0)) { level.set(p, nl); visit(p, nl); }
      }
    };
    visit(name, 0);
    const byLevel = new Map<number, string[]>();
    let maxL = 0;
    for (const [n, l] of level) {
      const arr = byLevel.get(l);
      if (arr) arr.push(n); else byLevel.set(l, [n]);
      if (l > maxL) maxL = l;
    }
    const out: string[][] = [];
    for (let l = 1; l <= maxL; l++) out.push((byLevel.get(l) ?? []).slice().sort((a, b) => a.localeCompare(b)));
    return out;
  };
  const collectionsByStory = new Map<string, string[]>();
  for (const c of raw.collections ?? []) {
    for (const member of c['component stories'] ?? []) {
      let list = collectionsByStory.get(member);
      if (!list) { list = []; collectionsByStory.set(member, list); }
      list.push(c.name);
    }
  }
  const storyDate = new Map<string, string>();
  for (const s of allStories) storyDate.set(s.name, s.date ?? '');

  const themeOntologyUrl = (kind: 'theme' | 'story', name: string) =>
    `https://www.themeontology.org/${kind}/${encodeURIComponent(name)}`;

  // Discreet source link, placed outside the card on the page background (omitted in prod).
  const sourceLine = (kind: 'theme' | 'story', name: string) => SHOW_SOURCE_LINK
    ? `<div class="doc-source"><a class="ext-link" href="${themeOntologyUrl(kind, name)}" target="_blank" rel="noopener">view on themeontology.org &#8599;</a></div>`
    : '';
  // A labelled list of links rendered inline (comma-separated) rather than one per line.
  const inlineList = (label: string, items: string[]) =>
    items.length ? `<h2>${label}</h2><p class="inline-list">${items.join(', ')}</p>` : '';

  await mkdir(join(outDir, 'theme'), { recursive: true });
  await mkdir(join(outDir, 'story'), { recursive: true });
  await mkdir(join(outDir, 'versions'), { recursive: true });

  await writeFile(join(outDir, 'pages.css'), PAGE_CSS + '\n', 'utf-8');
  await writeFile(join(outDir, 'pages.js'), PAGES_JS + '\n', 'utf-8');
  await writeFile(join(outDir, 'index.html'), frontPage(raw, version), 'utf-8');
  await writeFile(join(outDir, 'versions', 'index.html'), versionsPage(version), 'utf-8');
  await writeFile(join(outDir, 'robots.txt'),
    'User-agent: *\nDisallow: /master/\nDisallow: /versions/\n', 'utf-8');

  // Per-version dataset files ({lto, <type>} shape, as on themeontology.org/data), hosted
  // alongside this version's pages so any row on the versions page can offer downloads --
  // not just releases. Each published version (root, /<tag>/, /<branch>/) carries its own.
  await writeFile(join(outDir, 'themes.json'), JSON.stringify({ lto: raw.lto, themes: raw.themes ?? [] }), 'utf-8');
  await writeFile(join(outDir, 'stories.json'), JSON.stringify({ lto: raw.lto, stories: raw.stories ?? [] }), 'utf-8');
  await writeFile(join(outDir, 'collections.json'), JSON.stringify({ lto: raw.lto, collections: raw.collections ?? [] }), 'utf-8');

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

    const headParts: string[] = [`<h1>${esc(t.name)} <span class="doc-type">theme</span></h1>`];
    if (t.aliases && t.aliases.length > 0) headParts.push(`<p class="meta">also known as: ${t.aliases.map(esc).join(', ')}</p>`);
    if (t.description) headParts.push(`<p class="desc">${esc(t.description)}</p>`);

    // Main column: header + prose (notes/examples) + the big usage table.
    const content: string[] = [`<header class="doc-head">${headParts.join('\n')}</header>`];
    if (t.notes) content.push(`<h2>Notes</h2><p class="desc">${esc(t.notes)}</p>`);
    if (t.examples) content.push(`<h2>Examples</h2><p class="desc">${esc(t.examples)}</p>`);

    const overflow: Record<string, string> = {};
    const usages = (usagesByTheme.get(t.name) ?? []).sort((a, b) =>
      levelRank(a.level) - levelRank(b.level) || a.story.localeCompare(b.story));
    if (usages.length > 0) {
      const rows = usages.map(u => `<tr>
<td>${storyLink(u.story)}</td>
<td class="lvl">${esc(u.level)}</td>
<td>${esc(u.motivation)}${u.capacity ? ` <span class="cap">[${esc(u.capacity)}]</span>` : ''}</td>
</tr>`);
      const heading = `<p class="tbl-summary">${levelSummary(usages.map(u => u.level))}</p>`;
      const tbl = tableSection('tbl-stories', heading, ['Story', 'Level', 'Motivation'], rows, `${slug}.json`, 'stories');
      content.push(tbl.html);
      if (tbl.overflow) overflow['stories'] = tbl.overflow;
    }

    // Sidebar: ancestors (direct parents bold, then ancestors by topological level),
    // child themes, and references.
    const directParents = new Set(t.parents ?? []);
    const levels = ancestorLevels(t.name).filter(lvl => lvl.length > 0);
    let ancestorsHtml = '';
    if (levels.length > 0) {
      const parts = levels.map(lvl =>
        lvl.map(n => (directParents.has(n) ? `<strong>${themeLink(n)}</strong>` : themeLink(n))).join(', '),
      );
      ancestorsHtml = `<h2>Ancestors</h2><p class="ancestors">${parts.join(' <span class="lvl-sep">&rsaquo;</span> ')}</p>`;
    }
    const children = (childrenByTheme.get(t.name) ?? []).sort();
    const aside: string[] = [
      ancestorsHtml,
      inlineList(`Child themes (${children.length})`, children.map(themeLink)),
      refSection(t.references),
    ];

    writes.push({
      path: join(outDir, 'theme', `${slug}.html`),
      html: htmlDoc({
        title: `${t.name} · Theme Ontology`,
        description: t.description ?? '',
        depth: 1,
        active: '',
        body: `${sourceLine('theme', t.name)}<article class="doc type-theme">
<div class="doc-grid">
<div class="doc-content">${content.filter(Boolean).join('\n')}</div>
<aside class="doc-aside">${aside.filter(Boolean).join('\n') || '&nbsp;'}</aside>
</div>
</article>`,
        version,
      }),
    });
    if (Object.keys(overflow).length) {
      writes.push({ path: join(outDir, 'theme', `${slug}.json`), html: JSON.stringify(overflow) });
    }
  }

  // ── Story / collection pages ────────────────────────────────────────────────
  const storyPage = (s: RawStory, isCollection: boolean) => {
    const slug = storySlug.get(s.name);
    if (!slug) return;

    const kind = isCollection ? 'collection' : 'story';
    const headParts = [`<h1>${esc(s.title || s.name)} <span class="doc-type">${kind}</span></h1>`];
    const authors = typeof s.authors === 'string' ? s.authors : (s.authors ?? []).join(', ');
    const metaBits = [s.title && s.title !== s.name ? s.name : '', s.date ?? '', authors].filter(Boolean);
    if (metaBits.length > 0) headParts.push(`<p class="meta">${metaBits.map(esc).join(' · ')}</p>`);
    if (s.description) headParts.push(`<p class="desc">${esc(s.description)}</p>`);

    const content: string[] = [`<header class="doc-head">${headParts.join('\n')}</header>`];
    const overflow: Record<string, string> = {};

    const annotations = (s.themes ?? []).slice().sort((a, b) =>
      levelRank(a.level) - levelRank(b.level) || a.name.localeCompare(b.name));
    if (annotations.length > 0) {
      const rows = annotations.map(a => `<tr>
<td>${themeLink(a.name)}</td>
<td class="lvl">${esc(a.level ?? '')}</td>
<td>${esc(a.motivation ?? '')}${a.capacity ? ` <span class="cap">[${esc(a.capacity)}]</span>` : ''}</td>
</tr>`);
      const heading = `<p class="tbl-summary">${levelSummary(annotations.map(a => a.level))}</p>`;
      const tbl = tableSection('tbl-themes', heading, ['Theme', 'Level', 'Motivation'], rows, `${slug}.json`, 'themes');
      content.push(tbl.html);
      if (tbl.overflow) overflow['themes'] = tbl.overflow;
    }

    const components = (s['component stories'] ?? []).slice().sort();
    if (components.length > 0) {
      const rows = components.map(name => `<tr><td>${storyLink(name)}</td><td class="lvl">${esc(storyDate.get(name) ?? '')}</td></tr>`);
      const heading = `<p class="tbl-summary">${components.length} component stories</p>`;
      const tbl = tableSection('tbl-components', heading, ['Story', 'Date'], rows, `${slug}.json`, 'components', 'cols2');
      content.push(tbl.html);
      if (tbl.overflow) overflow['components'] = tbl.overflow;
    }

    const collections = (collectionsByStory.get(s.name) ?? []).sort();
    const related = (s['related stories'] ?? []).filter(Boolean);
    const aside: string[] = [
      inlineList('Part of', collections.map(storyLink)),
      inlineList('Related stories', related.map(storyLink)),
      refSection(s.references),
    ];

    writes.push({
      path: join(outDir, 'story', `${slug}.html`),
      html: htmlDoc({
        title: `${s.title || s.name} · Theme Ontology`,
        description: s.description ?? '',
        depth: 1,
        active: '',
        body: `${sourceLine('story', s.name)}<article class="doc ${isCollection ? 'type-collection' : 'type-story'}">
<div class="doc-grid">
<div class="doc-content">${content.filter(Boolean).join('\n')}</div>
<aside class="doc-aside">${aside.filter(Boolean).join('\n') || '&nbsp;'}</aside>
</div>
</article>`,
        version,
      }),
    });
    if (Object.keys(overflow).length) {
      writes.push({ path: join(outDir, 'story', `${slug}.json`), html: JSON.stringify(overflow) });
    }
  };

  for (const s of raw.stories ?? []) storyPage(s, false);
  for (const c of raw.collections ?? []) storyPage(c, true);

  const BATCH = 200;
  for (let i = 0; i < writes.length; i += BATCH) {
    await Promise.all(writes.slice(i, i + BATCH).map(w => writeFile(w.path, w.html, 'utf-8')));
  }

  return writes.length;
}
