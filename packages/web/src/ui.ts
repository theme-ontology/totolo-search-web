import type { SearchResult } from '@totolo-search/core';
import type { ResultsPhase } from './search.js';

const THEMEONTOLOGY_BASE = 'https://www.themeontology.org';

function themeontologyUrl(docType: string, name: string): string {
  const encoded = encodeURIComponent(name);
  if (docType === 'theme') return `${THEMEONTOLOGY_BASE}/theme/${encoded}`;
  return `${THEMEONTOLOGY_BASE}/story/${encoded}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  if (phase === 'semantic' || phase === 'reranked') {
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
  results: SearchResult[],
  phase: ResultsPhase,
  query = '',
) {
  if (phase === 'searching') { container.innerHTML = ''; return; }
  if (results.length === 0) {
    container.innerHTML = (phase === 'semantic' || phase === 'reranked' || phase === 'regex')
      ? '<p class="no-results">No results.</p>'
      : '';
    return;
  }
  const phaseLabel = phase === 'reranked' ? ' <span class="phase-tag">re-ranked</span>'
    : phase === 'semantic' ? ' <span class="phase-tag">semantic</span>'
    : phase === 'regex' ? ' <span class="phase-tag">regex</span>'
    : '';
  const hl = makeHighlighter(phase, query);
  container.innerHTML = `
    <p class="result-count">${results.length} results${phaseLabel}</p>
    ${results.map(r => renderResult(r, hl)).join('')}
  `;
}

function renderResult(r: SearchResult, hl: Highlighter): string {
  const typeClass = `type-${r.doc_type}`;
  const typeLabel = r.doc_type === 'story-theme' ? 'note'
    : r.doc_type === 'collection' ? 'group'
    : r.doc_type;

  if (r.doc_type === 'story-theme') {
    const storyUrl = themeontologyUrl('story', r.name);
    const themeUrl = themeontologyUrl('theme', r.title);
    const levelParen = r.theme_level
      ? ` <span class="result-date">(${escHtml(r.theme_level)})</span>`
      : '';
    return `
      <article class="result ${typeClass}">
        <header class="result-header">
          <span class="result-type">${escHtml(typeLabel)}</span>
          <a class="result-name" href="${storyUrl}" target="_blank" rel="noopener">${escHtml(r.name)}</a>
          <a class="result-theme-name" href="${themeUrl}" target="_blank" rel="noopener">${escHtml(r.title)}</a>${levelParen}
        </header>
        <p class="result-desc">${hl(r.description)}</p>
      </article>
    `;
  }

  const nameUrl = themeontologyUrl(r.doc_type, r.name);

  let subtitle = '';
  if (r.doc_type === 'theme') {
    if (r.parents && r.parents.length > 0) {
      const parentLinks = r.parents
        .map(p => `<a class="result-parent" href="${themeontologyUrl('theme', p)}" target="_blank" rel="noopener">${escHtml(p)}</a>`)
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
        <a class="result-name" href="${nameUrl}" target="_blank" rel="noopener">${escHtml(r.name)}</a>
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
