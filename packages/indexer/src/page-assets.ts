// Shared, cacheable page assets: the CSS + click-handler JS emitted as /pages.css and /pages.js.
// Split out of pages.ts so a CSS/JS-only change touches ONLY this file -> the assets-only fast lane
// (build.ts --assets-only) can ship it without re-rendering the ~7k theme/story pages.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PAGE_CSS = `
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
  /* Rows: intro sized to content, main's row (1fr) absorbs any surplus height. Without this, a tall
     aside (e.g. child-themes toggled to a table) spanning both rows inflates the intro row and pushes
     the main/usages panel down, leaving white space above it. align-items:start keeps main at the top
     of its row, so the leftover lands below it instead. */
  .doc-grid { grid-template-columns: minmax(0, 1fr) 280px; grid-template-areas: "intro aside" "main aside"; grid-template-rows: auto 1fr; }
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

/* Toggle-to-table blocks (sidebar ancestor / child-theme lists). The toggle sits at the top-right
   of the list heading; clicking it swaps the inline list for a compact table (handled in PAGES_JS). */
.tl + .tl { margin-top: 1.1rem; }                 /* restore the gap between the ancestor + child blocks */
.tl-head { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; }
.tl-head h2 { margin: 0 0 .2rem; }
.tl-toggle { flex: none; background: none; border: 0; padding: 0; cursor: pointer; font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #7048e8; }
.tl-toggle:hover { text-decoration: underline; }
.tl-table { margin-top: .15rem; overflow-x: auto; }
/* Dense: content-sized columns (not the global fixed layout), tight padding + type, in the narrow aside. */
.tl-table table { table-layout: auto; font-size: .78rem; }
.tl-table th { padding: .16rem .3rem; }
.tl-table td { padding: .16rem .3rem; line-height: 1.3; }
.tl-lvlhdr { color: #868e96; font-weight: 400; }
/* Ancestors: level badge (col 1, narrow) · theme · description. The level is a plain digit inside a
   CSS-drawn circle — circled-digit Unicode glyphs (①②③) render off-baseline in many fonts. */
.tl-anc th:first-child, .tl-anc td.tl-lvlcell { width: 2rem; text-align: center; padding-left: 0; padding-right: .2rem; }
.tl-lvlbadge { display: inline-flex; align-items: center; justify-content: center; width: 1.05rem; height: 1.05rem; border: 1.5px solid #adb5bd; border-radius: 50%; font-size: .68rem; line-height: 1; color: #868e96; vertical-align: top; }
.tl-anc th:nth-child(2), .tl-anc td:nth-child(2) { width: 28%; }
/* Children: theme · description (no level col). */
.tl-child th:first-child, .tl-child td:first-child { width: 30%; }
.tl-child th:nth-child(2), .tl-child td:nth-child(2) { width: auto; }
`.trim();

// Shared, cacheable script for the doc pages: clicking "Show all" fetches the table's
// overflow rows (pre-rendered HTML) from the sibling <slug>.json and appends them.
export const PAGES_JS = `
var __jsonCache = {};
function jget(u) {
  if (!__jsonCache[u]) {
    __jsonCache[u] = fetch(u).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); });
    __jsonCache[u].catch(function () { delete __jsonCache[u]; });  // don't cache a failure -> allow retry
  }
  return __jsonCache[u];  // one fetch+parse per sibling JSON, shared by every toggle / "Show all" on the page
}
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
  var tlBtn = t && t.closest ? t.closest('.tl-toggle') : null;
  if (tlBtn) {
    var box = tlBtn.closest('[data-tl]');
    if (!box) return;
    var showTable = tlBtn.getAttribute('aria-pressed') !== 'true';
    var lst = box.querySelector('.tl-list');
    var tb = box.querySelector('.tl-table');
    var body = box.querySelector('.tl-table tbody');
    var flip = function () {
      tlBtn.setAttribute('aria-pressed', showTable ? 'true' : 'false');
      tlBtn.textContent = showTable ? 'List' : 'Table';
      if (lst) lst.hidden = showTable;
      if (tb) tb.hidden = !showTable;
    };
    var src = tlBtn.getAttribute('data-src');
    // On first open, lazy-load the row cells (pre-rendered HTML) from the sibling <slug>.json so the
    // descriptions never ship in the initial page; then just show/hide on later toggles.
    if (showTable && src && body && !body.getAttribute('data-loaded')) {
      var key = tlBtn.getAttribute('data-key');
      tlBtn.disabled = true; tlBtn.textContent = 'Loading\\u2026';
      jget(src)
        .then(function (data) {
          body.insertAdjacentHTML('beforeend', (data && data[key]) || '');
          body.setAttribute('data-loaded', '1');
          tlBtn.disabled = false; flip();
        })
        .catch(function () { tlBtn.disabled = false; tlBtn.textContent = 'Table'; });
      return;
    }
    flip();
    return;
  }
  var btn = t && t.closest ? t.closest('.expand-btn') : null;
  if (!btn) return;
  var tbody = document.getElementById(btn.getAttribute('data-target'));
  if (!tbody) return;
  var key = btn.getAttribute('data-key');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  jget(btn.getAttribute('data-src'))
    .then(function (data) {
      tbody.insertAdjacentHTML('beforeend', (data && data[key]) || '');
      if (btn.parentNode) btn.parentNode.removeChild(btn);
    })
    .catch(function () { btn.disabled = false; btn.textContent = 'Failed \\u2014 click to retry'; });
});
`.trim();

// Write just the shared assets (pages.css + pages.js) -- no corpus, no page render.
export async function writeAssets(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'pages.css'), PAGE_CSS + '\n', 'utf-8');
  await writeFile(join(outDir, 'pages.js'), PAGES_JS + '\n', 'utf-8');
}
