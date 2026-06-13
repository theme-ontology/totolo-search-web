import type { SearchResult } from '@totolo-search/core';
import type { ResultsPhase } from './search.js';

const THEMEONTOLOGY_BASE = 'https://www.themeontology.org';

function themeontologyUrl(docType: string, name: string): string {
  const encoded = encodeURIComponent(name);
  if (docType === 'theme') return `${THEMEONTOLOGY_BASE}/theme/${encoded}`;
  return `${THEMEONTOLOGY_BASE}/story/${encoded}`;
}

// Locally generated detail pages (built by the indexer next to the other artifacts).
// Configured by main.ts once the corpus is loaded; until then — or for any name
// without a known slug — links fall back to themeontology.org.
let pagesBase = '';
let pageSlugs: Map<string, string> | null = null; // key: `${doc_type}:${name}`

export function setPageLinks(base: string, slugs: Map<string, string>) {
  pagesBase = base;
  pageSlugs = slugs;
}

function docUrl(docType: string, name: string): string {
  if (pagesBase && pageSlugs) {
    const slug = docType === 'theme'
      ? pageSlugs.get(`theme:${name}`)
      : (pageSlugs.get(`${docType}:${name}`)
        ?? pageSlugs.get(`story:${name}`)
        ?? pageSlugs.get(`collection:${name}`));
    if (slug) return `${pagesBase}${docType === 'theme' ? 'theme' : 'story'}/${slug}.html`;
  }
  return themeontologyUrl(docType, name);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Escapes a string for use inside a double-quoted HTML attribute.
function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, '&quot;');
}

// A small button that copies the given name to the clipboard (handled by a delegated
// listener in main.ts). Holds both a copy and a check icon; CSS swaps them when the
// button gains the `copied` class.
function copyButton(name: string): string {
  return `<button class="result-copy" type="button" data-copy="${escAttr(name)}"`
    + ` title="Copy name" aria-label="Copy name to clipboard">`
    + `<svg class="icon-copy" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">`
    + `<rect x="9" y="9" width="11" height="11" rx="2"></rect>`
    + `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`
    + `<svg class="icon-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">`
    + `<polyline points="20 6 9 17 4 12"></polyline></svg>`
    + `</button>`;
}

// Splits text at regex match boundaries, escapes each segment, wraps matches in <mark>.
function splitHighlight(text: string, re: RegExp): string {
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(escHtml(text.slice(last, m.index)));
    parts.push(`<mark>${escHtml(m[0])}</mark>`);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  parts.push(escHtml(text.slice(last)));
  return parts.join('');
}

type Highlighter = (text: string) => string;

function makeHighlighter(phase: ResultsPhase, query: string): Highlighter {
  if (!query) return escHtml;

  if (phase === 'regex') {
    try {
      new RegExp(query, 'gi'); // validate
      return (text) => splitHighlight(text, new RegExp(query, 'gi'));
    } catch {
      return escHtml;
    }
  }

  if (phase === 'semantic' || phase === 'reranked' || phase === 'keyword') {
    const terms = [...new Set(
      query.split(/\s+/)
        .map(t => t.replace(/^["'+\-]+|["']+$/g, ''))
        .filter(t => t.length >= 3)
        .map(t => t.toLowerCase()),
    )];
    if (terms.length === 0) return escHtml;
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return (text) => splitHighlight(text, new RegExp(`(${escaped.join('|')})`, 'gi'));
  }

  return escHtml;
}

export function renderResults(
  container: HTMLElement,
  countEl: HTMLElement,
  results: SearchResult[],
  phase: ResultsPhase,
  query = '',
) {
  if (phase === 'searching') {
    container.innerHTML = '';
    countEl.innerHTML = '';
    return;
  }
  if (results.length === 0) {
    countEl.innerHTML = '';
    container.innerHTML = (phase === 'semantic' || phase === 'reranked' || phase === 'regex' || phase === 'keyword')
      ? '<p class="no-results">No results.</p>'
      : '';
    return;
  }
  const hl = makeHighlighter(phase, query);
  countEl.innerHTML = `${results.length} results`;
  container.innerHTML = results.map(r => renderResult(r, hl)).join('');
}

function pill(label: string, active: boolean): string {
  return `<span class="phase-pill${active ? ' is-active' : ''}">${label}</span>`;
}

// Renders the three search-phase pills, darkening those that have applied to the
// current results. Phases are cumulative: semantic implies keyword, reranked implies
// both. Regex is its own phase. Empty phase (no active query) clears the pills.
export function renderPhases(el: HTMLElement, phase: ResultsPhase | 'none') {
  if (phase === 'none') {
    el.innerHTML = '';
    return;
  }
  if (phase === 'regex') {
    el.innerHTML = pill('regex', true);
    return;
  }
  const keyword = phase === 'keyword' || phase === 'semantic' || phase === 'reranked';
  const semantic = phase === 'semantic' || phase === 'reranked';
  const reranked = phase === 'reranked';
  el.innerHTML = pill('keyword', keyword) + pill('semantic', semantic) + pill('re-ranked', reranked);
}

function renderResult(r: SearchResult, hl: Highlighter): string {
  const typeClass = `type-${r.doc_type}`;
  const typeLabel = r.doc_type === 'story-theme' ? 'note'
    : r.doc_type === 'collection' ? 'group'
    : r.doc_type;

  if (r.doc_type === 'story-theme') {
    // Story and theme are equally important — both are links, sized to fit on one
    // line, and styled by kind (story = blue, theme = violet).
    const storyUrl = docUrl('story', r.name);
    const themeUrl = docUrl('theme', r.title);
    const levelParen = r.theme_level
      ? ` <span class="result-date">(${escHtml(r.theme_level)})</span>`
      : '';
    return `
      <article class="result ${typeClass}">
        <header class="result-header">
          <span class="result-type">${escHtml(typeLabel)}</span>
          <a class="result-annotation-link is-story" href="${storyUrl}" target="_blank" rel="noopener">${escHtml(r.name)}</a>
          <a class="result-annotation-link is-theme" href="${themeUrl}" target="_blank" rel="noopener">${escHtml(r.title)}</a>${levelParen}
        </header>
        <p class="result-desc">${hl(r.description)}</p>
      </article>
    `;
  }

  const nameUrl = docUrl(r.doc_type, r.name);
  // Themes get the violet link style so they read distinctly from stories.
  const nameClass = r.doc_type === 'theme' ? 'result-name is-theme' : 'result-name';

  let subtitle = '';
  if (r.doc_type === 'theme') {
    if (r.parents && r.parents.length > 0) {
      const parentLinks = r.parents
        .map(p => `<a class="result-parent" href="${docUrl('theme', p)}" target="_blank" rel="noopener">${escHtml(p)}</a>`)
        .join('<span class="result-parent-sep">, </span>');
      subtitle = `<span class="result-parents">&#x21D2; ${parentLinks}</span>`;
    }
  } else {
    const titlePart = r.title ? escHtml(r.title) : '';
    const datePart = r.date ? `<span class="result-date">(${escHtml(r.date)})</span>` : '';
    if (titlePart || datePart) {
      subtitle = `<span class="result-title">${titlePart}${titlePart && datePart ? ' ' : ''}${datePart}</span>`;
    }
  }

  const bodyClass = r.snippet ? 'result-snippet' : 'result-desc';
  const body = `<p class="${bodyClass}">${hl(r.description)}</p>`;

  return `
    <article class="result ${typeClass}">
      <header class="result-header">
        <span class="result-type">${escHtml(typeLabel)}</span>
        <a class="${nameClass}" href="${nameUrl}" target="_blank" rel="noopener">${escHtml(r.name)}</a>
        ${copyButton(r.name)}
        ${subtitle}
      </header>
      ${body}
    </article>
  `;
}

export function renderProgress(bar: HTMLElement, loaded: number, total: number, label: string) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  bar.innerHTML = `
    <div class="progress-label">${escHtml(label)} ${pct}%</div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
  `;
}

export function setStatus(el: HTMLElement, msg: string, kind: 'info' | 'error' | '' = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
}
