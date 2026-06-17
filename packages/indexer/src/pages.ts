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
  'story format'?: string;
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

// Leading year of a story's date string ("2000-01-01" -> 2000, "458 BC" -> -458).
function storyYear(date: string | undefined): number | null {
  if (!date) return null;
  const m = date.match(/\d{1,4}/);
  if (!m) return null;
  const y = parseInt(m[0], 10);
  return /\bbc\b/i.test(date) ? -y : y;
}

// 1, 2, 3 -> "1st", "2nd", "3rd"; 11/12/13 and the rest -> "Nth".
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// The five canonical story formats (themeontology.org "Story Format" field). Stacking and
// legend order; the page colours film with its own indigo and the rest in shades of blue.
const SBY_FORMATS = ['film', 'tv', 'stage', 'prose', 'game'] as const;
type Fmt = typeof SBY_FORMATS[number];
type FmtCounts = Record<Fmt, number>;
const mkCounts = (): FmtCounts => ({ film: 0, tv: 0, stage: 0, prose: 0, game: 0 });

// Map id prefix → format, a fallback for stories with no Story Format on themselves or their
// collection. "movie:" → film; "play:/opera:" → stage; written works → prose; "videogame:" →
// game; everything else (incl. the prefixless TV-episode ids) → tv.
function formatFromPrefix(name: string): Fmt {
  const p = name.split(':', 1)[0].toLowerCase();
  if (p === 'movie') return 'film';
  if (p === 'play' || p === 'opera') return 'stage';
  if (p === 'novel' || p === 'shortstory' || p === 'writing' || p === 'nonfiction') return 'prose';
  if (p === 'videogame') return 'game';
  return 'tv';
}

// Resolve every story's format. The canonical "Story Format" lives on collections and applies
// to their component stories; a Story Format set directly on a story overrides its collection's
// (e.g. live-action segments inside a TV anthology). Falls back to the id-prefix heuristic.
function buildFormatMap(stories: RawStory[], collections: RawStory[]): Map<string, Fmt> {
  const norm = (v: string | undefined): Fmt | null => {
    const x = (v ?? '').trim().toLowerCase();
    return (SBY_FORMATS as readonly string[]).includes(x) ? (x as Fmt) : null;
  };
  const m = new Map<string, Fmt>();
  for (const c of collections) {
    const f = norm(c['story format']);
    if (!f) continue;
    for (const cs of c['component stories'] ?? []) if (!m.has(cs)) m.set(cs, f);
  }
  for (const s of stories) {
    const f = norm(s['story format']);
    if (f) m.set(s.name, f);
  }
  return m;
}

// Histogram of story counts, with bins coarsening as they go back in time: one bin per
// year from 1950 onward, one per decade for 1900–1949, one per century before 1900 (only
// centuries that actually contain stories). Empty years/decades inside their ranges are
// kept so the modern axis stays continuous. Centuries are labelled as ordinals ("18th",
// "6th BC"); BC bins are flagged so the page can colour them distinctly. Each bin carries a
// per-format breakdown so the page can stack stories by story format.
interface SbyItem { t: string; s: string; fmt: Fmt; y: number }
interface SbyBin {
  label: string; tip: string; count: number; by: FmtCounts;
  lo: number; hi: number; // year span this bin covers (negative = BCE), for region headers
  era: 'year' | 'decade' | 'century'; bc?: boolean; mill?: boolean; items: SbyItem[];
}

function storiesByYear(stories: RawStory[], collections: RawStory[], storySlug: Map<string, string>): {
  total: number; unknown: number; bins: SbyBin[];
} {
  const fmtOf = buildFormatMap(stories, collections);
  // Each bucket holds its stories (title, slug, format, year); count and the per-format
  // breakdown derive from them. The 1st millennium CE (years 1–1000) is a single bucket;
  // centuries otherwise.
  type Bucket = { n: number; by: FmtCounts; items: SbyItem[] };
  const mk = (): Bucket => ({ n: 0, by: mkCounts(), items: [] });
  const tally = (b: Bucket, it: SbyItem) => { b.n++; b.by[it.fmt]++; b.items.push(it); };
  const add = (m: Map<number, Bucket>, k: number, it: SbyItem) => {
    let b = m.get(k); if (!b) { b = mk(); m.set(k, b); }
    tally(b, it);
  };
  const year = new Map<number, Bucket>();
  const decade = new Map<number, Bucket>();
  const century = new Map<number, Bucket>();
  const mill = mk(); // 1st millennium CE (years 1..1000)
  let total = 0, unknown = 0, maxYear = -Infinity, minOld = Infinity;
  for (const s of stories) {
    const y = storyYear(s.date);
    if (y === null) { unknown++; continue; }
    total++;
    const fmt = fmtOf.get(s.name) ?? formatFromPrefix(s.name);
    const it: SbyItem = { t: s.title || s.name, s: storySlug.get(s.name) ?? '', fmt, y };
    if (y >= 1950) { add(year, y, it); if (y > maxYear) maxYear = y; }
    else if (y >= 1900) { add(decade, Math.floor(y / 10) * 10, it); }
    else {
      if (y < minOld) minOld = y;
      if (y >= 1001) add(century, Math.floor(y / 100) * 100, it);
      else if (y >= 1) tally(mill, it);
      else add(century, Math.floor(y / 100) * 100, it);
    }
  }
  const byYearThenTitle = (a: SbyItem, b: SbyItem) => a.y - b.y || a.t.localeCompare(b.t);
  const take = (b: Bucket): Bucket => { b.items.sort(byYearThenTitle); return b; };
  const bins: SbyBin[] = [];
  // Pre-1900 spine: BCE centuries, then the 1st-millennium bucket, then CE centuries 11th–19th.
  // Empty centuries are kept so the axis stays contiguous; the 1st millennium (1st–10th c. CE)
  // is collapsed into one bucket. A century starting at c spans [c, c+99].
  if (minOld < 1900 && Number.isFinite(minOld)) {
    let emittedMill = false;
    for (let c = Math.floor(minOld / 100) * 100; c <= 1800; c += 100) {
      if (c >= 0 && c <= 900) {                 // 1st–10th c. CE → one millennium bucket
        if (!emittedMill) {
          take(mill);
          bins.push({ label: '1st mill.', tip: '1st millennium CE (1–1000)', count: mill.n, by: mill.by, lo: 1, hi: 1000, era: 'century', mill: true, items: mill.items });
          emittedMill = true;
        }
        continue;
      }
      const b = take(century.get(c) ?? mk());
      const ord = ordinal(c >= 0 ? c / 100 + 1 : -c / 100);
      const range = c >= 0 ? `${c}–${c + 99} CE` : `${-c}–${-(c + 99)} BCE`;
      bins.push({
        label: c >= 0 ? ord : `-${ord}`,
        tip: c >= 0 ? `${ord} century CE (${range})` : `${ord} century BCE (${range})`,
        count: b.n, by: b.by, lo: c, hi: c + 99, era: 'century', items: b.items,
        ...(c < 0 ? { bc: true } : {}),
      });
    }
  }
  // Decades 1900–1949 (all five, zeros kept). Axis label is the short "00s".."40s".
  for (let d = 1900; d <= 1940; d += 10) {
    const b = take(decade.get(d) ?? mk());
    bins.push({ label: `${String(d).slice(-2)}s`, tip: `${d}s (${d}–${d + 9})`, count: b.n, by: b.by, lo: d, hi: d + 9, era: 'decade', items: b.items });
  }
  // Years 1950..maxYear (zeros kept) for a continuous recent axis.
  if (maxYear >= 1950) {
    for (let y = 1950; y <= maxYear; y++) {
      const b = take(year.get(y) ?? mk());
      bins.push({ label: String(y), tip: String(y), count: b.n, by: b.by, lo: y, hi: y, era: 'year', items: b.items });
    }
  }
  return { total, unknown, bins };
}

// Small clipboard icon + a discrete button that copies the document name (handled by pages.js).
const COPY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
function copyBtn(name: string): string {
  return `<button class="copy-name" type="button" data-copy="${esc(name)}" title="Copy name" aria-label="Copy name">${COPY_SVG}</button>`;
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
/* Subtle inline links: muted colour + light underline (kept for affordance/accessibility),
   strengthening on hover — so links read as links without the bright-blue shout. */
.about a { color: #3f6189; text-decoration: underline; text-decoration-color: #c7d0dc; text-underline-offset: 2px; }
.about a:hover { text-decoration-color: #3f6189; }
.figures { font-size: .92rem; color: #495057; line-height: 1.65; margin: 0 0 .9rem; max-width: 62ch; }
.figures strong { color: #212529; font-weight: 700; }
@media (min-width: 760px) {
  .front-grid { grid-template-columns: minmax(0, 1fr) 190px; }
  .stats { grid-template-columns: 1fr; }
}

/* ── Versions page ────────────────────────────────────────────────────────── */
.versions-list { max-width: 720px; }
.version-branch { font-size: 1rem; font-weight: 600; margin: 1.1rem 0 .5rem; }
.version-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: .75rem; padding: .5rem .25rem; border-bottom: 1px solid #e9ecef; font-size: .9rem; }
.version-row .name { font-weight: 600; min-width: 9.5em; }   /* tag, or build month ("June 2026") */
.version-row .date { color: #adb5bd; font-size: .82rem; min-width: 6em; }   /* full build date, subtle */
.version-row .badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; padding: .1em .45em; border-radius: 3px; }
.version-row .badge.current { background: #e7f5ff; color: #1971c2; }   /* the version you're viewing */
.version-row .badge.latest { background: #ebfbee; color: #2f9e44; }    /* newest under its heading */
.version-row .muted { color: #868e96; font-size: .82rem; }
/* Per-release dataset downloads (themes/stories/collections JSON on data.themeontology.org). */
.version-row .downloads { margin-left: auto; display: inline-flex; flex-wrap: wrap; gap: .65rem; }
.version-row .dl { font-size: .8rem; color: #1971c2; text-decoration: none; white-space: nowrap; }
.version-row .dl::before { content: "\\2193\\00a0"; color: #adb5bd; }
.version-row .dl:hover { text-decoration: underline; }
/* GitHub source links on the section headings, and the first-column search links on rows
   (both inherit the text style; headings add the ↗ external mark). */
.version-branch a, .version-row .name-link { color: inherit; text-decoration: none; }
.version-branch a:hover, .version-row .name-link:hover { text-decoration: underline; }
.versions-list .ext-mark { font-size: .8em; color: #adb5bd; }

/* ── Detail (theme / story / collection) pages ────────────────────────────── */
/* --doc-accent carries the per-type colour so it can be the left accent on wide
   screens and a top bar on narrow ones (see the max-width:640px block). */
.doc { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; --doc-accent: transparent; border-left: 3px solid var(--doc-accent); padding: 1.25rem 1.4rem; }
.doc.type-theme { --doc-accent: #7048e8; }
.doc.type-story { --doc-accent: #0d6efd; }
.doc.type-collection { --doc-accent: #198754; }
/* Secondary metadata floats in a sidebar beside the whole content (head + table),
   from the top. Stacks to a single column on narrow screens. */
/* Three areas (intro / aside / main=tables). Single column by default, the sidebar folding in
   between the intro and the tables; widened to two columns at >=900px with the sidebar on the
   right spanning both rows. */
.doc-grid { display: grid; grid-template-columns: 1fr; grid-template-areas: "intro" "aside" "main"; gap: 1.25rem 1.75rem; align-items: start; }
.doc-intro { grid-area: intro; }
.doc-aside { grid-area: aside; }
.doc-main { grid-area: main; }
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
/* Discrete copy-the-document-name button next to the heading. */
.copy-name { background: none; border: 0; padding: 0 .15rem; cursor: pointer; color: #ced4da; vertical-align: middle; line-height: 0; position: relative; }
.copy-name svg { width: 15px; height: 15px; }
.copy-name:hover { color: #495057; }
.copy-name.copied { color: #2f9e44; }
.copy-name.copied::after { content: "Copied"; position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 3px; font-size: .62rem; font-weight: 600; color: #2f9e44; background: #fff; padding: 0 .2rem; white-space: nowrap; }
@media (min-width: 900px) {
  .doc-grid { grid-template-columns: minmax(0, 1fr) 280px; grid-template-areas: "intro aside" "main aside"; }
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
  var t = e.target;
  var copy = t && t.closest ? t.closest('.copy-name') : null;
  if (copy) {
    var done = function () { copy.classList.add('copied'); setTimeout(function () { copy.classList.remove('copied'); }, 1200); };
    var name = copy.getAttribute('data-copy') || '';
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(name).then(done, done); }
    else { done(); }
    return;
  }
  var btn = t && t.closest ? t.closest('.expand-btn') : null;
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

function navBar(active: 'search' | 'versions' | 'stats' | '', assetPrefix: string, showBrand = true): string {
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
      <a href="${SITE_BASE}/stats/">Stats</a>
      <a href="${SITE_BASE}/versions/">Versions</a>
      ${github}
    </nav>
  </div>
</header>`;
  }

  // Elsewhere: Search is the prominent left item (filled pill); Versions/GitHub right.
  const aS = active === 'search' ? ' active' : '';
  const aV = active === 'versions' ? ' active' : '';
  const aST = active === 'stats' ? ' active' : '';
  return `<header class="nav">
  <div class="nav-inner">
    <a class="nav-brand" href="${SITE_BASE}/"><img src="${assetPrefix}favicon.svg" alt="" width="26" height="26"><span>Theme Ontology</span></a>
    ${burger}
    <nav class="nav-links nav-main">
      <a class="nav-search${aS}" href="${SITE_BASE}/search/">Search</a>
      <a class="nav-stats${aST}" href="${SITE_BASE}/stats/">Stats</a>
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
  active: 'search' | 'versions' | 'stats' | '';
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

function frontPage(raw: RawCorpus, version: string, themeSlug: Map<string, string>, storySlug: Map<string, string>): string {
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

  // Concrete examples to link into the prose: the most-annotated theme, the story with the most
  // themes, and a randomly chosen collection (re-rolled each build).
  const themeUsage = new Map<string, number>();
  let mostThemedStory: RawStory | null = null, mostThemedCount = -1;
  for (const s of stories) {
    const ths = s.themes ?? [];
    if (ths.length > mostThemedCount) { mostThemedCount = ths.length; mostThemedStory = s; }
    for (const a of ths) themeUsage.set(a.name, (themeUsage.get(a.name) ?? 0) + 1);
  }
  for (const c of collections) for (const a of (c.themes ?? [])) themeUsage.set(a.name, (themeUsage.get(a.name) ?? 0) + 1);
  let mostUsedTheme = '', mostUsedCount = -1;
  for (const [name, cnt] of themeUsage) if (cnt > mostUsedCount) { mostUsedCount = cnt; mostUsedTheme = name; }
  const randomCollection = collections.length ? collections[Math.floor(Math.random() * collections.length)] : null;
  const tLink = (name: string) => { const sl = themeSlug.get(name); return sl ? `<a href="${SITE_BASE}/theme/${sl}.html">${esc(name)}</a>` : esc(name); };
  const sLink = (s: RawStory | null) => { if (!s) return ''; const sl = storySlug.get(s.name); const label = esc(s.title || s.name); return sl ? `<a href="${SITE_BASE}/story/${sl}.html">${label}</a>` : label; };

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
      <p class="figures">Every story–theme association is weighted as <em>minor</em>, <em>major</em>, or <em>choice</em>, and comes with an explanation, the <em>motivation</em>, describing how the theme manifests in that story. Each theme definition averages <strong>${avgThemeWords} words</strong>, every annotated story carries about <strong>${avgThemesPerStory} themes</strong>, and a typical motivation runs <strong>${avgMotivation} words</strong>, with the longest 10% reaching <strong>${p90} words</strong> or more. For a taste, explore the most-used theme ${tLink(mostUsedTheme)}, the most-themed story ${sLink(mostThemedStory)}, or the collection ${sLink(randomCollection)}.</p>
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
      // Meaningful date (YYYY-MM-DD): the release date / branch last-change date when known
      // (v.date), else the build date.
      var ymd = function (v) {
        if (v.date) return String(v.date).slice(0, 10);
        return v.built ? new Date(v.built).toISOString().slice(0, 10) : '';
      };
      var badges = function (v, latest) {
        return (isCurrent(v) ? '<span class="badge current">current</span>' : '')
          + (latest ? '<span class="badge latest">latest</span>' : '');
      };
      // External link to the source on GitHub, with the ↗ external-site mark. Only the
      // section headings link out: a branch heading -> its branch tree, the releases heading
      // -> the releases page. (Rows themselves link inward, to the build's search page.)
      var REPO = 'https://github.com/theme-ontology/theming';
      var ext = function (href, text) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + text
          + ' <span class="ext-mark" aria-hidden="true">↗</span></a>';
      };
      // First-column name links to this build's own search page (path is like '/', '/vX/',
      // '/<branch>/'). Branch builds show the build month ("June 2026"); releases show the tag.
      var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var monthLabel = function (d) {
        var p = String(d).split('-');
        return (p.length >= 2 && MONTHS[parseInt(p[1], 10) - 1]) ? MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[0] : String(d);
      };
      var searchLink = function (v, text) {
        return '<a class="name-link" href="' + (v.path || '/') + 'search/">' + text + '</a>';
      };
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
      var releases = [], byBranch = {};
      versions.forEach(function (v) { if (v.release) releases.push(v); else (byBranch[v.branch] = byBranch[v.branch] || []).push(v); });
      var html = '';
      // Branches: the heading links to the GitHub branch; each row's name is the build month,
      // linking to that build's search page, with the full build date alongside.
      Object.keys(byBranch).sort().forEach(function (branch) {
        html += '<div class="version-branch">' + ext(REPO + '/tree/' + branch, branch) + '</div>';
        byBranch[branch].sort(function (a, b) { return (b.date || b.built || '').localeCompare(a.date || a.built || ''); })
          .forEach(function (v, i) {
            html += '<div class="version-row"><span class="name">' + searchLink(v, monthLabel(ymd(v))) + '</span>'
              + '<span class="date">' + ymd(v) + '</span>' + badges(v, i === 0) + downloads(v) + '</div>';
          });
      });
      // Releases: the heading links to the GitHub releases page; each row's name is the tag,
      // linking to that release's search page, with the release date alongside.
      if (releases.length) {
        html += '<div class="version-branch">' + ext(REPO + '/releases', 'releases') + '</div>';
        releases.sort(function (a, b) { return (b.tag || '').localeCompare(a.tag || ''); })
          .forEach(function (v, i) {
            html += '<div class="version-row"><span class="name">' + searchLink(v, v.tag) + '</span>'
              + '<span class="date">' + ymd(v) + '</span>' + badges(v, i === 0) + downloads(v) + '</div>';
          });
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

// Landing page for the /stats/ section — a simple, extensible index of visualizations and
// dataset statistics. New stats pages can be added as further list entries / subdirectories.
function statsHubPage(version: string): string {
  const body = `<h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-.3px;margin-bottom:.4rem;">Statistics</h1>
<p style="color:#495057;line-height:1.55;max-width:680px;margin-bottom:1rem;">Interactive views and dataset statistics for the theme ontology.</p>
<ul style="list-style:none;padding:0;max-width:680px;">
  <li style="padding:.6rem 0;border-bottom:1px solid #e9ecef;">
    <a href="themes-graph/" style="font-weight:600;color:#1971c2;text-decoration:none;">Theme graph &rarr;</a>
    <div style="color:#868e96;font-size:.88rem;margin-top:.15rem;">Interactive map of the theme hierarchy — colour-coded by ultimate root, with foldable leaves and per-root subgraphs.</div>
  </li>
  <li style="padding:.6rem 0;border-bottom:1px solid #e9ecef;">
    <a href="most-used/" style="font-weight:600;color:#1971c2;text-decoration:none;">Most used &rarr;</a>
    <div style="color:#868e96;font-size:.88rem;margin-top:.15rem;">The most-used themes and most-themed stories, as stacked bars by weight (minor / major / choice).</div>
  </li>
  <li style="padding:.6rem 0;border-bottom:1px solid #e9ecef;">
    <a href="stories-by-year/" style="font-weight:600;color:#1971c2;text-decoration:none;">Stories by year &rarr;</a>
    <div style="color:#868e96;font-size:.88rem;margin-top:.15rem;">A histogram of how many stories fall in each year (from 1900) and century (before 1900).</div>
  </li>
</ul>`;
  return htmlDoc({
    title: 'Statistics · Theme Ontology',
    description: 'Theme Ontology statistics and visualizations.',
    depth: 1,
    active: 'stats',
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
  await writeFile(join(outDir, 'index.html'), frontPage(raw, version, themeSlug, storySlug), 'utf-8');
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

  // Stats / visualizations section (/stats/). Hub page + the interactive theme-DAG explorer
  // (/stats/themes-graph/), which ships a slim {name, slug, parents} list so it can fold leaves,
  // split into per-root subgraphs, and deep-link nodes to /theme/ pages — all client-side.
  await mkdir(join(outDir, 'stats', 'themes-graph'), { recursive: true });
  const graphThemes = (raw.themes ?? []).map(t => ({
    name: t.name,
    slug: themeSlug.get(t.name) ?? '',
    parents: t.parents ?? [],
  }));
  await writeFile(join(outDir, 'stats', 'themes-graph.json'),
    JSON.stringify({ lto: raw.lto, themes: graphThemes }), 'utf-8');
  await writeFile(join(outDir, 'stats', 'index.html'), statsHubPage(version), 'utf-8');
  try {
    const graphSrc = resolve(dirname(fileURLToPath(import.meta.url)), 'themes-graph.html');
    await writeFile(join(outDir, 'stats', 'themes-graph', 'index.html'), await readFile(graphSrc, 'utf-8'), 'utf-8');
  } catch {
    // The explorer page is an optional spike; its absence shouldn't fail the build.
  }

  // "Most used" page (/stats/most-used/): per-theme and per-story annotation counts split by
  // weight (minor/major/choice). Ship all entries so the page can re-rank when levels are
  // toggled. n=name/title, s=slug, mi/ma/ch=counts.
  await mkdir(join(outDir, 'stats', 'most-used'), { recursive: true });
  const themeCounts = new Map<string, { mi: number; ma: number; ch: number }>();
  for (const s of [...(raw.stories ?? []), ...(raw.collections ?? [])]) {
    for (const a of (s.themes ?? [])) {
      const lv = a.level;
      if (lv !== 'minor' && lv !== 'major' && lv !== 'choice') continue;
      let c = themeCounts.get(a.name);
      if (!c) { c = { mi: 0, ma: 0, ch: 0 }; themeCounts.set(a.name, c); }
      if (lv === 'minor') c.mi++; else if (lv === 'major') c.ma++; else c.ch++;
    }
  }
  const muThemes = [...themeCounts.entries()]
    .map(([name, c]) => ({ n: name, s: themeSlug.get(name) ?? '', mi: c.mi, ma: c.ma, ch: c.ch }))
    .filter(r => r.mi + r.ma + r.ch > 0);
  const muStories = (raw.stories ?? []).map(s => {
    let mi = 0, ma = 0, ch = 0;
    for (const a of (s.themes ?? [])) { if (a.level === 'minor') mi++; else if (a.level === 'major') ma++; else if (a.level === 'choice') ch++; }
    return { n: s.title || s.name, s: storySlug.get(s.name) ?? '', mi, ma, ch };
  }).filter(r => r.mi + r.ma + r.ch > 0);
  await writeFile(join(outDir, 'stats', 'most-used.json'), JSON.stringify({ themes: muThemes, stories: muStories }), 'utf-8');
  try {
    const muSrc = resolve(dirname(fileURLToPath(import.meta.url)), 'most-used.html');
    await writeFile(join(outDir, 'stats', 'most-used', 'index.html'), await readFile(muSrc, 'utf-8'), 'utf-8');
  } catch {
    // optional
  }

  // "Stories by year" page (/stats/stories-by-year/): a histogram of how many stories
  // fall in each year (1900 onward) / century (before 1900). First cut counts stories;
  // later it can be split by story format / franchise.
  await mkdir(join(outDir, 'stats', 'stories-by-year'), { recursive: true });
  await writeFile(join(outDir, 'stats', 'stories-by-year.json'),
    JSON.stringify({ lto: raw.lto, ...storiesByYear(raw.stories ?? [], raw.collections ?? [], storySlug) }), 'utf-8');
  try {
    const sbySrc = resolve(dirname(fileURLToPath(import.meta.url)), 'stories-by-year.html');
    await writeFile(join(outDir, 'stats', 'stories-by-year', 'index.html'), await readFile(sbySrc, 'utf-8'), 'utf-8');
  } catch {
    // optional
  }

  const writes: Array<{ path: string; html: string }> = [];

  // ── Theme pages ─────────────────────────────────────────────────────────────
  for (const t of raw.themes ?? []) {
    const slug = themeSlug.get(t.name);
    if (!slug) continue;

    const headParts: string[] = [`<h1>${esc(t.name)} <span class="doc-type">theme</span>${copyBtn(t.name)}</h1>`];
    if (t.aliases && t.aliases.length > 0) headParts.push(`<p class="meta">also known as: ${t.aliases.map(esc).join(', ')}</p>`);
    if (t.description) headParts.push(`<p class="desc">${esc(t.description)}</p>`);

    // Intro block: header + prose (notes/examples). The tables go in a separate main block
    // below, so the sidebar can fold in between them (above the tables) on narrow screens.
    const intro: string[] = [`<header class="doc-head">${headParts.join('\n')}</header>`];
    if (t.notes) intro.push(`<h2>Notes</h2><p class="desc">${esc(t.notes)}</p>`);
    if (t.examples) intro.push(`<h2>Examples</h2><p class="desc">${esc(t.examples)}</p>`);

    const main: string[] = [];
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
      main.push(tbl.html);
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
<div class="doc-intro">${intro.filter(Boolean).join('\n')}</div>
<aside class="doc-aside">${aside.filter(Boolean).join('\n') || '&nbsp;'}</aside>
<div class="doc-main">${main.filter(Boolean).join('\n')}</div>
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
    const headParts = [`<h1>${esc(s.title || s.name)} <span class="doc-type">${kind}</span>${copyBtn(s.name)}</h1>`];
    const authors = typeof s.authors === 'string' ? s.authors : (s.authors ?? []).join(', ');
    const metaBits = [s.title && s.title !== s.name ? s.name : '', s.date ?? '', authors].filter(Boolean);
    if (metaBits.length > 0) headParts.push(`<p class="meta">${metaBits.map(esc).join(' · ')}</p>`);
    if (s.description) headParts.push(`<p class="desc">${esc(s.description)}</p>`);

    // Intro = header; tables go in the main block below so the sidebar folds in above them
    // on narrow screens (see .doc-grid grid-template-areas).
    const intro: string[] = [`<header class="doc-head">${headParts.join('\n')}</header>`];
    const main: string[] = [];
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
      main.push(tbl.html);
      if (tbl.overflow) overflow['themes'] = tbl.overflow;
    }

    const components = (s['component stories'] ?? []).slice().sort();
    if (components.length > 0) {
      const rows = components.map(name => `<tr><td>${storyLink(name)}</td><td class="lvl">${esc(storyDate.get(name) ?? '')}</td></tr>`);
      const heading = `<p class="tbl-summary">${components.length} component stories</p>`;
      const tbl = tableSection('tbl-components', heading, ['Story', 'Date'], rows, `${slug}.json`, 'components', 'cols2');
      main.push(tbl.html);
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
<div class="doc-intro">${intro.filter(Boolean).join('\n')}</div>
<aside class="doc-aside">${aside.filter(Boolean).join('\n') || '&nbsp;'}</aside>
<div class="doc-main">${main.filter(Boolean).join('\n')}</div>
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
